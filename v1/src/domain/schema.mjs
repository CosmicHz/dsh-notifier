// Persistent data contract (02-DATA.md). Plain JSON only: no prototype keys, no
// unknown fields, max depth 16, opaque ids <=128 chars, names 1..80 codepoints.
import { DomainError, validationError } from './errors.mjs';
import { LIMITS, codepointLength } from './limits.mjs';

export const SCHEMA_VERSION = 1;

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;

export function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Compound map keys are JSON.stringify(string[]); platform ids are never split. */
export function compoundKey(parts) {
  if (!Array.isArray(parts) || parts.length === 0 || !parts.every((p) => typeof p === 'string')) {
    throw new DomainError('INTERNAL', 'compoundKey requires a non-empty string array');
  }
  return JSON.stringify(parts);
}

export function isCompoundKey(key) {
  try {
    const parsed = JSON.parse(key);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every((p) => typeof p === 'string');
  } catch {
    return false;
  }
}

/**
 * Deep JSON-shape check. Rejects prototype keys, non-JSON values and depth>16.
 * @throws {DomainError} VALIDATION
 */
export function assertJsonShape(value) {
  const errors = [];
  visit(value, '$', 0, errors);
  if (errors.length) throw validationError('invalid JSON shape', errors);
  return value;
}

function visit(value, path, depth, errors) {
  if (depth > LIMITS.MAX_DEPTH) {
    errors.push(`${path}: exceeds max depth ${LIMITS.MAX_DEPTH}`);
    return;
  }
  const t = typeof value;
  if (value === null || t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(value)) errors.push(`${path}: number must be finite`);
    return;
  }
  if (t !== 'object') {
    errors.push(`${path}: value of type ${t} is not JSON-serializable`);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) visit(value[i], `${path}[${i}]`, depth + 1, errors);
    return;
  }
  if (!isPlainObject(value)) {
    errors.push(`${path}: only plain objects are allowed`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (PROTO_KEYS.has(key)) {
      errors.push(`${path}.${key}: prototype keys are forbidden`);
      continue;
    }
    visit(value[key], `${path}.${key}`, depth + 1, errors);
  }
}

// ---------------------------------------------------------------------------
// field helpers
// ---------------------------------------------------------------------------

function noUnknown(obj, allowed, path, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.push(`${path}.${key}: unknown field`);
  }
}

function reqStr(obj, key, path, errors, { min = 1, max = LIMITS.MAX_ID_LENGTH, re = null } = {}) {
  const v = obj[key];
  if (typeof v !== 'string') {
    errors.push(`${path}.${key}: expected string`);
    return;
  }
  const len = codepointLength(v);
  if (len < min || len > max) errors.push(`${path}.${key}: length ${len} outside ${min}..${max}`);
  if (re && !re.test(v)) errors.push(`${path}.${key}: invalid format`);
}

function reqName(obj, key, path, errors) {
  reqStr(obj, key, path, errors, { min: 1, max: LIMITS.MAX_NAME_CODEPOINTS });
}

function reqId(obj, key, path, errors) {
  reqStr(obj, key, path, errors, { min: 1, max: LIMITS.MAX_ID_LENGTH, re: ID_RE });
}

function reqBool(obj, key, path, errors) {
  if (typeof obj[key] !== 'boolean') errors.push(`${path}.${key}: expected boolean`);
}

function reqInt(obj, key, path, errors, { min = 0 } = {}) {
  const v = obj[key];
  if (!Number.isInteger(v) || v < min) errors.push(`${path}.${key}: expected integer >= ${min}`);
}

function reqEnum(obj, key, path, errors, values) {
  if (!values.includes(obj[key])) errors.push(`${path}.${key}: expected one of ${values.join('|')}`);
}

function reqEnumOrNull(obj, key, path, errors, values) {
  if (obj[key] === null) return;
  if (!values.includes(obj[key])) errors.push(`${path}.${key}: expected null or one of ${values.join('|')}`);
}

function reqStringOrNull(obj, key, path, errors, opts) {
  if (obj[key] === null) return;
  reqStr(obj, key, path, errors, opts);
}

function reqArray(obj, key, path, errors, item) {
  const v = obj[key];
  if (!Array.isArray(v)) {
    errors.push(`${path}.${key}: expected array`);
    return;
  }
  v.forEach((itemValue, i) => item(itemValue, `${path}.${key}[${i}]`, errors));
}

function reqRecord(obj, key, path, errors) {
  const v = obj[key];
  if (!isPlainObject(v)) errors.push(`${path}.${key}: expected object`);
}

function idArray(obj, key, path, errors) {
  reqArray(obj, key, path, errors, (v, p, e) => {
    if (typeof v !== 'string' || !ID_RE.test(v)) e.push(`${p}: expected id string`);
  });
}

function validateSecrets(secrets, path, errors) {
  if (!isPlainObject(secrets)) {
    errors.push(`${path}: expected object`);
    return;
  }
  for (const [key, value] of Object.entries(secrets)) {
    const p = `${path}.${key}`;
    if (!isPlainObject(value)) {
      errors.push(`${p}: expected object`);
      continue;
    }
    if (value.kind === 'literal') {
      noUnknown(value, new Set(['kind', 'value']), p, errors);
      if (typeof value.value !== 'string') errors.push(`${p}.value: expected string`);
    } else if (value.kind === 'env') {
      noUnknown(value, new Set(['kind', 'name']), p, errors);
      if (typeof value.name !== 'string' || !ENV_RE.test(value.name)) {
        errors.push(`${p}.name: expected env var name`);
      }
    } else {
      errors.push(`${p}.kind: expected literal|env`);
    }
  }
}

// ---------------------------------------------------------------------------
// entities
// ---------------------------------------------------------------------------

const ENTITY = {
  Account: {
    keys: new Set([
      'id', 'revision', 'channelId', 'label', 'enabled', 'notificationEnabled',
      'controlEnabled', 'config', 'secrets', 'policyRevision', 'createdAt', 'updatedAt',
    ]),
    check(entity, path, errors) {
      reqId(entity, 'id', path, errors);
      reqInt(entity, 'revision', path, errors);
      reqId(entity, 'channelId', path, errors);
      reqName(entity, 'label', path, errors);
      reqBool(entity, 'enabled', path, errors);
      reqBool(entity, 'notificationEnabled', path, errors);
      reqBool(entity, 'controlEnabled', path, errors);
      reqRecord(entity, 'config', path, errors);
      if (isPlainObject(entity.config)) {
        noUnknown(entity.config, new Set(['outbound', 'inbound']), `${path}.config`, errors);
        reqRecord(entity.config, 'outbound', `${path}.config`, errors);
        reqRecord(entity.config, 'inbound', `${path}.config`, errors);
      }
      validateSecrets(entity.secrets, `${path}.secrets`, errors);
      reqInt(entity, 'policyRevision', path, errors);
      reqInt(entity, 'createdAt', path, errors);
      reqInt(entity, 'updatedAt', path, errors);
    },
  },
  Destination: {
    keys: new Set([
      'id', 'revision', 'accountId', 'label', 'kind', 'target', 'secrets', 'enabled',
      'createdAt', 'updatedAt',
    ]),
    check(entity, path, errors) {
      reqId(entity, 'id', path, errors);
      reqInt(entity, 'revision', path, errors);
      reqId(entity, 'accountId', path, errors);
      reqName(entity, 'label', path, errors);
      reqEnum(entity, 'kind', path, errors, ['private', 'group', 'local', 'endpoint']);
      reqRecord(entity, 'target', path, errors);
      validateSecrets(entity.secrets, `${path}.secrets`, errors);
      reqBool(entity, 'enabled', path, errors);
      reqInt(entity, 'createdAt', path, errors);
      reqInt(entity, 'updatedAt', path, errors);
    },
  },
  Principal: {
    keys: new Set([
      'id', 'revision', 'accountId', 'userId', 'role', 'canConverse', 'sessionIds',
      'enabled', 'replyContextId', 'createdAt', 'updatedAt',
    ]),
    check(entity, path, errors) {
      reqId(entity, 'id', path, errors);
      reqInt(entity, 'revision', path, errors);
      reqId(entity, 'accountId', path, errors);
      reqStr(entity, 'userId', path, errors);
      reqEnum(entity, 'role', path, errors, ['owner', 'member']);
      reqBool(entity, 'canConverse', path, errors);
      idArray(entity, 'sessionIds', path, errors);
      reqBool(entity, 'enabled', path, errors);
      reqId(entity, 'replyContextId', path, errors);
      reqInt(entity, 'createdAt', path, errors);
      reqInt(entity, 'updatedAt', path, errors);
    },
  },
  Pairing: {
    keys: new Set(['id', 'accountId', 'codeHash', 'role', 'canConverse', 'expiresAt', 'state', 'createdAt']),
    check(entity, path, errors) {
      reqId(entity, 'id', path, errors);
      reqId(entity, 'accountId', path, errors);
      reqStr(entity, 'codeHash', path, errors, { min: 1, max: 256 });
      reqEnum(entity, 'role', path, errors, ['owner', 'member']);
      reqBool(entity, 'canConverse', path, errors);
      reqInt(entity, 'expiresAt', path, errors);
      reqEnum(entity, 'state', path, errors, ['active', 'redeemed', 'revoked']);
      reqInt(entity, 'createdAt', path, errors);
    },
  },
  Interaction: {
    keys: new Set([
      'id', 'revision', 'type', 'sessionId', 'turnId', 'hostRef', 'prompt', 'choices',
      'multiple', 'allowText', 'targets', 'state', 'recovery', 'expiresAt', 'claim',
      'result', 'createdAt', 'updatedAt',
    ]),
    check(entity, path, errors) {
      reqId(entity, 'id', path, errors);
      reqInt(entity, 'revision', path, errors);
      reqEnum(entity, 'type', path, errors, ['approval', 'question', 'action']);
      reqId(entity, 'sessionId', path, errors);
      reqStringOrNull(entity, 'turnId', path, errors, { min: 1, max: LIMITS.MAX_ID_LENGTH });
      reqId(entity, 'hostRef', path, errors);
      reqStr(entity, 'prompt', path, errors, { min: 1, max: LIMITS.MAX_MESSAGE_CODEPOINTS });
      reqArray(entity, 'choices', path, errors, (c, p, e) => {
        if (!isPlainObject(c)) return void e.push(`${p}: expected object`);
        noUnknown(c, new Set(['id', 'label']), p, e);
        reqId(c, 'id', p, e);
        reqName(c, 'label', p, e);
      });
      reqBool(entity, 'multiple', path, errors);
      reqBool(entity, 'allowText', path, errors);
      reqArray(entity, 'targets', path, errors, (t, p, e) => {
        if (!isPlainObject(t)) return void e.push(`${p}: expected object`);
        noUnknown(t, new Set(['accountId', 'principalId', 'replyContextId', 'policyRevision']), p, e);
        reqId(t, 'accountId', p, e);
        reqId(t, 'principalId', p, e);
        reqId(t, 'replyContextId', p, e);
        reqInt(t, 'policyRevision', p, e);
      });
      reqEnum(entity, 'state', path, errors, [
        'pending', 'claimed', 'resolved', 'rejected', 'expired', 'cancelled', 'uncertain',
      ]);
      reqEnum(entity, 'recovery', path, errors, ['live', 'unconfirmed']);
      reqInt(entity, 'expiresAt', path, errors);
      if (entity.claim !== null) {
        if (!isPlainObject(entity.claim)) errors.push(`${path}.claim: expected object|null`);
        else {
          noUnknown(entity.claim, new Set(['effectId', 'actorKey', 'at']), `${path}.claim`, errors);
          reqId(entity.claim, 'effectId', `${path}.claim`, errors);
          reqStr(entity.claim, 'actorKey', `${path}.claim`, errors, { min: 1, max: 256 });
          reqInt(entity.claim, 'at', `${path}.claim`, errors);
        }
      }
      if (entity.result !== null) {
        if (!isPlainObject(entity.result)) errors.push(`${path}.result: expected object|null`);
        else {
          noUnknown(entity.result, new Set(['decision', 'choiceIds', 'text', 'code']), `${path}.result`, errors);
          reqStr(entity.result, 'decision', `${path}.result`, errors, { min: 1, max: 64 });
          if (entity.result.choiceIds !== null) idArray(entity.result, 'choiceIds', `${path}.result`, errors);
          reqStringOrNull(entity.result, 'text', `${path}.result`, errors, { min: 0, max: LIMITS.MAX_ANSWER_CODEPOINTS });
          reqStringOrNull(entity.result, 'code', `${path}.result`, errors, { min: 0, max: 256 });
        }
      }
      reqInt(entity, 'createdAt', path, errors);
      reqInt(entity, 'updatedAt', path, errors);
    },
  },
  Route: {
    keys: new Set(['id', 'revision', 'scope', 'scopeId', 'destinationIds', 'quiet', 'createdAt', 'updatedAt']),
    check(entity, path, errors) {
      reqId(entity, 'id', path, errors);
      reqInt(entity, 'revision', path, errors);
      reqEnum(entity, 'scope', path, errors, ['session', 'agent', 'workspace', 'global']);
      reqStr(entity, 'scopeId', path, errors, { min: 1, max: LIMITS.MAX_ID_LENGTH });
      if (entity.scope === 'global' && entity.scopeId !== '*') {
        errors.push(`${path}.scopeId: global scope requires '*'`);
      }
      if (entity.destinationIds !== null) idArray(entity, 'destinationIds', path, errors);
      reqEnumOrNull(entity, 'quiet', path, errors, [true, false]);
      if (entity.destinationIds === null && entity.quiet === null) {
        errors.push(`${path}: at least one of destinationIds/quiet must be non-null`);
      }
      reqInt(entity, 'createdAt', path, errors);
      reqInt(entity, 'updatedAt', path, errors);
    },
  },
  Receipt: {
    keys: new Set([
      'id', 'requestId', 'destinationId', 'accountId', 'kind', 'status', 'delivery',
      'effectIds', 'providerMessageIds', 'destinationLabel', 'errorCode', 'createdAt',
    ]),
    check(entity, path, errors) {
      reqId(entity, 'id', path, errors);
      reqId(entity, 'requestId', path, errors);
      reqStringOrNull(entity, 'destinationId', path, errors, { min: 1, max: LIMITS.MAX_ID_LENGTH });
      reqId(entity, 'accountId', path, errors);
      reqEnum(entity, 'kind', path, errors, ['notification', 'control']);
      reqEnum(entity, 'status', path, errors, ['accepted', 'confirmed', 'failed', 'skipped', 'uncertain']);
      reqEnum(entity, 'delivery', path, errors, ['complete', 'partial', 'none']);
      idArray(entity, 'effectIds', path, errors);
      reqArray(entity, 'providerMessageIds', path, errors, (v, p, e) => {
        if (typeof v !== 'string' || v.length > 256) e.push(`${p}: expected message id string`);
      });
      reqStringOrNull(entity, 'destinationLabel', path, errors, { min: 0, max: LIMITS.MAX_NAME_CODEPOINTS });
      reqStringOrNull(entity, 'errorCode', path, errors, { min: 1, max: 64 });
      reqInt(entity, 'createdAt', path, errors);
    },
  },
  Activity: {
    keys: new Set(['id', 'time', 'kind', 'accountId', 'sessionId', 'status', 'code']),
    check(entity, path, errors) {
      reqId(entity, 'id', path, errors);
      reqInt(entity, 'time', path, errors);
      reqStr(entity, 'kind', path, errors, { min: 1, max: 64 });
      reqStringOrNull(entity, 'accountId', path, errors, { min: 1, max: LIMITS.MAX_ID_LENGTH });
      reqStringOrNull(entity, 'sessionId', path, errors, { min: 1, max: LIMITS.MAX_ID_LENGTH });
      reqStr(entity, 'status', path, errors, { min: 1, max: 64 });
      reqStringOrNull(entity, 'code', path, errors, { min: 1, max: 64 });
    },
  },
  Binding: {
    keys: new Set(['principalId', 'sessionId', 'updatedAt']),
    check(entity, path, errors) {
      reqId(entity, 'principalId', path, errors);
      reqId(entity, 'sessionId', path, errors);
      reqInt(entity, 'updatedAt', path, errors);
    },
  },
  Lockout: {
    keys: new Set(['failures', 'lockedUntil', 'lastAttemptAt']),
    check(entity, path, errors) {
      reqInt(entity, 'failures', path, errors);
      reqInt(entity, 'lockedUntil', path, errors);
      reqInt(entity, 'lastAttemptAt', path, errors);
    },
  },
  Request: {
    keys: new Set(['hash', 'kind', 'status', 'result', 'createdAt', 'expiresAt']),
    check(entity, path, errors) {
      reqStr(entity, 'hash', path, errors, { min: 1, max: 128 });
      reqEnum(entity, 'kind', path, errors, ['config', 'effect']);
      reqEnum(entity, 'status', path, errors, ['pending', 'done', 'uncertain']);
      reqInt(entity, 'createdAt', path, errors);
      reqInt(entity, 'expiresAt', path, errors);
    },
  },
  Effect: {
    keys: new Set([
      'id', 'requestKey', 'accountId', 'destinationId', 'segmentIndex', 'attempt', 'kind',
      'status', 'providerMessageId', 'errorCode', 'createdAt', 'updatedAt',
    ]),
    check(entity, path, errors) {
      reqId(entity, 'id', path, errors);
      reqStr(entity, 'requestKey', path, errors, { min: 1, max: 512 });
      reqStringOrNull(entity, 'accountId', path, errors, { min: 1, max: LIMITS.MAX_ID_LENGTH });
      reqStringOrNull(entity, 'destinationId', path, errors, { min: 1, max: LIMITS.MAX_ID_LENGTH });
      reqInt(entity, 'segmentIndex', path, errors);
      reqInt(entity, 'attempt', path, errors);
      reqEnum(entity, 'kind', path, errors, ['notify', 'controlReply', 'hostSubmit', 'hostSettle', 'hostStop']);
      reqEnum(entity, 'status', path, errors, [
        'planned', 'started', 'accepted', 'confirmed', 'failed', 'uncertain', 'cancelled',
      ]);
      reqStringOrNull(entity, 'providerMessageId', path, errors, { min: 1, max: 256 });
      reqStringOrNull(entity, 'errorCode', path, errors, { min: 1, max: 64 });
      reqInt(entity, 'createdAt', path, errors);
      reqInt(entity, 'updatedAt', path, errors);
    },
  },
  Inbox: {
    keys: new Set(['accountId', 'eventId', 'status', 'receivedAt', 'expiresAt', 'effectIds']),
    check(entity, path, errors) {
      reqId(entity, 'accountId', path, errors);
      reqStr(entity, 'eventId', path, errors, { min: 1, max: 512 });
      reqEnum(entity, 'status', path, errors, ['received', 'claimed', 'done', 'uncertain']);
      reqInt(entity, 'receivedAt', path, errors);
      reqInt(entity, 'expiresAt', path, errors);
      idArray(entity, 'effectIds', path, errors);
    },
  },
  ReplyContext: {
    keys: new Set([
      'id', 'accountId', 'userId', 'chatId', 'chatType', 'transportData', 'expiresAt',
      'createdAt', 'updatedAt',
    ]),
    check(entity, path, errors) {
      reqId(entity, 'id', path, errors);
      reqId(entity, 'accountId', path, errors);
      reqStr(entity, 'userId', path, errors);
      reqStr(entity, 'chatId', path, errors);
      reqEnum(entity, 'chatType', path, errors, ['private']);
      reqRecord(entity, 'transportData', path, errors);
      if (entity.expiresAt !== null) reqInt(entity, 'expiresAt', path, errors);
      reqInt(entity, 'createdAt', path, errors);
      reqInt(entity, 'updatedAt', path, errors);
    },
  },
  ReplyRef: {
    keys: new Set([
      'id', 'tokenHash', 'accountId', 'principalId', 'replyContextId', 'interactionId',
      'interactionRevision', 'policyRevision', 'action', 'messageId', 'expiresAt', 'state',
      'createdAt',
    ]),
    check(entity, path, errors) {
      reqId(entity, 'id', path, errors);
      reqStringOrNull(entity, 'tokenHash', path, errors, { min: 1, max: 256 });
      reqId(entity, 'accountId', path, errors);
      reqId(entity, 'principalId', path, errors);
      reqId(entity, 'replyContextId', path, errors);
      reqId(entity, 'interactionId', path, errors);
      reqInt(entity, 'interactionRevision', path, errors);
      reqInt(entity, 'policyRevision', path, errors);
      reqEnum(entity, 'action', path, errors, ['approve', 'reject', 'answer']);
      reqStringOrNull(entity, 'messageId', path, errors, { min: 1, max: 256 });
      reqInt(entity, 'expiresAt', path, errors);
      reqEnum(entity, 'state', path, errors, ['active', 'used', 'revoked']);
      reqInt(entity, 'createdAt', path, errors);
    },
  },
  Correlation: {
    keys: new Set([
      'id', 'requestKey', 'accountId', 'principalId', 'replyContextId', 'sessionId',
      'hostRef', 'turnId', 'state', 'createdAt', 'updatedAt',
    ]),
    check(entity, path, errors) {
      reqId(entity, 'id', path, errors);
      reqStr(entity, 'requestKey', path, errors, { min: 1, max: 512 });
      reqId(entity, 'accountId', path, errors);
      reqId(entity, 'principalId', path, errors);
      reqId(entity, 'replyContextId', path, errors);
      reqId(entity, 'sessionId', path, errors);
      reqStringOrNull(entity, 'hostRef', path, errors, { min: 1, max: LIMITS.MAX_ID_LENGTH });
      reqStringOrNull(entity, 'turnId', path, errors, { min: 1, max: LIMITS.MAX_ID_LENGTH });
      reqEnum(entity, 'state', path, errors, ['reserved', 'active', 'completed', 'cancelled', 'uncertain']);
      reqInt(entity, 'createdAt', path, errors);
      reqInt(entity, 'updatedAt', path, errors);
    },
  },
  Import: {
    keys: new Set(['fingerprint', 'sourceHash', 'sourceKey', 'accountId', 'destinationId', 'createdAt']),
    check(entity, path, errors) {
      reqStr(entity, 'fingerprint', path, errors, { min: 1, max: 256 });
      reqStr(entity, 'sourceHash', path, errors, { min: 1, max: 256 });
      reqStr(entity, 'sourceKey', path, errors, { min: 1, max: 512 });
      reqId(entity, 'accountId', path, errors);
      reqId(entity, 'destinationId', path, errors);
      reqInt(entity, 'createdAt', path, errors);
    },
  },
};

export const ENTITY_KEYS = ENTITY;

const ROOT_MAPS = Object.freeze({
  accounts: 'Account',
  destinations: 'Destination',
  principals: 'Principal',
  pairing: 'Pairing',
  interactions: 'Interaction',
  routes: 'Route',
  receipts: 'Receipt',
  imports: 'Import',
  bindings: 'Binding',
  lockouts: 'Lockout',
  requests: 'Request',
  effects: 'Effect',
  inbox: 'Inbox',
  replyContexts: 'ReplyContext',
  replyRefs: 'ReplyRef',
  correlations: 'Correlation',
});

const ROOT_KEYS = new Set([
  'schemaVersion', 'revision', ...Object.keys(ROOT_MAPS),
  'cursors', 'settings', 'activity',
]);

function checkMap(state, key, entityName, path, errors, keyCheck) {
  const map = state[key];
  if (!isPlainObject(map)) {
    errors.push(`${path}.${key}: expected object map`);
    return;
  }
  for (const [mapKey, entity] of Object.entries(map)) {
    const p = `${path}.${key}[${mapKey}]`;
    if (keyCheck) keyCheck(mapKey, entity, p, errors);
    if (!isPlainObject(entity)) {
      errors.push(`${p}: expected object`);
      continue;
    }
    const def = ENTITY[entityName];
    noUnknown(entity, def.keys, p, errors);
    def.check(entity, p, errors);
  }
}

const mapKeyEqualsId = (mapKey, entity, p, errors) => {
  if (entity && typeof entity === 'object' && entity.id !== mapKey) {
    errors.push(`${p}: map key must equal entity.id`);
  }
};

function checkSettings(settings, path, errors) {
  if (!isPlainObject(settings)) {
    errors.push(`${path}.settings: expected object`);
    return;
  }
  noUnknown(settings, new Set(['revision', 'defaultDestinationIds', 'quiet', 'activityRetentionDays']), `${path}.settings`, errors);
  reqInt(settings, 'revision', `${path}.settings`, errors);
  idArray(settings, 'defaultDestinationIds', `${path}.settings`, errors);
  reqBool(settings, 'quiet', `${path}.settings`, errors);
  const days = settings.activityRetentionDays;
  if (!Number.isInteger(days) || days < LIMITS.ACTIVITY_RETENTION_MIN_DAYS || days > LIMITS.ACTIVITY_RETENTION_MAX_DAYS) {
    errors.push(`${path}.settings.activityRetentionDays: expected integer ${LIMITS.ACTIVITY_RETENTION_MIN_DAYS}..${LIMITS.ACTIVITY_RETENTION_MAX_DAYS}`);
  }
}

function checkCursors(cursors, path, errors) {
  if (!isPlainObject(cursors)) {
    errors.push(`${path}.cursors: expected object map`);
    return;
  }
  for (const [accountId, value] of Object.entries(cursors)) {
    const p = `${path}.cursors[${accountId}]`;
    if (!isPlainObject(value)) {
      errors.push(`${p}: expected object`);
      continue;
    }
    if (!ID_RE.test(accountId)) errors.push(`${p}: cursor key must be an account id`);
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > LIMITS.CURSOR_MAX_BYTES) {
      errors.push(`${p}: cursor exceeds ${LIMITS.CURSOR_MAX_BYTES} bytes`);
    }
    if (!isPlainObject(value.transportData)) errors.push(`${p}.transportData: expected object`);
  }
}

function checkActivity(activity, path, errors) {
  if (!Array.isArray(activity)) {
    errors.push(`${path}.activity: expected array`);
    return;
  }
  activity.forEach((entity, i) => {
    const p = `${path}.activity[${i}]`;
    if (!isPlainObject(entity)) return void errors.push(`${p}: expected object`);
    noUnknown(entity, ENTITY.Activity.keys, p, errors);
    ENTITY.Activity.check(entity, p, errors);
  });
}

// ---------------------------------------------------------------------------
// limits and references
// ---------------------------------------------------------------------------

function checkLimits(state, path, errors) {
  const size = (key) => Object.keys(state[key] ?? {}).length;
  if (size('accounts') > LIMITS.MAX_ACCOUNTS) errors.push(`${path}.accounts: exceeds ${LIMITS.MAX_ACCOUNTS}`);
  if (size('destinations') > LIMITS.MAX_DESTINATIONS) errors.push(`${path}.destinations: exceeds ${LIMITS.MAX_DESTINATIONS}`);
  if (size('principals') > LIMITS.MAX_PRINCIPALS) errors.push(`${path}.principals: exceeds ${LIMITS.MAX_PRINCIPALS}`);
  const pending = Object.values(state.interactions ?? {}).filter((i) => i?.state === 'pending').length;
  if (pending > LIMITS.MAX_PENDING_INTERACTIONS) errors.push(`${path}.interactions: pending exceeds ${LIMITS.MAX_PENDING_INTERACTIONS}`);
}

function checkOwnerRule(state, path, errors) {
  const owners = new Map();
  for (const principal of Object.values(state.principals ?? {})) {
    if (principal?.role === 'owner' && principal.enabled) {
      owners.set(principal.accountId, (owners.get(principal.accountId) ?? 0) + 1);
    }
  }
  for (const [accountId, count] of owners) {
    if (count > 1) errors.push(`${path}.principals: account ${accountId} has ${count} enabled owners (max 1)`);
  }
}

function checkReferences(state, path, errors) {
  const accounts = state.accounts ?? {};
  const destinations = state.destinations ?? {};
  const principals = state.principals ?? {};
  const replyContexts = state.replyContexts ?? {};
  const interactions = state.interactions ?? {};
  const has = (map, id) => Object.prototype.hasOwnProperty.call(map, id);

  for (const [id, dest] of Object.entries(destinations)) {
    if (dest?.accountId && !has(accounts, dest.accountId)) {
      errors.push(`${path}.destinations[${id}].accountId: unknown account ${dest.accountId}`);
    }
  }
  for (const [id, principal] of Object.entries(principals)) {
    if (principal?.accountId && !has(accounts, principal.accountId)) {
      errors.push(`${path}.principals[${id}].accountId: unknown account ${principal.accountId}`);
    }
    if (principal?.replyContextId && !has(replyContexts, principal.replyContextId)) {
      errors.push(`${path}.principals[${id}].replyContextId: unknown reply context`);
    }
  }
  for (const [id, pairing] of Object.entries(state.pairing ?? {})) {
    if (pairing?.accountId && !has(accounts, pairing.accountId)) {
      errors.push(`${path}.pairing[${id}].accountId: unknown account ${pairing.accountId}`);
    }
  }
  for (const [id, route] of Object.entries(state.routes ?? {})) {
    for (const destId of route?.destinationIds ?? []) {
      if (!has(destinations, destId)) errors.push(`${path}.routes[${id}]: unknown destination ${destId}`);
    }
  }
  for (const destId of state.settings?.defaultDestinationIds ?? []) {
    if (!has(destinations, destId)) errors.push(`${path}.settings.defaultDestinationIds: unknown destination ${destId}`);
  }
  // Interaction targets are strong refs only while pending.
  for (const [id, interaction] of Object.entries(interactions)) {
    if (interaction?.state !== 'pending' && interaction?.state !== 'claimed') continue;
    for (const target of interaction.targets ?? []) {
      if (!has(accounts, target.accountId)) errors.push(`${path}.interactions[${id}]: unknown target account`);
      if (!has(principals, target.principalId)) errors.push(`${path}.interactions[${id}]: unknown target principal`);
      if (!has(replyContexts, target.replyContextId)) errors.push(`${path}.interactions[${id}]: unknown target replyContext`);
    }
  }
  for (const [id, context] of Object.entries(replyContexts)) {
    if (context?.accountId && !has(accounts, context.accountId)) {
      errors.push(`${path}.replyContexts[${id}].accountId: unknown account ${context.accountId}`);
    }
  }
}

// ---------------------------------------------------------------------------
// public entry
// ---------------------------------------------------------------------------

/**
 * Validate a full store snapshot. Throws DomainError(VALIDATION) with a list of
 * problems, or returns the same object when valid.
 */
export function validateState(state) {
  if (!isPlainObject(state)) throw validationError('state must be a plain object');
  const errors = [];
  assertJsonShape(state);
  noUnknown(state, ROOT_KEYS, '$', errors);
  if (state.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`$.schemaVersion: expected ${SCHEMA_VERSION}`);
  }
  reqInt(state, 'revision', '$', errors);

  checkMap(state, 'accounts', 'Account', '$', errors, mapKeyEqualsId);
  checkMap(state, 'destinations', 'Destination', '$', errors, mapKeyEqualsId);
  checkMap(state, 'principals', 'Principal', '$', errors, mapKeyEqualsId);
  checkMap(state, 'pairing', 'Pairing', '$', errors, mapKeyEqualsId);
  checkMap(state, 'interactions', 'Interaction', '$', errors, mapKeyEqualsId);
  checkMap(state, 'routes', 'Route', '$', errors, mapKeyEqualsId);
  checkMap(state, 'receipts', 'Receipt', '$', errors, mapKeyEqualsId);
  checkMap(state, 'imports', 'Import', '$', errors, (mapKey, entity, p, e) => {
    if (entity && typeof entity === 'object' && entity.fingerprint !== mapKey) e.push(`${p}: map key must equal fingerprint`);
  });
  checkMap(state, 'bindings', 'Binding', '$', errors, (mapKey, entity, p, e) => {
    if (entity && typeof entity === 'object' && entity.principalId !== mapKey) e.push(`${p}: map key must equal principalId`);
  });
  checkMap(state, 'lockouts', 'Lockout', '$', errors, (mapKey, _entity, p, e) => {
    if (!isCompoundKey(mapKey)) e.push(`${p}: lockout key must be a compound [accountId,userId] key`);
  });
  checkMap(state, 'requests', 'Request', '$', errors, (mapKey, _entity, p, e) => {
    if (!isCompoundKey(mapKey)) e.push(`${p}: request key must be a compound key`);
  });
  checkMap(state, 'effects', 'Effect', '$', errors, mapKeyEqualsId);
  checkMap(state, 'inbox', 'Inbox', '$', errors, (mapKey, _entity, p, e) => {
    if (!isCompoundKey(mapKey)) e.push(`${p}: inbox key must be a compound [accountId,eventId] key`);
  });
  checkMap(state, 'replyContexts', 'ReplyContext', '$', errors, mapKeyEqualsId);
  checkMap(state, 'replyRefs', 'ReplyRef', '$', errors, mapKeyEqualsId);
  checkMap(state, 'correlations', 'Correlation', '$', errors, mapKeyEqualsId);

  checkCursors(state.cursors, '$', errors);
  checkSettings(state.settings, '$', errors);
  checkActivity(state.activity, '$', errors);

  checkLimits(state, '$', errors);
  checkOwnerRule(state, '$', errors);
  checkReferences(state, '$', errors);

  if (errors.length) throw validationError('state failed validation', errors);
  return state;
}

/** Build an empty, valid root store. */
export function createEmptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    accounts: {},
    destinations: {},
    principals: {},
    pairing: {},
    interactions: {},
    routes: {},
    receipts: {},
    cursors: {},
    imports: {},
    bindings: {},
    lockouts: {},
    requests: {},
    effects: {},
    inbox: {},
    replyContexts: {},
    replyRefs: {},
    correlations: {},
    settings: {
      revision: 0,
      defaultDestinationIds: [],
      quiet: false,
      activityRetentionDays: LIMITS.ACTIVITY_RETENTION_DEFAULT_DAYS,
    },
    activity: [],
  };
}