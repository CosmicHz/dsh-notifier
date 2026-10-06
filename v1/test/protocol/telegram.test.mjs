// T16 Telegram protocol tests: outbound, inbound long-poll (ACK/cursor), buttons,
// reply reference, media download URL, control reply and reconnect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNetwork, jsonResponse, jsonBody, signal } from './helpers.mjs';
import telegram from '../../src/providers/telegram/index.mjs';

const account = {
  id: 'acc-tg',
  channelId: 'telegram',
  config: { inbound: {}, outbound: {} },
  // Literal secrets are JSON-encoded (R08 fix)
  secrets: { 'inbound.botToken': { kind: 'literal', value: '"TOK"' } },
};

const msg = (over = {}) => ({ title: 'T', content: 'C', level: 'active', ...over });
const noSignal = () => new AbortController().signal;

async function waitFor(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

function cursorStore() {
  const commits = [];
  return {
    commits,
    load: () => ({ offset: 0 }),
    commit: async (_id, transportData) => { commits.push(transportData); return { advanced: true }; },
  };
}

test('telegram: outbound sendMessage URL/body and silent flag', async () => {
  const network = makeNetwork(() => jsonResponse({ ok: true, result: { message_id: 42 } }));
  const result = await telegram.send({
    config: { botToken: 'TOK', chatId: '555' },
    message: msg({ title: 'T', content: 'C', silent: true }),
    signal: noSignal(),
    network,
  });
  assert.deepEqual(result, { status: 'accepted', providerMessageId: '42' });
  assert.equal(network.calls[0].url, 'https://api.telegram.org/botTOK/sendMessage');
  assert.deepEqual(jsonBody(network.calls[0]), { chat_id: '555', text: 'T\nC', disable_notification: true });
});

test('telegram: missing credentials are NOT_CONFIGURED; failure and malformed are typed', async () => {
  assert.throws(() => telegram.validate({ chatId: '5' }), (e) => e.code === 'NOT_CONFIGURED');
  assert.throws(() => telegram.validate({ botToken: 'T' }), (e) => e.code === 'NOT_CONFIGURED');
  const api = makeNetwork(() => jsonResponse({ ok: false, description: 'chat not found' }));
  await assert.rejects(
    telegram.send({ config: { botToken: 'T', chatId: '5' }, message: msg(), signal: noSignal(), network: api }),
    (e) => e.code === 'API_ERROR' && /chat not found/.test(e.message),
  );
  const malformed = makeNetwork(() => ({ status: 200, text: 'not json' }));
  await assert.rejects(
    telegram.send({ config: { botToken: 'T', chatId: '5' }, message: msg(), signal: noSignal(), network: malformed }),
    (e) => e.code === 'BAD_UPSTREAM_RESPONSE',
  );
});

test('telegram: control reply uses inline keyboard and reports the message id', async () => {
  const network = makeNetwork(() => jsonResponse({ ok: true, result: { message_id: 7 } }));
  const result = await telegram.sendControlReply({
    account,
    replyContext: { chatId: '555', userId: '555' },
    content: { text: 'pick', actions: [{ label: 'Yes', token: 'tok-yes' }] },
    signal: noSignal(),
    network,
  });
  assert.equal(result.status, 'accepted');
  assert.equal(result.providerMessageId, '7');
  const body = jsonBody(network.calls[0]);
  assert.equal(body.chat_id, '555');
  assert.deepEqual(body.reply_markup, { inline_keyboard: [[{ text: 'Yes', callback_data: 'tok-yes' }]] });
});

test('telegram: R07 an over-long callback token fails closed instead of dropping the button', async () => {
  const network = makeNetwork(() => jsonResponse({ ok: true, result: { message_id: 7 } }));
  await assert.rejects(
    telegram.sendControlReply({
      account,
      replyContext: { chatId: '555', userId: '555' },
      content: { text: 'pick', actions: [{ label: 'Yes', token: 'x'.repeat(65) }] },
      signal: noSignal(),
      network,
    }),
    (e) => e.code === 'ENCODE_ERROR',
  );
  assert.equal(network.calls.length, 0, 'no partial send precedes the encoding failure');
});

test('telegram: R13 a later segment failure keeps the earlier accepted segment', async () => {
  let sends = 0;
  const network = makeNetwork((init) => {
    if (init.url.includes('/sendMessage')) {
      sends += 1;
      if (sends === 1) return jsonResponse({ ok: true, result: { message_id: 11 } });
      return jsonResponse({ ok: false, description: 'boom' });
    }
    return jsonResponse({ ok: true, result: {} });
  });
  await assert.rejects(
    telegram.sendControlReply({
      account,
      replyContext: { chatId: '555', userId: '555' },
      content: { text: 'x'.repeat(5000) },
      signal: noSignal(),
      network,
    }),
    (e) => {
      assert.equal(e.delivery, 'partial');
      assert.equal(e.segments.length, 2);
      assert.equal(e.segments[0].status, 'accepted');
      assert.equal(e.segments[0].providerMessageId, '11');
      assert.equal(e.segments[1].status, 'failed');
      return true;
    },
  );
});

test('telegram: R09 a group callback is classified as group and ACKed after the receipt', async () => {
  const order = [];
  let polls = 0;
  const network = makeNetwork((init) => {
    if (init.url.includes('/getUpdates')) {
      polls += 1;
      if (polls > 1) return jsonResponse({ ok: true, result: [] });
      return jsonResponse({ ok: true, result: [
        { update_id: 300, callback_query: { id: 'cb-group', from: { id: 555 }, message: { chat: { id: -100, type: 'supergroup' } }, data: JSON.stringify({ t: 'tok' }) } },
      ] });
    }
    if (init.url.includes('/answerCallbackQuery')) { order.push('ack'); return jsonResponse({ ok: true, result: true }); }
    return jsonResponse({ ok: true, result: {} });
  });
  const emitted = [];
  const started = await telegram.start({
    account, epoch: 'e1', network, signal: noSignal(), cursorStore: cursorStore(),
    emit: async (env) => { emitted.push(env); order.push('emit'); return { accepted: true }; },
  });
  await waitFor(() => order.includes('ack'));
  await started.stop();
  assert.equal(emitted[0].chatType, 'group');
  assert.ok(order.indexOf('emit') < order.indexOf('ack'), 'ACK must follow the reliable receipt');
  assert.equal(network.calls.some((c) => c.url.includes('/answerCallbackQuery')), true);
});

test('telegram: R09 a failed ACK does not invalidate the reliable receipt', async () => {
  let polls = 0;
  const network = makeNetwork((init) => {
    if (init.url.includes('/getUpdates')) {
      polls += 1;
      if (polls > 1) return jsonResponse({ ok: true, result: [] });
      return jsonResponse({ ok: true, result: [
        { update_id: 301, callback_query: { id: 'cb-x', from: { id: 555 }, message: { chat: { id: 555, type: 'private' } }, data: JSON.stringify({ t: 'tok' }) } },
      ] });
    }
    if (init.url.includes('/answerCallbackQuery')) return new Error('ack boom');
    return jsonResponse({ ok: true, result: {} });
  });
  const emitted = [];
  const cursor = cursorStore();
  const started = await telegram.start({
    account, epoch: 'e1', network, signal: noSignal(), cursorStore: cursor,
    emit: async (env) => { emitted.push(env); return { accepted: true }; },
  });
  await waitFor(() => cursor.commits.length > 0);
  await started.stop();
  assert.equal(emitted.length, 1);
  assert.deepEqual(cursor.commits[0], { offset: 302 });
});

test('telegram: inbound long-poll emits message + callback and commits the cursor', async () => {
  let polls = 0;
  const network = makeNetwork((init) => {
    if (init.url.includes('/getUpdates')) {
      polls += 1;
      if (polls > 1) return jsonResponse({ ok: true, result: [] });
      return jsonResponse({ ok: true, result: [
        { update_id: 100, message: { message_id: 7, chat: { id: 555, type: 'private' }, from: { id: 555 }, text: 'hello' } },
        { update_id: 101, callback_query: { id: 'cb1', from: { id: 555 }, message: { chat: { id: 555 } }, data: JSON.stringify({ t: 'tok' }) } },
      ] });
    }
    return jsonResponse({ ok: true, result: {} });
  });
  const emitted = [];
  const cursor = cursorStore();
  const started = await telegram.start({
    account, epoch: 'e1', network, signal: noSignal(), cursorStore: cursor,
    emit: async (env) => { emitted.push(env); return { accepted: true }; },
  });
  await waitFor(() => emitted.length === 2);
  await started.stop();
  assert.equal(emitted[0].kind, 'message');
  assert.equal(emitted[0].text, 'hello');
  assert.equal(emitted[0].userId, '555');
  assert.equal(emitted[0].epoch, 'e1');
  assert.equal(emitted[0].replyContext.transportData.chatId, '555');
  assert.equal(emitted[1].kind, 'callback');
  assert.equal(emitted[1].callback.token, 'tok');
  await waitFor(() => cursor.commits.length > 0);
  assert.deepEqual(cursor.commits[0], { offset: 102 });
});

test('telegram: a transient poll failure reconnects without losing the cursor', async () => {
  let polls = 0;
  const network = makeNetwork((init) => {
    if (init.url.includes('/getUpdates')) {
      polls += 1;
      if (polls === 1) return new Error('boom');
      if (polls === 2) return jsonResponse({ ok: true, result: [
        { update_id: 5, message: { message_id: 1, chat: { id: 9, type: 'private' }, from: { id: 9 }, text: 'after reconnect' } },
      ] });
      return jsonResponse({ ok: true, result: [] });
    }
    return jsonResponse({ ok: true, result: {} });
  });
  const emitted = [];
  const started = await telegram.start({
    account, epoch: 'e1', network, signal: noSignal(), cursorStore: cursorStore(), reconnectMs: 1,
    emit: async (env) => { emitted.push(env); return { accepted: true }; },
  });
  await waitFor(() => emitted.length === 1);
  await started.stop();
  assert.equal(emitted[0].text, 'after reconnect');
});

test('telegram: a stale-epoch cursor stop ends the loop', async () => {
  const network = makeNetwork((init) => {
    if (init.url.includes('/getUpdates')) {
      return jsonResponse({ ok: true, result: [
        { update_id: 1, message: { message_id: 1, chat: { id: 9, type: 'private' }, from: { id: 9 }, text: 'x' } },
      ] });
    }
    return jsonResponse({ ok: true, result: {} });
  });
  let polls = 0;
  const staleCursor = {
    load: () => ({ offset: 0 }),
    commit: async () => { polls += 1; return { advanced: false, reason: 'STALE_EPOCH' }; },
  };
  let emitted = 0;
  const started = await telegram.start({
    account, epoch: 'e1', network, signal: noSignal(), cursorStore: staleCursor,
    emit: async () => { emitted += 1; return { accepted: true }; },
  });
  await waitFor(() => polls === 1);
  await started.stop();
  assert.equal(emitted, 1, 'the update was handed over exactly once before the epoch went stale');
});

test('telegram: a photo is resolved to a downloadable file URL', async () => {
  let polls = 0;
  const network = makeNetwork((init) => {
    if (init.url.includes('/getUpdates')) {
      polls += 1;
      if (polls > 1) return jsonResponse({ ok: true, result: [] });
      return jsonResponse({ ok: true, result: [
        { update_id: 2, message: { message_id: 3, chat: { id: 9, type: 'private' }, from: { id: 9 }, caption: 'pic', photo: [{ file_id: 'small' }, { file_id: 'big', file_size: 1234 }] } },
      ] });
    }
    if (init.url.includes('/getFile')) return jsonResponse({ ok: true, result: { file_path: 'photos/big.jpg', file_size: 1234 } });
    return jsonResponse({ ok: true, result: {} });
  });
  const emitted = [];
  const started = await telegram.start({
    account, epoch: 'e1', network, signal: noSignal(), cursorStore: cursorStore(),
    emit: async (env) => { emitted.push(env); return { accepted: true }; },
  });
  await waitFor(() => emitted.length === 1);
  await started.stop();
  assert.equal(emitted[0].text, 'pic');
  assert.equal(emitted[0].attachments.length, 1);
  assert.equal(emitted[0].attachments[0].url, 'https://api.telegram.org/file/botTOK/photos/big.jpg');
  assert.equal(emitted[0].attachments[0].mime, 'image/jpeg');
});
test('telegram: R07 a button missing its token fails closed instead of vanishing', async () => {
  const network = makeNetwork(() => jsonResponse({ ok: true, result: { message_id: 7 } }));
  await assert.rejects(
    telegram.sendControlReply({
      account,
      replyContext: { chatId: '555', userId: '555' },
      content: { text: 'pick', actions: [{ label: 'Yes', token: '' }] },
      signal: noSignal(),
      network,
    }),
    (e) => e.code === 'ENCODE_ERROR',
  );
  assert.equal(network.calls.length, 0, 'nothing is sent when a control action is malformed');
});


