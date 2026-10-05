// A real in-memory DSH host used by unit/integration tests. It implements every
// HostPort method with observable behavior (no fake success) so tests exercise the
// same contract the real host adapter must satisfy.
import { randomUUID } from 'node:crypto';

export function createFixtureHost(overrides = {}) {
  const sessions = new Map();
  const tasks = new Map();
  const attachments = new Map();
  const callbacks = new Map();
  const subscribers = new Set();
  const handled = new Map();
  const submitted = [];
  let capabilities = {
    converse: true, steer: true, stop: true, questions: true, approvals: true,
    attachments: true, callbackMount: true, interactionRecovery: 'queryable',
    ...overrides.capabilities,
  };

  function emit(event) {
    for (const handler of subscribers) handler(event);
  }

  function addSession(session) {
    sessions.set(session.id, session);
    return session;
  }

  function addTask(task) {
    tasks.set(task.id, task);
    return task;
  }

  const host = {
    addSession,
    addTask,
    submitted,
    emitted: emit,
    setCapabilities(next) {
      capabilities = { ...capabilities, ...next };
      emit({ eventId: randomUUID(), at: Date.now(), type: 'capabilities.changed', capabilities });
    },
    async listTasks() {
      return [...tasks.values()].map((t) => ({ ...t }));
    },
    async listSessions() {
      return [...sessions.values()].map((s) => ({ ...s }));
    },
    async getSession(id) {
      const session = sessions.get(id);
      return session ? { ...session } : null;
    },
    async submit(x) {
      if (x.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const hostRef = randomUUID();
      const turnId = randomUUID();
      submitted.push({ ...x });
      emit({ eventId: randomUUID(), at: Date.now(), type: 'turn.started', sessionId: x.sessionId, turnId });
      if (overrides.autoComplete !== false) {
        queueMicrotask(() => {
          emit({
            eventId: randomUUID(), at: Date.now(), type: 'turn.output',
            sessionId: x.sessionId, turnId, text: `echo:${x.text}`, attachments: [],
          });
          emit({ eventId: randomUUID(), at: Date.now(), type: 'turn.completed', sessionId: x.sessionId, turnId });
        });
      }
      return { hostRef, turnId };
    },
    async stop() {
      return { stopped: true };
    },
    async settleInteraction(x) {
      if (handled.has(x.hostRef)) return { status: 'already_handled' };
      handled.set(x.hostRef, x);
      return { status: 'resolved' };
    },
    async queryInteraction(hostRef) {
      if (handled.has(hostRef)) return { status: 'resolved' };
      if (overrides.unknownInteractions === true) return { status: 'unknown' };
      return { status: 'pending' };
    },
    async saveAttachment(x) {
      const id = randomUUID();
      attachments.set(id, { name: x.name, mime: x.mime, bytes: x.bytes });
      return { id, name: x.name, mime: x.mime, size: x.bytes.byteLength };
    },
    async readAttachment(x) {
      const found = attachments.get(x.attachmentId);
      if (!found) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
      return { name: found.name, mime: found.mime, bytes: found.bytes };
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    async getCapabilities() {
      return { ...capabilities };
    },
    async mountCallback(x) {
      callbacks.set(x.path, x.handler);
      return () => callbacks.delete(x.path);
    },
    callbacks,
    async invokeCallback(path, request) {
      const handler = callbacks.get(path);
      if (!handler) throw new Error(`no callback mounted at ${path}`);
      return handler(request);
    },
  };
  return host;
}