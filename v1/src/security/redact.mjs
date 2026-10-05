// Redaction for views, logs and diagnostics (02-DATA.md, 03-SERVICES-RPC.md).
// Views must drop secrets entirely; logs and diagnostics mask secret values.

export const REDACTED = '[redacted]';

const SECRET_KEY_RE = /(secret|token|password|passwd|apikey|api_key|authorization|cookie|codehash|tokenhash|nonce)/i;

export function isSecretKey(key) {
  return typeof key === 'string' && SECRET_KEY_RE.test(key);
}

/** Deep-clone a value, replacing secret-named keys with REDACTED. */
export function redactObject(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactObject);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : redactObject(child);
  }
  return out;
}

/** Remove `secrets` (and any caller-listed fields) from a record for a View. */
export function toRedactedView(record, extraDrop = []) {
  const drop = new Set(['secrets', ...extraDrop]);
  const out = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (drop.has(key)) continue;
    out[key] = isSecretKey(key) ? REDACTED : redactObject(value);
  }
  return out;
}

/**
 * Mask occurrences of known secret literals inside free text.
 * Empty/very short values are skipped to avoid over-masking.
 */
export function redactText(text, secretValues = []) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const secret of secretValues) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    out = out.split(secret).join(REDACTED);
  }
  // Common inline credential shapes.
  out = out.replace(/\b(Bearer|Bot|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`);
  return out;
}

/** Collect plaintext secret values from a resolved secrets map. */
export function collectSecretValues(resolved = {}) {
  return Object.values(resolved).filter((v) => typeof v === 'string');
}