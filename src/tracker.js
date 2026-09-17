import { createHash } from "node:crypto";
import { normalizePhone } from "./audience.js";

const RANK = { reserved: 0, uncertain: 0, accepted: 1, sent: 1, failed: 2, delivered: 3, read: 4 };

export class ContactTracker {
  constructor(store, { fatigueHours = 48 } = {}) {
    this.store = store;
    this.db = store.db;
    this.vault = store.vault;
    this.fatigueHours = fatigueHours;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tracker_contacts (
        phone_hash TEXT PRIMARY KEY, phone_last4 TEXT NOT NULL,
        consent TEXT NOT NULL DEFAULT 'unknown', source TEXT, evidence TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS communications (
        key TEXT PRIMARY KEY, phone_hash TEXT NOT NULL, phone_last4 TEXT NOT NULL,
        origin TEXT NOT NULL, template TEXT NOT NULL, campaign_id TEXT, reservation_id TEXT, event_key TEXT,
        status TEXT NOT NULL, reason TEXT, meta_message_id TEXT UNIQUE,
        attempted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS communications_phone ON communications(phone_hash, attempted_at);
      CREATE UNIQUE INDEX IF NOT EXISTS communications_event ON communications(event_key)
        WHERE event_key IS NOT NULL AND attempted_at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS tracker_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, phone_hash TEXT, actor TEXT NOT NULL,
        action TEXT NOT NULL, source TEXT, evidence TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhook_relay (
        id TEXT PRIMARY KEY, payload_cipher TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL, delivered_at TEXT, created_at TEXT NOT NULL
      );
    `);
  }

  identity(phone) {
    // Callers already supply international numbers; never prepend a default country again.
    const normalized = normalizePhone(phone, "");
    if (!normalized) throw new Error("INVALID_PHONE");
    return { hash: this.vault.hashPhone(normalized), last4: normalized.slice(-4) };
  }

  inspect(phone, fatigueHours = this.fatigueHours, now = new Date()) {
    const { hash, last4 } = this.identity(phone);
    const contact = this.db.prepare("SELECT consent,source,evidence,updated_at FROM tracker_contacts WHERE phone_hash=?").get(hash);
    const suppression = this.store.getSuppression(hash);
    const legacy = this.db.prepare(`SELECT MAX(COALESCE(last_attempt_at,accepted_at)) AS at FROM recipients
      WHERE phone_hash=?`).get(hash)?.at;
    const current = this.db.prepare("SELECT MAX(attempted_at) AS at FROM communications WHERE phone_hash=? AND origin<>'test'").get(hash)?.at;
    const lastContactAt = [legacy, current].filter(Boolean).sort().at(-1) || null;
    const hours = Math.max(this.fatigueHours, fatigueHours);
    const nextAllowedAt = lastContactAt ? new Date(Date.parse(lastContactAt) + hours * 3600000).toISOString() : null;
    const inFlight = Boolean(this.db.prepare(`SELECT 1 FROM communications WHERE phone_hash=? AND status='reserved'
      AND attempted_at > ?`).get(hash, new Date(now.getTime() - 300000).toISOString()));
    return { phoneLast4: last4, suppressed: Boolean(suppression), suppression: suppression || null,
      consent: contact?.consent || "unknown", consentSource: contact?.source || null,
      lastContactAt, nextAllowedAt, fatigue: Boolean(nextAllowedAt && Date.parse(nextAllowedAt) > now.getTime()), inFlight };
  }

  eventKey(input, hash) {
    if (input.template !== "nollego_reagendar") return null;
    const date = input.reservationDate || /^precompro-no-show-(\d{4}-\d{2}-\d{2})$/.exec(input.source || "")?.[1];
    return date ? `no-show:${date}:${hash}` : null;
  }

  reserve(input) {
    const { hash, last4 } = this.identity(input.phone);
    const now = new Date(); const stamp = now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM communications WHERE key=?").get(input.key);
      if (existing && (existing.phone_hash !== hash || existing.origin !== input.origin || existing.template !== input.template))
        throw new Error("COMMUNICATION_KEY_CONFLICT");
      if (existing?.attempted_at) {
        this.db.exec("COMMIT");
        return { allowed: false, reason: "DUPLICATE_ATTEMPT", status: existing.status };
      }
      const state = this.inspect(input.phone, input.fatigueHours, now);
      const eventKey = this.eventKey(input, hash);
      let reason = null;
      if (state.suppressed) reason = "OPTED_OUT";
      else if (input.origin === "automation" && state.consent !== "granted") reason = "NO_CONSENT";
      else if (eventKey && this.db.prepare("SELECT 1 FROM communications WHERE event_key=? AND attempted_at IS NOT NULL").get(eventKey)) reason = "DUPLICATE_EVENT";
      else if (eventKey && this.db.prepare(`SELECT 1 FROM recipients r JOIN campaigns c ON c.id=r.campaign_id
        WHERE r.phone_hash=? AND c.template_name='nollego_reagendar' AND c.source=?
        AND (r.accepted_at IS NOT NULL OR r.last_attempt_at IS NOT NULL) LIMIT 1`).get(hash, `precompro-no-show-${eventKey.split(":")[1]}`)) reason = "DUPLICATE_EVENT";
      else if (state.inFlight) reason = "CONTACT_IN_FLIGHT";
      else if (input.origin !== "test" && state.fatigue) reason = "FATIGUE";
      this.db.prepare(`INSERT INTO communications(key,phone_hash,phone_last4,origin,template,campaign_id,reservation_id,event_key,status,reason,attempted_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status,reason=excluded.reason,
        attempted_at=excluded.attempted_at,updated_at=excluded.updated_at`).run(
        input.key, hash, last4, input.origin, input.template, input.campaignId || null, input.reservationId || null,
        eventKey, reason ? "skipped" : "reserved", reason, reason ? null : stamp, stamp, stamp);
      this.db.exec("COMMIT");
      return { allowed: !reason, reason, nextAllowedAt: state.nextAllowedAt };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  complete({ key, status, messageId, reason }) {
    const row = this.db.prepare("SELECT * FROM communications WHERE key=?").get(key);
    if (!row?.attempted_at) throw new Error("UNKNOWN_RESERVATION");
    if (row.meta_message_id && messageId && row.meta_message_id !== messageId) throw new Error("MESSAGE_ID_CONFLICT");
    const next = (RANK[row.status] ?? 0) > (RANK[status] ?? 0) ? row.status : status;
    this.db.prepare(`UPDATE communications SET status=?,reason=?,meta_message_id=COALESCE(meta_message_id,?),updated_at=? WHERE key=?`)
      .run(next, reason || null, messageId || null, new Date().toISOString(), key);
    if (messageId) {
      const events = this.db.prepare("SELECT status FROM webhook_events WHERE meta_message_id=? ORDER BY id").all(messageId);
      for (const event of events) this.applyStatus(messageId, event.status);
    }
    return { ok: true };
  }

  applyStatus(messageId, status) {
    if (!(status in RANK) || !messageId) return;
    const row = this.db.prepare("SELECT status FROM communications WHERE meta_message_id=?").get(messageId);
    if (!row || (RANK[status] ?? 0) < (RANK[row.status] ?? 0)) return;
    this.db.prepare("UPDATE communications SET status=?,updated_at=? WHERE meta_message_id=?")
      .run(status, new Date().toISOString(), messageId);
  }

  consent({ phone, consent, source, evidence, actor, suppressed = false, reactivate = false }) {
    const { hash, last4 } = this.identity(phone); const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (reactivate && !consent) throw new Error("REACTIVATION_REQUIRES_CONSENT");
      this.db.prepare(`INSERT INTO tracker_contacts(phone_hash,phone_last4,consent,source,evidence,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(phone_hash) DO UPDATE SET consent=excluded.consent,source=excluded.source,evidence=excluded.evidence,updated_at=excluded.updated_at`)
        .run(hash, last4, consent && !suppressed ? "granted" : "revoked", source, evidence, now);
      if (suppressed || !consent) this.store.addSuppression({ phoneHash: hash, phoneLast4: last4, reason: "consent_revoked", source });
      else if (reactivate) this.db.prepare("DELETE FROM suppressions WHERE phone_hash=?").run(hash);
      this.db.prepare("INSERT INTO tracker_audit(phone_hash,actor,action,source,evidence,created_at) VALUES(?,?,?,?,?,?)")
        .run(hash, actor, reactivate ? "reopt_in" : consent ? "consent_granted" : "consent_revoked", source, evidence, now);
      this.db.exec("COMMIT");
      return this.inspect(phone);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  history(limit = 100, offset = 0) {
    return this.db.prepare(`SELECT * FROM (
      SELECT key,phone_last4 AS phoneLast4,origin,template,campaign_id AS campaignId,reservation_id AS reservationId,
        status,reason,meta_message_id AS messageId,attempted_at AS attemptedAt,created_at AS createdAt,updated_at AS updatedAt
        FROM communications
      UNION ALL
      SELECT 'legacy:'||r.id,r.phone_last4,'legacy_campaign',c.template_name,c.id,NULL,r.status,r.error_code,r.meta_message_id,
        COALESCE(r.last_attempt_at,r.accepted_at),c.created_at,COALESCE(r.read_at,r.delivered_at,r.last_attempt_at,c.updated_at)
        FROM recipients r JOIN campaigns c ON c.id=r.campaign_id
        WHERE NOT EXISTS (SELECT 1 FROM communications m WHERE m.key='campaign:'||c.id||':'||r.id)
    ) ORDER BY createdAt DESC,key DESC LIMIT ? OFFSET ?`).all(limit, offset);
  }

  health() {
    const count = table => this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    const relay = this.db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN delivered_at IS NULL THEN 1 ELSE 0 END) AS pending,
      MAX(delivered_at) AS lastDeliveredAt,MAX(attempts) AS maxAttempts FROM webhook_relay`).get();
    return { version: 1, legacyRecipients: count("recipients"), communications: count("communications"),
      suppressions: count("suppressions"), consents: this.db.prepare("SELECT consent,COUNT(*) AS count FROM tracker_contacts GROUP BY consent").all(),
      fatigueHours: this.fatigueHours, activeCampaigns: this.db.prepare("SELECT id,status FROM campaigns WHERE status IN ('sending','queued')").all(), relay };
  }

  enqueueWebhook(raw, signature) {
    const id = createHash("sha256").update(raw).digest("hex"); const stamp = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO webhook_relay(id,payload_cipher,next_attempt_at,created_at) VALUES(?,?,?,?)")
      .run(id, this.vault.encrypt({ raw: raw.toString("utf8"), signature }), stamp, stamp);
  }
}

export class WebhookRelay {
  constructor(tracker, url, fetchImpl = fetch) {
    if (url && url !== "https://reservas-marketing.grupomistico.cloud/webhooks/whatsapp") throw new Error("UNEXPECTED_RELAY_DESTINATION");
    this.tracker = tracker; this.url = url; this.fetch = fetchImpl; this.active = null;
  }
  start() {
    if (!this.url) return;
    this.timer = setInterval(() => { this.drain().catch(() => {}); }, 5000);
    this.timer.unref(); this.drain().catch(() => {});
  }
  async stop() { clearInterval(this.timer); if (this.active) await this.active; }
  async drain() {
    if (!this.url) return;
    if (this.active) return this.active;
    this.active = this.flush().finally(() => { this.active = null; });
    return this.active;
  }
  async flush() {
    const db = this.tracker.db;
    const rows = db.prepare("SELECT * FROM webhook_relay WHERE delivered_at IS NULL AND next_attempt_at<=? ORDER BY created_at LIMIT 25").all(new Date().toISOString());
    for (const row of rows) {
      try {
        const data = this.tracker.vault.decrypt(row.payload_cipher);
        const response = await this.fetch(this.url, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": data.signature },
          body: data.raw, signal: AbortSignal.timeout(10000), redirect: "error" });
        if (!response.ok) throw new Error("RELAY_REJECTED");
        db.prepare("UPDATE webhook_relay SET delivered_at=?,payload_cipher=NULL,attempts=attempts+1 WHERE id=?").run(new Date().toISOString(), row.id);
      } catch {
        const delay = Math.min(3600, 5 * 2 ** Math.min(row.attempts, 10));
        db.prepare("UPDATE webhook_relay SET attempts=attempts+1,next_attempt_at=? WHERE id=?").run(new Date(Date.now() + delay * 1000).toISOString(), row.id);
      }
    }
    db.prepare("DELETE FROM webhook_relay WHERE delivered_at IS NOT NULL AND delivered_at<?").run(new Date(Date.now() - 30 * 86400000).toISOString());
  }
}
