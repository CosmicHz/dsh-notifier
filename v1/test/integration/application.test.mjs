// T26 DSH integration acceptance (18-WIRING.md, 05-HOST-CLI.md, 20-HOST-PROTOCOL-MAP.md).
//
// Real Store on a temp dir + the in-memory Host fixture. Covers the assembled
// Host call shapes, the tool events (registered shape + "no trusted context ->
// reject"), the attachment boundary (HostPort, UNSUPPORTED when absent) and the
// reverse-order disposal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, commit } from '../../src/storage/store.mjs';
import { createApplication, stableRequestId } from '../../src/runtime/application.mjs';
import { createDshHost, describeDshSeams } from '../../src/host/dsh.mjs';
import { createProjection } from '../../src/runtime/projection.mjs';
import { createFixtureHost } from '../fixtures/host.mjs';
import { apply, registerTools } from '../../src/plugin-entry.mjs';
import { claimInteraction, resolveClaim } from '../../src/services/interactions.mjs';

const REQ_ID = '11111111-1111-4111-8111-111111111111';

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-app-'));
  const { store } = await openStore(dir);
  return { dir, store };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function fakeCtx({ withEvents = true, withTools = true } = {}) {
  const registered = [];
  const provided = [];
  const unregistered = [];
  const unprovided = [];
  const ctx = {
    logger: null,
    registered,
    provided,
    unregistered,
    unprovided,
    provide(name, service) {
      provided.push({ name, service });
      return () => unprovided.push(name);
    },
    get() { return null; },
  };
  if (withEvents) ctx.on = () => () => {};
  if (withTools) ctx.tools = { register(tool) { registered.push(tool); return () => unregistered.push(tool.name); } };
  return ctx;
}

/** A recording DSH seam bundle; every call is observable. */
function recordingDsh() {
  const calls = { followup: [], inject: [], steer: [], stop: [], settle: [], query: [], save: [], read: [], mount: [] };
  const deliver = (bucket) => async (x) => { calls[bucket].push(x); return { turnId: 'turn-9' }; };
  return {
    calls,
    dsh: {
      events: { on: () => () => {} },
      sessions: { list: async () => [], get: async () => null },
      conversation: {
        followup: deliver('followup'),
        inject: deliver('inject'),
        steer: deliver('steer'),
        async stop(x) { calls.stop.push(x); return { stopped: true }; },
      },
      interactions: {
        async settle(x) { calls.settle.push(x); return { status: 'resolved' }; },
        async query(hostRef) { calls.query.push(hostRef); return { status: 'pending' }; },
      },
      attachments: {
        async save(x) { calls.save.push(x); return { id: 'att-1', name: x.name, mime: x.mime, size: x.bytes.byteLength }; },
        async read(x) { calls.read.push(x); return { name: 'f.txt', mime: 'text/plain', bytes: new Uint8Array([1, 2, 3]) }; },
      },
      webServer: { async mount(x) { calls.mount.push(x); return () => {}; } },
    },
  };
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

test('assembly: createApplication -> start wires the runtime, health is ready, stop/dispose are idempotent', async () => {
  const { store } = await scratch();
  const host = createFixtureHost();
  const projection = createProjection({ bootId: 'boot-t26', now: () => 0 });
  const app = createApplication({
    store,
    host,
    projection,
    managerOptions: { resolveProvider: () => null },
  });

  assert.equal(app.state, 'created');
  const started = await app.start();
  assert.equal(started.status, 'running');
  assert.equal(app.state, 'running');
  assert.equal(app.health().status, 'ready');
  assert.equal(app.manager.state, 'running');
  assert.equal(app.host, host, 'the injected HostPort is used as-is');

  // Host events reach the running dispatch loop (subscription installed first).
  const before = projection.surfaceVersion().sequence;
  host.emitted({
    eventId: 'ev-1', at: 1, type: 'capabilities.changed',
    capabilities: { converse: true, steer: true, stop: true, questions: true, approvals: true, attachments: true, callbackMount: true, interactionRecovery: 'process-only' },
  });
  assert.ok(await waitFor(() => projection.surfaceVersion().sequence > before), 'a host event invalidates the projection');

  await app.stop();
  assert.equal(app.state, 'stopped');
  await app.stop(); // idempotent
  assert.equal(app.state, 'stopped');
  await app.dispose();
  await app.dispose();
  assert.equal(app.state, 'stopped');
});

test('storage degraded is diagnostic-only: no Store, no runtime, typed reason', async () => {
  const app = createApplication({
    stateDir: '/nowhere',
    openStoreImpl: async () => ({ status: 'degraded', store: null, error: new Error('corrupt state.json') }),
  });
  const started = await app.start();
  assert.equal(started.status, 'degraded');
  assert.equal(app.state, 'degraded');
  assert.equal(app.store, null, 'no half-usable Store');
  assert.equal(app.manager, null, 'no half-usable runtime');
  assert.equal(app.health().status, 'degraded');
  assert.equal(app.health().code, 'STORAGE_UNAVAILABLE');
  assert.equal(app.diagnostics().storeReady, false);
  assert.equal(app.diagnostics().detail, 'corrupt state.json');
  await app.dispose();
  assert.equal(app.state, 'stopped');
});

test('a missing events service degrades health instead of reporting ready', async () => {
  const { store } = await scratch();
  const app = createApplication({ store, dsh: {}, logger: null });
  await app.start();
  assert.equal(app.state, 'running');
  assert.equal(app.health().status, 'degraded');
  assert.equal(app.health().code, 'HOST_EVENTS_UNAVAILABLE');
  assert.deepEqual(describeDshSeams({}), {
    events: false, sessions: false, conversation: false, interactions: false, attachments: false, webServer: false,
  });
  await app.dispose();
});

test('teardown runs registered disposers in reverse registration order', async () => {
  const { store } = await scratch();
  const order = [];
  const app = createApplication({ store, host: createFixtureHost(), managerOptions: { resolveProvider: () => null } });
  app.registerDisposer(() => order.push('a'));
  app.registerDisposer(() => order.push('b'));
  await app.start();
  app.registerDisposer(() => order.push('c'));
  await app.dispose();
  assert.deepEqual(order, ['c', 'b', 'a']);
});

// ---------------------------------------------------------------------------
// Host call shapes (fake dsh -> HostPort -> recorded seam calls)
// ---------------------------------------------------------------------------

test('Host call shape: submit/stop/settle/query/save/read use the frozen argument shapes', async () => {
  const { dsh, calls } = recordingDsh();
  let seq = 0;
  const host = createDshHost({ dsh, bootId: 'boot-1', newId: () => `id-${++seq}`, now: () => 42 });
  const signal = new AbortController().signal;

  const submitted = await host.submit({
    sessionId: 's-1', mode: 'followup', text: 'hi', attachments: [], requestId: 'r-1', signal,
  });
  assert.equal(calls.followup.length, 1);
  assert.equal(calls.followup[0].sessionId, 's-1');
  assert.equal(calls.followup[0].text, 'hi');
  assert.equal(calls.followup[0].requestId, 'r-1');
  assert.equal(calls.followup[0].signal, signal);
  assert.match(submitted.hostRef, /^boot-1:/, 'the adapter owns the hostRef boot prefix');
  assert.equal(submitted.turnId, 'turn-9');

  const stopped = await host.stop({ sessionId: 's-2', requestId: 'r-2', signal });
  assert.deepEqual(calls.stop[0], { sessionId: 's-2', requestId: 'r-2', signal });
  assert.equal(stopped.stopped, true);

  const settled = await host.settleInteraction({
    hostRef: 'boot-1:waiter-1', decision: 'answer', choiceIds: ['c1'], text: 'x', requestId: 'r-3', signal,
  });
  assert.equal(calls.settle[0].hostRef, 'boot-1:waiter-1');
  assert.equal(calls.settle[0].decision, 'answer');
  assert.deepEqual(calls.settle[0].choiceIds, ['c1']);
  assert.equal(calls.settle[0].text, 'x');
  assert.equal(settled.status, 'resolved');

  assert.deepEqual(await host.queryInteraction('boot-1:waiter-1'), { status: 'pending' });
  assert.deepEqual(calls.query, ['boot-1:waiter-1']);

  const ref = await host.saveAttachment({
    sessionId: 's-1', name: 'a.txt', mime: 'text/plain', bytes: new Uint8Array([9]), requestId: 'r-4', signal,
  });
  assert.equal(calls.save[0].sessionId, 's-1');
  assert.equal(calls.save[0].name, 'a.txt');
  assert.equal(calls.save[0].mime, 'text/plain');
  assert.equal(calls.save[0].bytes.byteLength, 1);
  assert.equal(ref.id, 'att-1');

  const read = await host.readAttachment({ sessionId: 's-1', attachmentId: 'att-1', signal });
  assert.deepEqual(calls.read[0], { sessionId: 's-1', attachmentId: 'att-1', signal });
  assert.deepEqual([...read.bytes], [1, 2, 3]);

  const caps = await host.getCapabilities();
  assert.equal(caps.converse, true);
  assert.equal(caps.interactionRecovery, 'process-only', 'rc.2 recovery is process-only');
});

test('Host call shape: a missing capability is a typed UNSUPPORTED, never a fake success', async () => {
  const host = createDshHost({ dsh: {} });
  const signal = new AbortController().signal;
  await assert.rejects(() => host.submit({ sessionId: 's', mode: 'followup', text: 't', attachments: [], requestId: 'r', signal }), (e) => e.code === 'UNSUPPORTED');
  await assert.rejects(() => host.stop({ sessionId: 's', requestId: 'r', signal }), (e) => e.code === 'UNSUPPORTED');
  await assert.rejects(() => host.settleInteraction({ hostRef: 'h', decision: 'approve', requestId: 'r', signal }), (e) => e.code === 'UNSUPPORTED');
  await assert.rejects(() => host.saveAttachment({ sessionId: 's', name: 'n', mime: 'm', bytes: new Uint8Array(), requestId: 'r', signal }), (e) => e.code === 'UNSUPPORTED');
  await assert.rejects(() => host.readAttachment({ sessionId: 's', attachmentId: 'a', signal }), (e) => e.code === 'UNSUPPORTED');
  await assert.rejects(() => host.mountCallback({ path: '/x', maxBytes: 1024, handler: async () => ({ status: 200, headers: {}, body: new Uint8Array() }) }), (e) => e.code === 'UNSUPPORTED');
  assert.deepEqual(await host.queryInteraction('foreign'), { status: 'unknown' });
});

// ---------------------------------------------------------------------------
// tool events
// ---------------------------------------------------------------------------

test('tool events: notify/notify_test/ask_user register, rejects without trusted context, and release in reverse', async () => {
  const { store } = await scratch();
  const app = createApplication({ store, host: createFixtureHost(), managerOptions: { resolveProvider: () => null } });
  await app.start();

  const ctx = fakeCtx();
  const release = registerTools(ctx, app);
  assert.deepEqual(ctx.registered.map((t) => t.name), ['notify', 'notify_test', 'ask_user']);
  const notify = ctx.registered.find((t) => t.name === 'notify');
  assert.equal(notify.parameters.required[0], 'text');

  // Trusted context: scope comes from execContext, never the model.
  const receipts = await notify.execute({ text: 'hello' }, { agent: { id: 'ag-1', session: { id: 's-1' } }, callId: 'call-1' });
  assert.ok(Array.isArray(receipts.receipts));

  // No trusted context -> reject.
  await assert.rejects(() => notify.execute({ text: 'x' }, {}), (e) => e.code === 'FORBIDDEN');

  const notifyTest = ctx.registered.find((t) => t.name === 'notify_test');
  await assert.rejects(
    () => notifyTest.execute({ destinationId: 'd-1' }, { agent: { id: 'ag-1', session: { id: 's-1' } } }),
    (e) => e.code === 'FORBIDDEN',
    'notify_test is local-management only',
  );

  // ask_user opens a durable question and waits for a single winner.
  const askUser = ctx.registered.find((t) => t.name === 'ask_user');
  await assert.rejects(() => askUser.execute({ prompt: 'pick' }, {}), (e) => e.code === 'FORBIDDEN');

  const pending = askUser.execute(
    { prompt: 'pick one', choices: [{ id: 'a', label: 'A' }], timeoutMs: 5000 },
    { agent: { id: 'ag-1', session: { id: 's-1' } } },
  );
  assert.ok(await waitFor(() => Object.values(store.snapshot().interactions).some((i) => i.state === 'pending')));
  const interaction = Object.values(store.snapshot().interactions)[0];
  assert.equal(interaction.type, 'question');
  await commit(store, null, (draft) => {
    claimInteraction(draft, {
      id: interaction.id,
      decision: 'answer',
      choiceIds: ['a'],
      actor: { kind: 'local-owner', id: 'tester' },
      requestId: REQ_ID,
      expectedRevision: interaction.revision,
    }, { now: 100 });
    resolveClaim(draft, interaction.id, { status: 'resolved', now: 101 });
    return null;
  });
  assert.deepEqual(await pending, { status: 'answered', choiceIds: ['a'], text: null });

  release();
  assert.deepEqual(ctx.unregistered, ['ask_user', 'notify_test', 'notify'], 'tools release in reverse registration order');
  await app.dispose();
});

test('requestId is stable for a given tool callId and valid UUID-shaped', () => {
  const a = stableRequestId('call-1');
  const b = stableRequestId('call-1');
  const c = stableRequestId('call-2');
  assert.equal(a, b, 'a retried call keeps the same requestId');
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

test('plugin-entry: apply provides notifierV1, registers tools when serviceable, releases in reverse', async () => {
  const { dir } = await scratch();
  const ctx = fakeCtx();
  const dispose = apply(ctx, { stateDir: dir });

  assert.ok(await waitFor(() => ctx.registered.length === 3), 'tools register once the runtime is serviceable');
  assert.deepEqual(ctx.provided.map((p) => p.name), ['notifierV1'], 'the service is published with ctx.provide');
  assert.equal(ctx.provided[0].service.version, 1);
  assert.equal(ctx.provided[0].service.health().status, 'ready');
  assert.deepEqual(ctx.registered.map((t) => t.name), ['notify', 'notify_test', 'ask_user']);

  await dispose();
  assert.deepEqual(ctx.unregistered, ['ask_user', 'notify_test', 'notify']);
  assert.deepEqual(ctx.unprovided, ['notifierV1']);
});

test('plugin-entry: a host without events degrades and registers no executable tool', async () => {
  const { dir } = await scratch();
  const ctx = fakeCtx({ withEvents: false });
  const dispose = apply(ctx, { stateDir: dir });

  assert.ok(await waitFor(() => ctx.provided.length === 1 && ctx.provided[0].service.health().status === 'degraded'));
  assert.equal(ctx.provided[0].service.health().code, 'HOST_EVENTS_UNAVAILABLE');
  assert.equal(ctx.registered.length, 0, 'no executable write tool is registered in a degraded state');
  await dispose();
  assert.deepEqual(ctx.unprovided, ['notifierV1']);
});

test('plugin-entry: a damaged store registry exposes diagnostics only', async () => {
  const ctx = fakeCtx();
  const dispose = apply(ctx, {}); // no stateDir -> storage degraded

  assert.ok(await waitFor(() => ctx.provided.length === 1 && ctx.provided[0].service.health().status === 'degraded'));
  assert.equal(ctx.provided[0].service.health().code, 'STORAGE_UNAVAILABLE');
  assert.equal(ctx.registered.length, 0);
  await dispose();
  assert.deepEqual(ctx.unprovided, ['notifierV1']);
});
