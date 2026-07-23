export function inspectTemplate(template) {
  const components = Array.isArray(template?.components) ? template.components : [];
  const header = components.find((component) => component.type === "HEADER");
  const body = components.find((component) => component.type === "BODY");
  const buttons = components.find((component) => component.type === "BUTTONS");
  const bodyText = body?.text || "";
  const bodyParams = [...bodyText.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map(
    (match) => match[1],
  );
  const dynamicButtons = (buttons?.buttons || [])
    .map((button, index) => ({
      index,
      type: button.type,
      dynamic: Boolean(button.url?.includes("{{")),
    }))
    .filter((button) => button.dynamic);

  return {
    name: template.name,
    status: template.status,
    category: template.category,
    language: template.language,
    headerFormat: header?.format || null,
    bodyParams,
    dynamicButtons,
  };
}

export function buildTemplateMessage({
  phone,
  template,
  templateInfo,
  language,
  mediaId,
  parameters = {},
}) {
  if (templateInfo.headerFormat === "IMAGE" && !mediaId) {
    throw new Error(`Template ${template} requires an image media id`);
  }
  if (templateInfo.dynamicButtons.length > 0) {
    throw new Error("Dynamic template buttons are not supported yet");
  }

  const components = [];
  if (templateInfo.headerFormat === "IMAGE") {
    components.push({
      type: "header",
      parameters: [{ type: "image", image: { id: mediaId } }],
    });
  }

  if (templateInfo.bodyParams.length > 0) {
    components.push({
      type: "body",
      parameters: templateInfo.bodyParams.map((parameterName) => {
        const text = String(parameters[parameterName] ?? "");
        if (!text) {
          throw new Error(`Missing template parameter: ${parameterName}`);
        }
        const parameter = { type: "text", text };
        if (!/^\d+$/.test(parameterName)) {
          parameter.parameter_name = parameterName;
        }
        return parameter;
      }),
    });
  }

  return {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: template,
      language: { code: language },
      ...(components.length > 0 ? { components } : {}),
    },
  };
}

