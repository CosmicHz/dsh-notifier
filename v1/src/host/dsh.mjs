// DSH 0.1.7-rc.2 host boundary (B04; 05-HOST-CLI.md, 20-HOST-PROTOCOL-MAP.md).
//
// The real DSH runtime is NEVER imported here: the host's capabilities arrive as
// an injected, narrow seam bundle (`dsh`). This keeps the adapter testable with a
// fake seam bundle and keeps every rc.2-specific call in one place.
//
// A seam that is not present degrades honestly: the matching capability is
// reported `false` and the call is a typed UNSUPPORTED, never a fake success.
// Event names and payload shapes come from event-map.mjs, which encodes the
// frozen rc.2 facts (session/event tuple, agent/disposed, assistant/message).
import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors.mjs';
import { wrapHostPort } from './port.mjs';
import { normalizeSessionEventArgs, mapSessionEvent, mapAgentLifecycle } from './event-map.mjs';
import { makeHostRef } from './waiters.mjs';

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function idOf(value) {
  if (typeof value === 'string' && value !== '') return value;
  if (isRecord(value) && typeof value.id === 'string' && value.id !== '') return value.id;
  return null;
}

const SESSION_STATUSES = new Set(['idle', 'running', 'closed']);

/** Map one host session/agent record to the frozen SessionView shape. */
function sessionViewOf(raw) {
  if (!isRecord(raw)) return null;
  const id = idOf(raw.id) ?? idOf(raw.sessionId) ?? idOf(raw.session);
  if (id === null) return null;
  return {
    id,
    agentId: idOf(raw.agentId) ?? idOf(raw.agent) ?? id,
    workspaceId: idOf(raw.workspaceId) ?? idOf(raw.workspace) ?? '',
    label: typeof raw.label === 'string' ? raw.label : (typeof raw.title === 'string' ? raw.title : id),
    status: SESSION_STATUSES.has(raw.status) ? raw.status : 'idle',
  };
}

/** Map one host task record to the frozen TaskView shape. */
function taskViewOf(raw) {
  if (!isRecord(raw)) return null;
  const id = idOf(raw.id) ?? idOf(raw.taskId);
  const sessionId = idOf(raw.sessionId) ?? idOf(raw.session);
  if (id === null || sessionId === null) return null;
  return {
    id,
    label: typeof raw.label === 'string' ? raw.label : (typeof raw.title === 'string' ? raw.title : id),
    sessionId,
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
  };
}

/**
 * Describe which documented rc.2 seams the injected bundle exposes. Used by the
 * composition root to decide `health` (a missing events/tools service is a
 * degraded plugin, never a silent `ready`).
 * @param {object} [dsh]
 */
export function describeDshSeams(dsh = {}) {
  const events = isRecord(dsh?.events) && typeof dsh.events.on === 'function';
  const sessions = isRecord(dsh?.sessions)
    && (typeof dsh.sessions.list === 'function' || typeof dsh.sessions.get === 'function');
  const conversation = isRecord(dsh?.conversation);
  const interactions = isRecord(dsh?.interactions) && typeof dsh.interactions.settle === 'function';
  const attachmentsSave = isRecord(dsh?.attachments) && typeof dsh.attachments.save === 'function';
  const attachmentsRead = isRecord(dsh?.attachments) && typeof dsh.attachments.read === 'function';
  const webServer = isRecord(dsh?.webServer) && typeof dsh.webServer.mount === 'function';
  return Object.freeze({
    events,
    sessions,
    conversation,
    interactions,
    attachments: attachmentsSave && attachmentsRead,
    webServer,
  });
}

/**
 * Adapt an injected DSH seam bundle to a validated HostPort.
 *
 * Seam bundle (all optional; `null`/missing = UNSUPPORTED for that capability):
 *   events        { on(name, handler, options) => disposer }   'session/event', 'agent/disposed'
 *   sessions      { list(), get(id) }                          agent/session accessor
 *   tasks         { list() }                                   optional task listing
 *   conversation  { followup/inject/steer/stop(payload) }      deliverToAgent / stop leaves
 *   interactions  { settle(request), query(hostRef) }          native approval/question bridge
 *   attachments   { save(request), read(request) }             attachment store
 *   webServer     { mount({path,maxBytes,handler}) => disposer } callback mount
 *
 * @param {object} options
 * @param {object} [options.dsh]
 * @param {string} [options.bootId] random per-process id embedded in every hostRef
 */
export function createDshHost({
  dsh = {},
  bootId = randomUUID(),
  now = Date.now,
  newId = randomUUID,
  logger = null,
  name = 'dsh-notifier',
} = {}) {
  const warn = (message) => {
    try { logger?.warn?.(`[${name}/host] ${message}`); } catch { /* logging is never fatal */ }
  };
  const events = isRecord(dsh?.events) ? dsh.events : null;
  const sessions = isRecord(dsh?.sessions) ? dsh.sessions : null;
  const tasks = isRecord(dsh?.tasks) ? dsh.tasks : null;
  const conversation = isRecord(dsh?.conversation) ? dsh.conversation : null;
  const interactions = isRecord(dsh?.interactions) ? dsh.interactions : null;
  const attachments = isRecord(dsh?.attachments) ? dsh.attachments : null;
  const webServer = isRecord(dsh?.webServer) ? dsh.webServer : null;

  async function getCapabilities() {
    return {
      converse: typeof conversation?.followup === 'function',
      steer: typeof conversation?.steer === 'function',
      stop: typeof conversation?.stop === 'function',
      questions: typeof interactions?.settle === 'function',
      approvals: typeof interactions?.settle === 'function',
      attachments: typeof attachments?.save === 'function' && typeof attachments?.read === 'function',
      callbackMount: typeof webServer?.mount === 'function',
      // rc.2 has no cross-process interaction query: recovery is process-only.
      interactionRecovery: 'process-only',
    };
  }

  const port = {
    async listTasks() {
      if (typeof tasks?.list !== 'function') return [];
      const list = await tasks.list();
      return (Array.isArray(list) ? list : []).map(taskViewOf).filter((item) => item !== null);
    },
    async listSessions() {
      if (typeof sessions?.list !== 'function') return [];
      const list = await sessions.list();
      return (Array.isArray(list) ? list : []).map(sessionViewOf).filter((item) => item !== null);
    },
    async getSession(id) {
      if (typeof sessions?.get !== 'function') return null;
      return sessionViewOf(await sessions.get(id));
    },
    async submit({ sessionId, mode, text, attachments: files = [], requestId, signal }) {
      const deliver = conversation?.[mode];
      if (typeof deliver !== 'function') {
        throw new DomainError('UNSUPPORTED', `${name}: dsh host cannot ${mode} into a session`);
      }
      const out = await deliver({ sessionId, text, attachments: files, requestId, signal });
      return {
        hostRef: makeHostRef(bootId, newId()),
        turnId: typeof out?.turnId === 'string' ? out.turnId : null,
      };
    },
    async stop({ sessionId, requestId, signal }) {
      if (typeof conversation?.stop !== 'function') {
        throw new DomainError('UNSUPPORTED', `${name}: dsh host cannot stop a session`);
      }
      const out = await conversation.stop({ sessionId, requestId, signal });
      return { stopped: out?.stopped === true };
    },
    async settleInteraction(x) {
      if (typeof interactions?.settle !== 'function') {
        throw new DomainError('UNSUPPORTED', `${name}: dsh host cannot settle interactions`);
      }
      const out = await interactions.settle({
        hostRef: x.hostRef,
        decision: x.decision,
        ...(x.choiceIds !== undefined ? { choiceIds: x.choiceIds } : {}),
        ...(x.text !== undefined ? { text: x.text } : {}),
        requestId: x.requestId,
        signal: x.signal,
      });
      return { status: out?.status === 'already_handled' ? 'already_handled' : 'resolved' };
    },
    async queryInteraction(hostRef) {
      if (typeof interactions?.query !== 'function') return { status: 'unknown' };
      const out = await interactions.query(hostRef);
      return { status: typeof out?.status === 'string' ? out.status : 'unknown' };
    },
    async saveAttachment(x) {
      if (typeof attachments?.save !== 'function') {
        throw new DomainError('UNSUPPORTED', `${name}: dsh host cannot save attachments`);
      }
      return attachments.save({
        sessionId: x.sessionId, name: x.name, mime: x.mime, bytes: x.bytes,
        requestId: x.requestId, signal: x.signal,
      });
    },
    async readAttachment(x) {
      if (typeof attachments?.read !== 'function') {
        throw new DomainError('UNSUPPORTED', `${name}: dsh host cannot read attachments`);
      }
      return attachments.read({ sessionId: x.sessionId, attachmentId: x.attachmentId, signal: x.signal });
    },
    subscribe(handler) {
      if (typeof events?.on !== 'function') return () => {};
      const disposers = [];
      const register = (event, listener) => {
        try {
          const dispose = events.on(event, listener, { global: true });
          if (typeof dispose === 'function') disposers.push(dispose);
        } catch (error) {
          warn(`event subscription failed (${event}): ${error?.code ?? error?.message ?? 'error'}`);
        }
      };
      register('session/event', (...args) => {
        const normalized = normalizeSessionEventArgs(args);
        if (normalized === null) return;
        const mapped = mapSessionEvent({ session: normalized.session, event: normalized.event, at: now(), newId });
        if (mapped !== null) handler(mapped);
      });
      register('agent/disposed', (payload) => {
        const mapped = mapAgentLifecycle(payload, { at: now(), newId });
        if (mapped !== null) handler(mapped);
      });
      return () => {
        for (const dispose of disposers.splice(0)) {
          try { dispose(); } catch { /* unsubscribe failures are never fatal */ }
        }
      };
    },
    getCapabilities,
    async mountCallback(x) {
      if (typeof webServer?.mount !== 'function') {
        throw new DomainError('UNSUPPORTED', `${name}: dsh host cannot mount callbacks`);
      }
      // Every seam is probed here; the failure paths above return typed errors.
      const dispose = await webServer.mount({ path: x.path, maxBytes: x.maxBytes, handler: x.handler });
      if (typeof dispose !== 'function') {
        throw new DomainError('INTERNAL', `${name}: dsh webServer.mount() must resolve to a disposer`);
      }
      return dispose;
    },
  };

  return wrapHostPort(port, { name });
}
