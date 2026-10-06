// QQ 官方机器人 provider (T19; 04-PROVIDERS.md, 20-HOST-PROTOCOL-MAP.md).
//
// Outbound is the two-step bot API: POST getAppAccessToken (appId + clientSecret)
// then POST /v2/{users|groups}/<id>/messages, authorized with `QQBot <token>`.
// msg_seq is the server-side dedupe key, so the counter is frozen while one send
// is in flight and only advanced after every segment is accepted (a retry reuses
// the same (seq, content) pairs and the already-delivered prefixes stay deduped).
// Sends are serialized per target by a local rate gate (60qpm ≈ 1/s).
//
// Inbound is the raw WebSocket gateway (no SDK): HELLO → IDENTIFY/RESUME →
// READY/RESUMED, op1/op11 heartbeat, op0 DISPATCH (C2C and group @ messages),
// reconnect with RESUME priority. The connection lives behind the injected
// NetworkPort's openWebSocket (ws/wss only); this module never touches a socket
// or fetch directly. A frame's cursor seq advances only after `emit` returns
// accepted (or DUPLICATE), so a rejected event is redelivered on resume.
import { ProviderError, str, num, timeoutOf, postJson, getJson, describeFailure, decodeText } from '../http.mjs';
import { capabilitiesOf } from '../specs.mjs';
import { createTokenManager, normalizeTtlMs } from '../tokens.mjs';
import {
  inboundSecrets, inboundEnvelope, replyContextFor, controlText, controlActions,
  chunkText, sleep, combineSignals, toInt,
} from '../platform.mjs';

const ID = 'qq-bot';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const DEFAULT_API_BASE = 'https://api.sgroup.qq.com';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RATE_MS = 1050;
// 出站单条上限按 Unicode 码点计：文本 2000 / Markdown 3000（官方限制）。
const TEXT_MAX_CODEPOINTS = 2000;
const MARKDOWN_MAX_CODEPOINTS = 3000;
// QQ keyboard 按钮 label 上限 ≤10 码点（按码点截断，不产生孤立代理项）。
const BUTTON_LABEL_MAX_CODEPOINTS = 10;
const MAX_FRAME_BYTES = 1024 * 1024;
const STATE_MAX = 1024;

// WS op codes（QQ 网关协议）
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;
const INTENTS = (1 << 25) | (1 << 26); // GROUP_AND_C2C | INTERACTION
const CLOSE_4008_WAIT_MS = 60000;

// Group @ prefix whitelist (only proven shapes are stripped; anything else is kept).
const MENTION_WHITELIST = [/^<@!\d+>\s*/, /^<@\d+>\s*/, /^@\S+\s+/];

// Cross-send state: per-target rate gate + msg_seq counter (shared by outbound and
// control replies). Keyed by apiBase|targetType|targetId so accounts never collide.
const RATE_GATES = new Map();
const MSG_SEQS = new Map();

function boundedSet(map, key, value) {
  if (map.size >= STATE_MAX && !map.has(key)) map.delete(map.keys().next().value);
  map.set(key, value);
}

function gateFor(key, rateMs) {
  let entry = RATE_GATES.get(key);
  if (entry === undefined || entry.rateMs !== rateMs) {
    entry = { rateMs, last: 0, chain: Promise.resolve() };
    boundedSet(RATE_GATES, key, entry);
  }
  return () => {
    const run = async () => {
      const wait = entry.last + entry.rateMs - Date.now();
      if (wait > 0) await sleep(wait);
      entry.last = Date.now();
    };
    entry.chain = entry.chain.then(run, run);
    return entry.chain;
  };
}

function seqBaseFor(key) {
  return MSG_SEQS.get(key) ?? 0;
}

function setSeqBase(key, value) {
  boundedSet(MSG_SEQS, key, value);
}

const targetKeyOf = (apiBase, targetType, targetId) => `${apiBase}\u0000${targetType}\u0000${targetId}`;
const clampButtonLabel = (label) => {
  const points = Array.from(str(label).trim());
  return points.length <= BUTTON_LABEL_MAX_CODEPOINTS
    ? points.join('')
    : points.slice(0, BUTTON_LABEL_MAX_CODEPOINTS - 1).join('') + '…';
};

/** Normalize an HTTP failure: 401/403 → FORBIDDEN, other 4xx/5xx → API_ERROR hint. */
function mapHttpError(error, label) {
  if (!(error instanceof ProviderError)) return error;
  if (error.code === 'HTTP_ERROR' && Number.isInteger(error.status)) {
    if (error.status === 401 || error.status === 403) {
      return new ProviderError('FORBIDDEN', `${label} 鉴权失败（HTTP ${error.status}）`, error.detail);
    }
    const hint = describeFailure(error.json, error.text);
    return new ProviderError('API_ERROR', `${label} 返回 HTTP ${error.status}${hint !== '' ? `: ${hint}` : ''}`, error.detail, {
      status: error.status, retryable: error.retryable, retryAfterMs: error.retryAfterMs, uncertain: error.uncertain,
    });
  }
  return error;
}

/** Exchange appId/appSecret for an access_token (TTL normalized, never faked). */
async function fetchAccessToken(network, appId, appSecret, { timeoutMs, signal }) {
  let response;
  try {
    response = await postJson(network, TOKEN_URL, { appId, clientSecret: appSecret }, { timeoutMs, channel: 'QQ Bot', signal });
  } catch (error) {
    throw mapHttpError(error, 'qq-bot token');
  }
  const payload = response.json;
  if (payload === null || typeof payload !== 'object') {
    throw new ProviderError('BAD_UPSTREAM_RESPONSE', 'qq-bot 换取 access_token 失败：返回非 JSON', response.text);
  }
  const token = str(payload.access_token);
  if (token === '') {
    throw new ProviderError('API_ERROR', 'qq-bot 换取 access_token 失败：检查 appId/appSecret 是否正确（q.qq.com 开发设置页）', response.text);
  }
  return { token, expiresInMs: normalizeTtlMs(num(payload.expires_in, NaN) * 1000, 'expires_in') };
}

function tokenManagerFor(network, appId, appSecret, timeoutMs, signal) {
  return createTokenManager(() => fetchAccessToken(network, appId, appSecret, { timeoutMs, signal }));
}

/** POST one QQ message; 2xx JSON {id,timestamp}; a non-JSON body or {code} fails. */
async function postQq(network, url, body, token, timeoutMs, signal) {
  let response;
  try {
    response = await postJson(network, url, body, { headers: { authorization: `QQBot ${token}` }, timeoutMs, channel: 'QQ Bot', signal });
  } catch (error) {
    throw mapHttpError(error, 'qq-bot');
  }
  const payload = response.json;
  if (payload === null || typeof payload !== 'object') {
    // A 2xx with a non-JSON body is a gateway error page / empty body — treat as
    // delivery failure rather than optimistic success (fail closed).
    throw new ProviderError('BAD_UPSTREAM_RESPONSE', 'qq-bot 返回格式异常：2xx 但响应非 JSON（预期 {id,timestamp}，可能是网关错误页）', response.text);
  }
  const code = str(payload.code);
  if (code !== '') {
    throw new ProviderError('API_ERROR', `qq-bot 返回错误 ${code}: ${str(payload.message) || '未知错误'}（确认机器人已开启相应场景的主动消息权限）`);
  }
  return { id: str(payload.id) || null };
}

export function resolveOutbound(cfg = {}) {
  const appId = str(cfg.appId);
  const appSecret = str(cfg.appSecret);
  const targetType = str(cfg.targetType) === 'group' ? 'group' : 'user';
  const targetId = str(targetType === 'group' ? cfg.groupId : cfg.userId);
  const missing = [];
  if (appId === '') missing.push('appId（QQ 开放平台 q.qq.com → 机器人开发设置）');
  if (appSecret === '') missing.push('appSecret（同页面 AppSecret）');
  if (targetId === '') missing.push(targetType === 'group' ? 'groupId（群 open id）' : 'userId（单聊用户 openid）');
  if (missing.length > 0) {
    throw new ProviderError('NOT_CONFIGURED', `qq-bot 未配置：${missing.join('、')} 未填写`);
  }
  return {
    appId,
    appSecret,
    targetType,
    targetId,
    apiBase: (str(cfg.apiBase) || DEFAULT_API_BASE).replace(/\/+$/, ''),
    timeoutMs: timeoutOf(cfg.timeoutMs, DEFAULT_TIMEOUT_MS),
    rateMs: Math.min(60000, Math.max(0, num(cfg.rateMs, DEFAULT_RATE_MS))),
    markdown: cfg.markdown !== false,
  };
}

/** Outbound notification (markdown by default; plain text when markdown=false). */
async function send({ config, message, signal, network }) {
  const resolved = resolveOutbound(config ?? {});
  if (network === null || typeof network?.request !== 'function') {
    throw new ProviderError('UNSUPPORTED', 'qq-bot 出站缺少网络端口');
  }
  const tokens = tokenManagerFor(network, resolved.appId, resolved.appSecret, resolved.timeoutMs, signal);
  const token = await tokens.get();
  const title = str(message?.title);
  const content = str(message?.content);
  const text = title !== '' ? `${title}\n${content}` : content;
  const chunks = chunkText(text, resolved.markdown ? MARKDOWN_MAX_CODEPOINTS : TEXT_MAX_CODEPOINTS);
  const url = resolved.targetType === 'group'
    ? `${resolved.apiBase}/v2/groups/${encodeURIComponent(resolved.targetId)}/messages`
    : `${resolved.apiBase}/v2/users/${encodeURIComponent(resolved.targetId)}/messages`;
  const key = targetKeyOf(resolved.apiBase, resolved.targetType, resolved.targetId);
  const gate = gateFor(key, resolved.rateMs);
  const baseSeq = seqBaseFor(key);
  let providerMessageId = null;
  for (let index = 0; index < chunks.length; index += 1) {
    await gate();
    const seq = (baseSeq + index + 1) % 1000000;
    const body = resolved.markdown
      ? { markdown: { content: chunks[index] }, msg_type: 2, msg_seq: seq }
      : { content: chunks[index], msg_type: 0, msg_seq: seq };
    const result = await postQq(network, url, body, token, resolved.timeoutMs, signal);
    if (result.id !== null) providerMessageId = result.id;
  }
  // Advance only after every segment succeeded: a retry reuses the frozen seq.
  setSeqBase(key, (baseSeq + chunks.length) % 1000000);
  return { status: 'accepted', providerMessageId };
}

/** Control keyboard: one callback button per {label,token}; malformed fails closed. */
function keyboardFor(actions) {
  const rows = [];
  actions.forEach((action, index) => {
    const label = str(action?.label).trim();
    const token = str(action?.token);
    if (label === '' || token === '') {
      throw new ProviderError('ENCODE_ERROR', 'qq-bot 按钮缺少 label 或 token', token);
    }
    rows.push({
      buttons: [{
        id: `btn_${index}`,
        render_data: { label: clampButtonLabel(label), visited_label: clampButtonLabel(label), style: 0 },
        // type 1 = callback button (produces INTERACTION_CREATE); data is mandatory.
        action: { type: 1, permission: { type: 2 }, click_limit: 1, data: token },
      }],
    });
  });
  return rows.length > 0 ? { content: { rows } } : null;
}

async function sendControlReply({ account, replyContext, content, signal, network }) {
  const { appId, appSecret } = inboundSecrets(account, { appId: true, appSecret: true });
  const target = str(replyContext?.chatId ?? replyContext?.userId);
  if (target === '') throw new ProviderError('NOT_CONFIGURED', 'qq-bot 控制回复缺少 chatId');
  if (network === null || typeof network?.request !== 'function') {
    throw new ProviderError('UNSUPPORTED', 'qq-bot 控制回复缺少网络端口');
  }
  // Validate the keyboard before spending a token request: a malformed button
  // must fail closed with nothing sent (no partial control card) (R07).
  const actions = controlActions(content);
  const keyboard = actions.length > 0 ? keyboardFor(actions) : null;
  const chunks = chunkText(controlText(content), keyboard !== null ? MARKDOWN_MAX_CODEPOINTS : TEXT_MAX_CODEPOINTS);
  const tokens = tokenManagerFor(network, appId, appSecret, DEFAULT_TIMEOUT_MS, signal);
  const token = await tokens.get();
  const url = `${DEFAULT_API_BASE}/v2/users/${encodeURIComponent(target)}/messages`;
  const key = targetKeyOf(DEFAULT_API_BASE, 'user', target);
  const gate = gateFor(key, DEFAULT_RATE_MS);
  const baseSeq = seqBaseFor(key);
  const segments = [];
  let providerMessageId = null;
  for (let index = 0; index < chunks.length; index += 1) {
    await gate();
    const seq = (baseSeq + index + 1) % 1000000;
    const chunk = chunks[index] === '' ? '(empty)' : chunks[index];
    const body = keyboard !== null
      ? { markdown: { content: chunk }, msg_type: 2, msg_seq: seq, ...(index === 0 ? { keyboard } : {}) }
      : { content: chunk, msg_type: 0, msg_seq: seq };
    try {
      const result = await postQq(network, url, body, token, DEFAULT_TIMEOUT_MS, signal);
      if (result.id !== null) providerMessageId = result.id;
      segments.push({ index, status: 'accepted', providerMessageId: result.id, errorCode: null });
    } catch (error) {
      const status = error?.uncertain === true ? 'uncertain' : error?.code === 'CANCELLED' ? 'cancelled' : 'failed';
      segments.push({ index, status, providerMessageId: null, errorCode: typeof error?.code === 'string' ? error.code : 'API_ERROR' });
      // A later segment never invalidates an earlier accepted one; report partial.
      const delivery = segments.some((s) => s.status === 'accepted') ? 'partial' : 'none';
      const failed = error instanceof Error ? error : new ProviderError('API_ERROR', 'qq-bot 控制回复失败');
      failed.segments = segments;
      failed.delivery = delivery;
      throw failed;
    }
  }
  setSeqBase(key, (baseSeq + chunks.length) % 1000000);
  return { status: 'accepted', providerMessageId, delivery: 'complete', segments };
}

/** QQ messages cannot be edited: send an explicit receipt text once (best effort). */
async function updateControlMessage({ account, replyContext, messageId, content, signal, network }) {
  if (str(messageId) === '') return { status: 'accepted', providerMessageId: null };
  const { appId, appSecret } = inboundSecrets(account, { appId: true, appSecret: true });
  const target = str(replyContext?.chatId ?? replyContext?.userId);
  if (target === '') throw new ProviderError('NOT_CONFIGURED', 'qq-bot 控制回复缺少 chatId');
  if (network === null || typeof network?.request !== 'function') {
    throw new ProviderError('UNSUPPORTED', 'qq-bot 控制回复缺少网络端口');
  }
  const tokens = tokenManagerFor(network, appId, appSecret, DEFAULT_TIMEOUT_MS, signal);
  const token = await tokens.get();
  const chunks = chunkText(controlText(content) || '(empty)', TEXT_MAX_CODEPOINTS);
  const url = `${DEFAULT_API_BASE}/v2/users/${encodeURIComponent(target)}/messages`;
  const key = targetKeyOf(DEFAULT_API_BASE, 'user', target);
  const gate = gateFor(key, DEFAULT_RATE_MS);
  const baseSeq = seqBaseFor(key);
  for (let index = 0; index < chunks.length; index += 1) {
    await gate();
    const seq = (baseSeq + index + 1) % 1000000;
    await postQq(network, url, { content: chunks[index], msg_type: 0, msg_seq: seq }, token, DEFAULT_TIMEOUT_MS, signal);
  }
  setSeqBase(key, (baseSeq + chunks.length) % 1000000);
  return { status: 'accepted', providerMessageId: str(messageId) };
}

// ---------------------------------------------------------------------------
// Inbound WebSocket gateway
// ---------------------------------------------------------------------------

function stripMention(content) {
  const text = str(content);
  for (const pattern of MENTION_WHITELIST) {
    if (pattern.test(text)) return text.replace(pattern, '').trim();
  }
  return text.trim();
}

/** Official `attachments` segment: keep only well-formed items with a URL. */
function attachmentsOf(d) {
  const list = Array.isArray(d?.attachments) ? d.attachments : [];
  const out = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const url = str(item.url);
    if (url === '') continue;
    const mime = str(item.content_type) !== '' ? str(item.content_type) : 'application/octet-stream';
    out.push({
      id: str(item.id),
      url,
      name: str(item.filename ?? item.name),
      mime,
      kind: mime.startsWith('image/') ? 'image' : 'file',
      ...(Number.isInteger(item.size) ? { size: item.size } : {}),
    });
  }
  return out;
}

const placeholderOf = (attachments) => (attachments.some((a) => a.kind === 'image') ? '[图片消息]' : '[文件消息]');

function envelopeFor(account, epoch, t, d) {
  const attachments = attachmentsOf(d);
  if (t === 'C2C_MESSAGE_CREATE') {
    const userId = str(d?.author?.user_openid);
    const messageId = str(d?.id);
    if (userId === '' || messageId === '') return null;
    const raw = str(d?.content).trim();
    const text = raw !== '' ? raw : (attachments.length > 0 ? placeholderOf(attachments) : '');
    if (text === '') return null;
    return inboundEnvelope({
      account, epoch, eventId: `qq:${messageId}`, userId, chatId: userId, chatType: 'private',
      kind: 'message', messageId, text, attachments,
      replyContext: replyContextFor(account, { userId, chatId: userId, transportData: { chatId: userId } }),
    });
  }
  // GROUP_AT_MESSAGE_CREATE
  const userId = str(d?.author?.member_openid);
  const chatId = str(d?.group_openid);
  const messageId = str(d?.id);
  if (userId === '' || chatId === '' || messageId === '') return null;
  const raw = stripMention(d?.content);
  const text = raw !== '' ? raw : (attachments.length > 0 ? placeholderOf(attachments) : '');
  if (text === '') return null;
  return inboundEnvelope({
    account, epoch, eventId: `qq:${messageId}`, userId, chatId, chatType: 'group',
    kind: 'message', messageId, text, attachments,
    replyContext: replyContextFor(account, { userId, chatId, transportData: { chatId } }),
  });
}

async function start({
  account, epoch, emit, signal, network, clock, cursorStore, onFatal,
  reconnectBaseMs, reconnectCapMs, handshakeTimeoutMs, heartbeatMissThreshold, close4008WaitMs, timeoutMs,
}) {
  void clock;
  if (network === null || typeof network?.request !== 'function' || typeof network?.openWebSocket !== 'function') {
    throw new ProviderError('UNSUPPORTED', 'qq-bot 入站缺少网络端口（需要 request 与 openWebSocket）');
  }
  if (typeof emit !== 'function') throw new ProviderError('UNSUPPORTED', 'qq-bot 入站缺少 emit');
  const { appId, appSecret } = inboundSecrets(account, { appId: true, appSecret: true });
  const baseMs = Math.max(1, num(reconnectBaseMs, 1000));
  const capMs = Math.max(baseMs, num(reconnectCapMs, 30000));
  const hsMs = Math.max(10, num(handshakeTimeoutMs, 10000));
  const missLimit = Math.max(1, Math.min(10, toInt(heartbeatMissThreshold, 2)));
  const rate4008WaitMs = Math.max(0, num(close4008WaitMs, CLOSE_4008_WAIT_MS));
  const reqTimeoutMs = timeoutOf(timeoutMs, DEFAULT_TIMEOUT_MS);

  const stopController = new AbortController();
  const stopSignal = combineSignals(signal, stopController.signal);
  const loaded = cursorStore?.load?.();
  let sessionId = null; // in-process session id (never persisted: a fresh IDENTIFY after restart)
  let seq = loaded !== null && typeof loaded === 'object' && Number.isInteger(loaded.seq) ? loaded.seq : null;

  const tokens = tokenManagerFor(network, appId, appSecret, reqTimeoutMs, stopSignal);

  async function gatewayUrl() {
    let token;
    try {
      token = await tokens.get();
    } catch (error) {
      throw mapHttpError(error, 'qq-bot 鉴权');
    }
    let response;
    try {
      response = await getJson(network, `${DEFAULT_API_BASE}/gateway`, {
        headers: { authorization: `QQBot ${token}` }, timeoutMs: reqTimeoutMs, channel: 'QQ Bot', signal: stopSignal,
      });
    } catch (error) {
      throw mapHttpError(error, 'qq-bot 网关');
    }
    const url = str(response.json?.url);
    if (url === '') throw new ProviderError('BAD_UPSTREAM_RESPONSE', 'qq-bot 获取 WS 网关地址失败：响应缺少 url', response.text);
    return url;
  }

  /** Close-code semantics: 4004 re-auth, 4008 fixed wait, 4006/7/9 drop session. */
  function classifyClose(code) {
    if (code === 4004) {
      tokens.invalidate();
      sessionId = null;
      seq = null;
      return {};
    }
    if (code === 4008) return { delayMs: rate4008WaitMs };
    if (code === 4006 || code === 4007 || code === 4009) {
      sessionId = null;
      seq = null;
      return {};
    }
    return {};
  }

  /** One connection attempt; resolves when the socket closes, fails or stops. */
  function connectOnce() {
    return new Promise((resolve) => {
      let socket = null;
      let settled = false;
      let closed = false;
      let handshakeTimer = null;
      let hbTimer = null;
      let hbInterval = null;
      let hbArmed = false;
      let awaitingAck = false;
      let missedAcks = 0;
      let chain = Promise.resolve();

      const clearTimers = () => {
        if (hbTimer !== null) { clearInterval(hbTimer); hbTimer = null; }
        if (handshakeTimer !== null) { clearTimeout(handshakeTimer); handshakeTimer = null; }
      };
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimers();
        const current = socket;
        socket = null;
        if (current !== null) { try { void current.close(); } catch { /* already closed */ } }
        resolve(outcome);
      };
      const sendFrame = (frame) => {
        if (socket === null) return false;
        try { void socket.send(new TextEncoder().encode(JSON.stringify(frame))); return true; } catch { return false; }
      };
      const armHandshake = (phase) => {
        if (handshakeTimer !== null) clearTimeout(handshakeTimer);
        handshakeTimer = setTimeout(() => {
          handshakeTimer = null;
          if (settled || stopSignal.aborted) return;
          settle({ reason: 'closed', code: `handshake-${phase}` });
        }, hsMs);
      };
      const clearHandshake = () => { if (handshakeTimer !== null) { clearTimeout(handshakeTimer); handshakeTimer = null; } };

      const armHeartbeat = () => {
        if (hbArmed || hbInterval === null) return;
        hbArmed = true;
        awaitingAck = false;
        missedAcks = 0;
        const beat = () => {
          if (settled) return;
          if (awaitingAck) {
            missedAcks += 1;
            if (missedAcks >= missLimit) {
              settle({ reason: 'closed', code: 'heartbeat-timeout' });
              return;
            }
          }
          if (!sendFrame({ op: OP_HEARTBEAT, d: seq })) return;
          awaitingAck = true;
        };
        hbTimer = setInterval(beat, Math.max(20, hbInterval));
        beat();
      };

      // IDENTIFY for a fresh session, RESUME when an in-process session survives.
      const sendAuth = () => {
        tokens.get().then((token) => {
          if (settled || socket === null) return;
          if (sessionId !== null) {
            sendFrame({ op: OP_RESUME, d: { token: `QQBot ${token}`, session_id: sessionId, seq } });
            return;
          }
          sendFrame({
            op: OP_IDENTIFY,
            d: {
              token: `QQBot ${token}`,
              intents: INTENTS,
              shard: [0, 1],
              properties: { $os: 'dsh-notifier', $browser: 'dsh-notifier', $device: 'dsh-notifier' },
            },
          });
        }).catch((error) => { settle({ reason: 'error', error: mapHttpError(error, 'qq-bot 鉴权') }); });
      };

      const handleDispatch = async (t, d, s) => {
        if (t === 'C2C_MESSAGE_CREATE' || t === 'GROUP_AT_MESSAGE_CREATE') {
          const envelope = envelopeFor(account, epoch, t, d);
          if (envelope === null) { if (typeof s === 'number') seq = s; return; }
          let outcome;
          try {
            outcome = await emit(envelope);
          } catch (error) {
            settle({ reason: 'error', error });
            return;
          }
          if (outcome?.accepted === true || outcome?.code === 'DUPLICATE') {
            if (typeof s === 'number') {
              const committed = await cursorStore?.commit?.(account.id, { seq: s });
              if (committed?.advanced === false) { settle({ reason: 'stale' }); return; }
              seq = s;
            }
            return;
          }
          const code = typeof outcome?.code === 'string' ? outcome.code : 'UNAVAILABLE';
          if (code === 'STALE_EPOCH') { settle({ reason: 'stale' }); return; }
          settle({ reason: 'error', error: new ProviderError(code, `qq-bot 入站事件被拒绝: ${code}`) });
          return;
        }
        if (typeof s === 'number') seq = s;
      };

      const handleFrameText = (text) => {
        const frame = tryParseJsonLocal(text);
        if (frame === null || typeof frame !== 'object') return;
        if (typeof frame.s === 'number') seq = frame.s;
        switch (frame.op) {
          case OP_HELLO:
            hbInterval = num(frame.d?.heartbeat_interval, 30000);
            armHandshake('ready');
            sendAuth();
            return;
          case OP_HEARTBEAT_ACK:
            awaitingAck = false;
            missedAcks = 0;
            return;
          case OP_DISPATCH:
            if (frame.t === 'READY') {
              clearHandshake();
              sessionId = str(frame.d?.session_id) || null;
              armHeartbeat();
              return;
            }
            if (frame.t === 'RESUMED') {
              clearHandshake();
              armHeartbeat();
              return;
            }
            chain = chain.then(() => handleDispatch(frame.t, frame.d, frame.s)).catch((error) => settle({ reason: 'error', error }));
            return;
          case OP_RECONNECT:
            settle({ reason: 'closed', code: 'server-reconnect' });
            return;
          case OP_INVALID_SESSION: {
            const resumable = frame.d === true;
            if (!resumable) { sessionId = null; seq = null; }
            settle({ reason: 'closed', code: resumable ? 'invalid-session-resumable' : 'invalid-session' });
            return;
          }
          default:
        }
      };

      (async () => {
        let url;
        try {
          url = await gatewayUrl();
        } catch (error) {
          settle({ reason: 'error', error });
          return;
        }
        if (stopSignal.aborted) { settle({ reason: 'aborted' }); return; }
        let ws;
        try {
          ws = await network.openWebSocket({
            url,
            timeoutMs: hsMs,
            maxFrameBytes: MAX_FRAME_BYTES,
            signal: stopSignal,
            channel: 'QQ Bot',
            onFrame: (bytes) => {
              if (settled) return;
              chain = chain.then(() => handleFrameText(decodeText(bytes))).catch((error) => settle({ reason: 'error', error }));
            },
            onClose: (code) => {
              if (closed) return;
              closed = true;
              settle({ reason: 'closed', code: Number(code) });
            },
          });
        } catch (error) {
          settle({ reason: 'error', error });
          return;
        }
        if (settled) { try { void ws?.close?.(); } catch { /* noop */ } return; }
        socket = ws;
        if (stopSignal.aborted) { settle({ reason: 'aborted' }); return; }
        armHandshake('hello');
      })();
    });
  }

  async function runLoop() {
    let attempt = 0;
    while (!stopSignal.aborted) {
      const outcome = await connectOnce();
      if (stopSignal.aborted || outcome.reason === 'aborted') return;
      if (outcome.reason === 'stale') return;
      if (outcome.reason === 'error') {
        const code = outcome.error?.code;
        if (code === 'FORBIDDEN' || code === 'NOT_CONFIGURED' || code === 'UNSAFE_TARGET' || code === 'UNSUPPORTED') {
          throw outcome.error;
        }
      } else if (outcome.reason === 'closed') {
        const decision = classifyClose(outcome.code);
        attempt += 1;
        const delay = decision.delayMs !== undefined ? decision.delayMs : Math.min(baseMs * 2 ** (attempt - 1), capMs);
        await sleep(delay, stopSignal);
        continue;
      }
      attempt += 1;
      await sleep(Math.min(baseMs * 2 ** (attempt - 1), capMs), stopSignal);
    }
  }

  const loopPromise = runLoop().catch((error) => {
    if (stopSignal.aborted) return;
    if (typeof onFatal === 'function') {
      const code = typeof error?.code === 'string' ? error.code : 'UNAVAILABLE';
      onFatal({ code, message: String(error?.publicMessage ?? error?.message ?? error ?? 'unknown') });
    }
  });

  return {
    async stop() {
      stopController.abort();
      await loopPromise;
    },
  };
}

/** Local JSON parse (avoids pulling the whole text through the http helper surface). */
function tryParseJsonLocal(text) {
  const trimmed = str(text).trim();
  if (trimmed === '' || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

export default Object.freeze({
  id: ID,
  capabilities: capabilitiesOf(ID),
  resolve: resolveOutbound,
  validate: (config) => resolveOutbound(config ?? {}),
  send,
  sendControlReply,
  updateControlMessage,
  start,
});
