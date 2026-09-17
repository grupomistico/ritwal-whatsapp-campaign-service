# Shared Messaging Tracker

The existing SQLite volume is authoritative for campaign history, suppressions
and automation contact claims. No customer export or hash-key migration is needed.

## Contract

All internal endpoints use the existing `x-tool-secret`. They do not impersonate
a Telegram actor or weaken the approval/test/confirmation requirements for campaigns.

- `GET /internal/tracker/health`: counts, relay backlog and active campaigns.
- `POST /internal/tracker/check`: `{phones, fatigueHours}`; read-only, max 500.
- `POST /internal/tracker/reserve`: atomic automation claim by key/phone/template/
  reservationId/reservationDate. Returns `allowed` and a reason when denied.
- `POST /internal/tracker/complete`: idempotent outcome by key; stores Meta ID.
- `POST /internal/tracker/consent`: explicit source/evidence/actor; never inferred.
- `GET /tools/tracker?limit=100&offset=0`: masked shared history and summary.
- `POST /tools/tracker/consents`: same consent payload; authorized Telegram actor
  required, as for existing campaign mutations.

Checks use old campaign recipients and hash-only suppressions directly. An atomic
SQLite transaction reserves the contact before Meta. The minimum gap is
`DEFAULT_FATIGUE_HOURS` (48 hours by default), even when a caller requests zero.
No-show is additionally deduplicated by phone and reservation date, including old
campaigns with source `precompro-no-show-YYYY-MM-DD`. Internal tests are recorded
separately and do not consume customer fatigue, but still respect opt-outs.

Bookings and previous sends do not grant consent. Automation claims require
an explicit granted record with provenance. Existing manual campaign approval
rules remain unchanged. A grant does not remove an old opt-out unless the caller
explicitly requests `reactivate=true` with new evidence.

## Durable Webhook Relay

Optional `AUTOMATION_WEBHOOK_URL` must equal
`https://reservas-marketing.grupomistico.cloud/webhooks/whatsapp`.
Meta continues to call the original campaign webhook. After signature validation,
the original body/signature are stored encrypted in SQLite and forwarded unchanged.
Failures retry with backoff. A successful delivery erases the stored payload;
delivered deduplication markers remain 30 days. No outgoing WhatsApp is produced
by the relay. Both services must use the same Meta app secret.

Automation outcome reports have a separate durable PostgreSQL outbox. Retrying
a report never retries the WhatsApp request. Ambiguous sends are not resent.

## Operations

Keep the existing `/app/data` volume and PII key. Use one application replica
and stop-first updates, as this is a single-writer SQLite service.
`health.relay.pending`, `maxAttempts` and `lastDeliveredAt` expose relay health.
The reservation automation also reports pending outcome reports and queue errors.

The September 17 integration does not activate automation sends. Its global
`SEND_ENABLED` remains false and no-show remains dry-run pending business review
and an explicitly authorized internal test.

Rollback: redeploy commit `9bebd248400542a4d9e5b20d9bcd896273d16a17` from a rollback
branch and remove only `AUTOMATION_WEBHOOK_URL` if necessary. Keep automation
sends off. Do not roll back the SQLite volume: new tables are additive and the
old service ignores them. Disable automation tracker readiness before rollback.
