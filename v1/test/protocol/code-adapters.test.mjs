// T22 protocol tests for the code adapters: real URL / method / headers / body,
// success, platform failure, malformed response, timeout and cancellation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNetwork, jsonResponse, jsonBody, formBody, textBody, signal } from './helpers.mjs';
import { DomainError } from '../../src/domain/errors.mjs';
import bark from '../../src/providers/bark/index.mjs';
import pushplus from '../../src/providers/pushplus/index.mjs';
import serverchan, { endpointOf } from '../../src/providers/serverchan/index.mjs';
import webhook from '../../src/providers/webhook/index.mjs';
import wecomApp from '../../src/providers/wecom-app/index.mjs';

const msg = (over = {}) => ({ title: 'T', content: 'C', level: 'active', ...over });

// ---------------------------------------------------------------------------
// bark
// ---------------------------------------------------------------------------

test('bark: <server>/<key> JSON body and code=200 accepted', async () => {
  const network = makeNetwork(() => jsonResponse({ code: 200 }));
  const result = await bark.send({
    config: { key: 'k1', server: 'https://api.day.app/', device: 'dev', timeoutMs: 5000 },
    message: msg({ level: 'timeSensitive', group: 'g' }),
    signal: signal(),
    network,
  });
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(network.calls[0].url, 'https://api.day.app/k1');
  assert.equal(network.calls[0].method, 'POST');
  assert.deepEqual(jsonBody(network.calls[0]), { title: 'T', body: 'C', group: 'g', level: 'timeSensitive', device: 'dev' });
});

test('bark: barkUrl wins over server+key; platform error throws API_ERROR', async () => {
  const okNet = makeNetwork(() => jsonResponse({ code: 200 }));
  await bark.send({ config: { barkUrl: 'https://example.com/x/' }, message: msg(), signal: signal(), network: okNet });
  assert.equal(okNet.calls[0].url, 'https://example.com/x');
  const badNet = makeNetwork(() => jsonResponse({ code: 400, message: 'bad key' }));
  await assert.rejects(bark.send({ config: { key: 'k' }, message: msg(), signal: signal(), network: badNet }),
    (e) => e.code === 'API_ERROR' && /bad key/.test(e.message));
});

test('bark: missing key is NOT_CONFIGURED and malformed body is BAD_UPSTREAM_RESPONSE', async () => {
  assert.throws(() => bark.validate({}), (e) => e.code === 'NOT_CONFIGURED');
  const net = makeNetwork(() => ({ status: 200, text: 'not json' }));
  await assert.rejects(bark.send({ config: { key: 'k' }, message: msg(), signal: signal(), network: net }),
    (e) => e.code === 'BAD_UPSTREAM_RESPONSE');
});

// ---------------------------------------------------------------------------
// pushplus
// ---------------------------------------------------------------------------

test('pushplus: fixed endpoint, body fields, code=200 accepted', async () => {
  const network = makeNetwork(() => jsonResponse({ code: 200 }));
  await pushplus.send({
    config: { token: 'tk', template: 'markdown', channel: 'wechat', topic: 'tp', option: 'op', timeoutMs: 10000 },
    message: msg(),
    signal: signal(),
    network,
  });
  assert.equal(network.calls[0].url, 'https://www.pushplus.plus/send');
  assert.deepEqual(jsonBody(network.calls[0]), {
    token: 'tk', title: 'T', content: 'C', template: 'markdown', channel: 'wechat', topic: 'tp', option: 'op',
  });
});

test('pushplus: template/channel enums are validated at config time', () => {
  assert.throws(() => pushplus.resolve({ token: 't', template: 'nope' }), (e) => e.code === 'NOT_CONFIGURED');
  assert.throws(() => pushplus.resolve({ token: 't', channel: 'nope' }), (e) => e.code === 'NOT_CONFIGURED');
  assert.throws(() => pushplus.resolve({}), (e) => e.code === 'NOT_CONFIGURED');
});

test('pushplus: platform error and malformed response', async () => {
  const bad = makeNetwork(() => jsonResponse({ code: 500, msg: 'internal' }));
  await assert.rejects(pushplus.send({ config: { token: 't' }, message: msg(), signal: signal(), network: bad }),
    (e) => e.code === 'API_ERROR' && /internal/.test(e.message));
  const malformed = makeNetwork(() => jsonResponse({ nope: 1 }));
  await assert.rejects(pushplus.send({ config: { token: 't' }, message: msg(), signal: signal(), network: malformed }),
    (e) => e.code === 'BAD_UPSTREAM_RESPONSE');
});

// ---------------------------------------------------------------------------
// serverchan
// ---------------------------------------------------------------------------

test('serverchan: Turbo and SC3 endpoints are derived from the SENDKEY', () => {
  assert.equal(endpointOf('SCT123'), 'https://sctapi.ftqq.com/SCT123.send');
  assert.equal(endpointOf('sctp123tABC'), 'https://123.push.ft07.com/send/sctp123tABC.send');
  assert.throws(() => endpointOf('sctpBROKEN'), (e) => e.code === 'NOT_CONFIGURED');
});

test('serverchan: form title+desp and code=0 accepted; code!=0 throws', async () => {
  const network = makeNetwork(() => jsonResponse({ code: 0 }));
  const result = await serverchan.send({ config: { sct: 'SCT123' }, message: msg(), signal: signal(), network });
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(network.calls[0].url, 'https://sctapi.ftqq.com/SCT123.send');
  assert.equal(network.calls[0].headers['content-type'], 'application/x-www-form-urlencoded; charset=utf-8');
  assert.deepEqual(formBody(network.calls[0]), { title: 'T', desp: 'C' });
  const bad = makeNetwork(() => jsonResponse({ code: 1, message: 'no key' }));
  await assert.rejects(serverchan.send({ config: { sct: 'SCT1' }, message: msg(), signal: signal(), network: bad }),
    (e) => e.code === 'API_ERROR' && /no key/.test(e.message));
});

test('serverchan: SC3 malformed key fails at validate', () => {
  assert.throws(() => serverchan.validate({ sct: 'sctpBROKEN' }), (e) => e.code === 'NOT_CONFIGURED');
  assert.throws(() => serverchan.validate({}), (e) => e.code === 'NOT_CONFIGURED');
});

// ---------------------------------------------------------------------------
// webhook
// ---------------------------------------------------------------------------

test('webhook: JSON body, custom headers and timestamp; 2xx accepted', async () => {
  const network = makeNetwork(() => ({ status: 204, text: '' }));
  await webhook.send({
    config: { url: 'https://example.com/hook', headers: JSON.stringify({ authorization: 'Bearer x', 'x-num': 7 }), allowPrivateNetwork: true },
    message: msg({ level: 'passive', group: 'g' }),
    signal: signal(),
    network,
  });
  const call = network.calls[0];
  assert.equal(call.url, 'https://example.com/hook');
  assert.equal(call.headers.authorization, 'Bearer x');
  assert.equal(call.headers['x-num'], '7');
  assert.equal(call.allowPrivateNetwork, true);
  const body = jsonBody(call);
  assert.equal(body.title, 'T');
  assert.equal(body.content, 'C');
  assert.equal(body.level, 'passive');
  assert.equal(body.group, 'g');
  assert.equal(typeof body.timestamp, 'string');
});

test('webhook: missing url is NOT_CONFIGURED; non-2xx throws HTTP_ERROR', async () => {
  assert.throws(() => webhook.validate({}), (e) => e.code === 'NOT_CONFIGURED');
  const net = makeNetwork(() => ({ status: 500, text: 'boom' }));
  await assert.rejects(webhook.send({ config: { url: 'https://e.com/' }, message: msg(), signal: signal(), network: net }),
    (e) => e.code === 'HTTP_ERROR' && e.retryable === true);
});

test('webhook: non-scalar header values are dropped (never guessed)', () => {
  const resolved = webhook.resolve({ url: 'https://e.com/', headers: JSON.stringify({ a: 'x', b: { nested: 1 }, c: null }) });
  assert.deepEqual(resolved.headers, { a: 'x' });
});

// ---------------------------------------------------------------------------
// wecom-app
// ---------------------------------------------------------------------------

test('wecom-app: gettoken then message/send carries touser/agentid/content', async () => {
  const network = makeNetwork((init) => {
    if (init.url.startsWith('https://qyapi.weixin.qq.com/cgi-bin/gettoken')) {
      return jsonResponse({ errcode: 0, access_token: 'tok-1', expires_in: 7200 });
    }
    return jsonResponse({ errcode: 0 });
  });
  const result = await wecomApp.send({
    config: { corpid: 'cp', secret: 'se', agentId: '1000002', toUser: 'user1', msgtype: 'markdown' },
    message: { title: 'Hi', content: 'Body', level: 'active' },
    signal: signal(),
    network,
  });
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(network.calls.length, 2);
  assert.match(network.calls[0].url, /gettoken\?corpid=cp&corpsecret=se$/);
  assert.match(network.calls[1].url, /message\/send\?access_token=tok-1$/);
  assert.deepEqual(jsonBody(network.calls[1]), {
    touser: 'user1', msgtype: 'markdown', agentid: 1000002, markdown: { content: 'Hi\nBody' },
  });
});

test('wecom-app: an invalidated token is refreshed and the send retried exactly once', async () => {
  let tokenCalls = 0;
  const network = makeNetwork((init) => {
    if (init.url.includes('gettoken')) {
      tokenCalls += 1;
      return jsonResponse({ errcode: 0, access_token: `tok-${tokenCalls}`, expires_in: 7200 });
    }
    // First send rejects the token; the second (with tok-2) succeeds.
    return jsonResponse(tokenCalls === 1 ? { errcode: 42001, errmsg: 'expired' } : { errcode: 0 });
  });
  const result = await wecomApp.send({
    config: { corpid: 'cp2', secret: 'se2', agentId: '1' },
    message: { title: '', content: 'x', level: 'active' },
    signal: signal(),
    network,
  });
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(tokenCalls, 2, 'token fetched, invalidated, fetched again');
});

test('wecom-app: business error carries the agentid hint; missing config fails closed', async () => {
  const net = makeNetwork((init) => (init.url.includes('gettoken')
    ? jsonResponse({ errcode: 0, access_token: 't', expires_in: 7200 })
    : jsonResponse({ errcode: 40056, errmsg: 'invalid agentid' })));
  await assert.rejects(wecomApp.send({ config: { corpid: 'c', secret: 's', agentId: '1' }, message: msg(), signal: signal(), network: net }),
    (e) => e.code === 'API_ERROR' && /agentid 不匹配/.test(e.message));
  assert.throws(() => wecomApp.validate({ corpid: 'c', secret: 's' }), (e) => e.code === 'NOT_CONFIGURED');
  assert.throws(() => wecomApp.validate({ corpid: 'c', secret: 's', agentId: 'NaN' }), (e) => e.code === 'NOT_CONFIGURED');
});

// ---------------------------------------------------------------------------
// shared: timeout / cancel propagate as typed ProviderError
// ---------------------------------------------------------------------------

test('timeout and cancellation map to TIMEOUT / CANCELLED for code adapters', async () => {
  const timeoutNet = makeNetwork(() => Object.assign(new Error('t'), { code: 'TIMEOUT' }));
  await assert.rejects(bark.send({ config: { key: 'k' }, message: msg(), signal: signal(), network: timeoutNet }),
    (e) => e.code === 'TIMEOUT' && e.uncertain === true);
  const abort = new AbortController();
  abort.abort();
  const cancelNet = makeNetwork(() => jsonResponse({ code: 200 }));
  await assert.rejects(bark.send({ config: { key: 'k' }, message: msg(), signal: abort.signal, network: cancelNet }),
    (e) => e.code === 'CANCELLED');
});

test('code adapters expose capabilities from the frozen descriptors', () => {
  for (const provider of [bark, pushplus, serverchan, webhook, wecomApp]) {
    assert.equal(provider.capabilities.outbound, true, provider.id);
    assert.equal(provider.capabilities.inbound, false, provider.id);
  }
  assert.ok(textBody !== undefined);
  assert.ok(DomainError);
});