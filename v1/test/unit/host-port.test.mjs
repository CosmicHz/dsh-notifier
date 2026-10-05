import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateHostPort, wrapHostPort, createUnavailableHost, HOST_METHODS,
} from '../../src/host/port.mjs';
import { createFixtureHost } from '../fixtures/host.mjs';
import { DomainError } from '../../src/domain/errors.mjs';

const signal = () => new AbortController().signal;
const isUnsupported = (e) => e instanceof DomainError && e.code === 'UNSUPPORTED';

test('validateHostPort requires every method', () => {
  const host = createFixtureHost();
  assert.equal(validateHostPort(host), host);
  for (const method of HOST_METHODS) {
    const broken = createFixtureHost();
    delete broken[method];
    assert.throws(() => validateHostPort(broken), new RegExp(method));
  }
});

test('the fixture host satisfies the full contract shape', async () => {
  const host = createFixtureHost();
  const port = wrapHostPort(host);
  host.addSession({ id: 's1', agentId: 'ag', workspaceId: 'ws', label: 'Session', status: 'idle' });
  host.addTask({ id: 't1', label: 'Task', sessionId: 's1', status: 'running' });
  assert.deepEqual(await port.listTasks(), [{ id: 't1', label: 'Task', sessionId: 's1', status: 'running' }]);
  assert.equal((await port.listSessions()).length, 1);
  assert.equal((await port.getSession('s1')).status, 'idle');
  assert.equal(await port.getSession('missing'), null);
  const caps = await port.getCapabilities();
  assert.equal(caps.converse, true);
  assert.equal(caps.interactionRecovery, 'queryable');
});

test('submit validates mode/shape and returns {hostRef,turnId}', async () => {
  const host = createFixtureHost();
  const port = wrapHostPort(host);
  await assert.rejects(
    port.submit({ sessionId: 's1', mode: 'nope', text: 'x', attachments: [], requestId: 'r1', signal: signal() }),
    /mode/,
  );
  await assert.rejects(
    port.submit({ sessionId: 's1', mode: 'followup', text: 'x', attachments: [], requestId: 'r1' }),
    /signal/,
  );
  const out = await port.submit({ sessionId: 's1', mode: 'followup', text: 'hi', attachments: [], requestId: 'r1', signal: signal() });
  assert.equal(typeof out.hostRef, 'string');
  assert.equal(typeof out.turnId, 'string');
});

test('capability gating returns UNSUPPORTED, never a fake success', async () => {
  const host = createFixtureHost({ capabilities: { steer: false, attachments: false, callbackMount: false } });
  const port = wrapHostPort(host);
  await assert.rejects(
    port.submit({ sessionId: 's1', mode: 'steer', text: 'x', attachments: [], requestId: 'r', signal: signal() }),
    isUnsupported,
  );
  await assert.rejects(
    port.saveAttachment({ sessionId: 's1', name: 'a.txt', mime: 'text/plain', bytes: new Uint8Array([1]), requestId: 'r', signal: signal() }),
    isUnsupported,
  );
  await assert.rejects(
    port.mountCallback({ path: '/x', maxBytes: 1024, handler: async () => ({ status: 200, headers: {}, body: new Uint8Array() }) }),
    isUnsupported,
  );
  // converse still works.
  const out = await port.submit({ sessionId: 's1', mode: 'followup', text: 'ok', attachments: [], requestId: 'r', signal: signal() });
  assert.equal(typeof out.hostRef, 'string');
});

test('capabilities refresh when the host reports a change', async () => {
  const host = createFixtureHost();
  const port = wrapHostPort(host);
  port.subscribe(() => {});
  assert.equal((await port.getCapabilities()).steer, true);
  host.setCapabilities({ steer: false });
  assert.equal((await port.getCapabilities()).steer, false, 'capabilities.changed must invalidate the cache');
  await assert.rejects(
    port.submit({ sessionId: 's1', mode: 'steer', text: 'x', attachments: [], requestId: 'r', signal: signal() }),
    isUnsupported,
  );
  // refreshCapabilities() is an explicit seam too.
  host.setCapabilities({ steer: true });
  port.refreshCapabilities();
  assert.equal((await port.getCapabilities()).steer, true);
});

test('settleInteraction surfaces already_handled without rewriting it', async () => {
  const host = createFixtureHost();
  const port = wrapHostPort(host);
  const base = { hostRef: 'h1', decision: 'approve', choiceIds: [], requestId: 'r', signal: signal() };
  assert.deepEqual(await port.settleInteraction(base), { status: 'resolved' });
  assert.deepEqual(await port.settleInteraction(base), { status: 'already_handled' });
});

test('queryInteraction returns a typed status', async () => {
  const host = createFixtureHost({ unknownInteractions: true });
  const port = wrapHostPort(host);
  assert.deepEqual(await port.queryInteraction('h1'), { status: 'unknown' });
  host.setCapabilities({ unknownInteractions: false });
});

test('subscribe validates emitted events', () => {
  const host = createFixtureHost();
  const port = wrapHostPort(host);
  const seen = [];
  const dispose = port.subscribe((event) => seen.push(event.type));
  host.emitted({ eventId: 'e1', at: Date.now(), type: 'turn.completed', sessionId: 's1', turnId: 't1' });
  assert.deepEqual(seen, ['turn.completed']);
  assert.throws(() => host.emitted({ type: 'bad' }), /malformed/);
  dispose();
  host.emitted({ eventId: 'e2', at: Date.now(), type: 'turn.completed', sessionId: 's1', turnId: 't1' });
  assert.equal(seen.length, 1);
});

test('the unavailable host denies every capability honestly', async () => {
  const port = wrapHostPort(createUnavailableHost('no host'));
  assert.deepEqual(await port.getCapabilities(), {
    converse: false, steer: false, stop: false, questions: false, approvals: false,
    attachments: false, callbackMount: false, interactionRecovery: 'process-only',
  });
  await assert.rejects(port.listTasks(), isUnsupported);
  await assert.rejects(port.submit({ sessionId: 's', mode: 'followup', text: 'x', attachments: [], requestId: 'r', signal: signal() }), isUnsupported);
  await assert.rejects(port.settleInteraction({ hostRef: 'h', decision: 'approve', requestId: 'r', signal: signal() }), isUnsupported);
  assert.equal(typeof port.subscribe(() => {}), 'function');
});

test('mountCallback enforces the 1MiB raw-body cap', async () => {
  const port = wrapHostPort(createFixtureHost());
  await assert.rejects(
    port.mountCallback({ path: '/x', maxBytes: 2 * 1024 * 1024, handler: async () => ({ status: 200, headers: {}, body: new Uint8Array() }) }),
    /maxBytes/,
  );
  const dispose = await port.mountCallback({
    path: '/dsh-notifier-v1/callback/tg/acc1',
    maxBytes: 1024 * 1024,
    handler: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
  });
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('wrapHostPort refuses a non-conforming host at construction', () => {
  assert.throws(() => wrapHostPort({}), /missing method/);
});