// best-effort importer (T29; 09-IMPORT.md).
//
// Scope is deliberately tiny: one user-named JSON file, and only the canonical
// `channel:<type>:outbound` prefix. Everything else (admin: keys, <type>:account,
// YAML, identities, pairing, routes, tokens, unknown top-level keys) is ignored by
// construction. Unsafe or unrecognized input is reported as skipped, never as a
// success, and never mutates the store. All ready records land in ONE transaction,
// so a single failure leaves no partial account behind.
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validationError, conflict } from '../domain/errors.mjs';
import { LIMITS } from '../domain/limits.mjs';
import { commit } from '../storage/store.mjs';
import { channelById, fieldsFor, fieldRequired, fieldVisible } from '../domain/descriptors.mjs';
import { validateAccountConfig, validateDestinationTarget } from '../domain/descriptors.mjs';
import { normalizeSecretValue } from '../security/secrets.mjs';
import { directionComplete, insertAccount, requireLabel } from './accounts.mjs';
import { insertDestination } from './destinations.mjs';

export const IMPORT_KEY_RE = /^channel:([a-z0-9-]+):outbound$/;
export const IMPORT_MAX_BYTES = 32 * 1024 * 1024;
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function fingerprintOf(sourceHash, sourceKey) {
  return createHash('sha256').update(sourceHash).update('\u0000').update(sourceKey).digest('hex');
}

/** Reject prototype keys and excessive depth before any field is trusted. */
function inspectJson(root) {
  const stack = [[root, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > LIMITS.MAX_DEPTH) return 'UNSAFE_JSON';
    if (node === null || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node)) {
      if (PROTO_KEYS.has(key)) return 'UNSAFE_JSON';
      if (value !== null && typeof value === 'object') stack.push([value, depth + 1]);
    }
  }
  return null;
}

/**
 * Read and hash one file as a single buffer, then parse that same buffer.
 * @returns {{ok:true,sourceHash:string,json:unknown}|{ok:false,sourceHash:string|null,reason:string}}
 */
export function readImportFile(file) {
  if (typeof file !== 'string' || file === '') throw validationError('file is required');
  let size;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return { ok: false, sourceHash: null, reason: 'INPUT_UNREADABLE' };
    size = stat.size;
  } catch {
    return { ok: false, sourceHash: null, reason: 'INPUT_UNREADABLE' };
  }
  if (size > IMPORT_MAX_BYTES) return { ok: false, sourceHash: null, reason: 'INPUT_TOO_LARGE' };

  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return { ok: false, sourceHash: null, reason: 'INPUT_UNREADABLE' };
  }
  if (buffer.byteLength > IMPORT_MAX_BYTES) return { ok: false, sourceHash: null, reason: 'INPUT_TOO_LARGE' };

  const sourceHash = createHash('sha256').update(buffer).digest('hex');
  let json;
  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch {
    return { ok: false, sourceHash, reason: 'BAD_JSON' };
  }
  const unsafe = inspectJson(json);
  if (unsafe !== null) return { ok: false, sourceHash, reason: unsafe };
  return { ok: true, sourceHash, json };
}

function toSecret(field, value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const name = value.kind === 'env' ? value.name : value.env;
    if (typeof name === 'string' && name !== '') return { kind: 'env', name };
  }
  if (field.type === 'string') {
    return { kind: 'literal', value: typeof value === 'string' ? value : String(value) };
  }
  return { kind: 'literal', value: JSON.stringify(value) };
}

function destinationKind(channel, target) {
  if (target.messageType === 'group' || target.targetType === 'group') return 'group';
  if (target.groupId !== undefined || target.group !== undefined) return 'group';
  return channel.defaultDestinationKind;
}

/** Extract the whitelisted fields and classify one canonical record. */
function buildItem(sourceKey, channelId, raw, sourceHash, state) {
  const fingerprint = fingerprintOf(sourceHash, sourceKey);
  const base = { sourceKey, channelId, fingerprint, dropped: [] };
  const channel = channelById(channelId);
  if (!channel || channel.outbound !== true) {
    return { ...base, status: 'skipped', reason: 'UNKNOWN_CHANNEL' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...base, status: 'skipped', reason: 'NOT_OBJECT' };
  }

  const accountFields = fieldsFor(channelId, 'outbound', 'account');
  const destFields = fieldsFor(channelId, 'outbound', 'destination');
  const accountConfig = {};
  const secretChanges = [];
  const target = {};
  const dropped = [];
  let invalid = null;

  for (const [key, value] of Object.entries(raw)) {
    const accountField = accountFields.find((f) => f.field === key);
    if (accountField) {
      if (!fieldVisible(accountField, raw)) { dropped.push(key); continue; }
      if (accountField.exposure === 'secret') {
        try {
          secretChanges.push({ path: accountField.path, op: 'set', value: normalizeSecretValue(toSecret(accountField, value)) });
        } catch {
          invalid = `INVALID_SECRET:${key}`;
        }
      } else {
        accountConfig[key] = value;
      }
      continue;
    }
    const destField = destFields.find((f) => f.field === key);
    if (destField) {
      if (!fieldVisible(destField, raw)) { dropped.push(key); continue; }
      target[destField.field] = value;
      continue;
    }
    dropped.push(key);
  }
  if (invalid !== null) return { ...base, status: 'skipped', reason: invalid };

  // Reuse the exact completeness check the account insert applies, so a record we
  // call ready can never fail mid-transaction.
  const secretMap = {};
  for (const change of secretChanges) secretMap[change.path] = true;
  if (!directionComplete(channelId, 'outbound', accountConfig, secretMap)) {
    return { ...base, status: 'skipped', reason: 'MISSING_REQUIRED' };
  }
  for (const field of destFields) {
    if (!fieldVisible(field, raw) || !fieldRequired(field, raw)) continue;
    if (target[field.field] === undefined || target[field.field] === null) {
      return { ...base, status: 'skipped', reason: `MISSING_REQUIRED:target.${field.field}` };
    }
  }

  const accountProblems = validateAccountConfig(channelId, 'outbound', accountConfig);
  if (accountProblems.length > 0) return { ...base, status: 'skipped', reason: `INVALID_ACCOUNT:${accountProblems[0]}` };
  const targetProblems = validateDestinationTarget(channelId, target);
  if (targetProblems.length > 0) return { ...base, status: 'skipped', reason: `INVALID_TARGET:${targetProblems[0]}` };

  const alreadyImported = state.imports?.[fingerprint] !== undefined;
  const duplicate = Object.values(state.imports ?? {}).some(
    (entry) => entry.sourceKey === sourceKey && entry.fingerprint !== fingerprint,
  );
  const reason = alreadyImported
    ? 'already-imported'
    : duplicate
      ? 'possible-duplicate'
      : dropped.length > 0
        ? 'unknown-fields-dropped'
        : null;

  return {
    ...base,
    status: alreadyImported ? 'skipped' : 'ready',
    reason,
    dropped,
    connection: {
      channelId,
      label: `imported-${channelId}`,
      config: { outbound: accountConfig },
      secretChanges,
      notificationEnabled: true,
      controlEnabled: false,
      enabled: true,
    },
    destination: {
      label: 'default',
      kind: destinationKind(channel, target),
      target,
    },
  };
}

function countOf(items) {
  const counts = { total: items.length, ready: 0, skipped: 0, alreadyImported: 0 };
  for (const item of items) {
    if (item.status === 'ready') counts.ready += 1;
    else counts.skipped += 1;
    if (item.reason === 'already-imported') counts.alreadyImported += 1;
  }
  return counts;
}

/** Build the plan without touching the store. */
export function planImport(json, sourceHash, state) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { supported: false, items: [], counts: countOf([]), reason: 'NO_SUPPORTED_RECORDS' };
  }
  const items = [];
  for (const key of Object.keys(json)) {
    const match = IMPORT_KEY_RE.exec(key);
    if (match === null) continue;
    items.push(buildItem(key, match[1], json[key], sourceHash, state));
  }
  if (items.length === 0) return { supported: false, items, counts: countOf(items), reason: 'NO_SUPPORTED_RECORDS' };
  return { supported: true, items, counts: countOf(items), reason: null };
}

function publicItem(item) {
  const out = { sourceKey: item.sourceKey, channelId: item.channelId, status: item.status, reason: item.reason };
  if (item.dropped.length > 0) out.dropped = item.dropped;
  return out;
}

/** Read-only preview: source hash, per-record status/reason and counts. No secrets. */
export function previewImport(store, { file }) {
  const read = readImportFile(file);
  if (!read.ok) {
    return { supported: false, sourceHash: read.sourceHash, items: [], counts: countOf([]), reason: read.reason };
  }
  const plan = planImport(read.json, read.sourceHash, store.snapshot());
  return {
    supported: plan.supported,
    sourceHash: read.sourceHash,
    items: plan.items.map(publicItem),
    counts: plan.counts,
    reason: plan.reason,
  };
}

/**
 * Re-read the file, verify the preview hash, then create every ready record in one
 * transaction. A hash mismatch is a CONFLICT; nothing is written on any failure.
 */
export async function applyImport(store, { file, sourceHash }, ctx = {}) {
  const read = readImportFile(file);
  if (!read.ok) {
    return { imported: 0, skipped: 0, counts: countOf([]), sourceHash: read.sourceHash, reason: read.reason };
  }
  if (typeof sourceHash !== 'string' || sourceHash === '') {
    throw validationError('sourceHash is required for import apply');
  }
  if (sourceHash !== read.sourceHash) {
    throw conflict('import file changed since preview', { expected: sourceHash, actual: read.sourceHash });
  }
  const plan = planImport(read.json, read.sourceHash, store.snapshot());
  const ready = plan.items.filter((item) => item.status === 'ready');
  if (ready.length === 0) {
    return { imported: 0, skipped: plan.items.length, counts: plan.counts, sourceHash: read.sourceHash };
  }
  const now = Number.isInteger(ctx?.now) ? ctx.now : Date.now();
  const imported = await commit(store, ctx.expectedGlobalRevision ?? null, (draft) => {
    let created = 0;
    for (const item of ready) {
      // A concurrent apply may have already recorded the same fingerprint.
      if (draft.imports[item.fingerprint] !== undefined) continue;
      const account = insertAccount(draft, item.connection, ctx);
      requireLabel(item.destination.label);
      const destination = insertDestination(draft, { ...item.destination, accountId: account.id }, ctx);
      draft.imports[item.fingerprint] = {
        fingerprint: item.fingerprint,
        sourceHash: read.sourceHash,
        sourceKey: item.sourceKey,
        accountId: account.id,
        destinationId: destination.id,
        createdAt: now,
      };
      created += 1;
    }
    return created;
  });
  return {
    imported,
    skipped: plan.items.length - imported,
    counts: { ...plan.counts, alreadyImported: plan.counts.alreadyImported + (ready.length - imported) },
    sourceHash: read.sourceHash,
  };
}