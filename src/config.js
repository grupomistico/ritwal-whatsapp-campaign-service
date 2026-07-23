import path from "node:path";

function integer(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function actorMap(value = "") {
  const actors = new Map();
  for (const item of value.split(",")) {
    const [rawId, ...labelParts] = item.split(":");
    const id = rawId.trim();
    const label = labelParts.join(":").trim();
    if (id && label) actors.set(id, label);
  }
  return actors;
}

export function loadConfig(env = process.env) {
  return {
    port: integer(env.PORT, 3000),
    host: env.HOST || "0.0.0.0",
    publicUrl: env.PUBLIC_MIDDLEWARE_URL || "http://127.0.0.1:3000",
    toolSecret: env.TOOL_SECRET || "",
    dataDir: path.resolve(env.DATA_DIR || "./data"),
    piiEncryptionKey: env.PII_ENCRYPTION_KEY || "",
    security: {
      authorizedActors: actorMap(env.AUTHORIZED_ACTORS),
    },
    meta: {
      accessToken: env.META_ACCESS_TOKEN || "",
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || "",
      businessAccountId: env.WHATSAPP_BUSINESS_ACCOUNT_ID || "",
      graphApiVersion: env.GRAPH_API_VERSION || "v25.0",
      appSecret: env.META_APP_SECRET || "",
      webhookVerifyToken: env.WHATSAPP_VERIFY_TOKEN || "",
    },
    campaign: {
      defaultCountryCode: env.DEFAULT_COUNTRY_CODE || "57",
      fatigueHours: integer(env.DEFAULT_FATIGUE_HOURS, 48),
      sendDelayMs: integer(env.DEFAULT_SEND_DELAY_MS, 1200),
      maxSize: integer(env.MAX_CAMPAIGN_SIZE, 10000),
    },
  };
}

export function assertRuntimeConfig(config, { requireWebhook = false } = {}) {
  const missing = [];
  if (!config.toolSecret) missing.push("TOOL_SECRET");
  if (!config.piiEncryptionKey) missing.push("PII_ENCRYPTION_KEY");
  if (!config.meta.accessToken) missing.push("META_ACCESS_TOKEN");
  if (!config.meta.phoneNumberId) missing.push("WHATSAPP_PHONE_NUMBER_ID");
  if (!config.meta.businessAccountId) missing.push("WHATSAPP_BUSINESS_ACCOUNT_ID");
  if (!config.security?.authorizedActors?.size) missing.push("AUTHORIZED_ACTORS");
  if (requireWebhook && !config.meta.appSecret) missing.push("META_APP_SECRET");
  if (requireWebhook && !config.meta.webhookVerifyToken) {
    missing.push("WHATSAPP_VERIFY_TOKEN");
  }
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }
}
