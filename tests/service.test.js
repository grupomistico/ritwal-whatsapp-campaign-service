import { afterEach, describe, expect, it, vi } from "vitest";
import { PiiVault } from "../src/crypto.js";
import { CampaignService } from "../src/service.js";
import { CampaignStore } from "../src/store.js";

const stores = [];

function setup() {
  const vault = new PiiVault("test-secret");
  const store = new CampaignStore({
    dataDir: ".",
    vault,
    databasePath: ":memory:",
  });
  stores.push(store);
  const meta = {
    listTemplates: vi.fn(async () => [
      {
        name: "soncubanojueves",
        status: "APPROVED",
        category: "MARKETING",
        language: "es_CO",
        components: [
          { type: "HEADER", format: "IMAGE" },
          { type: "BODY", text: "Hola {{nombre}}" },
        ],
      },
    ]),
    sendTemplate: vi.fn(async () => ({
      messages: [{ id: `wamid.${Date.now()}`, message_status: "accepted" }],
    })),
  };
  const service = new CampaignService({
    config: {
      meta: {},
      campaign: {
        defaultCountryCode: "57",
        fatigueHours: 48,
        sendDelayMs: 0,
        maxSize: 10000,
      },
    },
    meta,
    store,
    vault,
  });
  return { meta, service, store };
}

afterEach(() => {
  while (stores.length) stores.pop().close();
});

describe("campaign safety workflow", () => {
  it("requires test, approval and exact confirmation before submission", async () => {
    const { meta, service } = setup();
    const campaign = await service.createCampaign({
      name: "Son cubano",
      brand: "ritwal",
      template: "soncubanojueves",
      language: "es_CO",
      mediaId: "media-id",
      audience: [{ phone: "3001234567", name: "Valentina" }],
    });

    expect(() => service.approveCampaign(campaign.id, "Laura")).toThrow(
      "must pass a real test",
    );
    await service.testCampaign(campaign.id, [
      { phone: "3011234567", name: "Laura" },
    ]);
    service.approveCampaign(campaign.id, "Laura");
    expect(() =>
      service.startCampaign(campaign.id, {
        confirmation: "otro-id",
        idempotencyKey: `${campaign.id}-send-v1`,
      }),
    ).toThrow("exactly match");

    expect(
      service.startCampaign(campaign.id, {
        confirmation: campaign.id,
        idempotencyKey: `${campaign.id}-send-v1`,
      }),
    ).toMatchObject({ status: "queued", duplicateRequest: false });

    await waitFor(() => service.status(campaign.id).campaign.status === "submission_complete");
    expect(service.status(campaign.id).recipients.byStatus.accepted).toBe(1);
    expect(meta.sendTemplate).toHaveBeenCalledTimes(2);

    expect(
      service.startCampaign(campaign.id, {
        confirmation: campaign.id,
        idempotencyKey: `${campaign.id}-send-v1`,
      }),
    ).toMatchObject({
      status: "submission_complete",
      duplicateRequest: true,
    });
    expect(meta.sendTemplate).toHaveBeenCalledTimes(2);
  });
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for campaign");
}
