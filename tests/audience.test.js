import { describe, expect, it } from "vitest";
import {
  normalizeFirstName,
  normalizePhone,
  prepareAudience,
} from "../src/audience.js";
import { PiiVault } from "../src/crypto.js";

const vault = new PiiVault("test-secret");
const templateInfo = {
  bodyParams: ["nombre"],
  headerFormat: "IMAGE",
  dynamicButtons: [],
};

describe("phone normalization", () => {
  it.each([
    ["3001234567", "57", "573001234567"],
    ["+57 300 123 4567", "57", "573001234567"],
    ["0057 300 123 4567", "57", "573001234567"],
    ["573001234567", "57", "573001234567"],
  ])("normalizes %s", (input, countryCode, expected) => {
    expect(normalizePhone(input, countryCode)).toBe(expected);
  });

  it.each(["123", "571234567890", "0000000000"])(
    "rejects %s",
    (input) => {
      expect(normalizePhone(input, "57")).toBeNull();
    },
  );
});

describe("name normalization", () => {
  it("keeps a usable first name", () => {
    expect(normalizeFirstName("  Dra. valentina florez ")).toBe("Valentina");
  });

  it.each(["A", "Cliente", "prueba 123"])("rejects %s", (input) => {
    expect(normalizeFirstName(input)).toBeNull();
  });
});

describe("audience preparation", () => {
  it("deduplicates and validates required named parameters", () => {
    const result = prepareAudience({
      contacts: [
        { phone: "3001234567", name: "Valentina Florez" },
        { phone: "573001234567", name: "Otra Persona" },
        { phone: "3011234567", name: "Cliente" },
      ],
      templateInfo,
      vault,
      fatigueHours: 48,
    });
    expect(result.summary.ready).toBe(1);
    expect(result.summary.reasons).toEqual({
      duplicate_phone: 1,
      missing_template_parameter: 1,
    });
    expect(result.ready[0].parameters.nombre).toBe("Valentina");
  });
});

