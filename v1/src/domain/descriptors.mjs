// Static channel descriptors (02/03/04/18 + spec/CHANNELS.json + spec/EDITOR-FIELDS.json).
// Pure and IO-free: no adapter, store or network dependency. Field ownership,
// visibility and validation come only from the frozen machine fields.
import { CHANNELS, EDITOR_FIELDS } from './descriptor-data.mjs';

export const OUTBOUND_CHANNEL_COUNT = 28;
export const INBOUND_CHANNEL_COUNT = 6;

// Capability truth per channel. outbound/inbound/controlReply are fixed by
// CHANNELS.json; the remaining flags are refined by the frozen adapter facts when
// the concrete adapters land (T16-T21). They default to false so nothing is claimed
// without an implementation that has positive and negative evidence.
// `login` is a beginLogin scan flow (04-LATEST-CONTRACT-FIXES §4): only the two
// scan channels (Feishu, WeChat iLink) may advertise it. A manual-credential
// channel is configured with typed secrets, never a QR scan, so its login is false.
const CAPABILITY_OVERRIDES = Object.freeze({
  telegram: { replyLookup: true, media: true, buttons: true, updateMessage: true },
  feishu: { login: true, replyLookup: true, media: true, buttons: true, updateMessage: true },
  'wechat-ilink': { login: true, media: true },
  'qq-bot': { media: true, buttons: true, updateMessage: true },
  dingtalk: { media: true, buttons: true, updateMessage: true },
  wxpusher: {},
});

const TYPE_SET = new Set(['string', 'integer', 'boolean', 'string[]', 'integer[]', 'record<string,string>']);

function freezeDeep(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDeep));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = freezeDeep(v);
  return Object.freeze(out);
}

export const channels = freezeDeep(CHANNELS);
export const editorFields = freezeDeep(EDITOR_FIELDS);

const CHANNEL_BY_ID = new Map(channels.map((c) => [c.id, c]));
const FIELDS_BY_CHANNEL = new Map();
for (const field of editorFields) {
  if (!FIELDS_BY_CHANNEL.has(field.channelId)) FIELDS_BY_CHANNEL.set(field.channelId, []);
  FIELDS_BY_CHANNEL.get(field.channelId).push(field);
}

export function channelById(id) {
  return CHANNEL_BY_ID.get(id) ?? null;
}

export function channelIds() {
  return channels.map((c) => c.id);
}

function buildCapabilities(channel) {
  const overrides = CAPABILITY_OVERRIDES[channel.id] ?? {};
  return Object.freeze({
    outbound: channel.outbound === true,
    inbound: channel.inbound === true,
    controlReply: channel.inbound === true,
    login: overrides.login ?? false,
    replyLookup: overrides.replyLookup ?? false,
    media: overrides.media ?? false,
    buttons: overrides.buttons ?? false,
    updateMessage: overrides.updateMessage ?? false,
  });
}

function buildDescriptor(channel) {
  const fields = FIELDS_BY_CHANNEL.get(channel.id) ?? [];
  const accountFields = fields.filter((f) => f.owner === 'account');
  const destinationFields = fields.filter((f) => f.owner === 'destination');
  const targetFields = destinationFields.map((f) => f.field);
  const frozenTargets = Object.freeze([...channel.targetFields].sort());
  const declaredTargets = Object.freeze([...targetFields].sort());
  return Object.freeze({
    id: channel.id,
    outbound: channel.outbound === true,
    inbound: channel.inbound === true,
    defaultDestinationKind: channel.defaultDestinationKind,
    targetFields: frozenTargets,
    declaredDestinationFields: declaredTargets,
    capabilities: buildCapabilities(channel),
    accountFields: Object.freeze(accountFields.map((f) => f.id)),
    destinationFields: Object.freeze(destinationFields.map((f) => f.id)),
  });
}

let cachedDescriptors = null;

export function descriptors() {
  if (cachedDescriptors === null) {
    cachedDescriptors = Object.freeze(channels.map(buildDescriptor));
    if (cachedDescriptors.length !== CHANNELS.length) {
      throw new Error('descriptor count mismatch');
    }
  }
  return cachedDescriptors;
}

export const channelDescriptors = descriptors;

export function fieldsFor(channelId, direction, owner = null) {
  const list = FIELDS_BY_CHANNEL.get(channelId) ?? [];
  return list.filter((f) => f.direction === direction && (owner === null || f.owner === owner));
}

export function targetFieldNames(channelId) {
  const channel = CHANNEL_BY_ID.get(channelId);
  return channel ? [...channel.targetFields] : [];
}

// ---------------------------------------------------------------------------
// conditional visibility / requirement
// ---------------------------------------------------------------------------

function conditionMatches(condition, context) {
  if (!condition) return true;
  return context?.[condition.field] === condition.equals;
}

export function fieldVisible(field, context = {}) {
  return conditionMatches(field.visibleWhen, context);
}

export function fieldRequired(field, context = {}) {
  if (field.required === true) return true;
  if (!field.requiredWhen) return false;
  return conditionMatches(field.requiredWhen, context);
}

// ---------------------------------------------------------------------------
// value validation
// ---------------------------------------------------------------------------

export function validateFieldValue(field, value) {
  const type = field.type;
  if (!TYPE_SET.has(type)) return 'unknown field type';
  switch (type) {
    case 'string':
      if (typeof value !== 'string') return 'expected string';
      if (field.enum && !field.enum.includes(value)) return 'value not allowed';
      return null;
    case 'integer':
      if (!Number.isInteger(value)) return 'expected integer';
      if (field.minimum !== undefined && value < field.minimum) return `must be >= ${field.minimum}`;
      if (field.maximum !== undefined && value > field.maximum) return `must be <= ${field.maximum}`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'expected boolean';
    case 'string[]':
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return 'expected string[]';
      return null;
    case 'integer[]':
      if (!Array.isArray(value) || !value.every((v) => Number.isInteger(v) && v >= 0)) return 'expected non-negative integer[]';
      return null;
    case 'record<string,string>':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'expected object';
      if (!Object.values(value).every((v) => typeof v === 'string')) return 'expected string values';
      return null;
    default:
      return 'unknown field type';
  }
}

/**
 * Validate a public config/target object against the channel's non-secret fields.
 * Secret paths are validated separately through secretChanges.
 * @returns {string[]} list of problems (empty when valid)
 */
export function validateFieldValues(channelId, direction, owner, values = {}, { includeSecret = false } = {}) {
  const problems = [];
  const fields = fieldsFor(channelId, direction, owner);
  const known = new Set(fields.map((f) => f.field));
  const secretFields = new Set(fields.filter((f) => f.exposure === 'secret').map((f) => f.field));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) problems.push(`${key}: unknown ${owner} field for ${channelId}`);
    else if (!includeSecret && secretFields.has(key)) problems.push(`${key}: non-public fields go through secretChanges, not ${owner} config`);
  }
  for (const field of fields) {
    if (!includeSecret && field.exposure !== 'public') continue;
    if (!fieldVisible(field, values)) continue;
    const value = values[field.field];
    if (value === undefined || value === null) {
      if (fieldRequired(field, values)) problems.push(`${field.field}: required`);
      continue;
    }
    const problem = validateFieldValue(field, value);
    if (problem) problems.push(`${field.field}: ${problem}`);
  }
  return problems;
}

/**
 * Destination targets may only contain the channel's declared target fields.
 * Target fields marked secret (e.g. onebot messageType) are still accepted here and
 * are moved into destination.secrets by the connection service.
 */
export function validateDestinationTarget(channelId, target = {}) {
  const allowed = new Set(targetFieldNames(channelId));
  const problems = [];
  for (const key of Object.keys(target)) {
    if (!allowed.has(key)) problems.push(`target.${key}: not a declared target field for ${channelId}`);
  }
  const values = validateFieldValues(channelId, 'outbound', 'destination', target, { includeSecret: true });
  return [...problems, ...values];
}

/** Account config may only contain the channel's declared public account fields. */
export function validateAccountConfig(channelId, direction, config = {}) {
  return validateFieldValues(channelId, direction, 'account', config);
}

export function secretFieldPaths(channelId, direction, owner) {
  return fieldsFor(channelId, direction, owner)
    .filter((f) => f.exposure === 'secret')
    .map((f) => f.path);
}