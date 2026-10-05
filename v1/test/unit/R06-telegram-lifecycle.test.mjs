// R06: Telegram lifecycle — synchronous admission, fatal callback, auth failure detection
import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import telegram from '../../src/providers/telegram/index.mjs';

describe('R06: Telegram lifecycle and health', () => {
  test('start fails fast when botToken is missing', async () => {
    const account = {
      id: 'acc-no-token',
      channelId: 'telegram',
      config: { inbound: {}, outbound: {} },
      secrets: {},
    };
    await assert.rejects(
      telegram.start({
        account,
        epoch: 'e1',
        emit: () => ({ accepted: true }),
        signal: new AbortController().signal,
        network: { request: () => {} },
        cursorStore: { load: () => null, commit: () => ({ advanced: true }) },
      }),
      { code: 'NOT_CONFIGURED' },
    );
  });

  test('start fails fast when network is missing', async () => {
    const account = {
      id: 'acc-no-network',
      channelId: 'telegram',
      config: { inbound: {}, outbound: {} },
      secrets: { 'inbound.botToken': { kind: 'literal', value: '"TOK"' } },
    };
    await assert.rejects(
      telegram.start({
        account,
        epoch: 'e1',
        emit: () => ({ accepted: true }),
        signal: new AbortController().signal,
        network: null,
        cursorStore: { load: () => null, commit: () => ({ advanced: true }) },
      }),
      { code: 'UNSUPPORTED' },
    );
  });

  test('401 auth failure triggers fatal callback', async (t) => {
    const account = {
      id: 'acc-auth-fail',
      channelId: 'telegram',
      config: { inbound: {}, outbound: {} },
      secrets: { 'inbound.botToken': { kind: 'literal', value: '"BAD_TOKEN"' } },
    };
    let fatalCalled = false;
    let fatalCode = null;
    const network = {
      request: async () => ({ status: 401, json: { ok: false, description: 'Unauthorized' } }),
    };
    const handle = await telegram.start({
      account,
      epoch: 'e1',
      emit: () => ({ accepted: true }),
      signal: new AbortController().signal,
      network,
      cursorStore: { load: () => null, commit: () => ({ advanced: true }) },
      onFatal: ({ code }) => {
        fatalCalled = true;
        fatalCode = code;
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    await handle.stop();
    assert.strictEqual(fatalCalled, true, 'onFatal should be called');
    assert.strictEqual(fatalCode, 'FORBIDDEN', 'fatal code should be FORBIDDEN');
  });

  test('network error does not trigger fatal (recoverable)', async (t) => {
    const account = {
      id: 'acc-network-err',
      channelId: 'telegram',
      config: { inbound: {}, outbound: {} },
      secrets: { 'inbound.botToken': { kind: 'literal', value: '"TOK"' } },
    };
    let fatalCalled = false;
    let callCount = 0;
    const network = {
      request: async () => {
        callCount++;
        if (callCount < 3) throw new Error('Network error');
        return { status: 200, json: { ok: true, result: [] } };
      },
    };
    const handle = await telegram.start({
      account,
      epoch: 'e1',
      emit: () => ({ accepted: true }),
      signal: new AbortController().signal,
      network,
      cursorStore: { load: () => null, commit: () => ({ advanced: true }) },
      reconnectMs: 10,
      onFatal: () => {
        fatalCalled = true;
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    await handle.stop();
    assert.strictEqual(fatalCalled, false, 'onFatal should not be called for recoverable errors');
    assert.ok(callCount >= 2, 'should retry after network error');
  });
});
