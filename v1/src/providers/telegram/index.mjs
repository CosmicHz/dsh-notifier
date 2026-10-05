// Telegram provider (T16; 04-PROVIDERS.md, 20-HOST-PROTOCOL-MAP.md).
//
// Outbound is Bot API sendMessage; inbound is long polling getUpdates with a
// persisted offset cursor so a restart resumes exactly after the last processed
// update. Inline-keyboard callbacks carry an opaque reply token, control replies
// reuse the inbound bot, and media is resolved to a downloadable file URL via
// getFile before it is handed on. Every failure is typed; a reconnect never
// re-emits an already acknowledged update.
import { ProviderError, request, postJson, str, timeoutOf, describeFailure, tryParseJson } from '../http.mjs';
import { capabilitiesOf } from '../specs.mjs';
import {
  inboundSecrets, inboundEnvelope, replyContextFor, controlText, controlActions, chunkText,
  combineSignals, sleep, toInt,
} from '../platform.mjs';

const ID = 'telegram';
const API = 'https://api.telegram.org';
const TEXT_LIMIT = 4096;
const CALLBACK_DATA_LIMIT = 64;
const LONG_POLL_MS = 25000;
const RECONNECT_MS = 3000;

function resolveOutbound(cfg = {}) {
  const botToken = str(cfg.botToken);
  const chatId = str(cfg.chatId);
  if (botToken === '') throw new ProviderError('NOT_CONFIGURED', 'telegram 未配置：botToken 未填写');
  if (chatId === '') throw new ProviderError('NOT_CONFIGURED', 'telegram 未配置：chatId 未填写');
  return { botToken, chatId, timeoutMs: timeoutOf(cfg.timeoutMs, 10000) };
}

async function callApi(network, token, method, body, { timeoutMs = 10000, signal } = {}) {
  const response = await postJson(network, `${API}/bot${token}/${method}`, body, {
    timeoutMs, channel: 'Telegram', signal,
  });
  if (response.json === null) {
    throw new ProviderError('BAD_UPSTREAM_RESPONSE', 'telegram 返回了非 JSON 响应', response.text);
  }
  if (response.json.ok !== true) {
    throw new ProviderError('API_ERROR', `telegram 调用 ${method} 失败: ${describeFailure(response.json, response.text)}`);
  }
  return response.json.result;
}

async function send({ config, message, signal, network }) {
  const resolved = resolveOutbound(config ?? {});
  const title = str(message.title);
  const text = title !== '' ? `${title}\n${str(message.content)}` : str(message.content);
  let providerMessageId = null;
  for (const chunk of chunkText(text, TEXT_LIMIT)) {
    const result = await callApi(network, resolved.botToken, 'sendMessage', {
      chat_id: resolved.chatId,
      text: chunk,
      disable_notification: message.silent === true,
    }, { timeoutMs: resolved.timeoutMs, signal });
    if (result && result.message_id !== undefined) providerMessageId = String(result.message_id);
  }
  return { status: 'accepted', providerMessageId };
}

function keyboardFor(actions, tokenById) {
  const rows = [];
  for (const action of actions) {
    const label = str(action.label ?? action.id);
    const raw = str(action.value ?? action.id);
    const value = tokenById ? tokenById(action) : raw;
    if (label === '' || value === '' || [...value].length > CALLBACK_DATA_LIMIT) continue;
    rows.push([{ text: [...label].slice(0, 64).join(''), callback_data: value }]);
  }
  return rows.length > 0 ? { inline_keyboard: rows } : null;
}

async function sendControlReply({ account, replyContext, content, signal, network }) {
  const { botToken } = inboundSecrets(account, { botToken: true });
  const chatId = str(replyContext?.chatId ?? replyContext?.userId);
  if (chatId === '') throw new ProviderError('NOT_CONFIGURED', 'telegram 控制回复缺少 chatId');
  const text = controlText(content);
  const keyboard = keyboardFor(controlActions(content));
  let providerMessageId = null;
  for (const chunk of chunkText(text, TEXT_LIMIT)) {
    const body = { chat_id: chatId, text: chunk === '' ? '(empty)' : chunk };
    if (keyboard !== null) body.reply_markup = keyboard;
    const result = await callApi(network, botToken, 'sendMessage', body, { signal });
    if (result && result.message_id !== undefined) providerMessageId = String(result.message_id);
  }
  return { status: 'confirmed', providerMessageId };
}

async function updateControlMessage({ account, replyContext, messageId, content, signal, network }) {
  if (str(messageId) === '') return { status: 'accepted', providerMessageId: null };
  const { botToken } = inboundSecrets(account, { botToken: true });
  await callApi(network, botToken, 'editMessageText', {
    chat_id: str(replyContext?.chatId ?? replyContext?.userId),
    message_id: toInt(messageId, 0),
    text: controlText(content) || '(empty)',
  }, { signal });
  return { status: 'confirmed', providerMessageId: str(messageId) };
}

async function mediaAttachment(network, token, fileId, { name = '', mime = '', size = null, signal } = {}) {
  const file = await callApi(network, token, 'getFile', { file_id: fileId }, { signal });
  const path = str(file?.file_path);
  if (path === '') return null;
  return {
    id: str(fileId),
    url: `${API}/file/bot${token}/${path}`,
    name,
    mime: mime !== '' ? mime : 'application/octet-stream',
    size: Number.isInteger(size) ? size : (Number.isInteger(file?.file_size) ? file.file_size : undefined),
  };
}

async function updateToEnvelope({ account, epoch, update, token, network, signal }) {
  const at = (userId, chatId, extra) => inboundEnvelope({
    account, epoch, userId, chatId,
    replyContext: replyContextFor(account, { userId, chatId, transportData: { chatId } }),
    ...extra,
  });
  if (update.callback_query) {
    const query = update.callback_query;
    const chatId = str(query.message?.chat?.id ?? query.from?.id);
    const userId = str(query.from?.id);
    const parsed = tryParseJson(str(query.data)) ?? {};
    const token = str(parsed.t ?? query.data);
    if (token === '') return null;
    return at(userId, chatId, {
      eventId: `tg:${update.update_id}`,
      kind: 'callback',
      callback: { token, providerCallbackId: str(query.id) },
    });
  }
  const message = update.message ?? update.edited_message;
  if (!message) return null;
  const chatType = message.chat?.type === 'private' ? 'private' : 'group';
  const chatId = str(message.chat?.id);
  const userId = str(message.from?.id ?? message.chat?.id);
  let text = str(message.text ?? message.caption);
  const attachments = [];
  if (message.photo?.length) {
    const best = message.photo[message.photo.length - 1];
    const attachment = await mediaAttachment(network, token, str(best.file_id), {
      mime: 'image/jpeg', size: best.file_size, signal,
    });
    if (attachment) attachments.push(attachment);
  }
  if (message.document) {
    const attachment = await mediaAttachment(network, token, str(message.document.file_id), {
      name: str(message.document.file_name), mime: str(message.document.mime_type), size: message.document.file_size, signal,
    });
    if (attachment) attachments.push(attachment);
  }
  if (text.trim() === '' && attachments.length > 0) text = '[媒体]';
  return at(userId, chatId, {
    eventId: `tg:${update.update_id}`,
    chatType,
    kind: 'message',
    messageId: str(message.message_id),
    text,
    attachments,
  });
}

async function runLoop({ account, epoch, emit, signal, network, cursorStore, reconnectMs = RECONNECT_MS }, inner) {
  const { botToken } = inboundSecrets(account, { botToken: true });
  const stopSignal = combineSignals(signal, inner);
  let offset = toInt(cursorStore?.load?.()?.offset, 0);
  const allowed = encodeURIComponent(JSON.stringify(['message', 'callback_query']));
  while (!stopSignal.aborted) {
    let response;
    try {
      response = await request(network, {
        url: `${API}/bot${botToken}/getUpdates?offset=${offset}&timeout=${Math.floor(LONG_POLL_MS / 1000)}&allowed_updates=${allowed}`,
        method: 'GET', headers: { accept: 'application/json' },
        timeoutMs: LONG_POLL_MS + 5000, channel: 'Telegram', signal: stopSignal,
        throwOnHttpError: false,
      });
    } catch (error) {
      if (stopSignal.aborted) return;
      // Recoverable network errors (timeout, connection failure): backoff and retry.
      await sleep(reconnectMs, stopSignal);
      continue;
    }
    // Check HTTP status for auth failures.
    const status = response.status ?? 0;
    if (status === 401 || status === 403) {
      throw new ProviderError('FORBIDDEN', `telegram 认证失败 (HTTP ${status})`);
    }
    if (response.json?.ok !== true) {
      // Other API errors: backoff and retry.
      await sleep(reconnectMs, stopSignal);
      continue;
    }
    const updates = Array.isArray(response.json.result) ? response.json.result : [];
    if (updates.length === 0) { await sleep(25, stopSignal); continue; }
    let nextOffset = offset;
    let stopCause = null;
    for (const update of updates) {
      const envelope = await updateToEnvelope({ account, epoch, update, token: botToken, network, signal: stopSignal });
      const updateId = toInt(update.update_id, 0);
      if (envelope === null) {
        // Unparseable update (no message/edited_message, or a callback with no
        // token). Telegram redelivers any update whose id we do not acknowledge,
        // so a poison update would be re-fetched forever if we did not skip it.
        // Advancing past it is the only way to make progress; it is never
        // silently lost — the raw update was not a persistable envelope.
        nextOffset = Math.max(nextOffset, updateId + 1);
        continue;
      }
      const outcome = await emit(envelope);
      if (outcome?.accepted === true || outcome?.code === 'DUPLICATE') {
        // Accepted or already deduplicated: safe to advance offset.
        nextOffset = Math.max(nextOffset, updateId + 1);
      } else {
        // Any other rejection (STALE_EPOCH, NO_CONNECTION, FORBIDDEN): stop this
        // batch and preserve the old offset so nothing is skipped.
        stopCause = typeof outcome?.code === 'string' ? outcome.code : 'INTERNAL';
        break;
      }
    }
    // STALE_EPOCH means this connection was superseded: end quietly, the
    // replacement owns the account. Any other stop is a real fault and must
    // surface as fatal so the manager degrades instead of faking `ready`.
    if (stopCause === 'STALE_EPOCH') return;
    if (stopCause !== null) throw new ProviderError(stopCause, `telegram 入站批次中止: ${stopCause}`);
    if (nextOffset > offset) {
      // Commit the new offset only after all updates were reliably accepted or deduplicated.
      const advanced = await cursorStore.commit(account.id, { offset: nextOffset });
      // A failed cursor commit (e.g. an un-drained inbox) must not let the next
      // getUpdates use the new offset: stop rather than risk skipping a record.
      if (!advanced?.advanced) throw new ProviderError('UNAVAILABLE', 'telegram 游标提交失败，停止以避免越水位');
      offset = nextOffset;
    }
  }
}

async function start({ account, epoch, emit, signal, network, cursorStore, reconnectMs, onFatal }) {
  // Synchronous admission: fail fast if configuration is invalid.
  if (network === null || typeof network?.request !== 'function') {
    throw new ProviderError('UNSUPPORTED', 'telegram 入站缺少网络端口');
  }
  const { botToken } = inboundSecrets(account, { botToken: true });
  if (str(botToken) === '') {
    throw new ProviderError('NOT_CONFIGURED', 'telegram 入站未配置 botToken');
  }
  const controller = new AbortController();
  const promise = runLoop({ account, epoch, emit, signal, network, cursorStore, reconnectMs }, controller.signal)
    .catch((error) => {
      // Fatal errors: stop the loop and notify the manager.
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