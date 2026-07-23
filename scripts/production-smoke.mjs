#!/usr/bin/env node
import "dotenv/config";

const baseUrl = process.env.PUBLIC_MIDDLEWARE_URL;
const toolSecret = process.env.TOOL_SECRET;
if (!baseUrl || !toolSecret) {
  throw new Error("PUBLIC_MIDDLEWARE_URL and TOOL_SECRET are required");
}

const health = await get("/health", false);
const schema = await get("/tools/schema", true);
const account = await get("/tools/account", true);
const templates = await get("/tools/templates", true);

const approved = (templates.data || []).filter(
  (template) => template.status === "APPROVED",
);
if (!health.ok || !schema.ok || !account.ok || approved.length === 0) {
  throw new Error("Production smoke failed");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      service: health.service,
      webhookReady: health.webhookReady,
      toolCount: schema.tools?.length || 0,
      account: {
        verifiedName: account.data?.verifiedName,
        qualityRating: account.data?.qualityRating,
      },
      approvedTemplates: approved.length,
    },
    null,
    2,
  ),
);

async function get(route, authenticated) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${route}`, {
    headers: authenticated ? { "x-tool-secret": toolSecret } : {},
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${route} failed ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

