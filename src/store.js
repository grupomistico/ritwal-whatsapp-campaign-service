import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function nowIso() {
  return new Date().toISOString();
}

function campaignId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `GM-${date}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

export class CampaignStore {
  constructor({ dataDir, vault, databasePath }) {
    this.vault = vault;
    const dbPath = databasePath || path.join(dataDir, "masivoswpp.sqlite");
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        brand TEXT NOT NULL,
        template_name TEXT NOT NULL,
        language TEXT NOT NULL,
        media_id TEXT,
        status TEXT NOT NULL,
        source TEXT,
        requested_by TEXT,
        approved_by TEXT,
        template_json TEXT NOT NULL,
        audience_summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        tested_at TEXT,
        approved_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS recipients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        phone_hash TEXT NOT NULL,
        phone_last4 TEXT NOT NULL,
        pii_cipher TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        meta_message_id TEXT,
        error_code TEXT,
        error_message TEXT,
        last_attempt_at TEXT,
        accepted_at TEXT,
        delivered_at TEXT,
        read_at TEXT,
        failed_at TEXT,
        UNIQUE(campaign_id, phone_hash)
      );
      CREATE INDEX IF NOT EXISTS recipients_meta_message_idx
        ON recipients(meta_message_id);
      CREATE INDEX IF NOT EXISTS recipients_phone_hash_idx
        ON recipients(phone_hash);
      CREATE TABLE IF NOT EXISTS suppressions (
        phone_hash TEXT PRIMARY KEY,
        phone_last4 TEXT NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meta_message_id TEXT,
        phone_hash TEXT,
        status TEXT NOT NULL,
        error_code TEXT,
        occurred_at TEXT,
        received_at TEXT NOT NULL,
        UNIQUE(meta_message_id, status, occurred_at)
      );
    `);
  }

  createCampaign({
    name,
    brand,
    template,
    language,
    mediaId,
    source,
    requestedBy,
    templateInfo,
    audience,
    summary,
  }) {
    const id = campaignId();
    const timestamp = nowIso();
    const insertCampaign = this.db.prepare(`
      INSERT INTO campaigns (
        id, name, brand, template_name, language, media_id, status, source,
        requested_by, template_json, audience_summary_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?)
    `);
    const insertRecipient = this.db.prepare(`
      INSERT INTO recipients (
        campaign_id, phone_hash, phone_last4, pii_cipher, status
      ) VALUES (?, ?, ?, ?, 'pending')
    `);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      insertCampaign.run(
        id,
        name,
        brand,
        template,
        language,
        mediaId || null,
        source || null,
        requestedBy || null,
        JSON.stringify(templateInfo),
        JSON.stringify(summary),
        timestamp,
        timestamp,
      );
      for (const recipient of audience) {
        insertRecipient.run(
          id,
          recipient.phoneHash,
          recipient.phone.slice(-4),
          this.vault.encrypt({
            phone: recipient.phone,
            parameters: recipient.parameters,
          }),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getCampaign(id);
  }

  getCampaign(id) {
    const row = this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
    return row ? this.mapCampaign(row) : null;
  }

  mapCampaign(row) {
    return {
      id: row.id,
      name: row.name,
      brand: row.brand,
      template: row.template_name,
      language: row.language,
      mediaId: row.media_id,
      status: row.status,
      source: row.source,
      requestedBy: row.requested_by,
      approvedBy: row.approved_by,
      templateInfo: JSON.parse(row.template_json),
      audienceSummary: JSON.parse(row.audience_summary_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      testedAt: row.tested_at,
      approvedAt: row.approved_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      errorMessage: row.error_message,
    };
  }

  setCampaignStatus(id, status, fields = {}) {
    const allowed = new Set([
      "approved_by",
      "tested_at",
      "approved_at",
      "started_at",
      "completed_at",
      "error_message",
    ]);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    const clauses = ["status = ?", "updated_at = ?"];
    const values = [status, nowIso()];
    for (const [key, value] of entries) {
      clauses.push(`${key} = ?`);
      values.push(value);
    }
    values.push(id);
    this.db
      .prepare(`UPDATE campaigns SET ${clauses.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.getCampaign(id);
  }

  approveCampaign(id, approvedBy) {
    return this.setCampaignStatus(id, "approved", {
      approved_by: approvedBy,
      approved_at: nowIso(),
    });
  }

  getPendingRecipients(campaignId) {
    return this.db
      .prepare(
        `SELECT * FROM recipients
         WHERE campaign_id = ? AND status IN ('pending', 'retry')
         ORDER BY id`,
      )
      .all(campaignId)
      .map((row) => ({
        id: row.id,
        campaignId: row.campaign_id,
        phoneHash: row.phone_hash,
        phoneLast4: row.phone_last4,
        ...this.vault.decrypt(row.pii_cipher),
      }));
  }

  markAttempt(recipientId, {
    status,
    metaMessageId,
    errorCode,
    errorMessage,
  }) {
    const timestamp = nowIso();
    const acceptedAt = status === "accepted" ? timestamp : null;
    const failedAt = status === "failed" ? timestamp : null;
    this.db.prepare(`
      UPDATE recipients
      SET status = ?, attempts = attempts + 1, meta_message_id = ?,
          error_code = ?, error_message = ?, last_attempt_at = ?,
          accepted_at = COALESCE(accepted_at, ?),
          failed_at = COALESCE(failed_at, ?)
      WHERE id = ?
    `).run(
      status,
      metaMessageId || null,
      errorCode ? String(errorCode) : null,
      errorMessage || null,
      timestamp,
      acceptedAt,
      failedAt,
      recipientId,
    );
  }

  updateDeliveryStatus({
    metaMessageId,
    recipientPhoneHash,
    status,
    errorCode,
    errorMessage,
    occurredAt,
  }) {
    const timestamp = nowIso();
    const eventAt = occurredAt || timestamp;
    this.db.prepare(`
      INSERT OR IGNORE INTO webhook_events (
        meta_message_id, phone_hash, status, error_code, occurred_at, received_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      metaMessageId || null,
      recipientPhoneHash || null,
      status,
      errorCode ? String(errorCode) : null,
      eventAt,
      timestamp,
    );

    const statusColumn = {
      sent: "accepted_at",
      delivered: "delivered_at",
      read: "read_at",
      failed: "failed_at",
    }[status];
    if (!statusColumn || !metaMessageId) return;

    const recipient = this.db
      .prepare("SELECT id, status FROM recipients WHERE meta_message_id = ?")
      .get(metaMessageId);
    if (!recipient) return;

    const rank = {
      pending: 0,
      retry: 0,
      accepted: 1,
      sent: 1,
      failed: 1,
      delivered: 2,
      read: 3,
    };
    if ((rank[status] ?? 0) < (rank[recipient.status] ?? 0)) return;

    this.db.prepare(`
      UPDATE recipients
      SET status = ?, ${statusColumn} = ?, error_code = ?, error_message = ?
      WHERE id = ?
    `).run(
      status,
      eventAt,
      errorCode ? String(errorCode) : null,
      errorMessage || null,
      recipient.id,
    );
  }

  getSuppression(phoneHash) {
    return this.db
      .prepare(
        `SELECT reason, source, created_at AS createdAt, expires_at AS expiresAt
         FROM suppressions
         WHERE phone_hash = ?
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(phoneHash, nowIso());
  }

  addSuppression({ phoneHash, phoneLast4, reason, source, expiresAt = null }) {
    this.db.prepare(`
      INSERT INTO suppressions (
        phone_hash, phone_last4, reason, source, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone_hash) DO UPDATE SET
        reason = excluded.reason,
        source = excluded.source,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).run(phoneHash, phoneLast4, reason, source, nowIso(), expiresAt);
  }

  getLastContactAt(phoneHash) {
    const row = this.db.prepare(`
      SELECT MAX(accepted_at) AS last_contact_at
      FROM recipients
      WHERE phone_hash = ? AND accepted_at IS NOT NULL
    `).get(phoneHash);
    return row?.last_contact_at || null;
  }

  getIdempotency(key) {
    return this.db
      .prepare("SELECT campaign_id AS campaignId FROM idempotency WHERE key = ?")
      .get(key) || null;
  }

  claimIdempotency(key, campaignId) {
    const existing = this.getIdempotency(key);
    if (existing) {
      return { claimed: false, campaignId: existing.campaignId };
    }
    this.db
      .prepare(
        "INSERT INTO idempotency (key, campaign_id, created_at) VALUES (?, ?, ?)",
      )
      .run(key, campaignId, nowIso());
    return { claimed: true, campaignId };
  }

  stats(campaignId) {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM recipients
      WHERE campaign_id = ?
      GROUP BY status
    `).all(campaignId);
    const byStatus = Object.fromEntries(rows.map((row) => [row.status, row.count]));
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    return { total, byStatus };
  }

  close() {
    this.db.close();
  }
}
