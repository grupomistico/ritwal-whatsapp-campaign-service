import "dotenv/config";
import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig, assertRuntimeConfig } from "./config.js";
import { PiiVault, verifyMetaSignature } from "./crypto.js";
import { MetaClient, MetaApiError } from "./meta.js";
import { CampaignService } from "./service.js";
import { CampaignStore } from "./store.js";

const contactSchema = z
  .object({
    phone: z.union([z.string(), z.number()]).optional(),
    telefono: z.union([z.string(), z.number()]).optional(),
    whatsapp: z.union([z.string(), z.number()]).optional(),
    first_name: z.string().optional(),
    firstName: z.string().optional(),
    name: z.string().optional(),
    nombre: z.string().optional(),
    country_code: z.union([z.string(), z.number()]).optional(),
    countryCode: z.union([z.string(), z.number()]).optional(),
    parameters: z.record(z.string(), z.any()).optional(),
  })
  .passthrough();

const createCampaignSchema = z.object({
  name: z.string().min(3).max(120),
  brand: z.string().min(2).max(50).default("ritwal"),
  template: z.string().min(1),
  language: z.string().default("es_CO"),
  mediaId: z.string().optional(),
  source: z.string().max(200).optional(),
  fatigueHours: z.number().int().min(0).max(720).optional(),
  countryCode: z.string().optional(),
  audience: z.array(contactSchema).min(1),
});

export function buildApp(options = {}) {
  const config = options.config || loadConfig();
  assertRuntimeConfig(config);
  const app = Fastify({
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL || "info",
      redact: [
        "req.headers.authorization",
        "req.headers.x-tool-secret",
        "req.body.audience",
        "req.body.contacts",
        "req.body.base64",
      ],
    },
    bodyLimit: 15 * 1024 * 1024,
  });
  const vault = options.vault || new PiiVault(config.piiEncryptionKey);
  const store =
    options.store || new CampaignStore({ dataDir: config.dataDir, vault });
  const meta = options.meta || new MetaClient(config.meta);
  const service =
    options.service ||
    new CampaignService({ config, meta, store, vault, logger: app.log });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      if (
        request.url.startsWith("/webhooks/whatsapp") &&
        request.method === "POST"
      ) {
        request.rawBody = body;
      }
      try {
        done(null, JSON.parse(body.toString("utf8")));
      } catch (error) {
        error.statusCode = 400;
        done(error);
      }
    },
  );

  app.decorateRequest("actor", null);

  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/tools")) return;
    const headerSecret = request.headers["x-tool-secret"];
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (headerSecret !== config.toolSecret && bearer !== config.toolSecret) {
      const error = new Error("No autorizado");
      error.statusCode = 401;
      throw error;
    }
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;

    const actorId = String(request.headers["x-actor-id"] || "").trim();
    const actorName = config.security.authorizedActors.get(actorId);
    if (!actorName) {
      const error = new Error("Usuario no autorizado para modificar campanas");
      error.statusCode = 403;
      throw error;
    }
    request.actor = {
      id: actorId,
      name: actorName,
      auditLabel: `${actorName} (telegram:${actorId})`,
    };
  });

  app.get("/", async () => ({
    ok: true,
    service: "grupo-mistico-masivos-wpp",
    docs: {
      health: "/health",
      schema: "/tools/schema",
      webhook: "/webhooks/whatsapp",
    },
  }));

  app.get("/health", async () => ({
    ok: true,
    service: "grupo-mistico-masivos-wpp",
    webhookReady: Boolean(
      config.meta.appSecret && config.meta.webhookVerifyToken,
    ),
  }));

  app.get("/webhooks/whatsapp", async (request, reply) => {
    if (!config.meta.webhookVerifyToken) {
      return reply.status(503).send({
        ok: false,
        code: "WHATSAPP_WEBHOOK_NOT_CONFIGURED",
      });
    }
    const query = request.query || {};
    if (
      query["hub.mode"] === "subscribe" &&
      query["hub.verify_token"] === config.meta.webhookVerifyToken
    ) {
      return reply.type("text/plain").send(String(query["hub.challenge"] || ""));
    }
    return reply.status(403).send({ ok: false });
  });

  app.post("/webhooks/whatsapp", async (request, reply) => {
    if (!config.meta.appSecret) {
      return reply.status(503).send({
        ok: false,
        code: "META_APP_SECRET_NOT_CONFIGURED",
      });
    }
    const valid = verifyMetaSignature(
      request.rawBody,
      request.headers["x-hub-signature-256"],
      config.meta.appSecret,
    );
    if (!valid) return reply.status(401).send({ ok: false });
    const result = service.processWebhook(request.body);
    return { ok: true, ...result };
  });

  app.get("/tools/schema", async () => ({
    ok: true,
    tools: [
      "account",
      "templates",
      "campaign_create",
      "campaign_test",
      "campaign_approve",
      "campaign_send",
      "campaign_resume",
      "campaign_status",
      "media_upload",
      "suppression_add",
    ],
    mutationHeaders: ["x-tool-secret", "x-actor-id"],
  }));

  app.get("/tools/account", async () => ({ ok: true, data: await service.account() }));
  app.get("/tools/templates", async () => ({
    ok: true,
    data: await service.templates(),
  }));

  app.post("/tools/campaigns", async (request) => {
    const input = createCampaignSchema.parse(request.body);
    const campaign = await service.createCampaign({
      ...input,
      requestedBy: request.actor.auditLabel,
    });
    return { ok: true, data: publicCampaign(campaign) };
  });

  app.post("/tools/campaigns/:id/test", async (request) => {
    const body = z
      .object({ contacts: z.array(contactSchema).min(1).max(5) })
      .parse(request.body);
    return {
      ok: true,
      data: await service.testCampaign(request.params.id, body.contacts),
    };
  });

  app.post("/tools/campaigns/:id/approve", async (request) => {
    return {
      ok: true,
      data: publicCampaign(
        service.approveCampaign(request.params.id, request.actor.auditLabel),
      ),
    };
  });

  app.post("/tools/campaigns/:id/send", async (request, reply) => {
    const body = z
      .object({
        confirmation: z.string(),
        idempotencyKey: z.string().min(8),
      })
      .parse(request.body);
    const result = service.startCampaign(request.params.id, body);
    return reply.status(202).send({ ok: true, data: result });
  });

  app.post("/tools/campaigns/:id/resume", async (request, reply) => {
    return reply
      .status(202)
      .send({ ok: true, data: service.resumeCampaign(request.params.id) });
  });

  app.get("/tools/campaigns/:id", async (request) => ({
    ok: true,
    data: service.status(request.params.id),
  }));

  app.post("/tools/media", async (request) => {
    const body = z
      .object({
        fileName: z.string().min(1),
        mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
        base64: z.string().min(1),
      })
      .parse(request.body);
    const payload = await meta.uploadMedia({
      fileName: body.fileName,
      mimeType: body.mimeType,
      bytes: Buffer.from(body.base64, "base64"),
    });
    return { ok: true, data: { mediaId: payload.id } };
  });

  app.post("/tools/suppressions", async (request) => {
    const body = z
      .object({
        phone: z.union([z.string(), z.number()]),
        reason: z.string().min(2),
        source: z.string().default("manual"),
      })
      .parse(request.body);
    return {
      ok: true,
      data: service.suppressPhone(body.phone, body.reason, body.source),
    };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        ok: false,
        code: "VALIDATION_ERROR",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    if (error instanceof MetaApiError) {
      return reply.status(502).send({
        ok: false,
        code: "META_API_ERROR",
        details: error.details,
        message: error.message,
      });
    }
    const statusCode = error.statusCode || 400;
    return reply.status(statusCode).send({
      ok: false,
      code:
        statusCode === 401
          ? "UNAUTHORIZED"
          : statusCode === 403
            ? "FORBIDDEN"
            : "REQUEST_FAILED",
      message: error.message,
    });
  });

  app.addHook("onClose", async () => {
    if (!options.store) store.close();
  });

  return app;
}

function publicCampaign(campaign) {
  return {
    id: campaign.id,
    name: campaign.name,
    brand: campaign.brand,
    template: campaign.template,
    language: campaign.language,
    status: campaign.status,
    source: campaign.source,
    requestedBy: campaign.requestedBy,
    approvedBy: campaign.approvedBy,
    templateInfo: campaign.templateInfo,
    audienceSummary: campaign.audienceSummary,
    createdAt: campaign.createdAt,
    testedAt: campaign.testedAt,
    approvedAt: campaign.approvedAt,
  };
}

const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const config = loadConfig();
  const app = buildApp({ config });
  await app.listen({ port: config.port, host: config.host });
}
