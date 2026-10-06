// T20 DingTalk protocol test: webhook 加签 (timestamp + HMAC-SHA256), Stream gateway
// authentication, frame ACK, application-layer SYSTEM ping echo, reconnection and
// in-conversation replies. No real socket or fetch: the injected NetworkPort and its
// WebSocket are both fakes, so every protocol step is observed deterministically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonResponse, jsonBody } from './helpers.mjs';
import dingtalk, { dingtalkSign, dingtalkTimestamp } from '../../src/providers/dingtalk/index.mjs';

const GATEWAY = 'https://api.dingtalk.com/v1.0/gateway/connections/open';
const GETTOKEN = 'https://oapi.dingtalk.com/gettoken';
const SESSION_WEBHOOK = 'https://oapi.dingtalk.com/robot/sendBySession?x=1';
const FAR_FUTURE = 4102444800000; // year 2100, so the session webhook never expires mid-test

const msg = (over = {}) => ({ title: 'T', content: 'C', level: 'active', ...over });
const noSignal = () => new AbortController().signal;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function accountWith(appKey, appSecret = `SEC-${appKey}`) {
  return {
    id: `acc-${appKey}`,
    channelId: 'dingtalk',
    config: { inbound: {}, outbound: {} },
    secrets: {
      'inbound.appKey': { kind: 'literal', value: JSON.stringify(appKey) },
      'inbound.appSecret': { kind: 'literal', value: JSON.stringify(appSecret) },
    },
  };
}

/** A recording NetworkPort whose WebSocket is an in-memory fake. */
function makeStreamNetwork(responder) {
  const calls = [];
  const sockets = [];
  const events = [];
  const network = {
    calls,
    sockets,
    events,
    async request(init) {
      calls.push(init);
      if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'CANCELLED' });
      const result = await responder(init, calls.length - 1);
      if (result instanceof Error) throw result;
      const body = result.body ?? result.text ?? new Uint8Array();
      return {
        status: result.status ?? 200,
        headers: result.headers ?? {},
        body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
      };
    },
    async openWebSocket(init) {
      const socket = {
        init,
        sent: [],
        closed: false,
        async send(bytes) {
          const frame = JSON.parse(new TextDecoder().decode(bytes));
          this.sent.push(frame);
          events.push({ kind: 'ack', frame });
        },
        async close() { this.closed = true; },
      };
      sockets.push(socket);
      events.push({ kind: 'open', url: init.url });
      return socket;
    },
  };
  return network;
}

function gatewayNetwork() {
  return makeStreamNetwork((init) => {
    if (init.url.includes('/gettoken')) return jsonResponse({ errcode: 0, access_token: 'AT', expires_in: 7200 });
    if (init.url.includes('/gateway/connections/open')) {
      return jsonResponse({ endpoint: 'wss://stream.dingtalk.com/connect', ticket: 'TK 1' });
    }
    return jsonResponse({ errcode: 0, messageId: 'mid-1', processQueryKey: 'pq-1' });
  });
}

function streamFrame(messageId, payload, type = 'CALLBACK') {
  return new TextEncoder().encode(JSON.stringify({
    type,
    headers: { messageId },
    data: typeof payload === 'string' ? payload : JSON.stringify(payload),
  }));
}

const TEXT_MESSAGE = {
  conversationId: 'cid-1',
  msgId: 'msg-1',
  senderStaffId: 'staff-1',
  robotCode: 'robot-1',
  msgtype: 'text',
  text: { content: '  hello  ' },
  sessionWebhook: SESSION_WEBHOOK,
  sessionWebhookExpiredTime: FAR_FUTURE,
  conversationType: '1',
};

async function startStream({ account = accountWith('STREAM'), reconnectBaseMs } = {}) {
  const network = gatewayNetwork();
  const emitted = [];
  const started = await dingtalk.start({
    account,
    epoch: 'ep-1',
    emit: (envelope) => { emitted.push(envelope); network.events.push({ kind: 'emit' }); return { accepted: true }; },
    signal: noSignal(),
    network,
    ...(reconnectBaseMs === undefined ? {} : { reconnectBaseMs }),
  });
  return { started, network, emitted, socket: network.sockets[network.sockets.length - 1] };
}

test('dingtalk: capabilities mirror the frozen descriptor (login false, N04)', () => {
  assert.equal(dingtalk.id, 'dingtalk');
  assert.equal(dingtalk.capabilities.outbound, true);
  assert.equal(dingtalk.capabilities.inbound, true);
  assert.equal(dingtalk.capabilities.controlReply, true);
  assert.equal(dingtalk.capabilities.login, false, 'a manual-credential channel must never advertise a scan login');
});

test('dingtalk: the webhook carries the official HMAC timestamp/sign and a markdown body', async () => {
  const network = gatewayNetwork();
  const result = await dingtalk.send({
    config: { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=TOK', secret: 'SEC' },
    message: msg({ title: 'T', content: 'C' }),
    signal: noSignal(),
    network,
  });
  assert.deepEqual(result, { status: 'accepted', providerMessageId: null });
  const url = network.calls[0].url;
  const timestamp = new URL(url).searchParams.get('timestamp');
  assert.equal(timestamp, dingtalkTimestamp(Number(timestamp)), 'timestamp is milliseconds');
  assert.ok(url.includes(`timestamp=${timestamp}&sign=${dingtalkSign('SEC', timestamp)}`), 'sign matches the official algorithm');
  assert.deepEqual(jsonBody(network.calls[0]).markdown, { title: 'T', text: 'T\nC' });
});

test('dingtalk: no secret means no signature, and @all only for timeSensitive when enabled', async () => {
  const network = gatewayNetwork();
  await dingtalk.send({
    config: { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=TOK' },
    message: msg(),
    signal: noSignal(),
    network,
  });
  assert.equal(new URL(network.calls[0].url).searchParams.has('sign'), false);
  assert.equal('at' in jsonBody(network.calls[0]), false);

  await dingtalk.send({
    config: { webhook: 'https://x/send', atAllOnTimeSensitive: true },
    message: msg({ level: 'timeSensitive' }),
    signal: noSignal(),
    network,
  });
  assert.deepEqual(jsonBody(network.calls[1]).at, { isAtAll: true });

  await dingtalk.send({
    config: { webhook: 'https://x/send', atAllOnTimeSensitive: true },
    message: msg({ level: 'active' }),
    signal: noSignal(),
    network,
  });
  assert.equal('at' in jsonBody(network.calls[2]), false);
});

test('dingtalk: missing webhook, API errors and malformed bodies are typed', async () => {
  assert.throws(() => dingtalk.validate({}), (e) => e.code === 'NOT_CONFIGURED');
  const cases = [
    [310000, /加签/, 'API_ERROR'],
    [120001, /access_token/, 'API_ERROR'],
    [999, /999/, 'API_ERROR'],
  ];
  for (const [errcode, pattern, code] of cases) {
    const network = makeStreamNetwork(() => jsonResponse({ errcode, errmsg: `bad ${errcode}` }));
    await assert.rejects(
      dingtalk.send({ config: { webhook: 'https://x/send' }, message: msg(), signal: noSignal(), network }),
      (e) => e.code === code && pattern.test(e.message),
    );
  }
  const malformed = makeStreamNetwork(() => ({ status: 200, text: 'not json' }));
  await assert.rejects(
    dingtalk.send({ config: { webhook: 'https://x/send' }, message: msg(), signal: noSignal(), network: malformed }),
    (e) => e.code === 'BAD_UPSTREAM_RESPONSE',
  );
  const noCode = makeStreamNetwork(() => jsonResponse({ ok: true }));
  await assert.rejects(
    dingtalk.send({ config: { webhook: 'https://x/send' }, message: msg(), signal: noSignal(), network: noCode }),
    (e) => e.code === 'BAD_UPSTREAM_RESPONSE',
  );
});

test('dingtalk: timeout and cancellation are typed and uncertain', async () => {
  const timeout = makeStreamNetwork(() => Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
  await assert.rejects(
    dingtalk.send({ config: { webhook: 'https://x/send' }, message: msg(), signal: noSignal(), network: timeout }),
    (e) => e.code === 'TIMEOUT' && e.uncertain === true,
  );
  const cancelled = makeStreamNetwork(() => Object.assign(new Error('aborted'), { code: 'CANCELLED' }));
  await assert.rejects(
    dingtalk.send({ config: { webhook: 'https://x/send' }, message: msg(), signal: noSignal(), network: cancelled }),
    (e) => e.code === 'CANCELLED',
  );
});

test('dingtalk: control reply signs a session-webhook reply with an access token', async () => {
  const network = gatewayNetwork();
  const result = await dingtalk.sendControlReply({
    account: accountWith('KEY6'),
    replyContext: { chatId: 'cid-1', userId: 'staff-1', transportData: { chatId: 'cid-1', sessionWebhook: SESSION_WEBHOOK, sessionWebhookExpiredTime: FAR_FUTURE, staffId: 'staff-1', robotCode: 'robot-1' } },
    content: { text: 'hi', attachments: [], actions: [] },
    signal: noSignal(),
    network,
  });
  assert.equal(result.status, 'accepted');
  assert.match(result.providerMessageId, /^dt:reply-/);
  assert.ok(network.calls[0].url.startsWith(GETTOKEN), 'an access token is exchanged first');
  assert.equal(network.calls[1].url, SESSION_WEBHOOK);
  assert.equal(network.calls[1].headers['x-acs-dingtalk-access-token'], 'AT');
  const body = jsonBody(network.calls[1]);
  assert.equal(body.msgKey, 'sampleText');
  assert.deepEqual(JSON.parse(body.msgparam), { content: 'hi' });
});

test('dingtalk: an expired session webhook falls back to batchSend', async () => {
  const network = gatewayNetwork();
  const result = await dingtalk.sendControlReply({
    account: accountWith('KEY7'),
    replyContext: { chatId: 'cid-1', userId: 'staff-1', transportData: { chatId: 'cid-1', sessionWebhook: SESSION_WEBHOOK, sessionWebhookExpiredTime: 1, staffId: 'staff-1', robotCode: 'robot-1' } },
    content: { text: 'hi', attachments: [], actions: [] },
    signal: noSignal(),
    network,
  });
  assert.equal(result.providerMessageId, 'dt:pq-1');
  assert.ok(network.calls[1].url.includes('/v1.0/robot/oToMessages/batchSend?robot_code=robot-1'));
  const body = jsonBody(network.calls[1]);
  assert.equal(Array.isArray(body), true);
  assert.equal(body[0].staffId, 'staff-1');
  assert.deepEqual(JSON.parse(body[0].msgParam), { content: 'hi' });
});

test('dingtalk: a control reply without a usable target is NOT_CONFIGURED', async () => {
  const network = gatewayNetwork();
  await assert.rejects(
    dingtalk.sendControlReply({
      account: accountWith('KEY8'),
      replyContext: { chatId: 'cid-1', transportData: { sessionWebhook: '', sessionWebhookExpiredTime: FAR_FUTURE } },
      content: { text: 'hi', actions: [] },
      signal: noSignal(),
      network,
    }),
    (e) => e.code === 'NOT_CONFIGURED',
  );
  assert.equal(network.calls.length, 0, 'no request is made without a target');
});

test('dingtalk: updateControlMessage is an honest UNSUPPORTED', async () => {
  await assert.rejects(
    dingtalk.updateControlMessage({ account: accountWith('KEY9'), replyContext: { chatId: 'c' }, messageId: 'm', content: { text: 'x' } }),
    (e) => e.code === 'UNSUPPORTED',
  );
});

test('dingtalk: start authenticates the gateway and opens the stream socket', async () => {
  const { started, network, socket } = await startStream();
  const gatewayCall = network.calls.find((c) => c.url === GATEWAY);
  assert.ok(gatewayCall !== undefined, 'the gateway is opened with client credentials');
  const body = jsonBody(gatewayCall);
  assert.equal(body.clientId, 'STREAM');
  assert.equal(body.clientSecret, 'SEC-STREAM');
  assert.equal(body.ua, 'dsh-notifier');
  assert.deepEqual(body.subscriptions, [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }]);
  assert.equal(socket.init.url, 'wss://stream.dingtalk.com/connect?ticket=TK%201');
  assert.equal(typeof started.stop, 'function');
  await started.stop();
  assert.equal(socket.closed, true);
});

test('dingtalk: a business frame is ACKed before it is emitted', async () => {
  const { started, network, emitted, socket } = await startStream();
  socket.init.onFrame(streamFrame('msg-id-1', TEXT_MESSAGE));
  const ackIndex = network.events.findIndex((e) => e.kind === 'ack');
  const emitIndex = network.events.findIndex((e) => e.kind === 'emit');
  assert.ok(ackIndex >= 0 && emitIndex >= 0 && ackIndex < emitIndex, 'protocol receipt completes before emit');
  assert.deepEqual(socket.sent[0], { code: 200, headers: { contentType: 'application/json', messageId: 'msg-id-1' }, data: JSON.stringify('OK') });
  assert.equal(emitted.length, 1);
  const env = emitted[0];
  assert.equal(env.accountId, 'acc-STREAM');
  assert.equal(env.epoch, 'ep-1');
  assert.equal(env.eventId, 'dt:msg-1');
  assert.equal(env.userId, 'staff-1');
  assert.equal(env.chatId, 'cid-1');
  assert.equal(env.chatType, 'private');
  assert.equal(env.kind, 'message');
  assert.equal(env.text, 'hello');
  assert.deepEqual(env.attachments, [], 'a plain text message carries no attachment');
  assert.equal(env.replyContext.transportData.robotCode, 'robot-1');
  assert.equal(env.replyContext.transportData.sessionWebhook, SESSION_WEBHOOK);
  await started.stop();
});

test('dingtalk: a SYSTEM ping is echoed verbatim and never emitted', async () => {
  const { started, emitted, socket } = await startStream();
  socket.init.onFrame(new TextEncoder().encode(JSON.stringify({
    type: 'SYSTEM', headers: { topic: 'ping', messageId: 'sys-1' }, data: 'opaque',
  })));
  assert.deepEqual(socket.sent.at(-1), { code: 200, headers: { topic: 'ping', messageId: 'sys-1' }, data: 'opaque' });
  assert.equal(emitted.length, 0, 'a ping never enters the business path');
  // A non-ping SYSTEM subclass (e.g. KEEPALIVE) must not be echoed either.
  socket.init.onFrame(new TextEncoder().encode(JSON.stringify({ type: 'SYSTEM', headers: { topic: 'KEEPALIVE' }, data: 'x' })));
  assert.equal(socket.sent.length, 1);
  await started.stop();
});

test('dingtalk: duplicate msgIds and non-media messages are ACKed but not emitted', async () => {
  const { started, emitted, socket } = await startStream();
  socket.init.onFrame(streamFrame('m-1', TEXT_MESSAGE));
  socket.init.onFrame(streamFrame('m-1', TEXT_MESSAGE));
  assert.equal(emitted.length, 1, 'a redelivered msgId is deduplicated within the 60s window');
  socket.init.onFrame(streamFrame('m-2', { ...TEXT_MESSAGE, msgId: 'msg-2', msgtype: 'file', text: undefined }));
  assert.equal(emitted.length, 1, 'an unsupported message type is dropped, never injected');
  assert.equal(socket.sent.length, 3, 'every business frame is still acknowledged');
  await started.stop();
});

test('dingtalk: a picture frame becomes a single https attachment descriptor', async () => {
  const { started, emitted, socket } = await startStream();
  socket.init.onFrame(streamFrame('p-1', {
    ...TEXT_MESSAGE,
    msgId: 'msg-pic',
    msgtype: 'picture',
    text: undefined,
    // Only whitelisted url fields are read; unknown width/height are not invented.
    picture: { url: 'https://cdn.dingtalk.com/img/1.png', width: 120, height: 80 },
  }));
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].attachments, [{ url: 'https://cdn.dingtalk.com/img/1.png' }]);
  assert.equal(emitted[0].text, '[图片]', 'a pure image keeps a placeholder text');
  await started.stop();
});

test('dingtalk: a downloadCode-only picture yields no attachment and no emit', async () => {
  const { started, emitted, socket } = await startStream();
  socket.init.onFrame(streamFrame('p-2', {
    ...TEXT_MESSAGE, msgId: 'msg-dc', msgtype: 'picture', text: undefined, picture: { downloadCode: 'DC-1' },
  }));
  assert.equal(emitted.length, 0, 'without a URL the message is dropped, never invented (reference 88-92)');
  assert.equal(socket.sent.length, 1, 'the frame is still acknowledged');
  await started.stop();
});

test('dingtalk: a mixed text+image message keeps both text and the attachment', async () => {
  const { started, emitted, socket } = await startStream();
  socket.init.onFrame(streamFrame('p-3', {
    ...TEXT_MESSAGE, msgId: 'msg-mix', msgtype: 'text', text: { content: 'look' },
    image: { downloadUrl: 'https://cdn.dingtalk.com/img/2.jpg' },
  }));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].text, 'look');
  assert.deepEqual(emitted[0].attachments, [{ url: 'https://cdn.dingtalk.com/img/2.jpg' }]);
  await started.stop();
});

test('dingtalk: a richText frame turns its image module into an attachment', async () => {
  const { started, emitted, socket } = await startStream();
  socket.init.onFrame(streamFrame('p-4', {
    ...TEXT_MESSAGE,
    msgId: 'msg-rich',
    msgtype: 'richText',
    text: undefined,
    // The downloadCode module cannot become a URL; only the explicit downloadUrl one does.
    content: { richText: [{ text: 'a' }, { type: 'picture', downloadCode: 'DC-2' }, { type: 'picture', downloadUrl: 'https://cdn.dingtalk.com/img/3.png' }] },
  }));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].text, 'a');
  assert.deepEqual(emitted[0].attachments, [{ url: 'https://cdn.dingtalk.com/img/3.png' }]);
  await started.stop();
});

test('dingtalk: a non-https image url is rejected (fail closed)', async () => {
  const { started, emitted, socket } = await startStream();
  socket.init.onFrame(streamFrame('p-5', {
    ...TEXT_MESSAGE, msgId: 'msg-http', msgtype: 'picture', text: undefined, picture: { url: 'http://cdn.dingtalk.com/img/4.png' },
  }));
  assert.equal(emitted.length, 0, 'the MediaService downloads over NetworkPort; a plain http URL is refused');
  await started.stop();
});

test('dingtalk: a dropped stream reconnects with backoff, and stop halts it', async () => {
  const { started, network, socket } = await startStream({ account: accountWith('RC'), reconnectBaseMs: 1 });
  assert.equal(network.sockets.length, 1);
  socket.init.onClose(1006);
  await sleep(30);
  assert.equal(network.sockets.length, 2, 'a closed socket triggers a reconnection');
  assert.equal(network.calls.filter((c) => c.url === GATEWAY).length, 2, 'the gateway is re-authenticated');
  await started.stop();
  assert.equal(network.sockets[1].closed, true);
  network.sockets[1].init.onClose(1006);
  await sleep(20);
  assert.equal(network.sockets.length, 2, 'stop prevents any further reconnection');
});

test('dingtalk: start fails closed without inbound credentials', async () => {
  const account = { id: 'acc-none', channelId: 'dingtalk', config: { inbound: {} }, secrets: {} };
  await assert.rejects(
    dingtalk.start({ account, epoch: 'e', emit: () => {}, signal: noSignal(), network: gatewayNetwork() }),
    (e) => e.code === 'NOT_CONFIGURED',
  );
});
