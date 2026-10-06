// DingTalk provider (T20; 04-PROVIDERS.md, 20-HOST-PROTOCOL-MAP.md).
//
// Outbound is the custom-group-robot webhook: a markdown message, with the
// optional official "加签" carried as `timestamp` + HMAC-SHA256 `sign` query
// parameters. Inbound is the DingTalk Stream long connection spoken directly over
// ws/wss through the injected NetworkPort: the account authenticates the gateway
// (clientId/clientSecret), a socket is opened with the returned endpoint+ticket,
// every business frame is acknowledged, application-layer SYSTEM pings are echoed
// verbatim, the session webhook is learned for in-conversation replies, picture and
// richText image modules map to https attachment descriptors (a downloadCode-only
// payload fails closed), and the connection reconnects with capped exponential
// backoff. No socket or fetch is ever touched directly, and no credential ever
// appears in an error message.
import { createHmac } from 'node:crypto';
import {
  ProviderError, postJson, getJson, decodeText, tryParseJson, str, timeoutOf, describeFailure,
} from '../http.mjs';
import { capabilitiesOf } from '../specs.mjs';
import {
  inboundSecrets, inboundEnvelope, replyContextFor, controlText, combineSignals,
} from '../platform.mjs';
import { createTokenManager, normalizeTtlMs } from '../tokens.mjs';

const ID = 'dingtalk';
const API_BASE = 'https://api.dingtalk.com';
const OAPI_BASE = 'https://oapi.dingtalk.com';
const BOT_TOPIC = '/v1.0/im/bot/messages/get';
const DEFAULT_TIMEOUT_MS = 10000;
const DEDUP_WINDOW_MS = 60000;
const DEDUP_MAX = 1024;
const RECONNECT_CAP_MS = 60000;

/** Official DingTalk 加签: stringToSign = `${timestamp}\n${secret}`; URL-encoded base64(HmacSHA256). */
export function dingtalkSign(secret, timestamp) {
  const mac = createHmac('sha256', secret).update(`${timestamp}\n${secret}`, 'utf8').digest('base64');
  return encodeURIComponent(mac);
}

/** Current millisecond timestamp as a string (DingTalk expects milliseconds). */
export function dingtalkTimestamp(now = Date.now()) {
  return String(Math.floor(now));
}

/** Append `timestamp` + `sign` to the webhook; an empty secret leaves it untouched. */
function signedUrl(webhook, secret, timestamp) {
  if (secret === '') return webhook;
  const separator = webhook.includes('?') ? '&' : '?';
  return `${webhook}${separator}timestamp=${timestamp}&sign=${dingtalkSign(secret, timestamp)}`;
}

export function resolveOutbound(cfg = {}) {
  const webhook = str(cfg.webhook);
  if (webhook === '') {
    throw new ProviderError('NOT_CONFIGURED', 'dingtalk 未配置：webhook（钉钉机器人完整地址）未填写');
  }
  return {
    webhook,
    secret: str(cfg.secret),
    atAllOnTimeSensitive: cfg.atAllOnTimeSensitive === true,
    timeoutMs: timeoutOf(cfg.timeoutMs, DEFAULT_TIMEOUT_MS),
  };
}

function parseSendResult(response) {
  const payload = response.json;
  if (payload === null || typeof payload !== 'object') {
    throw new ProviderError('BAD_UPSTREAM_RESPONSE', 'dingtalk 返回了非 JSON 响应', response.text);
  }
  if (typeof payload.errcode !== 'number') {
    throw new ProviderError('BAD_UPSTREAM_RESPONSE', 'dingtalk 返回格式异常：缺少 errcode', response.text);
  }
  if (payload.errcode !== 0) {
    const detail = str(payload.errmsg) || '未知错误';
    if (payload.errcode === 310000) {
      throw new ProviderError('API_ERROR', 'dingtalk 返回 310000（加签校验失败）：请检查 secret 是否与机器人「安全设置-加签」一致');
    }
    if (payload.errcode === 120001) {
      throw new ProviderError('API_ERROR', 'dingtalk 返回 120001（access_token 失效）：请到钉钉群重新复制机器人 webhook');
    }
    throw new ProviderError('API_ERROR', `dingtalk 返回错误 ${payload.errcode}: ${detail}`);
  }
  return { status: 'accepted', providerMessageId: null };
}

async function send({ config, message, signal, network }) {
  const resolved = resolveOutbound(config ?? {});
  const title = str(message.title);
  const text = title !== '' ? `${title}\n${str(message.content)}` : str(message.content);
  const body = {
    msgtype: 'markdown',
    markdown: { title: title !== '' ? title : '通知', text },
  };
  if (resolved.atAllOnTimeSensitive && message.level === 'timeSensitive') {
    body.at = { isAtAll: true };
  }
  const response = await postJson(network, signedUrl(resolved.webhook, resolved.secret, dingtalkTimestamp()), body, {
    timeoutMs: resolved.timeoutMs, channel: 'DingTalk', signal,
  });
  return parseSendResult(response);
}

// One token manager per (appKey, appSecret); the provider is otherwise stateless.
// The port is refreshed on every use so a cached manager never keeps a stale one.
const TOKEN_MANAGERS = new Map();
const TOKEN_MANAGERS_MAX = 64;

function tokenManagerFor(appKey, appSecret, timeoutMs, network) {
  const key = `${appKey}\u0000${appSecret}`;
  const existing = TOKEN_MANAGERS.get(key);
  if (existing !== undefined) {
    existing.network = network;
    existing.timeoutMs = timeoutMs;
    return existing.manager;
  }
  const entry = { network, timeoutMs };
  entry.manager = createTokenManager(async () => {
    const url = `${OAPI_BASE}/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
    const response = await getJson(entry.network, url, { timeoutMs: entry.timeoutMs, channel: 'DingTalk' });
    const payload = response.json;
    if (Number(payload?.errcode) !== 0 || typeof payload?.access_token !== 'string' || payload.access_token === '') {
      throw new ProviderError('API_ERROR', `dingtalk 换取 access_token 失败（${payload?.errcode ?? '无码'}）: ${str(payload?.errmsg) || '检查 appKey 与 appSecret 是否匹配'}`);
    }
    return { token: payload.access_token, expiresInMs: normalizeTtlMs(Number(payload.expires_in) * 1000, 'expires_in') };
  }, { now: () => Date.now() });
  TOKEN_MANAGERS.set(key, entry);
  if (TOKEN_MANAGERS.size > TOKEN_MANAGERS_MAX) TOKEN_MANAGERS.delete(TOKEN_MANAGERS.keys().next().value);
  return entry.manager;
}

/** A business response is only OK when errcode is absent or 0; text must stay credential-free. */
function assertBusinessOk(response, label) {
  const payload = response.json;
  if (payload === null || typeof payload !== 'object') {
    throw new ProviderError('BAD_UPSTREAM_RESPONSE', `dingtalk ${label}返回了非 JSON 响应`, response.text);
  }
  if (payload.errcode !== undefined && Number(payload.errcode) !== 0) {
    throw new ProviderError('API_ERROR', `dingtalk ${label}返回错误 ${Number(payload.errcode)}: ${str(payload.errmsg) || '未知错误'}`);
  }
  return payload;
}

let replySeq = 0;

async function sendControlReply({ account, replyContext, content, signal, network }) {
  const { appKey, appSecret } = inboundSecrets(account, { appKey: true, appSecret: true });
  const transport = replyContext?.transportData ?? {};
  const text = controlText(content);
  const webhook = str(transport.sessionWebhook);
  const expiredAt = Number(transport.sessionWebhookExpiredTime) || 0;
  const webhookUsable = webhook !== '' && (expiredAt === 0 || expiredAt > Date.now());
  const robotCode = str(transport.robotCode);
  const staffId = str(transport.staffId ?? replyContext?.userId);
  if (!webhookUsable && (robotCode === '' || staffId === '')) {
    throw new ProviderError('NOT_CONFIGURED', 'dingtalk 控制回复缺少可用的 sessionWebhook 或 robotCode/staffId');
  }
  const manager = tokenManagerFor(appKey, appSecret, DEFAULT_TIMEOUT_MS, network);
  const token = await manager.get();
  const headers = { 'x-acs-dingtalk-access-token': token };
  if (webhookUsable) {
    const response = await postJson(network, webhook, {
      msgparam: JSON.stringify({ content: text }),
      msgKey: 'sampleText',
    }, { headers, channel: 'DingTalk', signal });
    assertBusinessOk(response, '会话回复');
    // The reply path returns no message id, so synthesize a unique one (G-24): a
    // timestamp plus a process-monotonic sequence keeps two identical replies apart.
    return { status: 'accepted', providerMessageId: `dt:reply-${Date.now().toString(36)}-${(++replySeq).toString(36)}` };
  }
  const url = `${API_BASE}/v1.0/robot/oToMessages/batchSend?robot_code=${encodeURIComponent(robotCode)}`;
  const response = await postJson(network, url, [{
    chatbotId: robotCode,
    msgKey: 'sampleText',
    msgParam: JSON.stringify({ content: text }),
    staffId,
  }], { headers, channel: 'DingTalk', signal });
  const payload = assertBusinessOk(response, '主动推送');
  const key = str(payload.processQueryKey);
  return { status: 'accepted', providerMessageId: key === '' ? null : `dt:${key}` };
}

// The reference has no edit-message API: `editResolved` only appends a follow-up
// reply ("消息不可编辑：以回执文本补一条结果", dingtalk-stream.mjs:643-651), so an
// edit claim would be a fake success.
async function updateControlMessage() {
  throw new ProviderError('UNSUPPORTED', 'dingtalk 不支持编辑已发送消息：请在原消息之后补发结果');
}

async function openGateway(network, appKey, appSecret, timeoutMs, signal) {
  const response = await postJson(network, `${API_BASE}/v1.0/gateway/connections/open`, {
    clientId: appKey,
    clientSecret: appSecret,
    subscriptions: [{ type: 'CALLBACK', topic: BOT_TOPIC }],
    ua: 'dsh-notifier',
  }, { timeoutMs, channel: 'DingTalk', signal });
  const endpoint = str(response.json?.endpoint);
  const ticket = str(response.json?.ticket);
  if (!/^wss?:\/\//.test(endpoint) || ticket === '') {
    throw new ProviderError('BAD_UPSTREAM_RESPONSE', `dingtalk 打开 Stream 网关失败: ${describeFailure(response.json, response.text) || '缺少 endpoint/ticket'}`);
  }
  return { endpoint, ticket };
}

const MAX_MEDIA_URL_LENGTH = 2048;

/**
 * Only an explicit, credential-free https URL is a usable inbound media location.
 * DingTalk picture payloads frequently carry only a `downloadCode` (an opaque handle
 * that needs a separate "download received file" API call to become a URL); the
 * frozen reference deliberately never makes that call and fails closed, so a
 * downloadCode-only payload yields no attachment (see dingtalk-stream.mjs:88-92).
 */
function httpsMediaUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '' || raw.length > MAX_MEDIA_URL_LENGTH) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { return ''; }
  if (parsed.protocol !== 'https:' || parsed.hostname === '') return '';
  if (parsed.username !== '' || parsed.password !== '') return '';
  return parsed.href;
}

/** Bounded known-field attachment: only the reference's url whitelist is read, everything else is dropped. */
function imageAttachmentFrom(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const url = httpsMediaUrl(raw.url ?? raw.media_url ?? raw.mediaUrl ?? raw.download_url ?? raw.downloadUrl);
  return url === '' ? null : { url };
}

function pushUnique(list, attachment) {
  if (attachment !== null && !list.some((item) => item.url === attachment.url)) list.push(attachment);
}

/**
 * picture/image messages, and mixed messages carrying a `picture`/`image` field, map
 * to attachment descriptors (reference parseDingtalkImageMessage).
 */
function imageAttachmentsOf(msg) {
  const type = str(msg.msgtype).toLowerCase();
  const candidates = [];
  if (type === 'picture' || type === 'image') candidates.push(msg.picture, msg.image, msg.content);
  else if (msg.picture !== undefined || msg.image !== undefined) candidates.push(msg.picture, msg.image);
  const out = [];
  for (const candidate of candidates) pushUnique(out, imageAttachmentFrom(candidate));
  return out;
}

/**
 * richText messages carry text modules and image modules in one array; text segments
 * concatenate, image segments run through the same whitelist as pictures (reference
 * parseRichTextMessage). Returns null for any non-richText message.
 */
function richTextContentOf(msg) {
  const modules = msg?.content?.richText;
  if (!Array.isArray(modules)) return null;
  let text = '';
  const attachments = [];
  for (const module of modules) {
    if (module === null || typeof module !== 'object' || Array.isArray(module)) continue;
    if (typeof module.text === 'string') text += module.text;
    pushUnique(attachments, imageAttachmentFrom(module) ?? imageAttachmentFrom(module.picture) ?? imageAttachmentFrom(module.image));
  }
  return { text, attachments };
}

async function start({ account, epoch, emit, signal, network, clock = () => Date.now(), onFatal, reconnectBaseMs = 1000 }) {
  if (network === null || typeof network?.request !== 'function' || typeof network?.openWebSocket !== 'function') {
    throw new ProviderError('UNSUPPORTED', 'dingtalk 入站缺少网络端口');
  }
  if (typeof emit !== 'function') throw new ProviderError('NOT_CONFIGURED', 'dingtalk 入站缺少 emit');
  const { appKey, appSecret } = inboundSecrets(account, { appKey: true, appSecret: true });
  const timeoutMs = timeoutOf(account?.config?.inbound?.timeoutMs, DEFAULT_TIMEOUT_MS);
  const base = Math.max(1, Number(reconnectBaseMs) || 1000);
  // Jitter [0, min(1000, base)) keeps the frozen 0..1000ms protocol semantics at the
  // default base while allowing a short, near-deterministic backoff in tests.
  const jitterCapMs = Math.min(1000, base);

  const controller = new AbortController();
  const stopSignal = combineSignals(signal, controller.signal);
  const state = { ws: null, reconnectTimer: null, attempts: 0, stopped: false };
  const seenMsgIds = new Map();

  function sendFrame(payload) {
    const socket = state.ws;
    if (socket === null) return;
    try {
      const pending = socket.send(new TextEncoder().encode(JSON.stringify(payload)));
      if (pending !== null && typeof pending?.catch === 'function') pending.catch(() => {});
    } catch { /* a gone socket must never break frame handling */ }
  }

  function ackFrame(messageId) {
    if (messageId === '') return;
    // G-01: the id lives only in frame.headers.messageId; data is the JSON string '"OK"'.
    sendFrame({ code: 200, headers: { contentType: 'application/json', messageId }, data: JSON.stringify('OK') });
  }

  /** Application-layer SYSTEM frames (distinct from transport WS ping/pong). */
  function handleSystemFrame(frame) {
    const headers = frame.headers !== null && typeof frame.headers === 'object' ? frame.headers : {};
    const marker = str(headers.topic ?? headers.method ?? headers.event_type ?? headers.eventType).toLowerCase();
    if (marker === 'ping') sendFrame({ code: 200, headers: frame.headers, data: frame.data });
  }

  function isFreshMsgId(msgId) {
    const now = clock();
    for (const [id, at] of seenMsgIds) {
      if (now - at >= DEDUP_WINDOW_MS) seenMsgIds.delete(id);
    }
    if (seenMsgIds.has(msgId)) return false;
    seenMsgIds.set(msgId, now);
    if (seenMsgIds.size > DEDUP_MAX) seenMsgIds.delete(seenMsgIds.keys().next().value);
    return true;
  }

  function handleBotMessage(msg) {
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return;
    const msgtype = str(msg.msgtype).toLowerCase();
    if (msgtype !== 'text' && msgtype !== 'richtext' && msgtype !== 'picture' && msgtype !== 'image') return;
    const chatId = str(msg.conversationId);
    const msgId = str(msg.msgId);
    const userId = str(msg.senderStaffId);
    if (chatId === '' || msgId === '' || userId === '') return;
    if (!isFreshMsgId(msgId)) return;
    const rich = richTextContentOf(msg);
    const text = (rich !== null ? rich.text : str(msg.text?.content)).trim();
    const attachments = rich !== null ? rich.attachments : imageAttachmentsOf(msg);
    if (text === '' && attachments.length === 0) return;
    const transportData = {
      chatId,
      staffId: userId,
      robotCode: str(msg.robotCode),
      sessionWebhook: str(msg.sessionWebhook),
      sessionWebhookExpiredTime: Number(msg.sessionWebhookExpiredTime) || 0,
    };
    const envelope = inboundEnvelope({
      account, epoch,
      eventId: `dt:${msgId}`,
      userId, chatId,
      chatType: str(msg.conversationType) === '2' ? 'group' : 'private',
      kind: 'message',
      messageId: msgId,
      text: text === '' ? '[图片]' : text,
      attachments,
      replyContext: replyContextFor(account, { userId, chatId, transportData }),
    });
    // The frame was acknowledged before this point (emit must never be the first
    // evidence of receipt); a synchronous emit throw still must not kill the loop.
    try {
      const outcome = emit(envelope);
      if (outcome !== null && typeof outcome?.catch === 'function') outcome.catch(() => {});
    } catch { /* isolated per message */ }
  }

  function handleFrame(bytes) {
    const frame = tryParseJson(decodeText(bytes));
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return;
    if (frame.type === 'SYSTEM') {
      handleSystemFrame(frame);
      return;
    }
    const messageId = str(frame.headers?.messageId);
    ackFrame(messageId);
    if (frame.data === undefined || frame.data === null) return;
    let data = frame.data;
    if (typeof data === 'string') {
      data = tryParseJson(data);
      // The frame was already ACKed, so a corrupt payload is dropped, never redelivered.
      if (data === null) return;
    }
    try {
      handleBotMessage(data);
    } catch { /* isolated per message */ }
  }

  function scheduleReconnect() {
    if (state.stopped || state.reconnectTimer !== null) return;
    const delay = Math.min(base * 2 ** state.attempts, RECONNECT_CAP_MS) + Math.floor(Math.random() * jitterCapMs);
    state.attempts += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (state.stopped) return;
      connect().catch((error) => {
        if (state.stopped) return;
        const code = typeof error?.code === 'string' ? error.code : 'NETWORK_ERROR';
        // A configuration/authorisation failure cannot be fixed by retrying; report
        // it as fatal so the manager degrades instead of looping forever.
        if ((code === 'NOT_CONFIGURED' || code === 'UNSUPPORTED') && typeof onFatal === 'function') {
          onFatal({ code, message: String(error?.message ?? error) });
          return;
        }
        scheduleReconnect();
      });
    }, delay);
  }

  async function connect() {
    const { endpoint, ticket } = await openGateway(network, appKey, appSecret, timeoutMs, stopSignal);
    if (state.stopped || stopSignal.aborted) return;
    const separator = endpoint.includes('?') ? '&' : '?';
    const holder = { socket: null };
    const socket = await network.openWebSocket({
      url: `${endpoint}${separator}ticket=${encodeURIComponent(ticket)}`,
      headers: {},
      timeoutMs,
      signal: stopSignal,
      onFrame: (bytes) => handleFrame(bytes),
      onClose: () => {
        if (state.ws !== holder.socket) return;
        state.ws = null;
        scheduleReconnect();
      },
    });
    holder.socket = socket;
    if (state.stopped) {
      try { await socket.close(); } catch { /* already gone */ }
      return;
    }
    state.ws = socket;
    state.attempts = 0;
  }

  // The first connection is awaited so an authentication/configuration failure is a
  // typed error the caller can observe, while later drops reconnect in the background.
  await connect();

  return {
    async stop() {
      state.stopped = true;
      controller.abort();
      if (state.reconnectTimer !== null) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      const socket = state.ws;
      state.ws = null;
      if (socket !== null) {
        try { await socket.close(); } catch { /* best effort */ }
      }
    },
  };
}

export default Object.freeze({
  id: ID,
  capabilities: capabilitiesOf(ID),
  resolve: resolveOutbound,
  validate: (config) => { resolveOutbound(config ?? {}); },
  send,
  sendControlReply,
  updateControlMessage,
  start,
});
