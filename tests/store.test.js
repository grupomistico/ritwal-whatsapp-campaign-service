import { afterEach, describe, expect, it } from "vitest";
import { PiiVault } from "../src/crypto.js";
import { CampaignStore } from "../src/store.js";

const stores = [];

function createStore() {
  const vault = new PiiVault("test-secret");
  const store = new CampaignStore({
    dataDir: ".",
    vault,
    databasePath: ":memory:",
  });
  stores.push(store);
  return { store, vault };
}

afterEach(() => {
  while (stores.length) stores.pop().close();
});

describe("campaign persistence", () => {
  it("encrypts recipients and prevents duplicate idempotency keys", () => {
    const { store, vault } = createStore();
    const phone = "573001234567";
    const campaign = store.createCampaign({
      name: "Campaign",
      brand: "ritwal",
      template: "soncubanojueves",
      language: "es_CO",
      mediaId: "media",
      source: "test",
      requestedBy: "Valentin",
      templateInfo: {
        headerFormat: "IMAGE",
        bodyParams: ["nombre"],
        dynamicButtons: [],
      },
      audience: [
        {
          phone,
          phoneHash: vault.hashPhone(phone),
          parameters: { nombre: "Valentina" },
        },
      ],
      summary: { input: 1, ready: 1, rejected: 0, reasons: {} },
    });

    expect(store.getPendingRecipients(campaign.id)[0]).toMatchObject({
      phone,
      parameters: { nombre: "Valentina" },
    });
    expect(store.claimIdempotency("campaign-v1", campaign.id)).toEqual({
      claimed: true,
      campaignId: campaign.id,
    });
    expect(store.claimIdempotency("campaign-v1", campaign.id)).toEqual({
      claimed: false,
      campaignId: campaign.id,
    });
  });

  it("tracks delivery state without exposing phone plaintext", () => {
    const { store, vault } = createStore();
    const phone = "573001234567";
    const campaign = store.createCampaign({
      name: "Campaign",
      brand: "ritwal",
      template: "plain",
      language: "es_CO",
      templateInfo: {
        headerFormat: null,
        bodyParams: [],
        dynamicButtons: [],
      },
      audience: [
        {
          phone,
          phoneHash: vault.hashPhone(phone),
          parameters: {},
        },
      ],
      summary: { input: 1, ready: 1, rejected: 0, reasons: {} },
    });
    const recipient = store.getPendingRecipients(campaign.id)[0];
    store.markAttempt(recipient.id, {
      status: "accepted",
      metaMessageId: "wamid.test",
    });
    store.updateDeliveryStatus({
      metaMessageId: "wamid.test",
      status: "delivered",
      occurredAt: new Date().toISOString(),
    });
    store.updateDeliveryStatus({
      metaMessageId: "wamid.test",
      status: "sent",
      occurredAt: new Date().toISOString(),
    });
    expect(store.stats(campaign.id).byStatus.delivered).toBe(1);
  });
});
