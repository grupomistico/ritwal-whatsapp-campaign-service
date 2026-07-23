export class MetaClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async getAccount() {
    return this.get(
      `${this.config.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,name_status,platform_type,throughput`,
    );
  }

  async listTemplates() {
    const templates = [];
    let url = this.url(
      `${this.config.businessAccountId}/message_templates?limit=100&fields=name,status,category,language,components`,
    );
    while (url) {
      const payload = await this.requestUrl(url);
      templates.push(...(payload.data || []));
      url = payload.paging?.next || null;
    }
    return templates;
  }

  async sendTemplate(message) {
    return this.post(`${this.config.phoneNumberId}/messages`, message);
  }

  async uploadMedia({ fileName, mimeType, bytes }) {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([bytes], { type: mimeType }), fileName);
    return this.requestUrl(this.url(`${this.config.phoneNumberId}/media`), {
      method: "POST",
      body: form,
    });
  }

  async get(path) {
    return this.requestUrl(this.url(path));
  }

  async post(path, body) {
    return this.requestUrl(this.url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  url(path) {
    return `https://graph.facebook.com/${this.config.graphApiVersion}/${path}`;
  }

  async requestUrl(url, options = {}) {
    const response = await this.fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new MetaApiError(
        payload.error?.message || `Meta API HTTP ${response.status}`,
        {
          httpStatus: response.status,
          code: payload.error?.code,
          subcode: payload.error?.error_subcode,
          type: payload.error?.type,
        },
      );
      throw error;
    }
    return payload;
  }
}

export class MetaApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MetaApiError";
    this.details = details;
  }
}

export function isCriticalMetaError(error) {
  const code = error?.details?.code;
  const status = error?.details?.httpStatus;
  return status === 401 || [10, 100, 190, 368, 130429, 131042, 131056].includes(code);
}

