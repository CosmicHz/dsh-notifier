// Diagnostics export and metadata-only JSONL log (02-DATA.md, 03-SERVICES-RPC.md).
// diagnostics.export returns a redacted snapshot: version, capabilities, health,
// counts and the most recent 100 error metadata rows. It never returns file paths
// and never reads arbitrary files.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '../domain/limits.mjs';
import { REDACTED, isSecretKey, redactText } from '../security/redact.mjs';

export const MAX_RECENT_ERRORS = 100;

const NON_ERROR_STATUS = new Set(['ok', 'success', 'accepted', 'confirmed', 'done', 'skipped', 'resolved']);

/** Deep-redact a log record: secret-named keys masked, secret literals masked in text. */
export function redactLogRecord(value, secretValues = []) {
  if (typeof value === 'string') return redactText(value, secretValues);
  if (Array.isArray(value)) return value.map((item) => redactLogRecord(item, secretValues));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? REDACTED : redactLogRecord(child, secretValues);
    }
    return out;
  }
  return value;
}

/**
 * Collect newest-first error metadata from the activity log. Only the fixed
 * metadata fields survive; message bodies and secrets are never present.
 */
export function collectRecentErrors(activity = [], { limit = MAX_RECENT_ERRORS, secretValues = [] } = {}) {
  const out = [];
  for (let i = activity.length - 1; i >= 0 && out.length < limit; i--) {
    const item = activity[i];
    if (!item || typeof item !== 'object') continue;
    if (NON_ERROR_STATUS.has(item.status)) continue;
    out.push({
      id: item.id,
      time: item.time,
      kind: item.kind,
      accountId: item.accountId ?? null,
      sessionId: item.sessionId ?? null,
      status: redactText(item.status, secretValues),
      code: item.code === null || item.code === undefined ? null : redactText(item.code, secretValues),
    });
  }
  return out;
}

function sanitizeCounts(counts) {
  const out = {};
  if (counts && typeof counts === 'object' && !Array.isArray(counts)) {
    for (const [key, value] of Object.entries(counts)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.max(0, Math.trunc(value));
    }
  }
  return out;
}

/**
 * Build the diagnostics.export payload. Pure: callers supply already-read state.
 * @returns {{schemaVersion:number,generatedAt:number,version:unknown,capabilities:unknown,health:unknown,counts:object,recentErrors:object[]}}
 */
export function buildDiagnostics({
  version = null,
  capabilities = null,
  health = 'unknown',
  counts = {},
  activity = [],
  secretValues = [],
  now = Date.now(),
} = {}) {
  return {
    schemaVersion: 1,
    generatedAt: now,
    version: redactLogRecord(version, secretValues),
    capabilities: redactLogRecord(capabilities, secretValues),
    health: redactLogRecord(health, secretValues),
    counts: sanitizeCounts(counts),
    recentErrors: collectRecentErrors(activity, { limit: MAX_RECENT_ERRORS, secretValues }),
  };
}

/**
 * Metadata-only JSONL logger with 5MB x 3 rotation (01-DECISIONS.md "日志").
 * Every record is redacted before it is written; the current file plus
 * `maxFiles - 1` numbered archives are retained.
 */
export class JsonlLog {
  #dir;
  #file;
  #maxBytes;
  #maxFiles;

  constructor({ dir, file = 'notifier.log', maxBytes = LIMITS.LOG_MAX_BYTES, maxFiles = LIMITS.LOG_MAX_FILES }) {
    if (typeof dir !== 'string' || dir.length === 0) throw new Error('JsonlLog requires a directory');
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive integer');
    if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error('maxFiles must be a positive integer');
    this.#dir = dir;
    this.#file = file;
    this.#maxBytes = maxBytes;
    this.#maxFiles = maxFiles;
    mkdirSync(dir, { recursive: true });
  }

  get path() {
    return join(this.#dir, this.#file);
  }

  /** Redacted append; returns the exact record written. */
  append(record, { secretValues = [] } = {}) {
    const safe = redactLogRecord(record, secretValues);
    const line = `${JSON.stringify(safe)}\n`;
    this.#rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
    appendFileSync(this.path, line, { encoding: 'utf8', mode: 0o600 });
    return safe;
  }

  #rotateIfNeeded(incomingBytes) {
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      return; // no current file yet
    }
    if (size + incomingBytes <= this.#maxBytes) return;
    const oldest = `${this.path}.${this.#maxFiles - 1}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = this.#maxFiles - 2; i >= 1; i--) {
      const from = `${this.path}.${i}`;
      if (existsSync(from)) renameSync(from, `${this.path}.${i + 1}`);
    }
    if (existsSync(this.path)) renameSync(this.path, `${this.path}.1`);
  }
}