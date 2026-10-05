// T17 Feishu protocol test: webhook card + HMAC sign, SDK-isolated WebSocket inbound,
// event/card-callback normalization, and typed failures. No socket is opened: the
// NetworkPort and the Lark SDK are both injected fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNetwork, jsonResponse, jsonBody } from './helpers.mjs';
import { createFeishuProvider, feishuSign } from '../../src/providers/feishu/index.mjs';

const account = {
  id: 'acc-fs',
  channelId: 'feishu',
  config: { inbound: {}, outbound: {} },
  secrets: {
    'inbound.appId': { kind: 'literal', value: '"cli_app"' },
    'inbound.appSecret': { kind: 'literal', value: '"cli_secret"' },
  },
};

const msg = (over = {}) => ({ title: 'T', content: 'C', level: 'active', ...over });
const noSignal = () => new AbortController().signal;

/** A recording fake of the Lark SDK surface the provider uses. */
function fakeSdk() {
  const state = { client: null, ws: null, registered: null, create: [], patch: [] };
  class EventDispatcher {
    register(map) { state.registered = map; return this; }
  }
  class WSClient {
    constructor(opts) { state.ws = { opts, started: false, closed: false }; }
    async start({ eventDispatcher }) { state.ws.started = true; state.dispatcher = eventDispatcher; }
    async close() { state.ws.closed = true; }
  }
  class Client {
    constructor(opts) {
      state.client = opts;
      this.im = { v1: { message: {
        create: async (x) => { state.create.push(x); return { code: 0, data: { message_id: 'om-1' } }; },
        patch: async (x) => { state.patch.push(x); return { code: 0 }; },
      } } };
    }
  }
  const okay = async () => ({});
  const defaultHttpInstance = { request: okay, get: okay, delete: okay, head: okay, options: okay, post: okay, put: okay, patch: okay };
  return { Client, WSClient, EventDispatcher, defaultHttpInstance, state };
}

test('feishu: capabilities reflect the frozen descriptor', () => {
  const provider = createFeishuProvider();
  assert.equal(provider.id, 'feishu');
  assert.equal(provider.capabilities.outbound, true);
  assert.equal(provider.capabilities.inbound, true);
  assert.equal(provider.capabilities.controlReply, true);
});

test('feishu: outbound webhook card body and accepted result', async () => {
  const provider = createFeishuProvider();
  const network = makeNetwork(() => jsonResponse({ code: 0 }));
  const result = await provider.send({
    config: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/TOK' },
    message: msg({ title: 'T', content: 'C' }),
    signal: noSignal(),
    network,
  });
  assert.deepEqual(result, { status: 'accepted', providerMessageId: null });
  assert.equal(network.calls[0].url, 'https://open.feishu.cn/open-apis/bot/v2/hook/TOK');
  const body = jsonBody(network.calls[0]);
  assert.equal(body.msg_type, 'interactive');
  assert.equal(body.card.header.title.content, 'T');
  assert.equal(body.card.elements[0].content, 'C');
  assert.equal(body.sign, undefined, 'no secret means no signature fields');
});

test('feishu: a secret adds the official HMAC timestamp/sign to the body', async () => {
  const provider = createFeishuProvider();
  const network = makeNetwork(() => jsonResponse({ code: 0 }));
  await provider.send({
    config: { webhook: 'https://x/hook', secret: 'S3CRET' },
    message: msg(),
    signal: noSignal(),
    network,
  });
  const body = jsonBody(network.calls[0]);
  assert.equal(typeof body.timestamp, 'string');
  assert.equal(body.sign, feishuSign('S3CRET', body.timestamp));
});

test('feishu: missing webhook, API error and malformed body are typed', async () => {
  const provider = createFeishuProvider();
  assert.throws(() => provider.validate({}), (e) => e.code === 'NOT_CONFIGURED');
  const api = makeNetwork(() => jsonResponse({ code: 19021, msg: 'sign match fail' }));
  await assert.rejects(
    provider.send({ config: { webhook: 'https://x' }, message: msg(), signal: noSignal(), network: api }),
    (e) => e.code === 'API_ERROR' && /sign match fail/.test(e.message),
  );
  const malformed = makeNetwork(() => ({ status: 200, text: 'nope' }));
  await assert.rejects(
    provider.send({ config: { webhook: 'https://x' }, message: msg(), signal: noSignal(), network: malformed }),
    (e) => e.code === 'BAD_UPSTREAM_RESPONSE',
  );
});

test('feishu: timeout and cancellation are typed and uncertain', async () => {
  const provider = createFeishuProvider();
  const timeout = makeNetwork(() => Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
  await assert.rejects(
    provider.send({ config: { webhook: 'https://x' }, message: msg(), signal: noSignal(), network: timeout }),
    (e) => e.code === 'TIMEOUT' && e.uncertain === true,
  );
  const cancelled = makeNetwork(() => Object.assign(new Error('aborted'), { code: 'CANCELLED' }));
  await assert.rejects(
    provider.send({ config: { webhook: 'https://x' }, message: msg(), signal: noSignal(), network: cancelled }),
    (e) => e.code === 'CANCELLED',
  );
});

test('feishu: start opens an SDK WS with bounded http, and stop closes it', async () => {
  const sdk = fakeSdk();
  const provider = createFeishuProvider({ sdkLoader: async () => sdk });
  const started = await provider.start({ account, epoch: 'ep-1', emit: () => {}, signal: noSignal() });
  assert.equal(sdk.state.ws.started, true);
  assert.equal(sdk.state.ws.opts.appId, 'cli_app');
  assert.equal(sdk.state.ws.opts.appSecret, 'cli_secret');
  assert.equal(typeof sdk.state.registered['im.message.receive_v1'], 'function');
  assert.equal(typeof sdk.state.registered['card.action.trigger'], 'function');
  assert.equal(typeof sdk.state.client.httpInstance.request, 'function', 'SDK gets a bounded HttpInstance');
  await started.stop();
  assert.equal(sdk.state.ws.closed, true);
});

test('feishu: an inbound text event becomes an envelope with mentions restored', async () => {
  const sdk = fakeSdk();
  const provider = createFeishuProvider({ sdkLoader: async () => sdk });
  const emitted = [];
  await provider.start({ account, epoch: 'ep-1', emit: (e) => { emitted.push(e); }, signal: noSignal() });
  sdk.state.registered['im.message.receive_v1']({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om-9', chat_id: 'oc_9', chat_type: 'p2p', message_type: 'text',
      content: JSON.stringify({ text: 'hi @_user_1' }),
      mentions: [{ key: '@_user_1', name: 'Bob' }],
    },
  });
  assert.equal(emitted.length, 1);
  const env = emitted[0];
  assert.equal(env.accountId, 'acc-fs');
  assert.equal(env.epoch, 'ep-1');
  assert.equal(env.userId, 'ou_1');
  assert.equal(env.chatId, 'oc_9');
  assert.equal(env.chatType, 'private');
  assert.equal(env.kind, 'message');
  assert.equal(env.text, 'hi @Bob');
});

test('feishu: a group message keeps chatType group so control can refuse it', async () => {
  const sdk = fakeSdk();
  const provider = createFeishuProvider({ sdkLoader: async () => sdk });
  const emitted = [];
  await provider.start({ account, epoch: 'e', emit: (e) => emitted.push(e), signal: noSignal() });
  sdk.state.registered['im.message.receive_v1']({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: { message_id: 'om-g', chat_id: 'oc_g', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: 'hi' }) },
  });
  assert.equal(emitted[0].chatType, 'group');
});

test('feishu: non-text is acknowledged then dropped, never injected', async () => {
  const sdk = fakeSdk();
  const provider = createFeishuProvider({ sdkLoader: async () => sdk });
  const emitted = [];
  await provider.start({ account, epoch: 'e', emit: (e) => emitted.push(e), signal: noSignal() });
  sdk.state.registered['im.message.receive_v1']({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: { message_id: 'om-i', chat_id: 'oc_1', message_type: 'image', content: JSON.stringify({ image_key: 'img_1' }) },
  });
  assert.equal(emitted.length, 0);
  assert.equal(sdk.state.create.length, 1, 'a receipt is sent');
  assert.equal(sdk.state.create[0].data.receive_id, 'oc_1');
});

test('feishu: a card action becomes a callback envelope carrying the token', async () => {
  const sdk = fakeSdk();
  const provider = createFeishuProvider({ sdkLoader: async () => sdk });
  const emitted = [];
  await provider.start({ account, epoch: 'ep-2', emit: (e) => emitted.push(e), signal: noSignal() });
  sdk.state.registered['card.action.trigger']({
    action: { value: { token: 'tok-1' } },
    operator: { open_id: 'ou_7' },
    context: { open_chat_id: 'oc_7', open_message_id: 'om-7' },
  });
  assert.equal(emitted.length, 1);
  const env = emitted[0];
  assert.equal(env.kind, 'callback');
  assert.equal(env.callback.token, 'tok-1');
  assert.equal(env.userId, 'ou_7');
  assert.equal(env.chatId, 'oc_7');
});

test('feishu: a missing or incomplete SDK is a typed UNSUPPORTED', async () => {
  const missing = createFeishuProvider({ sdkLoader: async () => { throw new Error('MODULE_NOT_FOUND'); } });
  await assert.rejects(
    missing.start({ account, epoch: 'e', emit: () => {}, signal: noSignal() }),
    (e) => e.code === 'UNSUPPORTED',
  );
  const incomplete = createFeishuProvider({ sdkLoader: async () => ({ Client: class {} }) });
  await assert.rejects(
    incomplete.start({ account, epoch: 'e', emit: () => {}, signal: noSignal() }),
    (e) => e.code === 'UNSUPPORTED',
  );
});

test('feishu: control reply sends text, and buttons become a card', async () => {
  const sdk = fakeSdk();
  const provider = createFeishuProvider({ sdkLoader: async () => sdk });
  const plain = await provider.sendControlReply({
    account, replyContext: { chatId: 'oc_1' }, content: { text: 'hi', attachments: [], actions: [] },
  });
  assert.equal(plain.status, 'accepted');
  assert.equal(sdk.state.create[0].data.msg_type, 'text');
  assert.equal(sdk.state.create[0].params.receive_id_type, 'chat_id');

  await provider.sendControlReply({
    account, replyContext: { chatId: 'oc_1' },
    content: { text: 'ok?', attachments: [], actions: [{ label: '批准', token: 'tok-a' }] },
  });
  const card = sdk.state.create[1].data;
  assert.equal(card.msg_type, 'interactive');
  const parsed = JSON.parse(card.content);
  const button = parsed.elements.find((e) => e.tag === 'action').actions[0];
  assert.equal(button.text.content, '批准');
  assert.equal(button.value.token, 'tok-a');
});

test('feishu: updateControlMessage patches the card', async () => {
  const sdk = fakeSdk();
  const provider = createFeishuProvider({ sdkLoader: async () => sdk });
  const result = await provider.updateControlMessage({
    account, replyContext: { chatId: 'oc_1' }, messageId: 'om-3', content: { text: 'done', attachments: [], actions: [] },
  });
  assert.equal(result.status, 'accepted');
  assert.equal(sdk.state.patch[0].path.message_id, 'om-3');
});
