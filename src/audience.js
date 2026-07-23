const JUNK_NAMES = new Set([
  "cliente",
  "contacto",
  "hola",
  "prueba",
  "test",
  "sin nombre",
  "na",
  "n a",
]);

export function normalizePhone(rawValue, countryCode = "57") {
  let digits = String(rawValue || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!digits) return null;

  if (digits.length === 10 && digits.startsWith("3") && countryCode === "57") {
    digits = `57${digits}`;
  } else if (
    countryCode &&
    !digits.startsWith(countryCode) &&
    digits.length >= 8 &&
    digits.length <= 12
  ) {
    digits = `${countryCode}${digits}`;
  }

  if (digits.length < 10 || digits.length > 15) return null;
  if (digits.startsWith("57") && !/^573\d{9}$/.test(digits)) return null;
  if (/^(\d)\1+$/.test(digits)) return null;
  return digits;
}

export function normalizeFirstName(rawValue) {
  const cleaned = String(rawValue || "")
    .normalize("NFKC")
    .replace(/[0-9]/g, "")
    .replace(/[^\p{L}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;

  const withoutTitle = cleaned.replace(
    /^(sr|sra|senor|senora|señor|señora|dr|dra|doctor|doctora)\s+/iu,
    "",
  );
  const first = withoutTitle.split(/\s+/)[0]?.replace(/^[-']+|[-']+$/g, "");
  if (!first || first.length < 3 || JUNK_NAMES.has(first.toLocaleLowerCase("es-CO"))) {
    return null;
  }
  return first
    .toLocaleLowerCase("es-CO")
    .replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase("es-CO"));
}

function parameterValue(contact, parameterName) {
  if (parameterName === "nombre") {
    return normalizeFirstName(
      contact.first_name ?? contact.firstName ?? contact.name ?? contact.nombre,
    );
  }
  if (/^\d+$/.test(parameterName)) {
    const positional = contact.parameters?.[parameterName];
    return positional ?? contact[`param_${parameterName}`] ?? contact[parameterName];
  }
  return contact.parameters?.[parameterName] ?? contact[parameterName];
}

export function prepareAudience({
  contacts,
  templateInfo,
  countryCode = "57",
  vault,
  store,
  fatigueHours = 48,
  now = new Date(),
}) {
  const ready = [];
  const rejected = [];
  const seen = new Set();
  const cutoff = new Date(now.getTime() - fatigueHours * 60 * 60 * 1000);

  for (const [index, contact] of contacts.entries()) {
    const phone = normalizePhone(
      contact.phone ?? contact.telefono ?? contact.whatsapp,
      String(contact.country_code ?? contact.countryCode ?? countryCode),
    );
    if (!phone) {
      rejected.push({ row: index + 2, reason: "invalid_phone" });
      continue;
    }

    const phoneHash = vault.hashPhone(phone);
    if (seen.has(phoneHash)) {
      rejected.push({ row: index + 2, reason: "duplicate_phone" });
      continue;
    }
    seen.add(phoneHash);

    const suppression = store?.getSuppression(phoneHash);
    if (suppression) {
      rejected.push({ row: index + 2, reason: "suppressed" });
      continue;
    }

    const lastContactAt = store?.getLastContactAt(phoneHash);
    if (lastContactAt && new Date(lastContactAt) > cutoff) {
      rejected.push({ row: index + 2, reason: "fatigue_window" });
      continue;
    }

    const parameters = {};
    let missingParameter = null;
    for (const parameterName of templateInfo.bodyParams) {
      const value = parameterValue(contact, parameterName);
      if (value === undefined || value === null || String(value).trim() === "") {
        missingParameter = parameterName;
        break;
      }
      parameters[parameterName] = String(value).trim();
    }
    if (missingParameter) {
      rejected.push({
        row: index + 2,
        reason: "missing_template_parameter",
        parameter: missingParameter,
      });
      continue;
    }

    ready.push({ phone, phoneHash, parameters });
  }

  const reasons = {};
  for (const item of rejected) {
    reasons[item.reason] = (reasons[item.reason] || 0) + 1;
  }

  return {
    ready,
    rejected,
    summary: {
      input: contacts.length,
      ready: ready.length,
      rejected: rejected.length,
      reasons,
      fatigueHours,
      rejectionSample: rejected.slice(0, 50),
    },
  };
}
