// WeChat iLink provider (T18; 04-PROVIDERS.md, 20-HOST-PROTOCOL-MAP.md).
//
// Inbound-only control channel: the iLink bot is a 1:1 private contact, so inbound
// is a getupdates long poll with a persisted cursor (a restart resumes exactly after
// the last reliably received batch), and control is sendmessage with the latest
// context_token echoed back. Outbound notifications are unsupported (outbound=false),
// so no `send` is exported and `resolve`/`validate` answer a typed UNSUPPORTED.
//
// The protocol facts (endpoints, headers, error semantics, cursor/context limits)
// are ported from the frozen v0 `_ilink-api.mjs`/`wechat-ilink` adapter: version
// facts, error classification and the context_token/stale-session retry are
// preserved verbatim; only the surrounding shape is rewritten to the v1 contract.
// Every request goes through the injected NetworkPort; every failure is typed.
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { ProviderError, str, num, postJson, getJson } from '../http.mjs';
import { capabilitiesOf } from '../specs.mjs';
import {
  inboundSecrets, inboundPublic, replyContextFor, inboundEnvelope, controlText, chunkText,
  sleep, combineSignals,
} from '../platform.mjs';
import { resolveSecret } from '../../security/secrets.mjs';

const ID = 'wechat-ilink';

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '2.2.0';
const ILINK_APP_ID = 'bot';
// 0x020200: protocol client version is locked so a drifting default cannot slip in.
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0);

const EP_GET_UPDATES = 'ilink/bot/getupdates';
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage';
const EP_GET_BOT_QRCODE = 'ilink/bot/get_bot_qrcode';
const EP_GET_QRCODE_STATUS = 'ilink/bot/get_qrcode_status';

const LONG_POLL_MS = 35000;
const API_TIMEOUT_MS = 15000;
const RECONNECT_MS = 2000;
const BACKOFF_MS = 30000;
const LOGIN_POLL_MS = 2000;
const LOGIN_TIMEOUT_MS = 300000;
const LOGIN_MAX_RESTARTS = 3;
const TEXT_LIMIT = 2000;

const SESSION_EXPIRED_ERRCODE = -14;
const RATE_LIMIT_ERRCODE = -2;

const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;

const MAX_CURSOR_LENGTH = 4096;
const MAX_CONTEXT_TOKEN_LENGTH = 512;

// v0 shape contract: a context_token is a short single-line visible string; a
// long/whitespace/control-character value is an anomalous payload and is dropped.
const CONTROL_RE = /[\u0000-\u001f\u007f\s]/;
// The declared inbound secret path for this channel. The frozen descriptor ships no
// wechat-ilink editor field yet, so `inboundSecrets` (descriptor-gated) cannot resolve
// it; the same path is typed-decoded directly as a forward-compatible fallback, and a
// non-string/empty value is still a typed NOT_CONFIGURED (never String()-coerced).
const TOKEN_FIELD = Object.freeze({ type: 'string' });

/** content → 6-hex digest (synthetic eventId when the provider sends no message id). */
function hash6(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 6);
}

/** X-WECHAT-UIN: base64(String(random_uint32)), regenerated per request (anti-replay). */
function randomWechatUin() {
  return Buffer.from(String(randomInt(0, 2 ** 32)), 'utf8').toString('base64');
}

function ilinkHeaders(token) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
  };
  if (token !== '') headers.Authorization = `Bearer ${token}`;
  return headers;
}

function ilinkGetHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
  };
}

/** Resolve the declared inbound bot `token`, typed-decoded and never empty. */
function inboundToken(account) {
  let token = '';
  try {
    token = inboundSecrets(account, { token: true }).token;
  } catch (error) {
    if (error?.code !== 'NOT_CONFIGURED') throw error;
    const secret = account?.secrets?.['inbound.token'];
    const resolved = secret ? resolveSecret(secret, process.env, TOKEN_FIELD) : null;
    token = resolved?.ok === true ? resolved.value : '';
  }
  if (typeof token !== 'string' || token === '') {
    throw new ProviderError('NOT_CONFIGURED', 'wechat-ilink 入站未配置：token 未填写');
  }
  return token;
}

/** The connection facts a start/control-reply call needs, resolved from the account. */
function resolveInbound(account) {
  const token = inboundToken(account);
  const config = inboundPublic(account, ['accountId', 'baseUrl']);
  const baseUrl = (str(config.baseUrl) || ILINK_BASE_URL).replace(/\/+$/, '');
  return { token, accountId: str(config.accountId).trim(), baseUrl };
}

/**
 * Classify an iLink response. Error semantics are ported verbatim:
 *   ret/errcode = -14                       → session expired (re-scan)
 *   -2 with errmsg exactly "unknown error"  → disguised stale context_token
 *   -2 otherwise                            → real rate limit (backoff)
 */
function classifyResponse(response) {
  const ret = typeof response?.ret === 'number' ? response.ret : 0;
  const errcode = typeof response?.errcode === 'number' ? response.errcode : 0;
  if (ret === 0 && errcode === 0) return { ok: true };
  const errmsg = str(response?.errmsg ?? response?.msg);
  const expired = ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE;
  const limited = ret === RATE_LIMIT_ERRCODE || errcode === RATE_LIMIT_ERRCODE;
  if (expired) return { ok: false, kind: 'session-expired', ret, errcode, errmsg };
  if (limited && errmsg.toLowerCase() === 'unknown error') {
    return { ok: false, kind: 'session-expired', ret, errcode, errmsg };
  }
  if (limited) return { ok: false, kind: 'rate-limited', ret, errcode, errmsg };
  return { ok: false, kind: 'error', ret, errcode, errmsg };
}

/** Extract text from item_list (type=1); a quoted message is prefixed. */
function extractText(itemList) {
  if (!Array.isArray(itemList)) return '';
  for (const item of itemList) {
    if (item?.type !== ITEM_TEXT) continue;
    const text = str(item?.text_item?.text);
    const ref = item?.ref_msg;
    if (ref !== null && typeof ref === 'object' && Object.keys(ref).length > 0) {
      const parts = [str(ref.title), extractText([ref.message_item].filter(Boolean))];
      const joined = parts.filter((part) => part !== '').join(' | ');
      return `[引用: ${joined}]\n${text}`.trim();
    }
    return text;
  }
  return '';
}

/**
 * Extract image descriptors from item_list (type=2). iLink media has no device
 * evidence for a download URL, so only an explicit media id / URL becomes an
 * attachment; anything else is dropped rather than guessed.
 */
function extractImages(itemList) {
  if (!Array.isArray(itemList)) return [];
  const out = [];
  for (const item of itemList) {
    if (item?.type !== ITEM_IMAGE) continue;
    const image = item.image_item;
    if (image === null || typeof image !== 'object') continue;
    const mediaId = str(image.media_id ?? image.mediaId).trim();
    const url = str(image.image_url ?? image.url ?? image.cdn_url).trim();
    if (mediaId === '' && url === '') continue;
    const attachment = { id: mediaId !== '' ? mediaId : url, name: '', mime: str(image.mime) || 'image/jpeg' };
    if (url !== '') attachment.url = url;
    const size = num(image.file_size ?? image.size, null);
    if (Number.isInteger(size) && size >= 0) attachment.size = size;
    out.push(attachment);
  }
  return out;
}

/** A cursor must be short, single-line and bounded; anything else keeps the old value. */
function boundedCursor(value) {
  const cursor = str(value);
  if (cursor === '') return '';
  return cursor.length <= MAX_CURSOR_LENGTH && !CONTROL_RE.test(cursor) ? cursor : '';
}

/** A context_token is transport state; a long/whitespace value is never cached. */
function boundedToken(value) {
  const token = str(value).trim();
  return token !== '' && token.length <= MAX_CONTEXT_TOKEN_LENGTH && !CONTROL_RE.test(token) ? token : '';
}

/** One inbound msgs[] entry → envelope, or null when it must not enter the Host. */
function toEnvelope({ account, epoch, config, msg }) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const userId = str(msg.from_user_id).trim();
  // The bot's own echo (from === the scanned account) and empty senders are not inbound.
  if (userId === '' || (config.accountId !== '' && userId === config.accountId)) return null;
  const text = extractText(msg.item_list);
  const attachments = extractImages(msg.item_list);
  if (text.trim() === '' && attachments.length === 0) return null;
  const messageId = str(msg.message_id).trim() || str(msg.client_id).trim();
  const eventId = messageId !== '' ? `ilink:${messageId}` : `ilink:${userId}:${hash6(text)}`;
  // iLink is a 1:1 bot; an explicit group/room marker is kept so the conversation
  // layer can refuse it instead of mistaking a group event for private control.
  const chatType = str(msg.chat_type) === 'group' || msg.group_id !== undefined || msg.room_id !== undefined
    ? 'group'
    : 'private';
  const contextToken = boundedToken(msg.context_token);
  const transportData = contextToken !== '' ? { chatId: userId, contextToken } : { chatId: userId };
  return inboundEnvelope({
    account, epoch, eventId, userId, chatId: userId, chatType, kind: 'message',
    messageId: messageId !== '' ? messageId : null,
    text: text.trim() !== '' ? text : '[图片消息]',
    attachments,
    replyContext: replyContextFor(account, { userId, chatId: userId, transportData }),
  });
}

/** One POST to the iLink bot API, with the locked channel_version base_info. */
async function ilinkPost(network, config, endpoint, payload, { timeoutMs = API_TIMEOUT_MS, signal } = {}) {
  return postJson(network, `${config.baseUrl}/${endpoint}`, {
    ...payload,
    base_info: { channel_version: CHANNEL_VERSION },
  }, {
    headers: ilinkHeaders(config.token),
    timeoutMs,
    channel: 'WeChat iLink',
    signal,
  });
}

/** One GET with the App headers only (the QR flow runs before a token exists). */
async function ilinkGet(network, url, { timeoutMs = API_TIMEOUT_MS, signal } = {}) {
  return getJson(network, url, { headers: ilinkGetHeaders(), timeoutMs, channel: 'WeChat iLink', signal });
}

/** Recoverable-failure pacing: fast retry below 3, 30s backoff at 3 then reset. */
async function backoff(failures, signal, reconnectMs, backoffMs) {
  const next = failures + 1;
  await sleep(next >= 3 ? backoffMs : reconnectMs, signal);
  return next >= 3 ? 0 : next;
}

async function runLoop({ account, epoch, emit, signal, network, cursorStore, config, reconnectMs, backoffMs }, inner) {
  const stopSignal = combineSignals(signal, inner);
  let cursor = boundedCursor(cursorStore?.load?.()?.buf);
  let failures = 0;
  while (!stopSignal.aborted) {
    let response;
    try {
      response = await ilinkPost(network, config, EP_GET_UPDATES, { get_updates_buf: cursor }, {
        timeoutMs: LONG_POLL_MS + 5000, signal: stopSignal,
      });
    } catch (error) {
      if (stopSignal.aborted) return;
      // Timeout/HTTP/network failures are recoverable: pace, then re-poll.
      failures = await backoff(failures, stopSignal, reconnectMs, backoffMs);
      continue;
    }
    const payload = response.json;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      failures = await backoff(failures, stopSignal, reconnectMs, backoffMs);
      continue;
    }
    const verdict = classifyResponse(payload);
    if (verdict.kind === 'session-expired') {
      // A stale session cannot be recovered by retrying: surface it as fatal so the
      // manager degrades instead of silently polling a dead token forever.
      throw new ProviderError('API_ERROR',
        `WeChat iLink 会话过期（ret=${verdict.ret} errcode=${verdict.errcode}）：请重新扫码登录`);
    }
    if (!verdict.ok) {
      failures = await backoff(failures, stopSignal, reconnectMs, backoffMs);
      continue;
    }
    failures = 0;
    const messages = Array.isArray(payload.msgs) ? payload.msgs : [];
    const rawCursor = payload.get_updates_buf;
    const nextCursor = rawCursor === undefined ? cursor : boundedCursor(rawCursor);
    // A malformed cursor is refused: the old usable cursor is kept (never replaced).
    const cursorRejected = rawCursor !== undefined && str(rawCursor) !== nextCursor;
    let stopCause = null;
    for (const msg of messages) {
      const envelope = toEnvelope({ account, epoch, config, msg });
      // Not a persistable envelope (own echo / unparseable): skipped so it can never
      // be re-fetched forever; it was never a message the Host could act on.
      if (envelope === null) continue;
      const outcome = await emit(envelope);
      if (outcome?.accepted === true || outcome?.code === 'DUPLICATE') continue;
      stopCause = typeof outcome?.code === 'string' ? outcome.code : 'INTERNAL';
      break;
    }
    // STALE_EPOCH means this connection was superseded: end quietly.
    if (stopCause === 'STALE_EPOCH') return;
    if (stopCause !== null) throw new ProviderError(stopCause, `WeChat iLink 入站批次中止: ${stopCause}`);
    if (!cursorRejected && nextCursor !== cursor) {
      // Commit only after the whole batch was reliably received or deduplicated.
      const advanced = await cursorStore.commit(account.id, { buf: nextCursor });
      // A failed commit (e.g. an un-drained inbox) must not let the next getupdates
      // use the new cursor: stop rather than risk skipping a record.
      if (!advanced?.advanced) throw new ProviderError('API_ERROR', 'WeChat iLink 游标提交失败，停止以避免越水位');
      cursor = nextCursor;
    } else if (messages.length === 0) {
      // Empty poll with no cursor change: yield briefly so stop() stays responsive.
      await sleep(25, stopSignal);
    }
  }
}

async function start({ account, epoch, emit, signal, network, cursorStore, reconnectMs, backoffMs, onFatal }) {
  // Synchronous admission: fail fast when the transport or credentials are invalid.
  if (network === null || typeof network?.request !== 'function') {
    throw new ProviderError('UNSUPPORTED', 'wechat-ilink 入站缺少网络端口');
  }
  if (typeof emit !== 'function') {
    throw new ProviderError('UNSUPPORTED', 'wechat-ilink 入站缺少 emit');
  }
  const config = resolveInbound(account);
  const controller = new AbortController();
  const promise = runLoop({
    account, epoch, emit, signal, network, cursorStore, config,
    reconnectMs: Number.isFinite(reconnectMs) ? reconnectMs : RECONNECT_MS,
    backoffMs: Number.isFinite(backoffMs) ? backoffMs : BACKOFF_MS,
  }, controller.signal).catch((error) => {
    if (!controller.signal.aborted && typeof onFatal === 'function') {
      const code = typeof error?.code === 'string' ? error.code : 'INTERNAL';
      onFatal({ code, message: String(error?.message ?? error ?? 'unknown') });
    }
  });
  return {
    async stop() {
      controller.abort();
      await promise;
    },
  };
}

/** One sendmessage call: session-expired strips the context_token once and retries. */
async function sendChunk(network, config, to, text, { contextToken = '', signal } = {}) {
  let token = contextToken;
  let retriedTokenless = false;
  for (;;) {
    const msg = {
      from_user_id: '',
      to_user_id: to,
      client_id: `dsh-notifier-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_TEXT, text_item: { text } }],
    };
    if (token !== '') msg.context_token = token;
    const response = await ilinkPost(network, config, EP_SEND_MESSAGE, { msg }, { signal });
    const payload = response.json;
    const verdict = classifyResponse(payload === null || typeof payload !== 'object' ? {} : payload);
    if (verdict.ok) return;
    if (verdict.kind === 'session-expired' && !retriedTokenless && token !== '') {
      // A stale context_token masquerades as a limit/expiry: drop it and retry once.
      retriedTokenless = true;
      token = '';
      continue;
    }
    if (verdict.kind === 'session-expired') {
      throw new ProviderError('API_ERROR',
        `WeChat iLink 会话过期（ret=${verdict.ret} errcode=${verdict.errcode}）：请重新扫码登录`);
    }
    throw new ProviderError('API_ERROR',
      `WeChat iLink sendmessage 失败（ret=${verdict.ret} errcode=${verdict.errcode} errmsg=${verdict.errmsg}）`);
  }
}

async function sendControlReply({ account, replyContext, content, signal, network }) {
  if (network === null || typeof network?.request !== 'function') {
    throw new ProviderError('UNSUPPORTED', 'wechat-ilink 控制回复缺少网络端口');
  }
  const config = resolveInbound(account);
  const to = str(replyContext?.chatId ?? replyContext?.userId);
  if (to === '') throw new ProviderError('NOT_CONFIGURED', 'WeChat iLink 控制回复缺少 chatId');
  const contextToken = boundedToken(replyContext?.transportData?.contextToken);
  const chunks = chunkText(controlText(content), TEXT_LIMIT);
  const segments = [];
  for (let index = 0; index < chunks.length; index++) {
    try {
      await sendChunk(network, config, to, chunks[index] === '' ? '(empty)' : chunks[index], { contextToken, signal });
      segments.push({ index, status: 'accepted', providerMessageId: null, errorCode: null });
    } catch (error) {
      const status = error?.uncertain === true ? 'uncertain' : error?.code === 'CANCELLED' ? 'cancelled' : 'failed';
      segments.push({ index, status, providerMessageId: null, errorCode: typeof error?.code === 'string' ? error.code : 'INTERNAL' });
      // A later segment failure never invalidates an earlier accepted one; report the
      // partial evidence rather than throwing the whole reply away (R13).
      const failed = error instanceof Error ? error : new ProviderError('API_ERROR', 'WeChat iLink 控制回复失败');
      failed.segments = segments;
      failed.delivery = segments.some((segment) => segment.status === 'accepted') ? 'partial' : 'none';
      throw failed;
    }
  }
  // A JSON 200 proves the platform accepted the message, never delivery.
  return { status: 'accepted', providerMessageId: null, delivery: 'complete', segments };
}

/**
 * Login driver (scan flow). `begin` fetches the QR once, pushes it through
 * onQrCode, then steps the status machine until confirmed/expired/cancelled and
 * resolves `done` with the credentials the login manager commits.
 */
function loginDriver(options = {}) {
  const defaultNetwork = options.network ?? null;
  const sleepFn = options.sleep ?? sleep;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : LOGIN_POLL_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : LOGIN_TIMEOUT_MS;

  async function begin({ account, signal, onQrCode, now = Date.now, network = defaultNetwork } = {}) {
    if (network === null || typeof network?.request !== 'function') {
      throw new ProviderError('UNSUPPORTED', 'WeChat iLink 扫码登录缺少网络端口');
    }
    const deadline = now() + timeoutMs;
    let baseUrl = ILINK_BASE_URL;
    let qrCode = '';
    let qrText = '';
    let restarts = 0;

    async function fetchQr() {
      const response = await ilinkGet(network, `${baseUrl}/${EP_GET_BOT_QRCODE}?bot_type=3`, { signal });
      const code = str(response.json?.qrcode);
      if (code === '') throw new ProviderError('BAD_UPSTREAM_RESPONSE', '微信服务端未返回二维码（qrcode 缺失），请稍后重试');
      qrCode = code;
      qrText = str(response.json?.qrcode_img_content) || code;
      onQrCode?.({ text: qrText, expiresAt: deadline });
    }

    await fetchQr();

    const done = (async () => {
      for (;;) {
        if (signal?.aborted) throw new ProviderError('CANCELLED', '微信扫码登录已取消');
        if (now() > deadline) throw new ProviderError('TIMEOUT', '微信扫码超时，请重新发起');
        let payload;
        try {
          const response = await ilinkGet(network,
            `${baseUrl}/${EP_GET_QRCODE_STATUS}?qrcode=${encodeURIComponent(qrCode)}`, { signal });
          payload = response.json;
        } catch (error) {
          if (signal?.aborted) throw new ProviderError('CANCELLED', '微信扫码登录已取消');
          // Transient poll failure (network/HTTP 5xx): retry next round, bounded by the deadline.
          await sleepFn(pollMs, signal);
          continue;
        }
        const status = str(payload?.status) || 'wait';
        if (status === 'wait' || status === 'scaned') {
          await sleepFn(pollMs, signal);
          continue;
        }
        if (status === 'scaned_but_redirect') {
          const host = (str(payload?.redirect_host) || str(payload?.ilink_bot_host)).trim();
          if (host !== '') baseUrl = `https://${host}`;
          await sleepFn(pollMs, signal);
          continue;
        }
        if (status === 'expired' || status === 'timeout') {
          restarts += 1;
          if (restarts > LOGIN_MAX_RESTARTS) {
            throw new ProviderError('TIMEOUT', `微信二维码已连续过期 ${LOGIN_MAX_RESTARTS} 次，请重新发起扫码`);
          }
          await fetchQr();
          continue;
        }
        if (status === 'confirmed' || status === 'success') {
          const accountId = str(payload?.ilink_bot_id ?? payload?.account_id).trim();
          const token = str(payload?.bot_token);
          const resolvedBase = (str(payload?.baseurl) || baseUrl).replace(/\/+$/, '');
          const userId = str(payload?.ilink_user_id).trim();
          if (accountId === '' || token === '') {
            throw new ProviderError('BAD_UPSTREAM_RESPONSE', '扫码成功但凭证不完整（ilink_bot_id/bot_token 缺失），请重新发起');
          }
          return {
            secretChanges: [{ path: 'inbound.token', op: 'set', value: { kind: 'literal', value: JSON.stringify(token) } }],
            config: { inbound: { accountId, baseUrl: resolvedBase, userId } },
          };
        }
        // Unknown state fails closed instead of spinning forever.
        throw new ProviderError('BAD_UPSTREAM_RESPONSE', `微信扫码返回未知状态：${status || '(空)'}`);
      }
    })();

    void account;
    return { done, qrText, expiresAt: deadline };
  }

  return { capabilities: Object.freeze({ login: true }), begin };
}

/** Outbound is not a capability of this channel: answer a typed UNSUPPORTED. */
function resolve() {
  throw new ProviderError('UNSUPPORTED', 'WeChat iLink 是入站/控制渠道，没有出站 send');
}

export default Object.freeze({
  id: ID,
  capabilities: capabilitiesOf(ID),
  resolve,
  validate: (config) => { void config; resolve(); },
  sendControlReply,
  start,
  loginDriver,
});
