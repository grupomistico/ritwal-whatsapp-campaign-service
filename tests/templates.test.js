import { describe, expect, it } from "vitest";
import {
  buildTemplateMessage,
  inspectTemplate,
} from "../src/templates.js";

const template = {
  name: "soncubanojueves",
  status: "APPROVED",
  category: "MARKETING",
  language: "es_CO",
  components: [
    { type: "HEADER", format: "IMAGE" },
    { type: "BODY", text: "Hola {{nombre}}, te esperamos." },
    {
      type: "BUTTONS",
      buttons: [{ type: "URL", url: "https://example.com/reservar" }],
    },
  ],
};

describe("template inspection", () => {
  it("detects media and named body parameters", () => {
    expect(inspectTemplate(template)).toMatchObject({
      headerFormat: "IMAGE",
      bodyParams: ["nombre"],
      dynamicButtons: [],
    });
  });

  it("builds the proven Ritwal payload shape", () => {
    const info = inspectTemplate(template);
    expect(
      buildTemplateMessage({
        phone: "573001234567",
        template: template.name,
        templateInfo: info,
        language: "es_CO",
        mediaId: "media-123",
        parameters: { nombre: "Valentina" },
      }),
    ).toEqual({
      messaging_product: "whatsapp",
      to: "573001234567",
      type: "template",
      template: {
        name: "soncubanojueves",
        language: { code: "es_CO" },
        components: [
          {
            type: "header",
            parameters: [{ type: "image", image: { id: "media-123" } }],
          },
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: "Valentina",
                parameter_name: "nombre",
              },
            ],
          },
        ],
      },
    });
  });
});

