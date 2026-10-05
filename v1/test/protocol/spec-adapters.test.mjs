// T23 protocol tests for the 16 declarative (spec) channels. Each case pins the
// real URL, method, headers and body of one channel plus its success predicate,
// platform-failure hint and config-time validation. No sockets: the recording
// NetworkPort answers locally (test/protocol/helpers.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNetwork, jsonResponse, jsonBody, formBody, signal } from './helpers.mjs';
import { specProviders } from '../../src/providers/specs.mjs';

const msg = (over = {}) => ({ title: 'T', content: 'C', level: 'active', ...over });
const send = (id, config, message, network) => specProviders[id].send({ config, message, signal: signal(), network });

const IDS = [
  'slack', 'discord', 'wecom', 'mattermost', 'gchat', 'teams', 'ntfy', 'gotify',
  'pushover', 'chanify', 'pushdeer', 'xizhi', 'qmsg', 'igot', 'onebot', 'wps-bot',
];

test('all 16 declarative channels are registered with outbound capability', () => {
  assert.equal(Object.keys(specProviders).length, 16);
  for (const id of IDS) {
    assert.equal(specProviders[id].id, id, id);
    assert.equal(specProviders[id].capabilities.outbound, true, id);
    assert.equal(typeof specProviders[id].send, 'function', id);
  }
});

// ---------------------------------------------------------------------------
// slack
// ---------------------------------------------------------------------------
test('slack: hooks.slack.com webhook posts {text}; 200 is the success code', async () => {
  const network = makeNetwork(() => ({ status: 200, text: 'ok' }));
  const result = await send('slack', { webhook: 'https://hooks.slack.com/services/AAA/BBB/CCC' }, msg({ title: 'Hi', content: 'Body' }), network);
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(network.calls[0].url, 'https://hooks.slack.com/services/AAA/BBB/CCC');
  assert.deepEqual(jsonBody(network.calls[0]), { text: 'Hi\n\nBody' });
});

test('slack: a non-official host fails config; 403 carries the re-copy hint', async () => {
  assert.throws(() => specProviders.slack.validate({ webhook: 'https://evil.example.com/services/x' }), (e) => e.code === 'NOT_CONFIGURED');
  const network = makeNetwork(() => ({ status: 403, text: 'invalid_token' }));
  await assert.rejects(send('slack', { webhook: 'https://hooks.slack.com/services/x' }, msg(), network),
    (e) => e.code === 'API_ERROR' && /重新复制地址/.test(e.message));
});

// ---------------------------------------------------------------------------
// discord
// ---------------------------------------------------------------------------
test('discord: meta webhook posts {content} with title newline; 2xx accepted', async () => {
  const network = makeNetwork(() => ({ status: 204, text: '' }));
  const result = await send('discord', { webhook: 'https://discord.com/api/webhooks/x/y' }, msg(), network);
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(network.calls[0].url, 'https://discord.com/api/webhooks/x/y');
  assert.deepEqual(jsonBody(network.calls[0]), { content: 'T\nC' });
});

test('discord: content over the 2000 char cap is refused before any request', async () => {
  const network = makeNetwork(() => jsonResponse({}));
  await assert.rejects(send('discord', { webhook: 'https://discord.com/api/webhooks/x/y' }, msg({ content: 'a'.repeat(2001) }), network),
    (e) => e.code === 'API_ERROR' && /2000/.test(e.message));
  assert.equal(network.calls.length, 0, 'no request is attempted for an oversized message');
});

// ---------------------------------------------------------------------------
// wecom (group robot)
// ---------------------------------------------------------------------------
test('wecom: key builds the qyapi webhook URL; errcode 0 accepted; 93100 hinted', async () => {
  const network = makeNetwork(() => jsonResponse({ errcode: 0 }));
  const result = await send('wecom', { key: 'abc123' }, msg({ title: 'Hi', content: 'Body' }), network);
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(network.calls[0].url, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc123');
  assert.deepEqual(jsonBody(network.calls[0]), { msgtype: 'markdown', markdown: { content: 'Hi\n\nBody' } });

  const bad = makeNetwork(() => jsonResponse({ errcode: 93100, errmsg: 'robot disabled' }));
  await assert.rejects(send('wecom', { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=z' }, msg(), bad),
    (e) => e.code === 'API_ERROR' && /93100/.test(e.message));
  assert.throws(() => specProviders.wecom.validate({}), (e) => e.code === 'NOT_CONFIGURED');
});

// ---------------------------------------------------------------------------
// mattermost
// ---------------------------------------------------------------------------
test('mattermost: server+hookId builds /hooks/<id>; webhook wins and 2xx accepted', async () => {
  const network = makeNetwork(() => ({ status: 200, text: 'ok' }));
  await send('mattermost', { server: 'https://mm.example.com/', hookId: 'hid' }, msg({ title: '', content: 'C' }), network);
  assert.equal(network.calls[0].url, 'https://mm.example.com/hooks/hid');
  assert.deepEqual(jsonBody(network.calls[0]), { text: 'C' });
  assert.throws(() => specProviders.mattermost.validate({ hookId: 'hid' }), (e) => e.code === 'NOT_CONFIGURED');
});

// ---------------------------------------------------------------------------
// gchat / teams
// ---------------------------------------------------------------------------
test('gchat: posts {text} with a single newline', async () => {
  const network = makeNetwork(() => ({ status: 200, text: '' }));
  await send('gchat', { webhook: 'https://chat.googleapis.com/v1/spaces/x/messages?key=k' }, msg(), network);
  assert.deepEqual(jsonBody(network.calls[0]), { text: 'T\nC' });
});

test('teams: sends an AdaptiveCard with the optional title block', async () => {
  const network = makeNetwork(() => ({ status: 200, text: '1' }));
  await send('teams', { webhook: 'https://prod-1.westus.logic.azure.com/workflows/x' }, msg({ title: 'Hi', content: 'Body' }), network);
  const body = jsonBody(network.calls[0]);
  assert.equal(body.type, 'message');
  assert.equal(body.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  assert.deepEqual(body.attachments[0].content.body, [
    { type: 'TextBlock', text: 'Hi', weight: 'Bolder', wrap: true },
    { type: 'TextBlock', text: 'Body', wrap: true },
  ]);
});

// ---------------------------------------------------------------------------
// ntfy
// ---------------------------------------------------------------------------
test('ntfy: default server, level->priority mapping and optional auth header', async () => {
  const network = makeNetwork(() => ({ status: 200, text: '{"id":"x"}' }));
  await send('ntfy', { server: 'https://ntfy.sh/', topic: 'tp', auth: 'Bearer tok' }, msg({ level: 'timeSensitive', title: 'Hi', content: 'Body' }), network);
  const call = network.calls[0];
  assert.equal(call.url, 'https://ntfy.sh');
  assert.equal(call.headers.authorization, 'Bearer tok');
  assert.deepEqual(jsonBody(call), { topic: 'tp', title: 'Hi', message: 'Body', priority: 5 });
});

test('ntfy: silent forces the lowest priority; a server error surfaces its message', async () => {
  const quiet = makeNetwork(() => ({ status: 200, text: '' }));
  await send('ntfy', { topic: 't' }, msg({ silent: true, level: 'critical' }), quiet);
  assert.equal(jsonBody(quiet.calls[0]).priority, 2);

  const bad = makeNetwork(() => ({ status: 400, text: '{"error":"bad topic"}' }));
  await assert.rejects(send('ntfy', { topic: 't' }, msg(), bad), (e) => e.code === 'API_ERROR' && /bad topic/.test(e.message));
});

// ---------------------------------------------------------------------------
// gotify
// ---------------------------------------------------------------------------
test('gotify: /message with x-gotify-key and level->priority mapping', async () => {
  const network = makeNetwork(() => ({ status: 200, text: '{}' }));
  await send('gotify', { server: 'https://gotify.example.com/', appToken: 'tok' }, msg({ level: 'critical', title: 'Hi', content: 'Body' }), network);
  const call = network.calls[0];
  assert.equal(call.url, 'https://gotify.example.com/message');
  assert.equal(call.headers['x-gotify-key'], 'tok');
  assert.deepEqual(jsonBody(call), { title: 'Hi', message: 'Body', priority: 8 });
  assert.throws(() => specProviders.gotify.validate({ server: 'https://x' }), (e) => e.code === 'NOT_CONFIGURED');
});

// ---------------------------------------------------------------------------
// pushover
// ---------------------------------------------------------------------------
test('pushover: form title/message and status 1; timeSensitive adds the siren', async () => {
  const network = makeNetwork(() => jsonResponse({ status: 1 }));
  const result = await send('pushover', { token: 'tk', user: 'u' }, msg({ level: 'timeSensitive', title: 'Hi', content: 'Body' }), network);
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(network.calls[0].url, 'https://api.pushover.net/1/messages.json');
  assert.equal(network.calls[0].headers['content-type'], 'application/x-www-form-urlencoded; charset=utf-8');
  assert.deepEqual(formBody(network.calls[0]), { token: 'tk', user: 'u', title: 'Hi', message: 'Body', sound: 'siren' });
});

test('pushover: status 0 rejects with the joined platform errors', async () => {
  const network = makeNetwork(() => jsonResponse({ status: 0, errors: ['user key is invalid'] }));
  await assert.rejects(send('pushover', { token: 't', user: 'u' }, msg(), network),
    (e) => e.code === 'API_ERROR' && /user key is invalid/.test(e.message));
});

// ---------------------------------------------------------------------------
// chanify / pushdeer
// ---------------------------------------------------------------------------
test('chanify: /<token> form body with title and text', async () => {
  const network = makeNetwork(() => ({ status: 200, text: '' }));
  await send('chanify', { token: 'tok' }, msg({ title: 'Hi', content: 'Body' }), network);
  assert.equal(network.calls[0].url, 'https://api.chanify.net/v1/sender/tok');
  assert.deepEqual(formBody(network.calls[0]), { title: 'Hi', text: 'Body' });
});

test('pushdeer: /message/push form, code 0 accepted, error surfaced', async () => {
  const network = makeNetwork(() => jsonResponse({ code: 0 }));
  await send('pushdeer', { pushKey: 'pk' }, msg({ title: 'Hi', content: 'Body' }), network);
  assert.equal(network.calls[0].url, 'https://api2.pushdeer.com/message/push');
  assert.deepEqual(formBody(network.calls[0]), { pushkey: 'pk', text: 'Hi', desp: 'Body', type: 'markdown' });

  const bad = makeNetwork(() => jsonResponse({ code: 1, error: 'invalid pushkey' }));
  await assert.rejects(send('pushdeer', { pushKey: 'pk' }, msg(), bad), (e) => e.code === 'API_ERROR' && /invalid pushkey/.test(e.message));
});

// ---------------------------------------------------------------------------
// xizhi / igot
// ---------------------------------------------------------------------------
test('xizhi: /<key>.send JSON, code 200 accepted, msg surfaced on failure', async () => {
  const network = makeNetwork(() => jsonResponse({ code: 200 }));
  await send('xizhi', { key: 'abc' }, msg(), network);
  assert.equal(network.calls[0].url, 'https://xizhi.qqoq.net/abc.send');
  assert.deepEqual(jsonBody(network.calls[0]), { title: 'T', content: 'C' });

  const bad = makeNetwork(() => jsonResponse({ code: 400, msg: 'key 无效' }));
  await assert.rejects(send('xizhi', { key: 'k' }, msg(), bad), (e) => e.code === 'API_ERROR' && /key 无效/.test(e.message));
});

test('igot: /<key> JSON with automaticallyCopy, ret 0 accepted, errMsg surfaced', async () => {
  const network = makeNetwork(() => jsonResponse({ ret: 0 }));
  await send('igot', { key: 'k' }, msg(), network);
  assert.equal(network.calls[0].url, 'https://push.hellyw.com/k');
  assert.deepEqual(jsonBody(network.calls[0]), { title: 'T', content: 'C', automaticallyCopy: 0 });

  const bad = makeNetwork(() => jsonResponse({ ret: 1, errMsg: 'key not found' }));
  await assert.rejects(send('igot', { key: 'k' }, msg(), bad), (e) => e.code === 'API_ERROR' && /key not found/.test(e.message));
});

// ---------------------------------------------------------------------------
// qmsg
// ---------------------------------------------------------------------------
test('qmsg: v3 send form, success true accepted and group forwarded when set', async () => {
  const network = makeNetwork(() => jsonResponse({ success: true }));
  await send('qmsg', { key: 'k', group: '12345' }, msg({ title: 'Hi', content: 'Body' }), network);
  assert.equal(network.calls[0].url, 'https://qmsg.zendee.cn/v3/send/k');
  assert.deepEqual(formBody(network.calls[0]), { msg: 'Hi\nBody', group: '12345' });

  const bad = makeNetwork(() => jsonResponse({ success: false, message: 'key 无效' }));
  await assert.rejects(send('qmsg', { key: 'k' }, msg(), bad), (e) => e.code === 'API_ERROR' && /key 无效/.test(e.message));
});

test('qmsg: request-level qq/bot is refused; legacy type=group maps onto group', () => {
  assert.throws(() => specProviders.qmsg.validate({ key: 'k', qq: '10001' }),
    (e) => e.code === 'NOT_CONFIGURED' && /控制台绑定目标/.test(e.message));
  assert.equal(specProviders.qmsg.resolve({ key: 'k', type: 'group', qq: '888' }).group, '888');
});

// ---------------------------------------------------------------------------
// onebot
// ---------------------------------------------------------------------------
test('onebot: private send builds /send_msg with a text segment and bearer auth', async () => {
  const network = makeNetwork(() => jsonResponse({ status: 'ok', retcode: 0 }));
  await send('onebot', { baseUrl: 'http://127.0.0.1:3000/', accessToken: 'at', messageType: 'private', userId: 10001 }, msg({ title: 'Hi', content: 'Body' }), network);
  const call = network.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:3000/send_msg');
  assert.equal(call.headers.authorization, 'Bearer at');
  assert.equal(call.allowPrivateNetwork, true, 'onebot explicitly allows a private self-hosted endpoint');
  assert.deepEqual(jsonBody(call), {
    message_type: 'private',
    message: [{ type: 'text', data: { text: 'Hi\nBody' } }],
    user_id: 10001,
  });
});

test('onebot: group needs groupId; a failed retcode surfaces wording', async () => {
  assert.throws(() => specProviders.onebot.validate({ baseUrl: 'http://x', messageType: 'group' }), (e) => e.code === 'NOT_CONFIGURED');
  const network = makeNetwork(() => jsonResponse({ status: 'failed', retcode: 1, wording: 'bad target' }));
  await assert.rejects(send('onebot', { baseUrl: 'http://x', messageType: 'group', groupId: 5 }, msg(), network),
    (e) => e.code === 'API_ERROR' && /bad target/.test(e.message));
});

// ---------------------------------------------------------------------------
// wps-bot
// ---------------------------------------------------------------------------
test('wps-bot: official host text payload uses {msgtype,text}; markdown mode switches shape', async () => {
  const network = makeNetwork(() => ({ status: 200, text: '{"code":0}' }));
  await send('wps-bot', { webhook: 'https://woa.wps.cn/api/v1/webhook/send?key=abc' }, msg({ title: 'Hi', content: 'Body' }), network);
  assert.equal(network.calls[0].url, 'https://woa.wps.cn/api/v1/webhook/send?key=abc');
  assert.deepEqual(jsonBody(network.calls[0]), { msgtype: 'text', text: { content: 'Hi\nBody' } });

  const md = makeNetwork(() => ({ status: 200, text: '' }));
  await send('wps-bot', { webhook: 'https://woa.wps.cn/api/v1/webhook/send?key=abc', msgtype: 'markdown' }, msg({ title: 'Hi', content: 'Body' }), md);
  assert.deepEqual(jsonBody(md.calls[0]), { msgtype: 'markdown', markdown: { text: 'Hi\n\nBody' } });
});

test('wps-bot: non-official host and unknown msgtype fail closed', () => {
  assert.throws(() => specProviders['wps-bot'].validate({ webhook: 'https://evil.example.com/api/v1/webhook/send' }), (e) => e.code === 'NOT_CONFIGURED');
  assert.throws(() => specProviders['wps-bot'].validate({ webhook: 'https://woa.wps.cn/api/v1/webhook/send', msgtype: 'card' }), (e) => e.code === 'NOT_CONFIGURED');
});