import { describe, expect, it, vi } from "vitest";
import { CampaignService } from "../src/service.js";
import { PiiVault } from "../src/crypto.js";

describe("webhook hygiene", () => {
  it("suppresses permanent delivery failures and explicit opt-outs", () => {
    const vault = new PiiVault("test-secret");
    const store = {
      updateDeliveryStatus: vi.fn(),
      addSuppression: vi.fn(),
    };
    const service = new CampaignService({
      config: {
        campaign: { defaultCountryCode: "57" },
      },
      meta: {},
      store,
      vault,
    });
    const result = service.processWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  {
                    id: "wamid.test",
                    recipient_id: "573001234567",
                    status: "failed",
                    errors: [{ code: 131050, title: "Opted out" }],
                  },
                ],
                messages: [
                  {
                    from: "573011234567",
                    text: { body: "No me escriban" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(result).toEqual({ statuses: 1, suppressions: 1, optOuts: 1 });
    expect(store.addSuppression).toHaveBeenCalledTimes(2);
  });
});

