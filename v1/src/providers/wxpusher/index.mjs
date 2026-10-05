// WxPusher provider (T21; 04-PROVIDERS.md, 20-HOST-PROTOCOL-MAP.md).
//
// Outbound is a single JSON send. Inbound is an HTTP callback mounted by the Host
// (W06): WxPusher has no signature, so authentication is the unguessable callback
// route (the system-generated account id in the fixed path), a strict uid shape
// check, and the pairing/whitelist enforced by the conversation layer. The
// callback body is never trusted to name its own account, and the appToken only
// ever comes from the account secret resolver — never from the callback payload.
import { createHash } from 'node:crypto';
import { ProviderError, decodeText, tryParseJson, postJson, str, timeoutOf } from '../http.mjs';
import { capabilitiesOf } from '../specs.mjs';
import { inboundSecrets, replyContextFor, controlText } from '../platform.mjs';

const ID = 'wxpusher';
const SEND_ENDPOINT = 'https://wxpusher.zjiecode.com/api/send/message';
const DEFAULT_TIMEOUT_MS = 10000;
const UID_MAX_LEN = 128;
// WxPusher upstream uids have no signature: constrain the shape before it can
// reach identity/routing, so a forged payload cannot smuggle path/injection.
const UID_PATTERN = /^[A-Za-z0-9_.\-]+$/;
const MAX_CONTROL_TEXT = 4000;

/** A process-monotonic suffix mirrors the frozen reference (G-27): WxPusher sends
 *  no message id, so without it two real same-second messages would collide. */
let syntheticSeq = 0;

function isValidUid(uid) {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= UID_MAX_LEN && UID_PATTERN.test(uid);
}

function hash6(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 6);
}

/** Strip the `#{appId} content` up-channel command prefix; return the net text. */
function stripCommandPrefix(content, appId) {
  const text = str(content).trim();
  const prefixed = appId !== '' ? `#${appId}` : '';
  if (prefixed !== '' && (text === prefixed || (text.startsWith(prefixed) && /\s/.test(text[prefixed.length] ?? '')))) {
    return text.slice(prefixed.length).trim();
  }
  return text.replace(/^#\S+\s+/, '').trim();
}

function strArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

function intArray(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const n = Number(item);
    if (Number.isInteger(n) && n >= 0) out.push(n);
  }
  return out;
}

function textAck(status, body = '') {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: new TextEncoder().encode(body) };
}

export function resolveOutbound(cfg = {}) {
  const appToken = str(cfg.appToken);
  const uids = strArray(cfg.uids);
  const topicIds = intArray(cfg.topicIds);
  if (appToken === '') {
    throw new ProviderError('NOT_CONFIGURED', 'wxpusher 未配置：appToken 未填写');
  }
  if (uids.length === 0 && topicIds.length === 0) {
    throw new ProviderError('NOT_CONFIGURED', 'wxpusher 未配置：请至少填写一个接收用户UID或主题ID');
  }
  return { appToken, uids, topicIds, timeoutMs: timeoutOf(cfg.timeoutMs, DEFAULT_TIMEOUT_MS) };
}

function parseSendResult(response, appToken) {
  const payload = response.json;
  if (payload === null || typeof payload !== 'object') {
    throw new ProviderError('BAD_UPSTREAM_RESPONSE', 'wxpusher 返回了非 JSON 响应', response.text);
  }
  if (typeof payload.code !== 'number') {
    throw new ProviderError('BAD_UPSTREAM_RESPONSE', 'wxpusher 返回格式异常：缺少 code', response.text);
  }
  if (payload.code !== 1000) {
    const detail = str(payload.msg) || '未知错误';
    throw new ProviderError('API_ERROR', `wxpusher 返回错误 ${payload.code}: ${detail}`);
  }
  void appToken;
  return { status: 'accepted', providerMessageId: null };
}

async function send({ config, message, signal, network }) {
  const resolved = resolveOutbound(config ?? {});
  const title = str(message.title);
  const content = title !== '' ? `${title}\n${str(message.content)}` : str(message.content);
  const response = await postJson(network, SEND_ENDPOINT, {
    appToken: resolved.appToken,
    content,
    summary: title,
    contentType: 1,
    uids: resolved.uids,
    topicIds: resolved.topicIds,
  }, { timeoutMs: resolved.timeoutMs, channel: 'WxPusher', signal });
  return parseSendResult(response, resolved.appToken);
}

async function pushToUid(network, appToken, uid, text, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const body = str(text).slice(0, MAX_CONTROL_TEXT);
  const response = await postJson(network, SEND_ENDPOINT, {
    appToken,
    content: body,
    summary: body.split('\n')[0].slice(0, 100),
    contentType: 1,
    uids: [uid],
    topicIds: [],
  }, { timeoutMs, channel: 'WxPusher', signal });
  return parseSendResult(response, appToken);
}

async function sendControlReply({ account, replyContext, content, signal, network }) {
  const { appToken } = inboundSecrets(account, { appToken: true });
  const uid = str(replyContext?.chatId ?? replyContext?.userId);
  if (uid === '') throw new ProviderError('NOT_CONFIGURED', 'wxpusher 控制回复缺少 uid');
  return pushToUid(network, appToken, uid, controlText(content), { signal });
}

/** Callback-only inbound: the Host owns the route; `start` only admits config. */
async function start({ account }) {
  inboundSecrets(account, { appToken: true });
  return { async stop() {} };
}

async function handleCallback({ account, method, rawBody, epoch }) {
  if (str(method).toUpperCase() !== 'POST') return { ok: false, ack: textAck(405, 'method not allowed') };
  const payload = tryParseJson(decodeText(rawBody));
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, ack: textAck(400, 'bad payload') };
  }
  const action = str(payload.action);
  const data = payload.data !== null && typeof payload.data === 'object' ? payload.data : {};
  // app_subscribe / unknown actions carry no business meaning in v1 (pairing is
  // explicit); acknowledge and ignore instead of inventing a handshake.
  if (action !== 'send_up_cmd') return { ok: false, ack: textAck(200, '') };

  const uid = str(data.uid);
  if (!isValidUid(uid)) return { ok: false, ack: textAck(400, 'invalid uid') };
  const text = stripCommandPrefix(data.content, str(data.appId));
  if (text === '') return { ok: false, ack: textAck(200, '') };

  const eventId = `wxpusher:${uid}:${str(data.time)}:${hash6(text)}:${syntheticSeq++}`;
  return {
    ok: true,
    envelope: {
      accountId: account.id,
      epoch,
      eventId,
      userId: uid,
      chatId: uid,
      chatType: 'private',
      kind: 'message',
      messageId: eventId,
      text,
      attachments: [],
      replyContext: replyContextFor(account, { userId: uid, chatId: uid, transportData: { uid } }),
    },
  };
}

function callbackAck({ replayed = false } = {}) {
  return textAck(200, replayed ? 'duplicate' : '');
}

export default Object.freeze({
  id: ID,
  capabilities: capabilitiesOf(ID),
  resolve: resolveOutbound,
  validate: (config) => { resolveOutbound(config ?? {}); },
  send,
  sendControlReply,
  start,
  handleCallback,
  callbackAck,
});
