// B04: host waiters, real DSH event mapping and the public callback mount
// (W03/W06/W25). The callback mount must write the inbox before ACKing, and a
// rejection must never reach the store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostWaiters, parseHostRef, makeHostRef } from '../../src/host/waiters.mjs';
import {
  mapSessionEvent, mapAgentLifecycle, mapCapabilitiesChanged,
  normalizeSessionEventArgs, assistantTextOf,
} from '../../src/host/event-map.mjs';
import { createCallbackMount, parseCallbackPath, callbackPathOf } from '../../src/host/callbacks.mjs';
import { createFixtureHost } from '../fixtures/host.mjs';
import { createUnavailableHost } from '../../src/host/port.mjs';

test('hostRefs embed the boot id and parse without splitting platform ids', () => {
  const ref = makeHostRef('boot-1', 'waiter-1');
  assert.deepEqual(parseHostRef(ref), { bootId: 'boot-1', waiterId: 'waiter-1' });
  assert.equal(parseHostRef('opaque'), null);
  assert.equal(parseHostRef(':missing-boot'), null);
});

test('W03 a live waiter is pending, a settled one keeps its terminal status', () => {
  const waiters = createHostWaiters({ bootId: 'boot-1', now: () => 5, newId: () => 'w1' });
  const waiter = waiters.register({ type: 'approval' });
  assert.equal(waiters.query(waiter.hostRef), 'pending');
  waiters.settle(waiter.hostRef, 'resolved');
  assert.equal(waiters.query(waiter.hostRef), 'resolved');
  // Settling twice keeps the first answer.
  waiters.settle(waiter.hostRef, 'cancelled');
  assert.equal(waiters.query(waiter.hostRef), 'resolved');
});

test('W03 an unresolved waiter from a previous boot is cancelled, a foreign ref unknown', () => {
  const waiters = createHostWaiters({ bootId: 'boot-2' });
  assert.equal(waiters.query(makeHostRef('boot-1', 'gone')), 'cancelled');
  assert.equal(waiters.query('platform-opaque-ref'), 'unknown');
  assert.equal(waiters.query(makeHostRef('boot-2', 'never-registered')), 'unknown');
});

test('W03 dispose cancels every live waiter and is idempotent', async () => {
  const waiters = createHostWaiters({ bootId: 'boot-1', newId: (() => { let i = 0; return () => `w${i++}`; })() });
  const a = waiters.register();
  waiters.dispose();
  assert.equal(waiters.count(), 0);
  assert.equal(waiters.query(a.hostRef), 'cancelled');
  assert.deepEqual(await a.promise, { hostRef: a.hostRef, status: 'cancelled' });
  waiters.dispose();
});

test('normalizeSessionEventArgs accepts the tuple and the envelope only', () => {
  assert.deepEqual(normalizeSessionEventArgs([{ id: 's' }, { type: 'turn/start' }]).shape, 'tuple');
  assert.deepEqual(normalizeSessionEventArgs([{ session: { id: 's' }, event: { type: 'turn/start' } }]).shape, 'envelope');
  assert.equal(normalizeSessionEventArgs([{ id: 's' }]), null);
  assert.equal(normalizeSessionEventArgs('nope'), null);
});

test('W25 assistant/message maps to turn.output with joined text blocks', () => {
  assert.equal(assistantTextOf({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'a' }, { type: 'tool', id: 'x' }, { type: 'text', text: 'b' }] } },
  }), 'a\nb');
  const event = mapSessionEvent({
    session: { id: 's-1' },
    event: { id: 'e-1', type: 'assistant/message', data: { turn: 't-1', message: { content: [{ type: 'text', text: 'hi' }] } } },
    at: 100,
  });
  assert.deepEqual(event, { eventId: 'e-1', at: 100, type: 'turn.output', sessionId: 's-1', turnId: 't-1', text: 'hi', attachments: [] });
});

test('W25 turn/end maps known kinds and never infers success for an unknown reason', () => {
  const base = { session: { id: 's' }, at: 1, newId: () => 'e' };
  assert.equal(mapSessionEvent({ ...base, event: { type: 'turn/end', data: { turn: 't', reason: { kind: 'completed' } } } }).type, 'turn.completed');
  const failed = mapSessionEvent({ ...base, event: { type: 'turn/end', data: { turn: 't', reason: { kind: 'error' } } } });
  assert.equal(failed.type, 'turn.failed');
  assert.equal(failed.code, 'ERROR');
  const unknown = mapSessionEvent({ ...base, event: { type: 'turn/end', data: { turn: 't', reason: { kind: 'mystery' } } } });
  assert.equal(unknown.type, 'turn.failed');
  assert.equal(unknown.code, 'TURN_END_UNKNOWN');
  assert.equal(mapSessionEvent({ ...base, event: { type: 'other/thing' } }), null);
});

test('W25 agent/disposed closes the session; capabilities.changed is typed', () => {
  const closed = mapAgentLifecycle({ type: 'agent/disposed', agent: { session: { id: 's-9' } } }, { at: 7, newId: () => 'e' });
  assert.deepEqual(closed, { eventId: 'e', at: 7, type: 'session.closed', sessionId: 's-9' });
  assert.equal(mapAgentLifecycle({ type: 'agent/other' }), null);
  const caps = mapCapabilitiesChanged({ converse: true }, { at: 8, newId: () => 'e' });
  assert.equal(caps.type, 'capabilities.changed');
  assert.throws(() => mapCapabilitiesChanged(null), (e) => e.code === 'INTERNAL');
});

// --- callback mount --------------------------------------------------------

const PATH = callbackPathOf('telegram', 'acc-1');

function callbackProvider({ ok = true, ack } = {}) {
  const calls = [];
  return {
    id: 'telegram',
    capabilities: { inbound: true, callbackReply: true },
    calls,
    async handleCallback(x) {
      calls.push(x);
      if (!ok) return { ok: false, ack: { status: 401, headers: {}, body: new TextEncoder().encode('bad sig') } };
      return { ok: true, envelope: { kind: 'message', eventId: 'ev-1', accountId: 'acc-1', epoch: x.epoch } };
    },
    callbackAck: ack ?? (() => ({ status: 200, headers: {}, body: new TextEncoder().encode('ack') })),
  };
}

async function mountWith(provider, { ingest } = {}) {
  const host = createFixtureHost();
  const ingested = [];
  const mount = createCallbackMount({
    host,
    epoch: 'ep-1',
    resolveAccount: () => ({ id: 'acc-1', channelId: 'telegram', enabled: true }),
    resolveProvider: () => provider,
    ingest: ingest ?? (async (envelope) => { ingested.push(envelope); return { replayed: false }; }),
  });
  const result = await mount.mountAccount({ id: 'acc-1', channelId: 'telegram', enabled: true });
  return { host, mount, ingested, result };
}

test('W06 a verified callback is durably received before the ack is returned', async () => {
  const provider = callbackProvider();
  const { host, ingested, result } = await mountWith(provider);
  assert.equal(result.mounted, true);
  assert.equal(result.path, PATH);

  const order = [];
  provider.callbackAck = () => { order.push('ack'); return { status: 200, headers: {}, body: new Uint8Array() }; };
  const response = await host.invokeCallback(PATH, {
    method: 'POST', headers: {}, rawBody: new TextEncoder().encode('{}'), signal: new AbortController().signal,
  });
  assert.equal(response.status, 200);
  assert.equal(ingested.length, 1);
  assert.deepEqual(order, ['ack']);
});

test('W06 a rejected signature never reaches the store', async () => {
  const provider = callbackProvider({ ok: false });
  const { host, ingested } = await mountWith(provider);
  const response = await host.invokeCallback(PATH, {
    method: 'POST', headers: {}, rawBody: new TextEncoder().encode('{}'), signal: new AbortController().signal,
  });
  assert.equal(response.status, 401);
  assert.equal(ingested.length, 0);
});

test('W06 an oversized body is 413 before any provider verification', async () => {
  const provider = callbackProvider();
  const { host, ingested } = await mountWith(provider);
  const response = await host.invokeCallback(PATH, {
    method: 'POST', headers: {}, rawBody: new Uint8Array(1024 * 1024 + 1), signal: new AbortController().signal,
  });
  assert.equal(response.status, 413);
  assert.equal(provider.calls.length, 0);
  assert.equal(ingested.length, 0);
});

test('W06 a stale epoch is rejected before the durable write', async () => {
  const provider = {
    id: 'telegram',
    capabilities: { inbound: true },
    async handleCallback() { return { ok: true, envelope: { kind: 'message', eventId: 'e', accountId: 'acc-1', epoch: 'old' } }; },
  };
  const { host, ingested } = await mountWith(provider);
  const response = await host.invokeCallback(PATH, {
    method: 'POST', headers: {}, rawBody: new Uint8Array(), signal: new AbortController().signal,
  });
  assert.equal(response.status, 409);
  assert.equal(ingested.length, 0);
});

test('W06 a failed durable write returns a retryable 503, not a success', async () => {
  const provider = callbackProvider();
  const { host } = await mountWith(provider, { ingest: async () => { throw new Error('disk full'); } });
  const response = await host.invokeCallback(PATH, {
    method: 'POST', headers: {}, rawBody: new Uint8Array(), signal: new AbortController().signal,
  });
  assert.equal(response.status, 503);
});

test('W06 a host without callback mount reports CALLBACK_UNAVAILABLE', async () => {
  const host = createUnavailableHost('DSH host has no webServer');
  const unavailable = [];
  const mount = createCallbackMount({
    host, epoch: 'ep-1',
    resolveAccount: () => ({ id: 'acc-1', channelId: 'wxpusher', enabled: true }),
    resolveProvider: () => ({ id: 'wxpusher', capabilities: { inbound: true }, handleCallback: async () => ({ ok: false }) }),
    ingest: async () => ({ replayed: false }),
    onUnavailable: (reason) => unavailable.push(reason),
  });
  const result = await mount.mountAccount({ id: 'acc-1', channelId: 'wxpusher', enabled: true });
  assert.equal(result.mounted, false);
  assert.equal(result.code, 'CALLBACK_UNAVAILABLE');
  assert.deepEqual(unavailable, ['CALLBACK_UNAVAILABLE']);
});

test('callback paths are matched exactly', () => {
  assert.deepEqual(parseCallbackPath(`${PATH}?x=1`), { channelId: 'telegram', accountId: 'acc-1' });
  assert.equal(parseCallbackPath('/dsh-notifier-v1/callback/telegram'), null);
  assert.equal(parseCallbackPath('/other/telegram/acc-1'), null);
});