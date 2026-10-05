// HostPort contract (spec/ports.d.ts, 05-HOST-CLI.md, 20-HOST-PROTOCOL-MAP.md).
// Strict shapes; a missing capability is a typed UNSUPPORTED, never a fake success.
// There is deliberately no default mock host: an absent host degrades honestly.
import { DomainError } from '../domain/errors.mjs';

export const HOST_METHODS = Object.freeze([
  'listTasks', 'listSessions', 'getSession', 'submit', 'stop', 'settleInteraction',
  'queryInteraction', 'saveAttachment', 'readAttachment', 'subscribe', 'getCapabilities',
  'mountCallback',
]);

export const TURN_MODES = Object.freeze(['followup', 'inject', 'steer']);
export const SESSION_STATUS = Object.freeze(['idle', 'running', 'closed']);
export const QUERY_STATUS = Object.freeze(['pending', 'resolved', 'cancelled', 'unknown']);
export const INTERACTION_RECOVERY = Object.freeze(['process-only', 'queryable']);

export const CAPABILITY_KEYS = Object.freeze([
  'converse', 'steer', 'stop', 'questions', 'approvals', 'attachments',
  'callbackMount', 'interactionRecovery',
]);

function bad(message) {
  return new DomainError('INTERNAL', `invalid HostPort: ${message}`);
}

function unsupported(message) {
  return new DomainError('UNSUPPORTED', message);
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkTaskView(v, at) {
  if (!isPlainObject(v)) throw bad(`${at} must be an object`);
  for (const key of ['id', 'label', 'sessionId', 'status']) {
    if (typeof v[key] !== 'string') throw bad(`${at}.${key} must be a string`);
  }
  return v;
}

function checkSessionView(v, at) {
  if (v === null) return v;
  if (!isPlainObject(v)) throw bad(`${at} must be an object|null`);
  for (const key of ['id', 'agentId', 'workspaceId', 'label']) {
    if (typeof v[key] !== 'string') throw bad(`${at}.${key} must be a string`);
  }
  if (!SESSION_STATUS.includes(v.status)) throw bad(`${at}.status must be one of ${SESSION_STATUS.join('|')}`);
  return v;
}

function checkAttachmentRef(v, at) {
  if (!isPlainObject(v)) throw bad(`${at} must be an object`);
  for (const key of ['id', 'name', 'mime']) {
    if (typeof v[key] !== 'string') throw bad(`${at}.${key} must be a string`);
  }
  if (!Number.isInteger(v.size) || v.size < 0) throw bad(`${at}.size must be a non-negative integer`);
  return v;
}

function checkCapabilities(v) {
  if (!isPlainObject(v)) throw bad('getCapabilities() must return an object');
  for (const key of CAPABILITY_KEYS) {
    if (!(key in v)) throw bad(`capabilities.${key} is missing`);
  }
  for (const key of CAPABILITY_KEYS) {
    if (key === 'interactionRecovery') continue;
    if (typeof v[key] !== 'boolean') throw bad(`capabilities.${key} must be a boolean`);
  }
  if (!INTERACTION_RECOVERY.includes(v.interactionRecovery)) {
    throw bad(`capabilities.interactionRecovery must be one of ${INTERACTION_RECOVERY.join('|')}`);
  }
  return v;
}

function requireSignal(signal, at) {
  if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function') {
    throw bad(`${at}.signal must be an AbortSignal`);
  }
}

/** Validate a host object exposes every method with the right arity/shape. */
export function validateHostPort(host) {
  if (!isPlainObject(host) && typeof host !== 'object') throw bad('host must be an object');
  for (const method of HOST_METHODS) {
    if (typeof host[method] !== 'function') throw bad(`missing method ${method}()`);
  }
  return host;
}

/**
 * Build the honest "no host" port: every capability is absent and every call is a
 * typed UNSUPPORTED. Used when the DSH host lacks tools/events/webServer.
 */
export function createUnavailableHost(reason = 'DSH host capabilities are unavailable') {
  const deny = async () => {
    throw unsupported(reason);
  };
  return {
    listTasks: deny,
    listSessions: deny,
    getSession: async () => null,
    submit: deny,
    stop: deny,
    settleInteraction: deny,
    queryInteraction: async () => ({ status: 'unknown' }),
    saveAttachment: deny,
    readAttachment: deny,
    subscribe: () => () => {},
    getCapabilities: async () => ({
      converse: false, steer: false, stop: false, questions: false, approvals: false,
      attachments: false, callbackMount: false, interactionRecovery: 'process-only',
    }),
    mountCallback: deny,
  };
}

/**
 * Wrap a host with strict input/output validation and capability gating. The
 * wrapped port never invents a success for a capability the host reports absent.
 */
export function wrapHostPort(host, { name = 'notifierV1' } = {}) {
  validateHostPort(host);
  let cachedCapabilities = null;
  const capabilities = async () => {
    if (cachedCapabilities === null) cachedCapabilities = checkCapabilities(await host.getCapabilities());
    return cachedCapabilities;
  };
  const refresh = () => {
    cachedCapabilities = null;
  };

  const gate = async (capability, message) => {
    const caps = await capabilities();
    if (caps[capability] !== true) throw unsupported(`${name}: host lacks ${capability} (${message})`);
  };

  return {
    async listTasks() {
      const list = await host.listTasks();
      if (!Array.isArray(list)) throw bad('listTasks() must return an array');
      return list.map((item, i) => checkTaskView(item, `listTasks()[${i}]`));
    },
    async listSessions() {
      const list = await host.listSessions();
      if (!Array.isArray(list)) throw bad('listSessions() must return an array');
      return list.map((item, i) => checkSessionView(item, `listSessions()[${i}]`));
    },
    async getSession(id) {
      if (typeof id !== 'string') throw bad('getSession(id) requires a string id');
      return checkSessionView(await host.getSession(id), 'getSession()');
    },
    async submit(x) {
      if (!isPlainObject(x)) throw bad('submit(x) requires an object');
      if (typeof x.sessionId !== 'string') throw bad('submit.sessionId must be a string');
      if (!TURN_MODES.includes(x.mode)) throw bad(`submit.mode must be one of ${TURN_MODES.join('|')}`);
      if (typeof x.text !== 'string') throw bad('submit.text must be a string');
      if (!Array.isArray(x.attachments)) throw bad('submit.attachments must be an array');
      if (typeof x.requestId !== 'string') throw bad('submit.requestId must be a string');
      requireSignal(x.signal, 'submit');
      await gate(x.mode === 'steer' ? 'steer' : 'converse', `mode=${x.mode}`);
      const out = await host.submit(x);
      if (!isPlainObject(out) || typeof out.hostRef !== 'string') throw bad('submit() must return {hostRef}');
      if (out.turnId !== null && typeof out.turnId !== 'string') throw bad('submit().turnId must be string|null');
      return out;
    },
    async stop(x) {
      if (!isPlainObject(x) || typeof x.sessionId !== 'string') throw bad('stop.sessionId must be a string');
      if (typeof x.requestId !== 'string') throw bad('stop.requestId must be a string');
      requireSignal(x.signal, 'stop');
      await gate('stop', 'stop');
      const out = await host.stop(x);
      if (!isPlainObject(out) || typeof out.stopped !== 'boolean') throw bad('stop() must return {stopped}');
      return out;
    },
    async settleInteraction(x) {
      if (!isPlainObject(x) || typeof x.hostRef !== 'string') throw bad('settleInteraction.hostRef must be a string');
      if (!['approve', 'reject', 'answer'].includes(x.decision)) throw bad('settleInteraction.decision is invalid');
      if (x.choiceIds !== undefined && !Array.isArray(x.choiceIds)) throw bad('settleInteraction.choiceIds must be an array');
      if (x.text !== undefined && typeof x.text !== 'string') throw bad('settleInteraction.text must be a string');
      if (typeof x.requestId !== 'string') throw bad('settleInteraction.requestId must be a string');
      requireSignal(x.signal, 'settleInteraction');
      const caps = await capabilities();
      if (!caps.approvals && !caps.questions) throw unsupported(`${name}: host lacks interaction settlement`);
      const out = await host.settleInteraction(x);
      if (!isPlainObject(out) || !['resolved', 'already_handled'].includes(out.status)) {
        throw bad('settleInteraction() must return {status: resolved|already_handled}');
      }
      return out;
    },
    async queryInteraction(hostRef) {
      if (typeof hostRef !== 'string') throw bad('queryInteraction(hostRef) requires a string');
      const out = await host.queryInteraction(hostRef);
      if (!isPlainObject(out) || !QUERY_STATUS.includes(out.status)) {
        throw bad(`queryInteraction() must return a status of ${QUERY_STATUS.join('|')}`);
      }
      return out;
    },
    async saveAttachment(x) {
      if (!isPlainObject(x) || typeof x.sessionId !== 'string') throw bad('saveAttachment.sessionId must be a string');
      if (typeof x.name !== 'string' || typeof x.mime !== 'string') throw bad('saveAttachment name/mime must be strings');
      if (!(x.bytes instanceof Uint8Array)) throw bad('saveAttachment.bytes must be a Uint8Array');
      if (typeof x.requestId !== 'string') throw bad('saveAttachment.requestId must be a string');
      requireSignal(x.signal, 'saveAttachment');
      await gate('attachments', 'saveAttachment');
      return checkAttachmentRef(await host.saveAttachment(x), 'saveAttachment()');
    },
    async readAttachment(x) {
      if (!isPlainObject(x) || typeof x.sessionId !== 'string' || typeof x.attachmentId !== 'string') {
        throw bad('readAttachment requires sessionId and attachmentId strings');
      }
      requireSignal(x.signal, 'readAttachment');
      await gate('attachments', 'readAttachment');
      const out = await host.readAttachment(x);
      if (!isPlainObject(out) || typeof out.name !== 'string' || typeof out.mime !== 'string' || !(out.bytes instanceof Uint8Array)) {
        throw bad('readAttachment() must return {name,mime,bytes}');
      }
      return out;
    },
    subscribe(handler) {
      if (typeof handler !== 'function') throw bad('subscribe(handler) requires a function');
      const dispose = host.subscribe((event) => {
        if (!isPlainObject(event) || typeof event.eventId !== 'string' || typeof event.at !== 'number' || typeof event.type !== 'string') {
          throw bad('host emitted a malformed event');
        }
        if (event.type === 'capabilities.changed') refresh();
        handler(event);
      });
      if (typeof dispose !== 'function') throw bad('subscribe() must return an unsubscribe function');
      return dispose;
    },
    getCapabilities: capabilities,
    async mountCallback(x) {
      if (!isPlainObject(x) || typeof x.path !== 'string' || typeof x.handler !== 'function') {
        throw bad('mountCallback requires {path,handler}');
      }
      if (!Number.isInteger(x.maxBytes) || x.maxBytes <= 0 || x.maxBytes > 1024 * 1024) {
        throw bad('mountCallback.maxBytes must be 1..1MiB');
      }
      await gate('callbackMount', 'mountCallback');
      const dispose = await host.mountCallback(x);
      if (typeof dispose !== 'function') throw bad('mountCallback() must resolve to a disposer');
      return dispose;
    },
    /** Test seam: drop cached capabilities after a capabilities.changed event. */
    refreshCapabilities: refresh,
    get host() {
      return host;
    },
  };
}