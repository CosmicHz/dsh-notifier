// Real DSH event facts -> typed v1 HostEvent (B04; 20-HOST-PROTOCOL-MAP.md,
// W03/W06/W25). Pure mapping only: no subscriptions, no host calls. The shapes
// come from the frozen sources (src/host-events.mjs, src/event-listener.mjs,
// src/inbound/conversation.mjs); event names are never invented.
import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors.mjs';

export const HOST_EVENT_TYPES = Object.freeze([
  'interaction.opened',
  'interaction.closed',
  'turn.started',
  'turn.output',
  'turn.completed',
  'turn.failed',
  'session.closed',
  'capabilities.changed',
]);

const KNOWN_FAILED_KINDS = new Set(['error', 'blocked', 'max-tokens', 'interrupted']);
const KNOWN_SUCCESS_KINDS = new Set(['completed', 'aborted']);

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function idOf(value) {
  if (typeof value === 'string' && value !== '') return value;
  if (isRecord(value) && typeof value.id === 'string' && value.id !== '') return value.id;
  return null;
}

/**
 * Normalize the documented `(session, event)` tuple and the one explicit
 * envelope fallback. Anything else is not a host session event.
 */
export function normalizeSessionEventArgs(args) {
  if (!Array.isArray(args)) return null;
  const [first, second] = args;
  if (args.length === 2 && isRecord(first) && isRecord(second) && typeof second.type === 'string') {
    return { session: first, event: second, shape: 'tuple' };
  }
  if (args.length === 1 && isRecord(first) && isRecord(first.session) && isRecord(first.event)
      && typeof first.event.type === 'string') {
    return { session: first.session, event: first.event, shape: 'envelope' };
  }
  return null;
}

/**
 * Text of one assistant/message event: multiple text blocks joined in order.
 * Never reads the removed `session.events` getter. Always returns '' on any
 * shape mismatch (no throw path).
 */
export function assistantTextOf(event) {
  if (!isRecord(event) || event.type !== 'assistant/message') return '';
  const blocks = event.data?.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** DSH documents lifecycle payloads as {agent}; a direct agent is legacy-only. */
export function normalizeAgentLifecyclePayload(payload) {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.agent)) return payload.agent;
  if (payload.id !== undefined || isRecord(payload.session)) return payload;
  return null;
}

function checkCapabilitiesShape(capabilities) {
  if (!isRecord(capabilities)) throw new DomainError('INTERNAL', 'capabilities.changed requires capabilities');
  return capabilities;
}

/**
 * Map one `session/event` tuple to a typed HostEvent, or null when the event is
 * not a surface event v1 subscribes to.
 * @param {object} input
 * @param {object} input.session
 * @param {object} input.event
 * @param {number} [input.at]
 * @param {()=>string} [input.newId]
 */
export function mapSessionEvent({ session, event, at = Date.now(), newId = randomUUID } = {}) {
  if (!isRecord(session) || !isRecord(event)) return null;
  const sessionId = idOf(session);
  if (sessionId === null) return null;
  const base = { eventId: typeof event.id === 'string' && event.id !== '' ? event.id : newId(), at };
  const turnId = event.data?.turn;

  switch (event.type) {
    case 'turn/start':
      return { ...base, type: 'turn.started', sessionId, turnId: idOf(turnId) ?? String(turnId ?? '') };
    case 'assistant/message':
      return {
        ...base,
        type: 'turn.output',
        sessionId,
        turnId: idOf(turnId) ?? String(turnId ?? ''),
        text: assistantTextOf(event),
        attachments: [],
      };
    case 'turn/end': {
      const kind = event.data?.reason?.kind;
      if (KNOWN_FAILED_KINDS.has(kind)) {
        return { ...base, type: 'turn.failed', sessionId, turnId: idOf(turnId) ?? String(turnId ?? ''), code: String(kind).toUpperCase() };
      }
      if (KNOWN_SUCCESS_KINDS.has(kind)) {
        return { ...base, type: 'turn.completed', sessionId, turnId: idOf(turnId) ?? String(turnId ?? '') };
      }
      // Unknown reason: keep a redacted code rather than inferring success.
      return { ...base, type: 'turn.failed', sessionId, turnId: idOf(turnId) ?? String(turnId ?? ''), code: 'TURN_END_UNKNOWN' };
    }
    default:
      return null;
  }
}

/** Map a host agent lifecycle payload; only `disposed` closes the session. */
export function mapAgentLifecycle(payload, { at = Date.now(), newId = randomUUID } = {}) {
  if (!isRecord(payload) || typeof payload.type !== 'string') return null;
  if (payload.type !== 'agent/disposed') return null;
  const agent = normalizeAgentLifecyclePayload(payload);
  if (agent === null) return null;
  const sessionId = idOf(agent.session) ?? idOf(agent.sessionId);
  if (sessionId === null) return null;
  return { eventId: newId(), at, type: 'session.closed', sessionId };
}

export function mapCapabilitiesChanged(capabilities, { at = Date.now(), newId = randomUUID } = {}) {
  return { eventId: newId(), at, type: 'capabilities.changed', capabilities: checkCapabilitiesShape(capabilities) };
}

/** Shallow typed-event guard used by the runtime event bus. */
export function isHostEvent(value) {
  return isRecord(value)
    && typeof value.eventId === 'string'
    && typeof value.at === 'number'
    && HOST_EVENT_TYPES.includes(value.type);
}