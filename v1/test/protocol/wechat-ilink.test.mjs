// T18 WeChat iLink protocol tests: QR scan login, inbound long-poll + cursor,
// context_token learning/retry, media extraction and control replies. No socket is
// opened: the NetworkPort is an injected recording fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNetwork, jsonResponse, jsonBody } from './helpers.mjs';
import wechatIlink from '../../src/providers/wechat-ilink/index.mjs';

const account = {
  id: 'acc-wx',
  channelId: 'wechat-ilink',
  config: { inbound: { accountId: 'BOT_A', baseUrl: 'https://ilink.test' }, outbound: {} },
  // Literal secrets are JSON-encoded (R08/N02).
  secrets: { 'inbound.token': { kind: 'literal', value: '"TOKEN_A"' } },
};

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
    load: () => ({ buf: '' }),
    commit: async (_id, transportData) => { commits.push(transportData); return { advanced: true }; },
  };
}

/** A responder that yields the first batch once, then empty polls (so stop() returns). */
function pollOnce(batch, onCall) {
  let polls = 0;
  return makeNetwork((init) => {
    if (init.url.includes('/ilink/bot/getupdates')) {
      polls += 1;
      onCall?.(init, polls);
      if (polls === 1) return jsonResponse(batch);
      return jsonResponse({ ret: 0, msgs: [] });
    }
    return jsonResponse({ ret: 0 });
  });
}

test('wechat-ilink: capabilities are inbound/control/login only and there is no outbound send', () => {
  assert.equal(wechatIlink.id, 'wechat-ilink');
  assert.equal(wechatIlink.capabilities.outbound, false);
  assert.equal(wechatIlink.capabilities.inbound, true);
  assert.equal(wechatIlink.capabilities.controlReply, true);
  assert.equal(wechatIlink.capabilities.login, true);
  assert.equal(wechatIlink.capabilities.media, true);
  assert.equal(wechatIlink.capabilities.buttons, false);
  assert.equal(wechatIlink.send, undefined, 'no outbound send is exported');
});

test('wechat-ilink: outbound resolve/validate are a typed UNSUPPORTED, not a fake success', () => {
  assert.throws(() => wechatIlink.resolve({}), (e) => e.code === 'UNSUPPORTED');
  assert.throws(() => wechatIlink.validate({}), (e) => e.code === 'UNSUPPORTED');
});

test('wechat-ilink: a missing token is a typed NOT_CONFIGURED on start and control reply', async () => {
  const bare = { id: 'acc-wx', channelId: 'wechat-ilink', config: { inbound: {} }, secrets: {} };
  await assert.rejects(
    wechatIlink.start({ account: bare, epoch: 'e', emit: () => {}, signal: noSignal(), network: makeNetwork(() => jsonResponse({ ret: 0 })), cursorStore: cursorStore() }),
    (e) => e.code === 'NOT_CONFIGURED',
  );
  await assert.rejects(
    wechatIlink.sendControlReply({ account: bare, replyContext: { chatId: 'USER_A' }, content: { text: 'x' }, signal: noSignal(), network: makeNetwork(() => jsonResponse({ ret: 0 })) }),
    (e) => e.code === 'NOT_CONFIGURED',
  );
});

test('wechat-ilink: a missing network port is a typed UNSUPPORTED', async () => {
  await assert.rejects(
    wechatIlink.start({ account, epoch: 'e', emit: () => {}, signal: noSignal(), network: null, cursorStore: cursorStore() }),
    (e) => e.code === 'UNSUPPORTED',
  );
});

test('wechat-ilink: getupdates carries the version + auth headers and the persisted cursor', async () => {
  const network = pollOnce({ ret: 0, get_updates_buf: 'CUR_1', msgs: [] });
  const started = await wechatIlink.start({
    account, epoch: 'e1', network, signal: noSignal(), cursorStore: cursorStore(),
    emit: async () => ({ accepted: true }),
  });
  await waitFor(() => network.calls.length > 0);
  await started.stop();
  const call = network.calls[0];
  assert.equal(call.url, 'https://ilink.test/ilink/bot/getupdates');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, 'Bearer TOKEN_A');
  assert.equal(call.headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(call.headers['iLink-App-ClientVersion'], String((2 << 16) | (2 << 8) | 0));
  assert.ok(typeof call.headers['X-WECHAT-UIN'] === 'string' && call.headers['X-WECHAT-UIN'].length > 0);
  assert.deepEqual(jsonBody(call), { get_updates_buf: '', base_info: { channel_version: '2.2.0' } });
});

test('wechat-ilink: an inbound message becomes an envelope and the cursor is committed', async () => {
  const network = pollOnce({
    ret: 0, get_updates_buf: 'CUR_1',
    msgs: [{ from_user_id: 'USER_A', message_id: 'M1', context_token: 'CTX1', item_list: [{ type: 1, text_item: { text: '你好' } }] }],
  });
  const emitted = [];
  const cursor = cursorStore();
  const started = await wechatIlink.start({
    account, epoch: 'e1', network, signal: noSignal(), cursorStore: cursor,
    emit: async (env) => { emitted.push(env); return { accepted: true }; },
  });
  await waitFor(() => emitted.length === 1);
  await waitFor(() => cursor.commits.length > 0);
  await started.stop();
  const env = emitted[0];
  assert.equal(env.accountId, 'acc-wx');
  assert.equal(env.epoch, 'e1');
  assert.equal(env.userId, 'USER_A');
  assert.equal(env.chatId, 'USER_A');
  assert.equal(env.chatType, 'private');
  assert.equal(env.kind, 'message');
  assert.equal(env.text, '你好');
  assert.equal(env.eventId, 'ilink:M1');
  assert.equal(env.replyContext.transportData.contextToken, 'CTX1');
  assert.equal(env.replyContext.transportData.chatId, 'USER_A');
  assert.deepEqual(cursor.commits[0], { buf: 'CUR_1' });
});

test('wechat-ilink: a rejected receipt preserves the cursor; a duplicate advances it', async () => {
  const reject = pollOnce({ ret: 0, get_updates_buf: 'CUR_R', msgs: [{ from_user_id: 'USER_A', message_id: 'M', item_list: [{ type: 1, text_item: { text: 'x' } }] }] });
  const cursor = cursorStore();
  const fatals = [];
  const started = await wechatIlink.start({
    account, epoch: 'e1', network: reject, signal: noSignal(), cursorStore: cursor,
    emit: async () => ({ accepted: false, code: 'FORBIDDEN' }),
    onFatal: (info) => fatals.push(info),
  });
  await waitFor(() => fatals.length === 1);
  await started.stop();
  assert.equal(fatals[0].code, 'FORBIDDEN');
  assert.equal(cursor.commits.length, 0, 'a rejected batch never advances the cursor');

  const dup = pollOnce({ ret: 0, get_updates_buf: 'CUR_D', msgs: [{ from_user_id: 'USER_A', message_id: 'M', item_list: [{ type: 1, text_item: { text: 'x' } }] }] });
  const dupCursor = cursorStore();
  const startedDup = await wechatIlink.start({
    account, epoch: 'e1', network: dup, signal: noSignal(), cursorStore: dupCursor,
    emit: async () => ({ accepted: false, code: 'DUPLICATE' }),
  });
  await waitFor(() => dupCursor.commits.length > 0);
  await startedDup.stop();
  assert.deepEqual(dupCursor.commits[0], { buf: 'CUR_D' });
});

test('wechat-ilink: a session-expired response is fatal with re-scan guidance', async () => {
  const network = makeNetwork(() => jsonResponse({ ret: -14, errmsg: 'session expired' }));
  const fatals = [];
  const started = await wechatIlink.start({
    account, epoch: 'e1', network, signal: noSignal(), cursorStore: cursorStore(),
    emit: async () => ({ accepted: true }),
    onFatal: (info) => fatals.push(info),
  });
  await waitFor(() => fatals.length === 1);
  await started.stop();
  assert.equal(fatals[0].code, 'API_ERROR');
  assert.match(fatals[0].message, /会话过期/);
});

test('wechat-ilink: a transient failure reconnects without losing the cursor', async () => {
  let polls = 0;
  const network = makeNetwork((init) => {
    if (init.url.includes('/ilink/bot/getupdates')) {
      polls += 1;
      if (polls === 1) return new Error('boom');
      if (polls === 2) {
        return jsonResponse({ ret: 0, get_updates_buf: 'CUR_T', msgs: [{ from_user_id: 'USER_A', message_id: 'M9', item_list: [{ type: 1, text_item: { text: 'after reconnect' } }] }] });
      }
      return jsonResponse({ ret: 0, msgs: [] });
    }
    return jsonResponse({ ret: 0 });
  });
  const emitted = [];
  const started = await wechatIlink.start({
    account, epoch: 'e1', network, signal: noSignal(), cursorStore: cursorStore(), reconnectMs: 1,
    emit: async (env) => { emitted.push(env); return { accepted: true }; },
  });
  await waitFor(() => emitted.length === 1);
  await started.stop();
  assert.equal(emitted[0].text, 'after reconnect');
});

test('wechat-ilink: a rate-limited response backs off and then recovers', async () => {
  let polls = 0;
  const network = makeNetwork((init) => {
    if (init.url.includes('/ilink/bot/getupdates')) {
      polls += 1;
      if (polls === 1) return jsonResponse({ ret: -2, errmsg: 'busy' });
      if (polls === 2) return jsonResponse({ ret: 0, get_updates_buf: 'CUR_L', msgs: [{ from_user_id: 'USER_A', message_id: 'M', item_list: [{ type: 1, text_item: { text: 'hi' } }] }] });
      return jsonResponse({ ret: 0, msgs: [] });
    }
    return jsonResponse({ ret: 0 });
  });
  const emitted = [];
  const started = await wechatIlink.start({
    account, epoch: 'e1', network, signal: noSignal(), cursorStore: cursorStore(), reconnectMs: 1,
    emit: async (env) => { emitted.push(env); return { accepted: true }; },
  });
  await waitFor(() => emitted.length === 1);
  await started.stop();
  assert.equal(emitted[0].text, 'hi');
});

test('wechat-ilink: a malformed response is never treated as an accepted batch', async () => {
  let polls = 0;
  const network = makeNetwork((init) => {
    if (init.url.includes('/ilink/bot/getupdates')) {
      polls += 1;
      if (polls === 1) return { status: 200, text: 'not json' };
      return jsonResponse({ ret: 0, msgs: [] });
    }
    return jsonResponse({ ret: 0 });
  });
  let emitted = 0;
  const started = await wechatIlink.start({
    account, epoch: 'e1', network, signal: noSignal(), cursorStore: cursorStore(), reconnectMs: 1,
    emit: async () => { emitted += 1; return { accepted: true }; },
  });
  await waitFor(() => polls >= 2);
  await started.stop();
  assert.equal(emitted, 0);
});

test('wechat-ilink: an image item becomes an attachment and text-only empty becomes a placeholder', async () => {
  const network = pollOnce({
    ret: 0, get_updates_buf: 'C',
    msgs: [
      { from_user_id: 'USER_A', message_id: 'IM', item_list: [{ type: 2, image_item: { media_id: 'media-1', file_size: 1234 } }] },
      { from_user_id: 'USER_B', message_id: 'QT', item_list: [{ type: 1, text_item: { text: 'see this' }, ref_msg: { title: 'quote', message_item: { type: 1, text_item: { text: 'orig' } } } }] },
    ],
  });
  const emitted = [];
  const started = await wechatIlink.start({
    account, epoch: 'e1', network, signal: noSignal(), cursorStore: cursorStore(),
    emit: async (env) => { emitted.push(env); return { accepted: true }; },
  });
  await waitFor(() => emitted.length === 2);
  await started.stop();
  const image = emitted.find((e) => e.eventId === 'ilink:IM');
  assert.equal(image.text, '[图片消息]');
  assert.equal(image.attachments.length, 1);
  assert.equal(image.attachments[0].id, 'media-1');
  assert.equal(image.attachments[0].mime, 'image/jpeg');
  assert.equal(image.attachments[0].size, 1234);
  const quoted = emitted.find((e) => e.eventId === 'ilink:QT');
  assert.match(quoted.text, /^\[引用: quote \| orig\]/);
});

test('wechat-ilink: the bot echo and group-marked events are not private control input', async () => {
  const network = pollOnce({
    ret: 0, get_updates_buf: 'C',
    msgs: [
      { from_user_id: 'BOT_A', message_id: 'SELF', item_list: [{ type: 1, text_item: { text: 'echo' } }] },
      { from_user_id: 'USER_G', message_id: 'G1', chat_type: 'group', item_list: [{ type: 1, text_item: { text: 'hi all' } }] },
    ],
  });
  const emitted = [];
  const started = await wechatIlink.start({
    account, epoch: 'e1', network, signal: noSignal(), cursorStore: cursorStore(),
    emit: async (env) => { emitted.push(env); return { accepted: true }; },
  });
  await waitFor(() => emitted.length === 1);
  await started.stop();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].eventId, 'ilink:G1');
  assert.equal(emitted[0].chatType, 'group', 'a group-marked event is kept group so control refuses it');
});

test('wechat-ilink: an over-long cursor is refused and the old usable cursor is kept', async () => {
  const sent = [];
  let polls = 0;
  const network = makeNetwork((init) => {
    if (init.url.includes('/ilink/bot/getupdates')) {
      polls += 1;
      sent.push(jsonBody(init).get_updates_buf);
      if (polls === 1) return jsonResponse({ ret: 0, get_updates_buf: 'X'.repeat(4097), msgs: [] });
      return jsonResponse({ ret: 0, msgs: [] });
    }
    return jsonResponse({ ret: 0 });
  });
  const seeded = { commits: [], load: () => ({ buf: 'GOOD' }), commit: async () => ({ advanced: true }) };
  const started = await wechatIlink.start({
    account, epoch: 'e1', network, signal: noSignal(), cursorStore: seeded, reconnectMs: 1,
    emit: async () => ({ accepted: true }),
  });
  await waitFor(() => polls >= 2);
  await started.stop();
  assert.equal(sent[1], 'GOOD', 'the illegal cursor never replaces the usable one');
});

test('wechat-ilink: control reply sends sendmessage and echoes the context token', async () => {
  const network = makeNetwork(() => jsonResponse({ ret: 0 }));
  const result = await wechatIlink.sendControlReply({
    account,
    replyContext: { chatId: 'USER_A', transportData: { contextToken: 'CTX9' } },
    content: { text: '确认', actions: [{ label: '批准', token: 'tok' }] },
    signal: noSignal(),
    network,
  });
  assert.equal(result.status, 'accepted');
  assert.equal(result.delivery, 'complete');
  assert.equal(network.calls[0].url, 'https://ilink.test/ilink/bot/sendmessage');
  const body = jsonBody(network.calls[0]).msg;
  assert.equal(body.to_user_id, 'USER_A');
  assert.equal(body.context_token, 'CTX9');
  assert.equal(body.message_type, 2);
  assert.equal(body.item_list[0].text_item.text, '确认\n[批准]');
});

test('wechat-ilink: a session-expired send strips the context token and retries once', async () => {
  let sends = 0;
  const network = makeNetwork(() => {
    sends += 1;
    return sends === 1 ? jsonResponse({ ret: -14 }) : jsonResponse({ ret: 0 });
  });
  const result = await wechatIlink.sendControlReply({
    account,
    replyContext: { chatId: 'USER_A', transportData: { contextToken: 'CTX9' } },
    content: { text: 'hi' },
    signal: noSignal(),
    network,
  });
  assert.equal(result.status, 'accepted');
  assert.equal(network.calls.length, 2);
  assert.equal(jsonBody(network.calls[0]).msg.context_token, 'CTX9');
  assert.equal(jsonBody(network.calls[1]).msg.context_token, undefined, 'the stale token is stripped on retry');
});

test('wechat-ilink: a later control segment failure keeps the earlier accepted segment (R13)', async () => {
  let sends = 0;
  const network = makeNetwork(() => {
    sends += 1;
    return sends === 1 ? jsonResponse({ ret: 0 }) : jsonResponse({ ret: -2, errmsg: 'busy' });
  });
  await assert.rejects(
    wechatIlink.sendControlReply({
      account,
      replyContext: { chatId: 'USER_A', transportData: {} },
      content: { text: 'x'.repeat(2500) },
      signal: noSignal(),
      network,
    }),
    (e) => {
      assert.equal(e.delivery, 'partial');
      assert.equal(e.segments.length, 2);
      assert.equal(e.segments[0].status, 'accepted');
      assert.equal(e.segments[1].status, 'failed');
      return true;
    },
  );
});

test('wechat-ilink: QR login scans through to credentials', async () => {
  let statusPolls = 0;
  const calls = [];
  const network = makeNetwork((init) => {
    calls.push(init.url);
    if (init.url.includes('get_bot_qrcode')) return jsonResponse({ qrcode: 'QR1', qrcode_img_content: 'LITE_APP' });
    if (init.url.includes('get_qrcode_status')) {
      statusPolls += 1;
      if (statusPolls === 1) return jsonResponse({ status: 'wait' });
      return jsonResponse({ status: 'confirmed', ilink_bot_id: 'BOT_A', bot_token: 'TOK', baseurl: 'https://ilink.test/', ilink_user_id: 'USER_A' });
    }
    return jsonResponse({ ret: 0 });
  });
  const qrCodes = [];
  const driver = wechatIlink.loginDriver({ network, sleep: () => Promise.resolve(), pollMs: 0 });
  assert.equal(driver.capabilities.login, true);
  const begun = await driver.begin({ account, signal: noSignal(), onQrCode: (info) => qrCodes.push(info) });
  assert.equal(begun.qrText, 'LITE_APP');
  assert.equal(typeof begun.expiresAt, 'number');
  const result = await begun.done;
  assert.deepEqual(qrCodes[0].text, 'LITE_APP');
  assert.equal(result.secretChanges.length, 1);
  assert.equal(result.secretChanges[0].path, 'inbound.token');
  assert.equal(result.secretChanges[0].value.kind, 'literal');
  assert.equal(JSON.parse(result.secretChanges[0].value.value), 'TOK');
  assert.equal(result.config.inbound.accountId, 'BOT_A');
  assert.equal(result.config.inbound.baseUrl, 'https://ilink.test');
  assert.equal(result.config.inbound.userId, 'USER_A');
  assert.ok(calls.some((url) => url.includes('qrcode=QR1')));
});

test('wechat-ilink: QR login follows a cross-datacenter redirect before confirming', async () => {
  let statusPolls = 0;
  const calls = [];
  const network = makeNetwork((init) => {
    calls.push(init.url);
    if (init.url.includes('get_bot_qrcode')) return jsonResponse({ qrcode: 'QR2', qrcode_img_content: 'LITE' });
    if (init.url.includes('get_qrcode_status')) {
      statusPolls += 1;
      if (statusPolls === 1) return jsonResponse({ status: 'scaned_but_redirect', redirect_host: 'node-2' });
      return jsonResponse({ status: 'confirmed', ilink_bot_id: 'BOT_B', bot_token: 'TOK2', baseurl: 'https://node-2/' });
    }
    return jsonResponse({ ret: 0 });
  });
  const driver = wechatIlink.loginDriver({ network, sleep: () => Promise.resolve(), pollMs: 0 });
  const begun = await driver.begin({ account, signal: noSignal(), onQrCode: () => {} });
  const result = await begun.done;
  assert.equal(result.config.inbound.baseUrl, 'https://node-2');
  assert.ok(calls.some((url) => url.startsWith('https://node-2/')), 'the redirect host is used for the next poll');
});

test('wechat-ilink: QR login fails closed on missing qrcode, unknown status, cancel and timeout', async () => {
  const missing = wechatIlink.loginDriver({ network: makeNetwork(() => jsonResponse({ ret: 0 })), sleep: () => Promise.resolve() });
  await assert.rejects(
    missing.begin({ account, signal: noSignal(), onQrCode: () => {} }),
    (e) => e.code === 'BAD_UPSTREAM_RESPONSE',
  );

  const unknown = wechatIlink.loginDriver({
    network: makeNetwork((init) => (init.url.includes('get_bot_qrcode')
      ? jsonResponse({ qrcode: 'QR3' })
      : jsonResponse({ status: 'future-state' }))),
    sleep: () => Promise.resolve(),
  });
  const begunUnknown = await unknown.begin({ account, signal: noSignal(), onQrCode: () => {} });
  await assert.rejects(begunUnknown.done, (e) => e.code === 'BAD_UPSTREAM_RESPONSE');

  const controller = new AbortController();
  const cancelNetwork = makeNetwork((init) => (init.url.includes('get_bot_qrcode')
    ? jsonResponse({ qrcode: 'QR4' })
    : jsonResponse({ status: 'wait' })));
  const cancelDriver = wechatIlink.loginDriver({ network: cancelNetwork, sleep: () => new Promise((r) => setTimeout(r, 0)) });
  const begunCancel = await cancelDriver.begin({ account, signal: controller.signal, onQrCode: () => {} });
  controller.abort();
  await assert.rejects(begunCancel.done, (e) => e.code === 'CANCELLED');

  const timeoutDriver = wechatIlink.loginDriver({
    network: makeNetwork((init) => (init.url.includes('get_bot_qrcode') ? jsonResponse({ qrcode: 'QR5' }) : jsonResponse({ status: 'wait' }))),
    sleep: () => Promise.resolve(),
    timeoutMs: 0,
  });
  const begunTimeout = await timeoutDriver.begin({ account, signal: noSignal(), onQrCode: () => {} });
  await assert.rejects(begunTimeout.done, (e) => e.code === 'TIMEOUT');
});
