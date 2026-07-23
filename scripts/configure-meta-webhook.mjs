#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const secret = process.env.META_APP_SECRET || (await readSecret());
if (!/^[a-f0-9]{32}$/i.test(secret)) {
  throw new Error("META_APP_SECRET must be a 32-character hexadecimal value");
}

const required = [
  "META_APP_ID",
  "META_ACCESS_TOKEN",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "WHATSAPP_VERIFY_TOKEN",
  "PUBLIC_MIDDLEWARE_URL",
  "DOKPLOY_BASE_URL",
  "DOKPLOY_API_KEY",
  "DOKPLOY_APPLICATION_ID",
];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}`);

updateLocalEnv("META_APP_SECRET", secret);
process.env.META_APP_SECRET = secret;

const provision = spawnSync(process.execPath, ["scripts/provision-dokploy.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: process.env,
  stdio: "inherit",
});
if (provision.status !== 0) {
  throw new Error("Could not synchronize Dokploy environment");
}

await dokploy("application.deploy", {
  method: "POST",
  body: {
    applicationId: process.env.DOKPLOY_APPLICATION_ID,
    title: "Enable signed Meta WhatsApp webhook",
    description: "Synchronize META_APP_SECRET and webhook verification",
  },
});
await waitForDeployment();

const health = await fetchJson(
  `${process.env.PUBLIC_MIDDLEWARE_URL.replace(/\/$/, "")}/health`,
);
if (!health.webhookReady) {
  throw new Error("Production API did not enable signed webhooks");
}

const callbackUrl =
  `${process.env.PUBLIC_MIDDLEWARE_URL.replace(/\/$/, "")}/webhooks/whatsapp`;
const appAccessToken = `${process.env.META_APP_ID}|${secret}`;
const subscription = await meta(
  `${process.env.META_APP_ID}/subscriptions`,
  appAccessToken,
  {
    method: "POST",
    parameters: {
      object: "whatsapp_business_account",
      callback_url: callbackUrl,
      verify_token: process.env.WHATSAPP_VERIFY_TOKEN,
      fields: "messages",
      include_values: "true",
    },
  },
);
if (subscription.success !== true) {
  throw new Error("Meta did not confirm the app webhook subscription");
}

const wabaSubscription = await meta(
  `${process.env.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps`,
  process.env.META_ACCESS_TOKEN,
  { method: "POST" },
);
if (wabaSubscription.success !== true) {
  throw new Error("Meta did not confirm the WABA app subscription");
}

const subscriptions = await meta(
  `${process.env.META_APP_ID}/subscriptions`,
  appAccessToken,
);
const whatsapp = (subscriptions.data || []).find(
  (item) => item.object === "whatsapp_business_account",
);
if (!whatsapp || whatsapp.callback_url !== callbackUrl) {
  throw new Error("Meta webhook callback verification did not match production");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      webhookReady: health.webhookReady,
      callbackUrl,
      fields: whatsapp.fields || [],
      wabaSubscribed: true,
    },
    null,
    2,
  ),
);

async function readSecret() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").trim();
  }

  process.stdout.write("Meta App Secret: ");
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      resolve(value.trim());
    };
    process.stdin.on("data", (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") {
          process.stdin.setRawMode(false);
          reject(new Error("Cancelled"));
          return;
        }
        if (character === "\u007f") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    });
  });
}

async function waitForDeployment() {
  let sawRunning = false;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const application = await dokploy("application.one", {
      query: { applicationId: process.env.DOKPLOY_APPLICATION_ID },
    });
    if (application.applicationStatus === "running") sawRunning = true;
    if (application.applicationStatus === "error") {
      throw new Error("Dokploy deployment failed");
    }
    if (sawRunning && application.applicationStatus === "done") return;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("Timed out waiting for Dokploy deployment");
}

async function dokploy(path, options = {}) {
  const url = new URL(
    `${process.env.DOKPLOY_BASE_URL.replace(/\/$/, "")}/${path}`,
  );
  for (const [key, value] of Object.entries(options.query || {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      accept: "application/json",
      "x-api-key": process.env.DOKPLOY_API_KEY,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`Dokploy ${path} failed with HTTP ${response.status}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function meta(path, accessToken, options = {}) {
  const url = new URL(
    `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || "v25.0"}/${path}`,
  );
  const parameters = new URLSearchParams({
    access_token: accessToken,
    ...(options.parameters || {}),
  });
  const response = await fetch(
    options.method === "POST" ? url : `${url}?${parameters}`,
    {
      method: options.method || "GET",
      headers:
        options.method === "POST"
          ? { "content-type": "application/x-www-form-urlencoded" }
          : undefined,
      body: options.method === "POST" ? parameters : undefined,
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Meta ${path} failed with HTTP ${response.status}` +
        (payload.error?.code ? ` (code ${payload.error.code})` : ""),
    );
  }
  return payload;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  return payload;
}

function updateLocalEnv(key, value) {
  const envPath = new URL("../.env", import.meta.url);
  const contents = fs.readFileSync(envPath, "utf8");
  const line = `${key}=${JSON.stringify(String(value))}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const updated = pattern.test(contents)
    ? contents.replace(pattern, line)
    : `${contents.trimEnd()}\n${line}\n`;
  fs.writeFileSync(envPath, updated, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}
