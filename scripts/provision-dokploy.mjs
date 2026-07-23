#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";

const projectName = "Grupo Mistico Messaging";
const applicationName = "Ritwal WhatsApp Campaign API";
const appName = "ritwal-whatsapp-campaign";
const repositoryUrl =
  "https://github.com/grupomistico/ritwal-whatsapp-campaign-service.git";
const host = "masivos-wpp.grupomistico.cloud";
const baseUrl =
  process.env.DOKPLOY_BASE_URL || "https://grupomistico.cloud/api";
const apiKey = process.env.DOKPLOY_API_KEY;

if (!apiKey) throw new Error("DOKPLOY_API_KEY is required");

const projects = await api("project.all");
let project = projects.find((item) => item.name === projectName);
let environment;

if (!project) {
  const created = await api("project.create", {
    method: "POST",
    body: {
      name: projectName,
      description: "Servicios de mensajeria segura de Grupo Mistico",
      env: "",
    },
  });
  project = created.project;
  environment = created.environment;
} else {
  environment = project.environments?.find(
    (item) => item.name === "production" || item.isDefault,
  );
}

if (!environment) {
  const environments = await api("environment.byProjectId", {
    query: { projectId: project.projectId },
  });
  environment = environments.find(
    (item) => item.name === "production" || item.isDefault,
  );
}
if (!environment) throw new Error("Dokploy production environment not found");

let application = environment.applications?.find(
  (item) => item.name === applicationName,
);
if (!application) {
  application = await api("application.create", {
    method: "POST",
    body: {
      name: applicationName,
      appName,
      description: "Campanas WhatsApp Cloud API con control de acceso y trazabilidad",
      environmentId: environment.environmentId,
    },
  });
}

await api("application.saveGitProvider", {
  method: "POST",
  body: {
    applicationId: application.applicationId,
    customGitBuildPath: "/",
    customGitUrl: repositoryUrl,
    customGitBranch: "main",
    watchPaths: [],
    enableSubmodules: false,
  },
});

await api("application.saveEnvironment", {
  method: "POST",
  sensitive: true,
  body: {
    applicationId: application.applicationId,
    env: runtimeEnvironment(),
    buildArgs: "",
    buildSecrets: "",
    createEnvFile: false,
  },
});

const detail = await api("application.one", {
  query: { applicationId: application.applicationId },
});
if (!(detail.mounts || []).some((mount) => mount.mountPath === "/app/data")) {
  await api("mounts.create", {
    method: "POST",
    body: {
      type: "volume",
      volumeName: "ritwal-whatsapp-campaign-data",
      mountPath: "/app/data",
      serviceType: "application",
      serviceId: application.applicationId,
    },
  });
}
if (!(detail.domains || []).some((domain) => domain.host === host)) {
  await api("domain.create", {
    method: "POST",
    body: {
      host,
      path: "/",
      port: 3000,
      https: true,
      applicationId: application.applicationId,
      certificateType: "letsencrypt",
      domainType: "application",
      internalPath: "/",
      stripPath: false,
      middlewares: [],
      forwardAuthEnabled: false,
    },
  });
}

updateLocalEnv("DOKPLOY_APPLICATION_ID", application.applicationId);
console.log(
  JSON.stringify(
    {
      ok: true,
      projectId: project.projectId,
      environmentId: environment.environmentId,
      applicationId: application.applicationId,
      host,
    },
    null,
    2,
  ),
);

function runtimeEnvironment() {
  const required = [
    "TOOL_SECRET",
    "PII_ENCRYPTION_KEY",
    "AUTHORIZED_ACTORS",
    "META_ACCESS_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_BUSINESS_ACCOUNT_ID",
    "WHATSAPP_VERIFY_TOKEN",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing runtime configuration: ${missing.join(", ")}`);
  }

  const values = {
    PORT: "3000",
    HOST: "0.0.0.0",
    PUBLIC_MIDDLEWARE_URL: `https://${host}`,
    TOOL_SECRET: process.env.TOOL_SECRET,
    DATA_DIR: "/app/data",
    PII_ENCRYPTION_KEY: process.env.PII_ENCRYPTION_KEY,
    AUTHORIZED_ACTORS: process.env.AUTHORIZED_ACTORS,
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_BUSINESS_ACCOUNT_ID: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
    GRAPH_API_VERSION: process.env.GRAPH_API_VERSION || "v25.0",
    META_APP_ID: process.env.META_APP_ID || "",
    META_APP_SECRET: process.env.META_APP_SECRET || "",
    WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
    DEFAULT_COUNTRY_CODE: process.env.DEFAULT_COUNTRY_CODE || "57",
    DEFAULT_FATIGUE_HOURS: process.env.DEFAULT_FATIGUE_HOURS || "48",
    DEFAULT_SEND_DELAY_MS: process.env.DEFAULT_SEND_DELAY_MS || "1200",
    MAX_CAMPAIGN_SIZE: process.env.MAX_CAMPAIGN_SIZE || "10000",
  };
  return Object.entries(values)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("\n");
}

async function api(path, options = {}) {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${path}`);
  for (const [key, value] of Object.entries(options.query || {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      accept: "application/json",
      "x-api-key": apiKey,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = options.sensitive ? "" : `: ${text.slice(0, 300)}`;
    throw new Error(`Dokploy ${path} failed ${response.status}${detail}`);
  }
  return text ? JSON.parse(text) : null;
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
