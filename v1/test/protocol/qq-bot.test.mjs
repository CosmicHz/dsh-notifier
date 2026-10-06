// T19 QQ Bot protocol tests: outbound token/send/msg_seq, control keyboard,
// gateway auth (HELLO→IDENTIFY), READY, heartbeat, rendering, reconnect.
// No real sockets: the NetworkPort is a recording fake and the WebSocket is a
// controllable in-memory double driven frame-by-frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNetwork, jsonResponse, jsonBody } from './helpers.mjs';
import qq from '../../src/providers/qq-bot/index.mjs';

const account = {
  id: 'acc-qq',
  channelId: 'qq-bot',
  config: { inbound: {}, outbound: {} },
  // Literal secrets are JSON-encoded strings.
  secrets: {
    'inbound.appId': { kind: 'literal', value: '"AP"' },
    'inbound.appSecret': { kind: 'literal', value: '"SEC"' },
  },
};

const signal = () => new AbortController().signal;
const dec = (bytes) => new TextDecoder().decode(bytes);
const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));

async function waitFor(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

function route({ token = 'TOK', gateway = 'wss://api.sgroup.qq.com/websocket', messageId = 'msg-1' } = {}) {
  return (init) => {
    if (init.url === TOKEN_URL) return jsonResponse({ access_token: token, expires_in: 7200 });
    if (init.url.endsWith('/gateway')) return jsonResponse({ url: gateway });
    if (/\/v2\/(users|groups)\/.*\/messages$/.test(init.url)) return jsonResponse({ id: messageId, timestamp: 1 });
    return jsonResponse({});
  };
}

/** A recording network whose openWebSocket returns a frame-driven fake socket. */
function wsNetwork(responder) {
  const net = makeNetwork(responder);
  const sockets = [];
  net.sockets = sockets;
  net.openWebSocket = async (init) => {
    const socket = {
      init, frames: [], closed: false,
      async send(bytes) { socket.frames.push(JSON.parse(dec(bytes))); },
      async close() { if (!socket.closed) { socket.closed = true; init.onClose?.(1000); } },
    };
    sockets.push(socket);
    const onAbort = () => { if (!socket.closed) { socket.closed = true; init.onClose?.(1000); } };
    if (init.signal?.aborted) queueMicrotask(onAbort);
    else init.signal?.addEventListener?.('abort', onAbort, { once: true });
    return socket;
  };
  return net;
}

function makeCursor() {
  const commits = [];
  return { commits, load: () => ({}), commit: async (_id, transportData) => { commits.push(transportData); return { advanced: true }; } };
}

test('qq-bot: resolve requires appId/appSecret/target and defaults to a user target', () => {
  assert.throws(() => qq.validate({ appSecret: 'S', userId: 'u1' }), (e) => e.code === 'NOT_CONFIGURED');
  assert.throws(() => qq.validate({ appId: 'A', userId: 'u1' }), (e) => e.code === 'NOT_CONFIGURED');
  assert.throws(() => qq.validate({ appId: 'A', appSecret: 'S' }), (e) => e.code === 'NOT_CONFIGURED');
  assert.throws(() => qq.validate({ appId: 'A', appSecret: 'S', targetType: 'group' }), (e) => e.code === 'NOT_CONFIGURED');
  const resolved = qq.resolve({ appId: 'A', appSecret: 'S', groupId: 'g1', targetType: 'group' });
  assert.equal(resolved.targetType, 'group');
  assert.equal(resolved.targetId, 'g1');
  assert.equal(resolved.markdown, true);
  assert.equal(qq.capabilities.login, false); // manual credential channel: no scan login
  assert.equal(qq.capabilities.inbound, true);
  assert.equal(qq.capabilities.buttons, true);
});

test('qq-bot: outbound exchanges a token then posts markdown with an auth header', async () => {
  const network = wsNetwork(route());
  const result = await qq.send({
    config: { appId: 'A', appSecret: 'S', userId: 'user-send-1', rateMs: 0 },
    message: { title: 'T', content: 'C' },
    signal: signal(),
    network,
  });
  assert.deepEqual(result, { status: 'accepted', providerMessageId: 'msg-1' });
  assert.equal(network.calls[0].url, TOKEN_URL);
  assert.deepEqual(jsonBody(network.calls[0]), { appId: 'A', clientSecret: 'S' });
  const post = network.calls[1];
  assert.equal(post.url, 'https://api.sgroup.qq.com/v2/users/user-send-1/messages');
  assert.equal(post.headers.authorization, 'QQBot TOK');
  assert.deepEqual(jsonBody(post), { markdown: { content: 'T\nC' }, msg_type: 2, msg_seq: 1 });
});

test('qq-bot: markdown=false splits plain text under the 2000-codepoint limit', async () => {
  const network = wsNetwork(route({ messageId: 'm' }));
  await qq.send({
    config: { appId: 'A', appSecret: 'S', userId: 'user-send-2', markdown: false, rateMs: 0 },
    message: { title: '', content: 'x'.repeat(2500) },
    signal: signal(),
    network,
  });
  const posts = network.calls.filter((c) => c.url.includes('/v2/'));
  assert.equal(posts.length, 2);
  assert.equal(jsonBody(posts[0]).msg_type, 0);
  assert.equal([...jsonBody(posts[0]).content].length, 2000);
  assert.deepEqual(posts.map((p) => jsonBody(p).msg_seq), [1, 2]);
});

test('qq-bot: upstream errors are typed (business code / non-JSON / auth)', async () => {
  const api = wsNetwork((init) => (init.url === TOKEN_URL ? jsonResponse({ access_token: 'TOK', expires_in: 7200 }) : jsonResponse({ code: 'BABC0622', message: '权限不足，未开启主动消息' })));
  await assert.rejects(
    qq.send({ config: { appId: 'A', appSecret: 'S', userId: 'u-err-1', rateMs: 0 }, message: { title: '', content: 'c' }, signal: signal(), network: api }),
    (e) => e.code === 'API_ERROR' && /BABC0622/.test(e.message),
  );
  const malformed = wsNetwork((init) => (init.url === TOKEN_URL ? jsonResponse({ access_token: 'TOK', expires_in: 7200 }) : { status: 200, text: 'not json' }));
  await assert.rejects(
    qq.send({ config: { appId: 'A', appSecret: 'S', userId: 'u-err-2', rateMs: 0 }, message: { title: '', content: 'c' }, signal: signal(), network: malformed }),
    (e) => e.code === 'BAD_UPSTREAM_RESPONSE',
  );
  const auth = wsNetwork(() => ({ status: 401, text: 'unauthorized' }));
  await assert.rejects(
    qq.send({ config: { appId: 'A', appSecret: 'S', userId: 'u-err-3', rateMs: 0 }, message: { title: '', content: 'c' }, signal: signal(), network: auth }),
    (e) => e.code === 'FORBIDDEN',
  );
});

test('qq-bot: a failed segment freezes msg_seq so a retry reuses the same seq', async () => {
  let posts = 0;
  const network = wsNetwork((init) => {
    if (init.url === TOKEN_URL) return jsonResponse({ access_token: 'TOK', expires_in: 7200 });
    if (!init.url.includes('/v2/')) return jsonResponse({});
    posts += 1;
    if (posts === 2) return { status: 500, text: 'boom' };
    return jsonResponse({ id: `m-${posts}`, timestamp: 1 });
  });
  const config = { appId: 'A', appSecret: 'S', userId: 'user-seq-1', markdown: false, rateMs: 0 };
  const message = { title: '', content: 'y'.repeat(2500) };
  await assert.rejects(
    qq.send({ config, message, signal: signal(), network }),
    (e) => e.code === 'API_ERROR',
  );
  const seqs = () => network.calls.filter((c) => c.url.includes('/v2/')).map((c) => jsonBody(c).msg_seq);
  assert.deepEqual(seqs(), [1, 2]);
  const retried = await qq.send({ config, message, signal: signal(), network });
  assert.equal(retried.status, 'accepted');
  assert.deepEqual(seqs(), [1, 2, 1, 2]); // counter stayed frozen; retry reuses (seq, content)
  await qq.send({ config, message, signal: signal(), network });
  assert.deepEqual(seqs().slice(4), [3, 4]); // advanced only after the full success
});

test('qq-bot: control reply sends markdown + keyboard and reports the message id', async () => {
  const network = wsNetwork(route({ messageId: 'c-1' }));
  const result = await qq.sendControlReply({
    account,
    replyContext: { chatId: 'ctrl-1', userId: 'ctrl-1' },
    content: { text: 'pick', actions: [{ label: 'Yes', token: 'tok-yes' }] },
    signal: signal(),
    network,
  });
  assert.equal(result.status, 'accepted');
  assert.equal(result.providerMessageId, 'c-1');
  const post = network.calls.find((c) => c.url.includes('/v2/'));
  assert.equal(post.url, 'https://api.sgroup.qq.com/v2/users/ctrl-1/messages');
  const body = jsonBody(post);
  assert.equal(body.msg_type, 2);
  assert.equal(body.markdown.content, 'pick\n[Yes]');
  const button = body.keyboard.content.rows[0].buttons[0];
  assert.deepEqual(button.action, { type: 1, permission: { type: 2 }, click_limit: 1, data: 'tok-yes' });
  assert.equal(button.render_data.label, 'Yes');
});

test('qq-bot: a control button missing its token fails closed before any send', async () => {
  const network = wsNetwork(route());
  await assert.rejects(
    qq.sendControlReply({
      account,
      replyContext: { chatId: 'ctrl-2' },
      content: { text: 'pick', actions: [{ label: 'Yes', token: '' }] },
      signal: signal(),
      network,
    }),
    (e) => e.code === 'ENCODE_ERROR',
  );
  assert.equal(network.calls.length, 0, 'nothing is sent when a control action is malformed');
});

test('qq-bot: updateControlMessage sends a receipt text (QQ cannot edit)', async () => {
  const network = wsNetwork(route({ messageId: 'm-2' }));
  const result = await qq.updateControlMessage({
    account,
    replyContext: { chatId: 'ctrl-3' },
    messageId: 'orig-9',
    content: { text: 'done' },
    signal: signal(),
    network,
  });
  assert.deepEqual(result, { status: 'accepted', providerMessageId: 'orig-9' });
  const post = network.calls.find((c) => c.url.includes('/v2/'));
  assert.equal(jsonBody(post).msg_type, 0);
  assert.equal(jsonBody(post).content, 'done');
});

test('qq-bot gateway: HELLO→IDENTIFY, READY, heartbeat and a C2C message advance the cursor', async () => {
  const network = wsNetwork(route());
  const emitted = [];
  const cursor = makeCursor();
  const started = await qq.start({
    account, epoch: 'e1', network, signal: signal(), cursorStore: cursor,
    emit: async (env) => { emitted.push(env); return { accepted: true }; },
  });
  await waitFor(() => network.sockets.length === 1);
  const ws = network.sockets[0];
  ws.init.onFrame(enc({ op: 10, d: { heartbeat_interval: 500 } }));
  await waitFor(() => ws.frames.some((f) => f.op === 2));
  const identify = ws.frames.find((f) => f.op === 2);
  assert.equal(identify.d.token, 'QQBot TOK');
  assert.equal(typeof identify.d.intents, 'number');
  assert.deepEqual(identify.d.shard, [0, 1]);
  ws.init.onFrame(enc({ op: 0, t: 'READY', s: 5, d: { session_id: 'sess-1' } }));
  await waitFor(() => ws.frames.some((f) => f.op === 1));
  assert.equal(ws.frames.find((f) => f.op === 1).d, 5, 'heartbeat carries the READY seq');
  ws.init.onFrame(enc({ op: 11 }));
  ws.init.onFrame(enc({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 6, d: { id: 'ev-1', author: { user_openid: 'u-9' }, content: 'hello' } }));
  await waitFor(() => emitted.length === 1);
  await waitFor(() => cursor.commits.length === 1);
  await started.stop();
  assert.equal(emitted[0].chatType, 'private');
  assert.equal(emitted[0].text, 'hello');
  assert.equal(emitted[0].userId, 'u-9');
  assert.equal(emitted[0].epoch, 'e1');
  assert.equal(emitted[0].replyContext.transportData.chatId, 'u-9');
  assert.deepEqual(cursor.commits[0], { seq: 6 });
});

test('qq-bot gateway: a group @ message strips the mention and is classified as group', async () => {
  const network = wsNetwork(route());
  const emitted = [];
  const started = await qq.start({
    account, epoch: 'e1', network, signal: signal(), cursorStore: makeCursor(),
    emit: async (env) => { emitted.push(env); return { accepted: true }; },
  });
  await waitFor(() => network.sockets.length === 1);
  const ws = network.sockets[0];
  ws.init.onFrame(enc({ op: 10, d: { heartbeat_interval: 500 } }));
  ws.init.onFrame(enc({ op: 0, t: 'READY', s: 1, d: { session_id: 's2' } }));
  ws.init.onFrame(enc({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 2, d: { id: 'g-ev', group_openid: 'G1', author: { member_openid: 'M1' }, content: '<@!123> 构建完成' } }));
  await waitFor(() => emitted.length === 1);
  await started.stop();
  assert.equal(emitted[0].chatType, 'group');
  assert.equal(emitted[0].chatId, 'G1');
  assert.equal(emitted[0].userId, 'M1');
  assert.equal(emitted[0].text, '构建完成');
});

test('qq-bot gateway: a 401 while fetching the gateway is fatal', async () => {
  const network = wsNetwork((init) => (init.url === TOKEN_URL ? jsonResponse({ access_token: 'TOK', expires_in: 7200 }) : { status: 401, text: 'nope' }));
  let fatal = null;
  const started = await qq.start({
    account, epoch: 'e1', network, signal: signal(), cursorStore: makeCursor(),
    emit: async () => ({ accepted: true }), onFatal: (info) => { fatal = info; },
  });
  await waitFor(() => fatal !== null);
  await started.stop();
  assert.equal(fatal.code, 'FORBIDDEN');
});

test('qq-bot gateway: a missing HELLO hits the handshake deadline and reconnects', async () => {
  const network = wsNetwork(route());
  const started = await qq.start({
    account, epoch: 'e1', network, signal: signal(), cursorStore: makeCursor(),
    emit: async () => ({ accepted: true }), handshakeTimeoutMs: 30, reconnectBaseMs: 5, reconnectCapMs: 5,
  });
  await waitFor(() => network.sockets.length >= 2, 3000);
  await started.stop();
  assert.ok(network.sockets.length >= 2, 'the gateway reconnects after the READY deadline');
});

test('qq-bot gateway: a dropped socket reconnects and RESUMEs the in-process session', async () => {
  const network = wsNetwork(route());
  const emitted = [];
  const started = await qq.start({
    account, epoch: 'e1', network, signal: signal(), cursorStore: makeCursor(),
    emit: async (env) => { emitted.push(env); return { accepted: true }; },
    reconnectBaseMs: 5, reconnectCapMs: 5,
  });
  await waitFor(() => network.sockets.length === 1);
  const first = network.sockets[0];
  first.init.onFrame(enc({ op: 10, d: { heartbeat_interval: 500 } }));
  first.init.onFrame(enc({ op: 0, t: 'READY', s: 1, d: { session_id: 'keep' } }));
  await waitFor(() => first.frames.some((f) => f.op === 2));
  first.init.onFrame(enc({ op: 7 }));
  await waitFor(() => network.sockets.length === 2);
  const second = network.sockets[1];
  second.init.onFrame(enc({ op: 10, d: { heartbeat_interval: 500 } }));
  await waitFor(() => second.frames.some((f) => f.op === 6));
  assert.equal(second.frames.find((f) => f.op === 6).d.session_id, 'keep');
  second.init.onFrame(enc({ op: 0, t: 'RESUMED', s: 2, d: {} }));
  second.init.onFrame(enc({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 3, d: { id: 'ev-r', author: { user_openid: 'u-r' }, content: 'after' } }));
  await waitFor(() => emitted.length === 1);
  await started.stop();
  assert.equal(emitted[0].text, 'after');
});

test('qq-bot gateway: a missing heartbeat ACK past the threshold reconnects', async () => {
  const network = wsNetwork(route());
  const started = await qq.start({
    account, epoch: 'e1', network, signal: signal(), cursorStore: makeCursor(),
    emit: async () => ({ accepted: true }), heartbeatMissThreshold: 1, reconnectBaseMs: 5, reconnectCapMs: 5,
  });
  await waitFor(() => network.sockets.length === 1);
  const ws = network.sockets[0];
  ws.init.onFrame(enc({ op: 10, d: { heartbeat_interval: 20 } }));
  ws.init.onFrame(enc({ op: 0, t: 'READY', s: 1, d: { session_id: 'hb' } }));
  await waitFor(() => network.sockets.length >= 2, 3000);
  await started.stop();
  assert.ok(network.sockets.length >= 2, 'an unacknowledged heartbeat drops the socket');
});

test('qq-bot gateway: a rejected event stops the loop without advancing the cursor', async () => {
  const network = wsNetwork(route());
  const cursor = makeCursor();
  let fatal = null;
  const started = await qq.start({
    account, epoch: 'e1', network, signal: signal(), cursorStore: cursor,
    emit: async () => ({ accepted: false, code: 'FORBIDDEN' }), onFatal: (info) => { fatal = info; },
  });
  await waitFor(() => network.sockets.length === 1);
  const ws = network.sockets[0];
  ws.init.onFrame(enc({ op: 10, d: { heartbeat_interval: 500 } }));
  ws.init.onFrame(enc({ op: 0, t: 'READY', s: 1, d: { session_id: 'x' } }));
  ws.init.onFrame(enc({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'ev-x', author: { user_openid: 'u' }, content: 'hi' } }));
  await waitFor(() => fatal !== null);
  await started.stop();
  assert.equal(cursor.commits.length, 0, 'a rejected event must be redelivered, not skipped');
});

test('qq-bot gateway: a DUPLICATE outcome still advances the cursor', async () => {
  const network = wsNetwork(route());
  const cursor = makeCursor();
  const started = await qq.start({
    account, epoch: 'e1', network, signal: signal(), cursorStore: cursor,
    emit: async () => ({ accepted: false, code: 'DUPLICATE' }),
  });
  await waitFor(() => network.sockets.length === 1);
  const ws = network.sockets[0];
  ws.init.onFrame(enc({ op: 10, d: { heartbeat_interval: 500 } }));
  ws.init.onFrame(enc({ op: 0, t: 'READY', s: 1, d: { session_id: 'd' } }));
  ws.init.onFrame(enc({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 4, d: { id: 'ev-d', author: { user_openid: 'u' }, content: 'dup' } }));
  await waitFor(() => cursor.commits.length === 1);
  await started.stop();
  assert.deepEqual(cursor.commits[0], { seq: 4 });
});

test('qq-bot gateway: a stale-epoch cursor commit ends the loop without a fatal', async () => {
  const network = wsNetwork(route());
  let fatal = null;
  const started = await qq.start({
    account, epoch: 'e1', network, signal: signal(),
    cursorStore: { load: () => ({}), commit: async () => ({ advanced: false, reason: 'STALE_EPOCH' }) },
    emit: async () => ({ accepted: true }), onFatal: (info) => { fatal = info; },
  });
  await waitFor(() => network.sockets.length === 1);
  const ws = network.sockets[0];
  ws.init.onFrame(enc({ op: 10, d: { heartbeat_interval: 500 } }));
  ws.init.onFrame(enc({ op: 0, t: 'READY', s: 1, d: { session_id: 's' } }));
  ws.init.onFrame(enc({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'ev-s', author: { user_openid: 'u' }, content: 'x' } }));
  await waitFor(() => ws.closed);
  await started.stop();
  assert.equal(fatal, null);
});
