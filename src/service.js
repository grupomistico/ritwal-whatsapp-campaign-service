import { setTimeout as sleep } from "node:timers/promises";
import { prepareAudience, normalizePhone } from "./audience.js";
import { isCriticalMetaError } from "./meta.js";
import { buildTemplateMessage, inspectTemplate } from "./templates.js";
import { ContactTracker } from "./tracker.js";
import { randomUUID } from "node:crypto";

const PERMANENT_SUPPRESSION_CODES = new Set(["131026", "131050"]);
const OPT_OUT_PATTERN =
  /^\s*(stop|baja|cancelar|salir|no\s+m[a\u00e1]s|no\s+me\s+(?:escriban|contacten)|no\s+quiero\s+(?:mensajes|recibir))[\s.!]*$/iu;

export class CampaignService {
  constructor({ config, meta, store, vault, logger = console, tracker }) {
    this.config = config;
    this.meta = meta;
    this.store = store;
    this.vault = vault;
    this.logger = logger;
    this.activeRuns = new Set();
    this.tracker = tracker || (store.db ? new ContactTracker(store, { fatigueHours: config.campaign.fatigueHours }) : null);
  }

  async account() {
    const account = await this.meta.getAccount();
    return {
      verifiedName: account.verified_name,
      displayPhoneNumber: account.display_phone_number,
      qualityRating: account.quality_rating,
      nameStatus: account.name_status,
      platformType: account.platform_type,
      throughput: account.throughput,
      webhookReady: Boolean(
        this.config.meta.appSecret && this.config.meta.webhookVerifyToken,
      ),
    };
  }

  async templates() {
    const templates = await this.meta.listTemplates();
    return templates.map(inspectTemplate);
  }

  async createCampaign(input) {
    const templates = await this.meta.listTemplates();
    const template = templates.find(
      (item) =>
        item.name === input.template &&
        item.language === (input.language || "es_CO"),
    );
    if (!template) throw new Error("Template not found for requested language");
    if (template.status !== "APPROVED") {
      throw new Error(`Template ${template.name} is not APPROVED`);
    }

    const templateInfo = inspectTemplate(template);
    if (templateInfo.headerFormat === "IMAGE" && !input.mediaId) {
      throw new Error(`Template ${input.template} requires mediaId`);
    }
    if (templateInfo.dynamicButtons.length > 0) {
      throw new Error("Dynamic URL buttons require explicit support before sending");
    }

    const prepared = prepareAudience({
      contacts: input.audience,
      templateInfo,
      countryCode:
        input.countryCode || this.config.campaign.defaultCountryCode,
      vault: this.vault,
      store: this.store,
      fatigueHours:
        input.fatigueHours ?? this.config.campaign.fatigueHours,
    });
    if (prepared.ready.length === 0) {
      throw new Error("Audience has no eligible recipients");
    }
    if (prepared.ready.length > this.config.campaign.maxSize) {
      throw new Error(
        `Audience exceeds MAX_CAMPAIGN_SIZE (${this.config.campaign.maxSize})`,
      );
    }

    return this.store.createCampaign({
      name: input.name,
      brand: input.brand || "ritwal",
      template: input.template,
      language: input.language || "es_CO",
      mediaId: input.mediaId,
      source: input.source,
      requestedBy: input.requestedBy,
      templateInfo,
      audience: prepared.ready,
      summary: prepared.summary,
    });
  }

  async testCampaign(campaignId, contacts) {
    const campaign = this.requireCampaign(campaignId);
    if (!["prepared", "tested"].includes(campaign.status)) {
      throw new Error(`Campaign cannot be tested from status ${campaign.status}`);
    }
    if (!Array.isArray(contacts) || contacts.length < 1 || contacts.length > 5) {
      throw new Error("Test requires between 1 and 5 internal recipients");
    }

    const prepared = prepareAudience({
      contacts,
      templateInfo: campaign.templateInfo,
      countryCode: this.config.campaign.defaultCountryCode,
      vault: this.vault,
      store: null,
      fatigueHours: 0,
    });
    if (prepared.ready.length !== contacts.length) {
      throw new Error(`Invalid test audience: ${JSON.stringify(prepared.summary)}`);
    }

    const results = [];
    for (const recipient of prepared.ready) {
      const message = buildTemplateMessage({
        phone: recipient.phone,
        template: campaign.template,
        templateInfo: campaign.templateInfo,
        language: campaign.language,
        mediaId: campaign.mediaId,
        parameters: recipient.parameters,
      });
      const key = `test:${campaignId}:${randomUUID()}`;
      const claim = this.tracker?.reserve({ key, phone: recipient.phone, origin: "test", template: campaign.template, campaignId });
      if (claim && !claim.allowed) throw new Error(`Test contact blocked: ${claim.reason}`);
      let response;
      try {
        response = await this.meta.sendTemplate(message);
        this.tracker?.complete({ key, status: response.messages?.[0]?.id ? "accepted" : "uncertain", messageId: response.messages?.[0]?.id });
      } catch (error) {
        this.tracker?.complete({ key, status: "uncertain", reason: "TEST_REMOTE_OUTCOME_UNKNOWN" });
        throw error;
      }
      results.push({
        phoneLast4: recipient.phone.slice(-4),
        accepted: response.messages?.[0]?.message_status === "accepted",
        messageId: response.messages?.[0]?.id || null,
      });
      await sleep(Math.min(this.config.campaign.sendDelayMs, 500));
    }
    if (!results.every((result) => result.accepted)) {
      throw new Error("One or more test messages were not accepted by Meta");
    }
    this.store.setCampaignStatus(campaignId, "tested", {
      tested_at: new Date().toISOString(),
    });
    return { campaignId, tested: results.length, results };
  }

  approveCampaign(campaignId, approvedBy) {
    const campaign = this.requireCampaign(campaignId);
    if (campaign.status !== "tested") {
      throw new Error("Campaign must pass a real test before approval");
    }
    if (!approvedBy) throw new Error("approvedBy is required");
    return this.store.approveCampaign(campaignId, approvedBy);
  }

  startCampaign(campaignId, { confirmation, idempotencyKey }) {
    const campaign = this.requireCampaign(campaignId);
    if (confirmation !== campaignId) {
      throw new Error("Confirmation must exactly match the campaign id");
    }
    if (!idempotencyKey) throw new Error("idempotencyKey is required");

    const existing = this.store.getIdempotency(idempotencyKey);
    if (existing) {
      if (existing.campaignId !== campaignId) {
        throw new Error("Idempotency key already belongs to another campaign");
      }
      return {
        campaignId,
        status: campaign.status,
        duplicateRequest: true,
      };
    }
    if (campaign.status !== "approved") {
      throw new Error(`Campaign must be approved, current status: ${campaign.status}`);
    }

    const claim = this.store.claimIdempotency(idempotencyKey, campaignId);
    if (!claim.claimed && claim.campaignId !== campaignId) {
      throw new Error("Idempotency key already belongs to another campaign");
    }
    if (!claim.claimed) {
      return {
        campaignId,
        status: this.requireCampaign(campaignId).status,
        duplicateRequest: true,
      };
    }
    this.store.setCampaignStatus(campaignId, "queued");
    this.queueRun(campaignId);
    return { campaignId, status: "queued", duplicateRequest: false };
  }

  resumeCampaign(campaignId) {
    const campaign = this.requireCampaign(campaignId);
    if (!["queued", "sending", "paused", "failed"].includes(campaign.status)) {
      throw new Error(`Campaign cannot resume from status ${campaign.status}`);
    }
    this.queueRun(campaignId);
    return { campaignId, status: "queued_for_resume" };
  }

  queueRun(campaignId) {
    if (this.activeRuns.has(campaignId)) return;
    this.activeRuns.add(campaignId);
    queueMicrotask(() => {
      this.runCampaign(campaignId)
        .catch((error) => {
          this.logger.error({ campaignId, err: error }, "Campaign run failed");
        })
        .finally(() => this.activeRuns.delete(campaignId));
    });
  }

  async runCampaign(campaignId) {
    const campaign = this.requireCampaign(campaignId);
    this.store.setCampaignStatus(campaignId, "sending", {
      started_at: campaign.startedAt || new Date().toISOString(),
      error_message: null,
    });
    const recipients = this.store.getPendingRecipients(campaignId);

    for (const recipient of recipients) {
      const key = `campaign:${campaignId}:${recipient.id}`;
      let reserved = false;
      try {
        const message = buildTemplateMessage({
          phone: recipient.phone,
          template: campaign.template,
          templateInfo: campaign.templateInfo,
          language: campaign.language,
          mediaId: campaign.mediaId,
          parameters: recipient.parameters,
        });
        const claim = this.tracker?.reserve({ key, phone: recipient.phone, template: campaign.template,
          campaignId, source: campaign.source, origin: "campaign", fatigueHours: this.config.campaign.fatigueHours });
        if (claim && !claim.allowed) {
          this.store.markSkipped(recipient.id, claim.reason);
          continue;
        }
        this.store.markReserved(recipient.id);
        reserved = true;
        const response = await this.meta.sendTemplate(message);
        const metaMessage = response.messages?.[0];
        const accepted = metaMessage?.message_status === "accepted";
        this.tracker?.complete({ key, status: accepted ? "accepted" : "uncertain", messageId: metaMessage?.id });
        this.store.markAttempt(recipient.id, {
          status: accepted ? "accepted" : "failed",
          metaMessageId: metaMessage?.id,
          errorMessage: accepted ? null : "Meta did not return accepted",
          incrementAttempt: false,
        });
      } catch (error) {
        const definitive = error.details?.httpStatus >= 400 && error.details.httpStatus < 500;
        if (reserved) this.tracker?.complete({ key, status: definitive ? "failed" : "uncertain", reason: definitive ? "META_REJECTED" : "REMOTE_OUTCOME_UNKNOWN" });
        this.store.markAttempt(recipient.id, {
          status: reserved && !definitive ? "uncertain" : "failed",
          errorCode: error.details?.code,
          errorMessage: error.message,
          incrementAttempt: !reserved,
        });
        if (isCriticalMetaError(error)) {
          this.store.setCampaignStatus(campaignId, "paused", {
            error_message: `Critical Meta error ${error.details?.code || ""}: ${error.message}`,
          });
          return;
        }
      }
      await sleep(this.config.campaign.sendDelayMs);
    }

    this.store.setCampaignStatus(campaignId, "submission_complete", {
      completed_at: new Date().toISOString(),
    });
  }

  status(campaignId) {
    const campaign = this.requireCampaign(campaignId);
    return { campaign, recipients: this.store.stats(campaignId) };
  }

  suppressPhone(phone, reason, source = "manual") {
    const normalized = normalizePhone(
      phone,
      this.config.campaign.defaultCountryCode,
    );
    if (!normalized) throw new Error("Invalid phone");
    this.store.addSuppression({
      phoneHash: this.vault.hashPhone(normalized),
      phoneLast4: normalized.slice(-4),
      reason,
      source,
    });
    return { ok: true, phoneLast4: normalized.slice(-4), reason, source };
  }

  processWebhook(payload) {
    let statuses = 0;
    let suppressions = 0;
    let optOuts = 0;

    for (const entry of payload?.entry || []) {
      for (const change of entry?.changes || []) {
        const value = change?.value || {};
        for (const status of value.statuses || []) {
          const error = status.errors?.[0];
          const code = error?.code ? String(error.code) : null;
          const recipient = normalizePhone(
            status.recipient_id,
            this.config.campaign.defaultCountryCode,
          );
          const phoneHash = recipient ? this.vault.hashPhone(recipient) : null;
          this.store.updateDeliveryStatus({
            metaMessageId: status.id,
            recipientPhoneHash: phoneHash,
            status: status.status,
            errorCode: code,
            errorMessage: error?.title || error?.message,
            occurredAt: status.timestamp
              ? new Date(Number(status.timestamp) * 1000).toISOString()
              : null,
          });
          this.tracker?.applyStatus(status.id, status.status);
          statuses += 1;
          if (recipient && PERMANENT_SUPPRESSION_CODES.has(code)) {
            this.store.addSuppression({
              phoneHash,
              phoneLast4: recipient.slice(-4),
              reason: `meta_${code}`,
              source: "webhook",
            });
            suppressions += 1;
          }
        }

        for (const message of value.messages || []) {
          const text = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || "";
          const sender = normalizePhone(
            message.from,
            this.config.campaign.defaultCountryCode,
          );
          if (sender && OPT_OUT_PATTERN.test(text)) {
            this.store.addSuppression({
              phoneHash: this.vault.hashPhone(sender),
              phoneLast4: sender.slice(-4),
              reason: "explicit_opt_out",
              source: "inbound_whatsapp",
            });
            optOuts += 1;
          }
        }
      }
    }
    return { statuses, suppressions, optOuts };
  }

  requireCampaign(id) {
    const campaign = this.store.getCampaign(id);
    if (!campaign) throw new Error(`Campaign not found: ${id}`);
    return campaign;
  }
}
