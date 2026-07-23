#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";

const input = process.argv.slice(2);
const command = input[0];
const needsTarget = new Set(["test", "approve", "send", "resume", "status"]);
const target = needsTarget.has(command) ? input[1] : undefined;
const rawArgs = needsTarget.has(command) ? input.slice(2) : input.slice(1);
const args = parseArgs(rawArgs);
const baseUrl =
  process.env.PUBLIC_MIDDLEWARE_URL || "http://127.0.0.1:3000";
const toolSecret = process.env.TOOL_SECRET;
const actorId = args.actorId || process.env.MASIVOSWPP_ACTOR_ID;

if (!toolSecret) throw new Error("TOOL_SECRET is required");

switch (command) {
  case "account":
    output(await request("/tools/account"));
    break;
  case "templates":
    output(await request("/tools/templates"));
    break;
  case "create": {
    const contacts = await readContacts(required(args, "contacts"));
    output(
      await request("/tools/campaigns", {
        method: "POST",
        body: {
          name: required(args, "name"),
          brand: args.brand || "ritwal",
          template: required(args, "template"),
          language: args.language || "es_CO",
          mediaId: args.mediaId,
          source: args.source || path.basename(args.contacts),
          requestedBy: args.requestedBy,
          fatigueHours:
            args.fatigueHours === undefined
              ? undefined
              : Number(args.fatigueHours),
          audience: contacts,
        },
      }),
    );
    break;
  }
  case "test": {
    const contacts = await readContacts(required(args, "contacts"));
    output(
      await request(`/tools/campaigns/${requiredTarget(target)}/test`, {
        method: "POST",
        body: { contacts },
      }),
    );
    break;
  }
  case "approve":
    output(
      await request(`/tools/campaigns/${requiredTarget(target)}/approve`, {
        method: "POST",
        body: {},
      }),
    );
    break;
  case "send":
    output(
      await request(`/tools/campaigns/${requiredTarget(target)}/send`, {
        method: "POST",
        body: {
          confirmation: required(args, "confirm"),
          idempotencyKey: required(args, "idempotencyKey"),
        },
      }),
    );
    break;
  case "resume":
    output(
      await request(`/tools/campaigns/${requiredTarget(target)}/resume`, {
        method: "POST",
        body: {},
      }),
    );
    break;
  case "status":
    output(await request(`/tools/campaigns/${requiredTarget(target)}`));
    break;
  case "upload-media": {
    const filePath = required(args, "file");
    const extension = path.extname(filePath).toLowerCase();
    const mimeType = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    }[extension];
    if (!mimeType) throw new Error("Supported media: jpg, jpeg, png, webp");
    const bytes = await readFile(filePath);
    output(
      await request("/tools/media", {
        method: "POST",
        body: {
          fileName: path.basename(filePath),
          mimeType,
          base64: bytes.toString("base64"),
        },
      }),
    );
    break;
  }
  case "suppress":
    output(
      await request("/tools/suppressions", {
        method: "POST",
        body: {
          phone: required(args, "phone"),
          reason: required(args, "reason"),
          source: args.source || "openclaw",
        },
      }),
    );
    break;
  default:
    usage();
    process.exit(command ? 1 : 0);
}

async function request(route, { method = "GET", body } = {}) {
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (mutation && !actorId) {
    throw new Error("--actor-id or MASIVOSWPP_ACTOR_ID is required");
  }
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${route}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-tool-secret": toolSecret,
      ...(mutation ? { "x-actor-id": actorId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(
      `${method} ${route} failed ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function readContacts(filePath) {
  const contents = await readFile(filePath, "utf8");
  return parse(contents, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value
      .slice(2)
      .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function required(values, key) {
  const value = values[key];
  if (value === undefined || value === true || value === "") {
    throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return value;
}

function requiredTarget(value) {
  if (!value || value.startsWith("--")) throw new Error("Campaign id is required");
  return value;
}

function output(value) {
  console.log(JSON.stringify(value, null, 2));
}

function usage() {
  console.log(`Usage:
  npm run masivoswpp -- account
  npm run masivoswpp -- templates
  npm run masivoswpp -- create --actor-id TELEGRAM_ID --name NAME --template TEMPLATE --contacts FILE [--media-id ID]
  npm run masivoswpp -- test CAMPAIGN_ID --actor-id TELEGRAM_ID --contacts FILE
  npm run masivoswpp -- approve CAMPAIGN_ID --actor-id TELEGRAM_ID
  npm run masivoswpp -- send CAMPAIGN_ID --actor-id TELEGRAM_ID --confirm CAMPAIGN_ID --idempotency-key KEY
  npm run masivoswpp -- resume CAMPAIGN_ID --actor-id TELEGRAM_ID
  npm run masivoswpp -- status CAMPAIGN_ID
  npm run masivoswpp -- upload-media --actor-id TELEGRAM_ID --file IMAGE
  npm run masivoswpp -- suppress --actor-id TELEGRAM_ID --phone PHONE --reason REASON`);
}
