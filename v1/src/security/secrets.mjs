// Secret envelopes and secretChanges (02-DATA.md "字段、秘密与DTO").
// A secret is either a literal string or an env reference; env values are resolved
// on demand and never written back into the store.
import { DomainError, validationError } from '../domain/errors.mjs';

export const DIRECTION_PATHS = Object.freeze(['outbound', 'inbound', 'target']);
const PATH_RE = /^(outbound|inbound|target)\.[A-Za-z0-9_]{1,64}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;

const MASK_RE = /^[*•·xX]+$/;

export function isValidSecretPath(path) {
  return typeof path === 'string' && PATH_RE.test(path);
}

/** A masked value (all stars/bullets) must never be submitted as a secret. */
export function isMaskedValue(value) {
  return typeof value === 'string' && value.length > 0 && MASK_RE.test(value);
}

/**
 * Normalize one secret envelope, rejecting masked literals.
 * @throws {DomainError} VALIDATION
 */
export function normalizeSecretValue(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw validationError('secret value must be an object');
  }
  if (input.kind === 'literal') {
    if (typeof input.value !== 'string') throw validationError('literal secret requires a string value');
    if (isMaskedValue(input.value)) throw validationError('a masked value cannot be stored as a secret');
    return { kind: 'literal', value: input.value };
  }
  if (input.kind === 'env') {
    if (typeof input.name !== 'string' || !ENV_RE.test(input.name)) {
      throw validationError('env secret requires a NAME matching ^[A-Z_][A-Z0-9_]*$');
    }
    return { kind: 'env', name: input.name };
  }
  throw validationError('secret kind must be literal or env');
}

/**
 * Apply secretChanges to a secrets map. Absent paths are kept, `clear` removes,
 * `set` writes. On create only `set` is allowed.
 * @param {object} base existing secrets map
 * @param {Array<{path:string,op:'set'|'clear',value?:object}>} changes
 * @param {{creating?:boolean}} [opts]
 */
export function applySecretChanges(base, changes, { creating = false } = {}) {
  const errors = [];
  if (!Array.isArray(changes)) throw validationError('secretChanges must be an array');
  const next = {};
  for (const [path, value] of Object.entries(base ?? {})) next[path] = { ...value };

  const seen = new Set();
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const at = `secretChanges[${i}]`;
    if (change === null || typeof change !== 'object') {
      errors.push(`${at}: expected object`);
      continue;
    }
    if (!isValidSecretPath(change.path)) {
      errors.push(`${at}.path: invalid secret path`);
      continue;
    }
    if (seen.has(change.path)) {
      errors.push(`${at}.path: duplicate change for ${change.path}`);
      continue;
    }
    seen.add(change.path);
    if (change.op === 'set') {
      try {
        next[change.path] = normalizeSecretValue(change.value);
      } catch (err) {
        errors.push(`${at}.value: ${err.message}`);
      }
    } else if (change.op === 'clear') {
      if (creating) {
        errors.push(`${at}.op: clear is not allowed on create`);
        continue;
      }
      delete next[change.path];
    } else {
      errors.push(`${at}.op: expected set|clear`);
    }
  }
  if (errors.length) throw validationError('invalid secretChanges', errors);
  return next;
}

/**
 * Resolve a secret envelope to its plaintext value.
 * Literal values are returned from state; env values are read from the environment
 * and are never persisted.
 * @returns {{ok:true,value:string}|{ok:false,reason:'MISSING'|'INVALID'}}
 */
export function resolveSecret(secret, env = process.env) {
  if (secret === null || typeof secret !== 'object') return { ok: false, reason: 'INVALID' };
  if (secret.kind === 'literal') {
    return typeof secret.value === 'string' ? { ok: true, value: secret.value } : { ok: false, reason: 'INVALID' };
  }
  if (secret.kind === 'env') {
    if (typeof secret.name !== 'string' || !ENV_RE.test(secret.name)) return { ok: false, reason: 'INVALID' };
    const value = env[secret.name];
    if (typeof value !== 'string' || value.length === 0) return { ok: false, reason: 'MISSING' };
    return { ok: true, value };
  }
  return { ok: false, reason: 'INVALID' };
}

/**
 * Resolve a whole secrets map. Missing/invalid entries are reported by path.
 * @returns {{values:Record<string,string>, missing:string[], invalid:string[]}}
 */
export function resolveSecrets(secrets, env = process.env) {
  const values = {};
  const missing = [];
  const invalid = [];
  for (const [path, secret] of Object.entries(secrets ?? {})) {
    const resolved = resolveSecret(secret, env);
    if (resolved.ok) values[path] = resolved.value;
    else if (resolved.reason === 'MISSING') missing.push(path);
    else invalid.push(path);
  }
  return { values, missing, invalid };
}

/** Which non-public fields are configured (for AccountView.secretFields). */
export function secretFieldStatus(secrets) {
  return Object.keys(secrets ?? {})
    .sort()
    .map((path) => ({ path, configured: true }));
}

export { DomainError };