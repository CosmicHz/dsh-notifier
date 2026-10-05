// R05: Telegram offset 推进逻辑测试
// 验证：只有可靠接收/明确已去重才能推进连续水位；任一未接受停止该批并保留旧offset
import { test } from 'node:test';
import assert from 'node:assert/strict';
import telegram from '../../src/providers/telegram/index.mjs';

function makeNetwork(responder) {
  const calls = [];
  const network = {
    calls,
    async request(init) {
      calls.push(init);
      if (init.signal?.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'CANCELLED' });
      }
      const result = await responder(init, calls.length - 1);
      if (result instanceof Error) throw result;
      const body = result.body ?? result.text ?? new Uint8Array();
      return {
        status: result.status ?? 200,
        headers: result.headers ?? {},
        body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
      };
    },
  };
  return network;
}

function jsonResponse(value, status = 200) {
  return { status, text: JSON.stringify(value), headers: { 'content-type': 'application/json' } };
}

async function waitFor(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

test('R05: offset advances only when all updates are accepted or deduplicated', async (t) => {
  const account = {
    id: 'acc-tg-r05',
    channelId: 'telegram',
    config: { inbound: {}, outbound: {} },
    secrets: { 'inbound.botToken': { kind: 'literal', value: '"TOK"' } },
  };

  await t.test('all accepted: offset advances to 103', async () => {
    const cursorStore = {
      lastCommit: null,
      load: () => ({ offset: 100 }),
      commit: async (_id, transportData) => {
        cursorStore.lastCommit = transportData;
        return { advanced: true };
      },
    };

    const emittedEvents = [];
    let pollCount = 0;
    const network = makeNetwork((init) => {
      if (!init.url.includes('/getUpdates')) {
        return jsonResponse({ ok: true, result: {} });
      }
      pollCount++;
      if (pollCount === 1) {
        return jsonResponse({
          ok: true,
          result: [
            { update_id: 100, message: { message_id: 1, chat: { id: 555, type: 'private' }, from: { id: 555 }, text: 'msg1' } },
            { update_id: 101, message: { message_id: 2, chat: { id: 555, type: 'private' }, from: { id: 555 }, text: 'msg2' } },
            { update_id: 102, message: { message_id: 3, chat: { id: 555, type: 'private' }, from: { id: 555 }, text: 'msg3' } },
          ],
        });
      }
      return jsonResponse({ ok: true, result: [] });
    });

    const controller = new AbortController();
    const handle = await telegram.start({
      account,
      epoch: 'e1',
      network,
      signal: controller.signal,
      cursorStore,
      emit: async (envelope) => {
        emittedEvents.push(envelope);
        if (emittedEvents.length >= 3) controller.abort();
        return { accepted: true };
      },
    });

    await waitFor(() => emittedEvents.length === 3);
    await handle.stop();

    assert.equal(emittedEvents.length, 3);
    assert.equal(cursorStore.lastCommit?.offset, 103);
  });

  await t.test('second rejected: offset stays at 100', async () => {
    const cursorStore = {
      lastCommit: null,
      load: () => ({ offset: 100 }),
      commit: async (_id, transportData) => {
        cursorStore.lastCommit = transportData;
        return { advanced: true };
      },
    };

    const emittedEvents = [];
    let pollCount = 0;
    const network = makeNetwork((init) => {
      if (!init.url.includes('/getUpdates')) {
        return jsonResponse({ ok: true, result: {} });
      }
      pollCount++;
      if (pollCount === 1) {
        return jsonResponse({
          ok: true,
          result: [
            { update_id: 100, message: { message_id: 1, chat: { id: 555, type: 'private' }, from: { id: 555 }, text: 'msg1' } },
            { update_id: 101, message: { message_id: 2, chat: { id: 555, type: 'private' }, from: { id: 555 }, text: 'msg2' } },
            { update_id: 102, message: { message_id: 3, chat: { id: 555, type: 'private' }, from: { id: 555 }, text: 'msg3' } },
          ],
        });
      }
      return jsonResponse({ ok: true, result: [] });
    });

    const controller = new AbortController();
    const handle = await telegram.start({
      account,
      epoch: 'e1',
      network,
      signal: controller.signal,
      cursorStore,
      emit: async (envelope) => {
        emittedEvents.push(envelope);
        if (emittedEvents.length === 1) return { accepted: true };
        if (emittedEvents.length === 2) {
          controller.abort();
          return { accepted: false, code: 'NO_CONNECTION' };
        }
        return { accepted: true };
      },
    });

    await waitFor(() => emittedEvents.length === 2);
    await handle.stop();

    assert.equal(emittedEvents.length, 2);
    assert.equal(cursorStore.lastCommit, null, 'should not commit when rejected');
  });

  await t.test('duplicate is treated as accepted: offset advances', async () => {
    const cursorStore = {
      lastCommit: null,
      load: () => ({ offset: 100 }),
      commit: async (_id, transportData) => {
        cursorStore.lastCommit = transportData;
        return { advanced: true };
      },
    };

    const emittedEvents = [];
    let pollCount = 0;
    const network = makeNetwork((init) => {
      if (!init.url.includes('/getUpdates')) {
        return jsonResponse({ ok: true, result: {} });
      }
      pollCount++;
      if (pollCount === 1) {
        return jsonResponse({
          ok: true,
          result: [
            { update_id: 100, message: { message_id: 1, chat: { id: 555, type: 'private' }, from: { id: 555 }, text: 'msg1' } },
            { update_id: 101, message: { message_id: 2, chat: { id: 555, type: 'private' }, from: { id: 555 }, text: 'msg2' } },
            { update_id: 102, message: { message_id: 3, chat: { id: 555, type: 'private' }, from: { id: 555 }, text: 'msg3' } },
          ],
        });
      }
      return jsonResponse({ ok: true, result: [] });
    });

    const controller = new AbortController();
    const handle = await telegram.start({
      account,
      epoch: 'e1',
      network,
      signal: controller.signal,
      cursorStore,
      emit: async (envelope) => {
        emittedEvents.push(envelope);
        if (emittedEvents.length >= 3) controller.abort();
        if (emittedEvents.length === 2) return { accepted: false, code: 'DUPLICATE' };
        return { accepted: true };
      },
    });

    await waitFor(() => emittedEvents.length === 3);
    await handle.stop();

    assert.equal(emittedEvents.length, 3);
    assert.equal(cursorStore.lastCommit?.offset, 103, 'DUPLICATE should advance offset');
  });

  await t.test('STALE_EPOCH stops immediately', async () => {
    const cursorStore = {
      lastCommit: null,
      load: () => ({ offset: 100 }),
      commit: async (_id, transportData) => {
        cursorStore.lastCommit = transportData;
        return { advanced: true };
      },
    };

    const emittedEvents = [];
    let pollCount = 0;
    const network = makeNetwork((init) => {
      if (!init.url.includes('/getUpdates')) {
        return jsonResponse({ ok: true, result: {} });
      }
      pollCount++;
      if (pollCount === 1) {
        return jsonResponse({
          ok: true,
          result: [
            { update_id: 100, message: { message_id: 1, chat: { id: 555, type: 'private' }, from: { id: 555 }, text: 'msg1' } },
            { update_id: 101, message: { message_id: 2, chat: { id: 555, type: 'private' }, from: { id: 555 }, text: 'msg2' } },
          ],
        });
      }
      return jsonResponse({ ok: true, result: [] });
    });

    const controller = new AbortController();
    const handle = await telegram.start({
      account,
      epoch: 'e1',
      network,
      signal: controller.signal,
      cursorStore,
      emit: async (envelope) => {
        emittedEvents.push(envelope);
        if (emittedEvents.length === 1) return { accepted: true };
        if (emittedEvents.length === 2) {
          controller.abort();
          return { accepted: false, code: 'STALE_EPOCH' };
        }
        return { accepted: true };
      },
    });

    await waitFor(() => emittedEvents.length === 2);
    await handle.stop();

    assert.equal(emittedEvents.length, 2);
    assert.equal(cursorStore.lastCommit, null, 'STALE_EPOCH should not commit');
  });
});

// R05 + R06: a rejected batch must not silently end (fake ready); it must surface
// as fatal so the manager can degrade, while cursor-commit failure stops cleanly.
test('R05: a non-stale rejection surfaces as fatal (never a silent fake ready)', async () => {
  const account = {
    id: 'acc-tg-r05-fatal',
    channelId: 'telegram',
    config: { inbound: {}, outbound: {} },
    secrets: { 'inbound.botToken': { kind: 'literal', value: '"TOK"' } },
  };
  let fatal = null;
  const network = makeNetwork((init) => {
    if (!init.url.includes('/getUpdates')) return jsonResponse({ ok: true, result: {} });
    return jsonResponse({
      ok: true,
      result: [{ update_id: 100, message: { message_id: 1, chat: { id: 5, type: 'private' }, from: { id: 5 }, text: 'x' } }],
    });
  });
  const handle = await telegram.start({
    account,
    epoch: 'e1',
    network,
    signal: new AbortController().signal,
    cursorStore: { load: () => ({ offset: 100 }), commit: () => ({ advanced: true }) },
    reconnectMs: 5,
    onFatal: (info) => { fatal = info; },
    emit: async () => ({ accepted: false, code: 'NO_CONNECTION' }),
  });
  await waitFor(() => fatal !== null, 1000);
  await handle.stop();
  assert.equal(fatal?.code, 'NO_CONNECTION', 'batch rejection must reach onFatal');
});

test('R05: a failed cursor commit stops before the next getUpdates uses the new offset', async () => {
  const account = {
    id: 'acc-tg-r05-cursor',
    channelId: 'telegram',
    config: { inbound: {}, outbound: {} },
    secrets: { 'inbound.botToken': { kind: 'literal', value: '"TOK"' } },
  };
  let fatal = null;
  let polls = 0;
  const network = makeNetwork((init) => {
    if (!init.url.includes('/getUpdates')) return jsonResponse({ ok: true, result: {} });
    polls += 1;
    return jsonResponse({
      ok: true,
      result: [{ update_id: 100, message: { message_id: 1, chat: { id: 5, type: 'private' }, from: { id: 5 }, text: 'x' } }],
    });
  });
  const handle = await telegram.start({
    account,
    epoch: 'e1',
    network,
    signal: new AbortController().signal,
    cursorStore: { load: () => ({ offset: 100 }), commit: () => ({ advanced: false, reason: 'IN_FLIGHT_EVENTS' }) },
    reconnectMs: 5,
    onFatal: (info) => { fatal = info; },
    emit: async () => ({ accepted: true }),
  });
  await waitFor(() => fatal !== null, 1000);
  await handle.stop();
  assert.equal(fatal?.code, 'UNAVAILABLE', 'cursor-commit failure must be fatal');
  assert.equal(polls, 1, 'must not poll again with the un-committed offset');
});
