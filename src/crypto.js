import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export class PiiVault {
  constructor(secret) {
    if (!secret) throw new Error("PII_ENCRYPTION_KEY is required");
    this.key = createHash("sha256").update(secret).digest();
  }

  hashPhone(phone) {
    return createHmac("sha256", this.key).update(String(phone)).digest("hex");
  }

  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
  }

  decrypt(value) {
    const [version, ivText, tagText, encryptedText] = String(value).split(".");
    if (version !== "v1" || !ivText || !tagText || !encryptedText) {
      throw new Error("Unsupported encrypted payload");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(ivText, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString("utf8"));
  }
}

export function verifyMetaSignature(rawBody, signature, appSecret) {
  if (!appSecret || !signature?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");
  const received = signature.slice("sha256=".length);
  if (expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export function maskPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits ? `***${digits.slice(-4)}` : "***";
}

