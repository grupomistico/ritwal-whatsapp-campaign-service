import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignStore } from "../src/store.js";
import { PiiVault, verifyMetaSignature } from "../src/crypto.js";
import { ContactTracker, WebhookRelay } from "../src/tracker.js";
import { CampaignService } from "../src/service.js";
import { buildApp } from "../src/server.js";
import { createHmac } from "node:crypto";

const stores = []; const apps = [];
const phone = "573001234567";
function setup() {
  const vault = new PiiVault("test-only-key");
  const store = new CampaignStore({ dataDir: ".", databasePath: ":memory:", vault }); stores.push(store);
  const tracker = new ContactTracker(store);
  return { store, tracker, vault };
}
function grant(tracker) { tracker.consent({ phone, consent: true, source: "test-form", evidence: "Test proof, not real customers", actor: "test" }); }
function claim(key, overrides = {}) { return { key, phone, template: "nollego_reagendar", origin: "automation", reservationId: "r1", reservationDate: "2026-09-16", ...overrides }; }
function legacy(store, vault, { date = new Date().toISOString(), source = "precompro-no-show-2026-09-16" } = {}) {
  const campaign = store.createCampaign({ name: "Existing campaign", brand: "ritwal", template: "nollego_reagendar", language: "es_CO", source,
    templateInfo: {}, summary: {}, audience: [{ phone, phoneHash: vault.hashPhone(phone), parameters: { nombre: "Test" } }] });
  const recipient = store.getPendingRecipients(campaign.id)[0];
  store.markAttempt(recipient.id, { status: "accepted", metaMessageId: `legacy-${recipient.id}` });
  store.db.prepare("UPDATE recipients SET last_attempt_at=?,accepted_at=? WHERE id=?").run(date, date, recipient.id);
  return campaign;
}
afterEach(async () => { while (apps.length) await apps.pop().close(); while (stores.length) stores.pop().close(); });

describe("shared communication tracker", () => {
  it("preserves international identities without adding the Colombian prefix", () => {
    const { tracker, vault } = setup();
    for (const international of ["14155552671", "51987654321", "34612345678"]) {
      expect(tracker.identity(`+${international}`).hash).toBe(vault.hashPhone(international));
      expect(tracker.inspect(international)).toMatchObject({ consent: "unknown", fatigue: false });
    }
  });
  it("reads historical sends without copying phone data or assuming consent", () => {
    const { store, tracker, vault } = setup(); legacy(store, vault);
    expect(tracker.inspect(phone)).toMatchObject({ fatigue: true, consent: "unknown" });
    expect(tracker.history()[0]).toMatchObject({ origin: "legacy_campaign", status: "accepted", phoneLast4: "4567" });
    expect(JSON.stringify(tracker.history())).not.toContain(phone);
    expect(tracker.reserve(claim("automation:r1"))).toMatchObject({ allowed: false, reason: "NO_CONSENT" });
  });
  it("reads old opt-outs even when only their protected hash remains", () => {
    const { store, tracker, vault } = setup(); grant(tracker);
    store.addSuppression({ phoneHash: vault.hashPhone(phone), phoneLast4: "4567", reason: "old opt-out", source: "legacy" });
    expect(tracker.reserve(claim("automation:r1"))).toMatchObject({ allowed: false, reason: "OPTED_OUT" });
  });
  it("deduplicates historical no-show events even after the fatigue window", () => {
    const { store, tracker, vault } = setup(); grant(tracker);
    legacy(store, vault, { date: new Date(Date.now() - 72 * 3600000).toISOString() });
    expect(tracker.reserve(claim("automation:r1"))).toMatchObject({ allowed: false, reason: "DUPLICATE_EVENT" });
  });
  it("atomically grants one contact reservation across campaign and automation", () => {
    const { tracker } = setup(); grant(tracker);
    expect(tracker.reserve(claim("automation:r1")).allowed).toBe(true);
    expect(tracker.reserve(claim("campaign:c1:r2", { origin: "campaign", template: "other" }))).toMatchObject({ allowed: false, reason: "CONTACT_IN_FLIGHT" });
    expect(tracker.reserve(claim("automation:r1"))).toMatchObject({ allowed: false, reason: "DUPLICATE_ATTEMPT" });
    tracker.complete({ key: "automation:r1", status: "accepted", messageId: "wamid.test" });
    expect(tracker.reserve(claim("campaign:c2:r3", { origin: "campaign", template: "other", fatigueHours: 0 }))).toMatchObject({ allowed: false, reason: "FATIGUE" });
  });
  it("does not clear an opt-out without an explicit re-opt-in", () => {
    const { tracker } = setup();
    tracker.consent({ phone, consent: false, source: "test", evidence: "stop", actor: "test" });
    grant(tracker);
    expect(tracker.inspect(phone).suppressed).toBe(true);
    tracker.consent({ phone, consent: true, source: "test", evidence: "new explicit opt-in", actor: "test", reactivate: true });
    expect(tracker.inspect(phone)).toMatchObject({ consent: "granted", suppressed: false });
  });
  it("reconciles receipts arriving before completion and never regresses read", () => {
    const { tracker, store } = setup(); grant(tracker); tracker.reserve(claim("automation:r1"));
    store.updateDeliveryStatus({ metaMessageId: "wamid.test", status: "read" });
    tracker.complete({ key: "automation:r1", status: "accepted", messageId: "wamid.test" });
    tracker.applyStatus("wamid.test", "sent");
    expect(tracker.history()[0].status).toBe("read");
    expect(() => tracker.complete({ key: "automation:r1", status: "accepted", messageId: "different" })).toThrow("MESSAGE_ID_CONFLICT");
  });
  it("manual campaigns recheck opt-outs at send time", async () => {
    const { tracker, store, vault } = setup();
    const campaign = store.createCampaign({ name: "Before optout", brand: "ritwal", template: "test", language: "es_CO", source: "test",
      templateInfo: { bodyParams: [], dynamicButtons: [] }, summary: {}, audience: [{ phone, phoneHash: vault.hashPhone(phone), parameters: {} }] });
    store.addSuppression({ phoneHash: vault.hashPhone(phone), phoneLast4: "4567", reason: "stop", source: "test" });
    const meta = { sendTemplate: vi.fn() };
    const service = new CampaignService({ config: { campaign: { fatigueHours: 48, sendDelayMs: 0 } }, meta, store, vault, tracker });
    await service.runCampaign(campaign.id);
    expect(meta.sendTemplate).not.toHaveBeenCalled();
    expect(store.stats(campaign.id).byStatus.skipped).toBe(1);
  });
});

describe("durable signed webhook relay", () => {
  it("encrypts payload, retries failures and forwards exact original signature/body", async () => {
    const { tracker, store } = setup();
    const raw = Buffer.from(JSON.stringify({ entry: [], marker: "synthetic-no-send" }));
    const signature = `sha256=${createHmac("sha256", "test-app-secret").update(raw).digest("hex")}`;
    tracker.enqueueWebhook(raw, signature); tracker.enqueueWebhook(raw, signature);
    expect(tracker.health().relay.total).toBe(1);
    expect(store.db.prepare("SELECT payload_cipher FROM webhook_relay").get().payload_cipher).not.toContain("synthetic");
    let fail = true;
    const relay = new WebhookRelay(tracker, "https://reservas-marketing.grupomistico.cloud/webhooks/whatsapp", async (_url, options) => {
      expect(verifyMetaSignature(Buffer.from(options.body), options.headers["x-hub-signature-256"], "test-app-secret")).toBe(true);
      expect(options.redirect).toBe("error");
      if (fail) throw new Error("offline");
      return { ok: true };
    });
    await relay.drain(); expect(tracker.health().relay.pending).toBe(1);
    store.db.prepare("UPDATE webhook_relay SET next_attempt_at='2000-01-01T00:00:00.000Z'").run(); fail = false;
    await relay.drain(); expect(tracker.health().relay.pending).toBe(0);
    expect(store.db.prepare("SELECT payload_cipher,attempts FROM webhook_relay").get()).toMatchObject({ payload_cipher: null, attempts: 2 });
    await relay.stop();
  });
  it("authenticates internal calls without impersonating a Telegram user", async () => {
    const { tracker, store } = setup();
    const app = buildApp({ store, tracker, logger: false, config: {
      toolSecret: "test-shared-secret", piiEncryptionKey: "test-only-key", security: { authorizedActors: new Map([["1135608648", "Valentin"]]) },
      meta: { accessToken: "test", phoneNumberId: "123", businessAccountId: "456" }, campaign: { fatigueHours: 48 },
    } }); apps.push(app);
    expect((await app.inject('/internal/tracker/health')).statusCode).toBe(401);
    const headers = { 'x-tool-secret': 'test-shared-secret' };
    expect((await app.inject({ method: 'POST', url: '/internal/tracker/check', headers, payload: { phones: [phone] } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/tools/campaigns/x/send', headers, payload: {} })).statusCode).toBe(403);
  });
});
