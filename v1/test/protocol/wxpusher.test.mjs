// T21 WxPusher protocol test: outbound JSON encoding, error mapping, timeout and
// cancellation, control-reply targeting, and the callback auth/envelope rules.
// Sockets are never opened: a recording in-memory NetworkPort answers every call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNetwork, jsonResponse, jsonBody } from './helpers.mjs';
import wxpusher from '../../src/providers/wxpusher/index.mjs';

const SEND_URL = 'https://wxpusher.zjiecode.com/api/send/message';

const account = {
  id: 'acc-wx',
  channelId: 'wxpusher',
  config: { inbound: {}, outbound: {} },
  // Literal secrets are JSON-encoded (R08 fix).
  secrets: { 'inbound.appToken': { kind: 'literal', value: '"TOK"' } },
};

const msg = (over = {}) => ({ title: 'T', content: 'C', level: 'active', ...over });
const noSignal = () => new AbortController().signal;

function raw(payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new TextEncoder().encode(body);
}

test('wxpusher: capabilities reflect the frozen descriptor', () => {
  assert.equal(wxpusher.id, 'wxpusher');
  assert.equal(wxpusher.capabilities.outbound, true);
  assert.equal(wxpusher.capabilities.inbound, true);
  assert.equal(wxpusher.capabilities.controlReply, true);
  assert.equal(wxpusher.capabilities.buttons, false);
  assert.equal(wxpusher.capabilities.updateMessage, false);
});

test('wxpusher: outbound URL/body and accepted result', async () => {
  const network = makeNetwork(() => jsonResponse({ code: 1000, msg: 'ok' }));
  const result = await wxpusher.send({
    config: { appToken: 'TOK', uids: ['UID_1'], topicIds: [12] },
    message: msg({ title: 'T', content: 'C' }),
    signal: noSignal(),
    network,
  });
  assert.deepEqual(result, { status: 'accepted', providerMessageId: null });
  assert.equal(network.calls[0].url, SEND_URL);
  assert.deepEqual(jsonBody(network.calls[0]), {
    appToken: 'TOK', content: 'T\nC', summary: 'T', contentType: 1, uids: ['UID_1'], topicIds: [12],
  });
});

test('wxpusher: missing credentials and missing targets are NOT_CONFIGURED', () => {
  assert.throws(() => wxpusher.validate({ uids: ['U'] }), (e) => e.code === 'NOT_CONFIGURED');
  assert.throws(() => wxpusher.validate({ appToken: 'T' }), (e) => e.code === 'NOT_CONFIGURED');
  assert.throws(() => wxpusher.validate({ appToken: 'T', uids: [], topicIds: [] }), (e) => e.code === 'NOT_CONFIGURED');
});

test('wxpusher: API error and malformed body are typed', async () => {
  const api = makeNetwork(() => jsonResponse({ code: 1002, msg: 'appToken 无效' }));
  await assert.rejects(
    wxpusher.send({ config: { appToken: 'T', uids: ['U'] }, message: msg(), signal: noSignal(), network: api }),
    (e) => e.code === 'API_ERROR' && /appToken 无效/.test(e.message),
  );
  const malformed = makeNetwork(() => ({ status: 200, text: 'not json' }));
  await assert.rejects(
    wxpusher.send({ config: { appToken: 'T', uids: ['U'] }, message: msg(), signal: noSignal(), network: malformed }),
    (e) => e.code === 'BAD_UPSTREAM_RESPONSE',
  );
});

test('wxpusher: timeout and cancellation surface as typed, uncertain failures', async () => {
  const timeout = makeNetwork(() => Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
  await assert.rejects(
    wxpusher.send({ config: { appToken: 'T', uids: ['U'] }, message: msg(), signal: noSignal(), network: timeout }),
    (e) => e.code === 'TIMEOUT' && e.uncertain === true,
  );
  const cancelled = makeNetwork(() => Object.assign(new Error('aborted'), { code: 'CANCELLED' }));
  await assert.rejects(
    wxpusher.send({ config: { appToken: 'T', uids: ['U'] }, message: msg(), signal: noSignal(), network: cancelled }),
    (e) => e.code === 'CANCELLED',
  );
});

test('wxpusher: control reply targets the reply context uid using the account secret', async () => {
  const network = makeNetwork(() => jsonResponse({ code: 1000 }));
  const result = await wxpusher.sendControlReply({
    account,
    replyContext: { chatId: 'UID_9' },
    content: { text: 'hi', attachments: [], actions: [{ label: '批准', token: 'tok' }] },
    signal: noSignal(),
    network,
  });
  assert.equal(result.status, 'accepted');
  const body = jsonBody(network.calls[0]);
  assert.equal(body.appToken, 'TOK');
  assert.deepEqual(body.uids, ['UID_9']);
  assert.equal(body.content, 'hi\n[批准]');
});

test('wxpusher: start admits config and fails closed without the inbound secret', async () => {
  const started = await wxpusher.start({ account });
  assert.equal(typeof started.stop, 'function');
  await assert.rejects(
    () => wxpusher.start({ account: { ...account, secrets: {} } }),
    (e) => e.code === 'NOT_CONFIGURED',
  );
});

test('wxpusher: callback normalizes an up-channel command into an envelope', async () => {
  const result = await wxpusher.handleCallback({
    account,
    method: 'POST',
    epoch: 'ep-1',
    rawBody: raw({ action: 'send_up_cmd', data: { uid: 'UID_1', appId: 'AT_x', time: '1700000000', content: '#AT_x /help' } }),
  });
  assert.equal(result.ok, true);
  const env = result.envelope;
  assert.equal(env.accountId, 'acc-wx', 'the account comes from the mount, not the body');
  assert.equal(env.epoch, 'ep-1');
  assert.equal(env.userId, 'UID_1');
  assert.equal(env.chatId, 'UID_1');
  assert.equal(env.chatType, 'private');
  assert.equal(env.kind, 'message');
  assert.equal(env.text, '/help', 'the appId command prefix is stripped');
  assert.deepEqual(env.attachments, []);
  assert.equal('appToken' in env, false, 'no credential leaks into the envelope');
});

test('wxpusher: callback rejects bad shape, invalid uid, wrong method and ignores other actions', async () => {
  const badJson = await wxpusher.handleCallback({ account, method: 'POST', epoch: 'e', rawBody: raw('nope') });
  assert.equal(badJson.ok, false);
  assert.equal(badJson.ack.status, 400);

  const badUid = await wxpusher.handleCallback({ account, method: 'POST', epoch: 'e', rawBody: raw({ action: 'send_up_cmd', data: { uid: 'bad uid/../x', content: 'hi' } }) });
  assert.equal(badUid.ok, false);
  assert.equal(badUid.ack.status, 400);

  const get = await wxpusher.handleCallback({ account, method: 'GET', epoch: 'e', rawBody: raw({}) });
  assert.equal(get.ack.status, 405);

  const subscribe = await wxpusher.handleCallback({ account, method: 'POST', epoch: 'e', rawBody: raw({ action: 'app_subscribe', data: { uid: 'UID_1' } }) });
  assert.equal(subscribe.ok, false);
  assert.equal(subscribe.ack.status, 200, 'other actions are acknowledged and ignored, never invented');

  const empty = await wxpusher.handleCallback({ account, method: 'POST', epoch: 'e', rawBody: raw({ action: 'send_up_cmd', data: { uid: 'UID_1', content: '   ' } }) });
  assert.equal(empty.ok, false);
  assert.equal(empty.ack.status, 200);
});

test('wxpusher: callback ack is a plain 200, duplicate-safe', () => {
  assert.equal(wxpusher.callbackAck({ replayed: false }).status, 200);
  assert.equal(wxpusher.callbackAck({ replayed: true }).status, 200);
});
