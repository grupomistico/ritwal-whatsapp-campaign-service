import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/server.js";

const apps = [];

function config() {
  return {
    port: 3000,
    host: "127.0.0.1",
    publicUrl: "http://127.0.0.1:3000",
    toolSecret: "tool-secret",
    dataDir: ".",
    piiEncryptionKey: "pii-secret",
    security: {
      authorizedActors: new Map([
        ["1135608648", "Valentin"],
        ["8474026326", "Laura"],
      ]),
    },
    meta: {
      accessToken: "meta-token",
      phoneNumberId: "phone-id",
      businessAccountId: "waba-id",
      graphApiVersion: "v25.0",
      appSecret: "app-secret",
      webhookVerifyToken: "verify-token",
    },
    campaign: {
      defaultCountryCode: "57",
      fatigueHours: 48,
      sendDelayMs: 0,
      maxSize: 10000,
    },
  };
}

afterEach(async () => {
  while (apps.length) await apps.pop().close();
});

describe("HTTP security", () => {
  it("requires the tool secret for reads", async () => {
    const app = buildApp({
      config: config(),
      service: { templates: vi.fn() },
      store: {},
      logger: false,
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/tools/templates",
    });
    expect(response.statusCode).toBe(401);
  });

  it("allows only configured actors to mutate campaigns", async () => {
    const service = { approveCampaign: vi.fn() };
    const app = buildApp({ config: config(), service, store: {}, logger: false });
    apps.push(app);

    const forbidden = await app.inject({
      method: "POST",
      url: "/tools/campaigns/GM-TEST/approve",
      headers: {
        "x-tool-secret": "tool-secret",
        "x-actor-id": "999",
      },
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);

    service.approveCampaign.mockReturnValue({
      id: "GM-TEST",
      status: "approved",
    });
    const allowed = await app.inject({
      method: "POST",
      url: "/tools/campaigns/GM-TEST/approve",
      headers: {
        "x-tool-secret": "tool-secret",
        "x-actor-id": "8474026326",
      },
      payload: {},
    });
    expect(allowed.statusCode).toBe(200);
    expect(service.approveCampaign).toHaveBeenCalledWith(
      "GM-TEST",
      "Laura (telegram:8474026326)",
    );
  });

  it("verifies webhook signatures against the unparsed body", async () => {
    const service = {
      processWebhook: vi.fn(() => ({
        statuses: 0,
        suppressions: 0,
        optOuts: 0,
      })),
    };
    const app = buildApp({ config: config(), service, store: {}, logger: false });
    apps.push(app);
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    const signature = `sha256=${createHmac("sha256", "app-secret")
      .update(body)
      .digest("hex")}`;

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(service.processWebhook).toHaveBeenCalledWith({
      object: "whatsapp_business_account",
    });
  });
});
