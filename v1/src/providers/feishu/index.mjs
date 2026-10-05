// Feishu / Lark provider (T17; 04-PROVIDERS.md, 20-HOST-PROTOCOL-MAP.md).
//
// Outbound is the custom-bot webhook (interactive card, optional HMAC "加签").
// Inbound is the official Lark SDK WebSocket long connection: the SDK is loaded
// lazily (optional dependency) and only ever receives schema-checked ids — never
// a user URL — while every chat-derived media URL would still have to go through
// the self-hosted NetworkPort. Non-text messages are acknowledged and dropped
// (the frozen reference does the same; they are never injected into the Host).
//
// SDK isolation: the SDK gets a per-client bounded HttpInstance (finite timeout,
// no shared-instance mutation), a no-op logger (a null logger crashes SDK
// 1.46+), and a bounded start/handshake deadline. A missing SDK is a typed
// UNSUPPORTED so the connection degrades honestly instead of faking `ready`.
import { createHmac } from 'node:crypto';
import { ProviderError, postJson, str, timeoutOf } from '../http.mjs';
import { capabilitiesOf } from '../specs.mjs';
import {
  inboundSecrets, inboundEnvelope, replyContextFor, controlText, controlActions,
} from '../platform.mjs';

const ID = 'feishu';
const DEFAULT_DOMAIN = 'https://open.feishu.cn';
const SDK_PACKAGE = '@larksuiteoapi/node-sdk';
const FEISHU_HTTP_TIMEOUT_MS = 10000;
const HANDSHAKE_TIMEOUT_MS = 10000;
const TEXT_LIMIT = 4000;
const UNSUPPORTED_MESSAGE = '暂不支持该消息类型，请发送文字。';

/** Feishu 加签（official algorithm）: key = `${timestamp}\n${secret}`, empty data. */
export function feishuSign(secret, timestamp) {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

export function feishuTimestamp(now = Date.now()) {
  return String(Math.floor(now / 1000));
}

function receiveIdTypeOf(id) {
  if (id.startsWith('oc_')) return 'chat_id';
  if (id.startsWith('on_')) return 'union_id';
  return 'open_id';
}

function withDeadline(promise, ms, label) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new ProviderError('TIMEOUT', `${label} 超时（${ms}ms）`)), ms); }),
  ]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

function boundedOptions(options, maxMs) {
  const source = options !== null && typeof options === 'object' ? options : {};
  const requested = Number(source.timeout);
  const timeout = Number.isFinite(requested) && requested > 0 ? Math.min(Math.trunc(requested), maxMs) : maxMs;
  return { ...source, timeout };
}

/** A per-client HttpInstance wrapper that clamps every method's timeout (never mutates the shared one). */
function createTimedHttpInstance(base, timeoutMs = FEISHU_HTTP_TIMEOUT_MS) {
  if (base === null || typeof base !== 'object' || typeof base.request !== 'function') {
    throw new ProviderError('UNSUPPORTED', `${SDK_PACKAGE} defaultHttpInstance 不可用`);
  }
  const opts = (value) => boundedOptions(value, timeoutMs);
  return {
    request: (options) => base.request(opts(options)),
    get: (url, options) => base.get(url, opts(options)),
    delete: (url, options) => base.delete(url, opts(options)),
    head: (url, options) => base.head(url, opts(options)),
    options: (url, options) => base.options(url, opts(options)),
    post: (url, data, options) => base.post(url, data, opts(options)),
    put: (url, data, options) => base.put(url, data, opts(options)),
    patch: (url, data, options) => base.patch(url, data, opts(options)),
  };
}

/** A no-op SDK logger: passing `null` makes SDK 1.46+ throw on `logger.info`. */
function sdkLogger(warn) {
  return {
    info() {}, warn() {}, debug() {}, trace() {},
    error: (...args) => warn(`飞书 SDK: ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`),
  };
}

/** Restore `@_user_N` mentions from the structured map, else strip them. */
function extractText(content, mentions = []) {
  try {
    const parsed = JSON.parse(content ?? '');
    const text = typeof parsed?.text === 'string' ? parsed.text : '';
    if (text === '') return '';
    const byKey = new Map();
    for (const mention of Array.isArray(mentions) ? mentions : []) {
      const key = str(mention?.key);
      const name = str(mention?.name).trim();
      if (key !== '' && name !== '') byKey.set(key, `@${name}`);
    }
    if (byKey.size === 0) return text.replace(/@_user_\d+/g, '').trim();
    return text.replace(/@_user_\d+/g, (placeholder) => byKey.get(placeholder) ?? '').trim();
  } catch {
    return '';
  }
}

export function resolveOutbound(cfg = {}) {
  const webhook = str(cfg.webhook);
  if (webhook === '') {
    throw new ProviderError('NOT_CONFIGURED', 'feishu 未配置：webhook（飞书机器人完整地址）未填写');
  }
  return {
    webhook,
    secret: str(cfg.secret),
    atOpenId: str(cfg.atOpenId),
    timeoutMs: timeoutOf(cfg.timeoutMs, FEISHU_HTTP_TIMEOUT_MS),
  };
}

function parseSendResult(response) {
  const payload = response.json;
  if (payload === null || typeof payload !== 'object') {
    throw new ProviderError('BAD_UPSTREAM_RESPONSE', 'feishu 返回了非 JSON 响应', response.text);
  }
  if (typeof payload.code !== 'number') {
    throw new ProviderError('BAD_UPSTREAM_RESPONSE', 'feishu 返回格式异常：缺少 code', response.text);
  }
  if (payload.code !== 0) {
    throw new ProviderError('API_ERROR', `feishu 返回错误 ${payload.code}: ${str(payload.msg) || '未知错误'}`);
  }
  return { status: 'accepted', providerMessageId: null };
}

async function send({ config, message, signal, network }) {
  const resolved = resolveOutbound(config ?? {});
  const at = resolved.atOpenId !== '' && message.level === 'timeSensitive'
    ? `<at user_id="${resolved.atOpenId}"></at>\n`
    : '';
  const body = {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: str(message.title) } },
      elements: [{ tag: 'markdown', content: `${at}${str(message.content)}` }],
    },
  };
  if (resolved.secret !== '') {
    const timestamp = feishuTimestamp();
    body.timestamp = timestamp;
    body.sign = feishuSign(resolved.secret, timestamp);
  }
  const response = await postJson(network, resolved.webhook, body, {
    timeoutMs: resolved.timeoutMs, channel: 'Feishu', signal,
  });
  return parseSendResult(response);
}

/** Control card: body text plus one button per `{label,token}` action. */
function controlCard(content, title = '通知与控制') {
  const actions = controlActions(content);
  const elements = [{ tag: 'div', text: { tag: 'lark_md', content: str(content?.text) } }];
  if (actions.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'action',
      actions: actions.map((action) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: str(action.label).slice(0, 64) },
        type: 'primary',
        value: { token: str(action.token) },
      })),
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: str(title) } },
    elements,
  };
}

function larkError(response, label) {
  if (response !== null && typeof response === 'object' && response.code !== undefined && Number(response.code) !== 0) {
    throw new ProviderError('API_ERROR', `${label}失败 ${response.code}: ${str(response.msg) || '未知错误'}`);
  }
}

/**
 * @param {object} [options]
 * @param {() => Promise<object>} [options.sdkLoader] SDK loader (dependency-injection point)
 */
export function createFeishuProvider({ sdkLoader = () => import(SDK_PACKAGE) } = {}) {
  const clients = new Map();

  function warn(message) {
    try { console.error(`[dsh-notifier/feishu] ${message}`); } catch { /* logging is never fatal */ }
  }

  async function loadSdk() {
    try {
      return await sdkLoader();
    } catch (error) {
      throw new ProviderError('UNSUPPORTED', `飞书入站需要 ${SDK_PACKAGE}（未安装）`, String(error?.message ?? error));
    }
  }

  function assertSdk(sdk) {
    if (sdk?.Client === undefined || sdk?.WSClient === undefined || sdk?.EventDispatcher === undefined) {
      throw new ProviderError('UNSUPPORTED', `${SDK_PACKAGE} 接口不完整（缺 Client/WSClient/EventDispatcher）`);
    }
  }

  /** Lazily build one bounded SDK client per appId (shared by control replies and patches). */
  async function clientFor(appId, appSecret) {
    if (clients.has(appId)) return clients.get(appId);
    const sdk = await loadSdk();
    assertSdk(sdk);
    const client = new sdk.Client({
      appId,
      appSecret,
      domain: DEFAULT_DOMAIN,
      httpInstance: createTimedHttpInstance(sdk.defaultHttpInstance, FEISHU_HTTP_TIMEOUT_MS),
    });
    clients.set(appId, client);
    return client;
  }

  async function sendControlReply({ account, replyContext, content }) {
    const { appId, appSecret } = inboundSecrets(account, { appId: true, appSecret: true });
    const target = str(replyContext?.chatId ?? replyContext?.userId);
    if (target === '') throw new ProviderError('NOT_CONFIGURED', '飞书控制回复缺少 chatId');
    const client = await clientFor(appId, appSecret);
    const actions = controlActions(content);
    const payload = actions.length > 0
      ? controlCard(content)
      : { text: controlText(content).slice(0, TEXT_LIMIT) || '(empty)' };
    const response = await client.im.v1.message.create({
      params: { receive_id_type: receiveIdTypeOf(target) },
      data: { receive_id: target, msg_type: actions.length > 0 ? 'interactive' : 'text', content: JSON.stringify(payload) },
    });
    larkError(response, '飞书发送');
    const messageId = str(response?.data?.message_id);
    return { status: 'accepted', providerMessageId: messageId === '' ? null : messageId };
  }

  async function updateControlMessage({ account, replyContext, messageId, content }) {
    if (str(messageId) === '') return { status: 'accepted', providerMessageId: null };
    const { appId, appSecret } = inboundSecrets(account, { appId: true, appSecret: true });
    const client = await clientFor(appId, appSecret);
    const payload = controlActions(content).length > 0
      ? controlCard(content)
      : { text: controlText(content).slice(0, TEXT_LIMIT) };
    const response = await client.im.v1.message.patch({
      path: { message_id: str(messageId) },
      data: { content: JSON.stringify(payload) },
    });
    larkError(response, '飞书卡片更新');
    return { status: 'accepted', providerMessageId: str(messageId) };
  }

  async function start({ account, epoch, emit, signal }) {
    if (typeof emit !== 'function') throw new ProviderError('INTERNAL', '飞书入站缺少 emit');
    const { appId, appSecret } = inboundSecrets(account, { appId: true, appSecret: true });
    const sdk = await loadSdk();
    assertSdk(sdk);

    const client = new sdk.Client({
      appId,
      appSecret,
      domain: DEFAULT_DOMAIN,
      httpInstance: createTimedHttpInstance(sdk.defaultHttpInstance, FEISHU_HTTP_TIMEOUT_MS),
    });
    clients.set(appId, client);

    const dispatch = (envelope) => {
      try {
        const result = emit(envelope);
        if (result !== null && typeof result?.catch === 'function') result.catch((error) => warn(`入站投递失败: ${error?.code ?? error?.message ?? 'error'}`));
      } catch (error) {
        warn(`入站投递异常: ${error?.message ?? error}`);
      }
    };

    function onMessage(data) {
      try {
        const message = data?.message ?? {};
        const openId = str(data?.sender?.sender_id?.open_id);
        const messageId = str(message.message_id);
        if (messageId === '' || openId === '') return;
        const chatId = str(message.chat_id) || openId;
        if (str(message.message_type) !== 'text') {
          // Non-text is acknowledged then dropped (never injected into the Host).
          Promise.resolve(client.im.v1.message.create({
            params: { receive_id_type: receiveIdTypeOf(chatId) },
            data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: UNSUPPORTED_MESSAGE }) },
          })).catch(() => {});
          return;
        }
        const text = extractText(message.content, message.mentions);
        if (text === '') return;
        const chatType = str(message.chat_type) === 'group' ? 'group' : 'private';
        dispatch(inboundEnvelope({
          account, epoch,
          eventId: `feishu:${messageId}`,
          userId: openId, chatId, chatType, kind: 'message', messageId, text,
          replyContext: replyContextFor(account, { userId: openId, chatId, transportData: { chatId } }),
        }));
      } catch (error) {
        warn(`事件处理异常: ${error?.message ?? error}`);
      }
    }

    function onCardAction(data) {
      try {
        const value = data?.action?.value ?? {};
        const token = str(value.token) || str(value.act);
        const operator = str(data?.operator?.open_id ?? data?.sender?.sender_id?.open_id);
        const chatId = str(data?.context?.open_chat_id ?? data?.open_chat_id ?? data?.chat_id);
        const messageId = str(data?.context?.open_message_id ?? data?.message_id ?? data?.open_message_id);
        if (token === '' || operator === '' || chatId === '') return;
        dispatch(inboundEnvelope({
          account, epoch,
          eventId: `feishu:${messageId}:${operator}:${token}`,
          userId: operator, chatId,
          // v1 only issues cards to authorized private targets; chatId+principal
          // matching in the reply-ref lookup is the real guard, so a forwarded
          // group click cannot settle an interaction it was not addressed to.
          chatType: 'private',
          kind: 'callback',
          callback: { token, providerCallbackId: messageId },
          replyContext: replyContextFor(account, { userId: operator, chatId, transportData: { chatId } }),
        }));
      } catch (error) {
        warn(`卡片回调异常: ${error?.message ?? error}`);
      }
    }

    const dispatcher = new sdk.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => onMessage(data),
      'card.action.trigger': (data) => onCardAction(data),
    });
    const wsClient = new sdk.WSClient({ appId, appSecret, domain: DEFAULT_DOMAIN, logger: sdkLogger(warn) });
    try {
      await withDeadline(wsClient.start({ eventDispatcher: dispatcher }), HANDSHAKE_TIMEOUT_MS, '飞书 WS 连接');
    } catch (error) {
      await Promise.resolve(typeof wsClient.close === 'function' ? wsClient.close() : wsClient.stop?.()).catch(() => {});
      throw error;
    }

    void signal;
    return {
      async stop() {
        try {
          if (typeof wsClient.close === 'function') await withDeadline(wsClient.close(), HANDSHAKE_TIMEOUT_MS, '飞书 WS 关闭');
          else if (typeof wsClient.stop === 'function') await withDeadline(wsClient.stop(), HANDSHAKE_TIMEOUT_MS, '飞书 WS 停止');
        } catch { /* best effort */ }
      },
    };
  }

  return Object.freeze({
    id: ID,
    capabilities: capabilitiesOf(ID),
    resolve: resolveOutbound,
    validate: (config) => { resolveOutbound(config ?? {}); },
    send,
    sendControlReply,
    updateControlMessage,
    start,
  });
}

export default createFeishuProvider();
