// Shared plumbing for the six inbound/platform channels (T16-T21).
//
// Providers never touch sockets directly and never see the Store: they receive
// the authenticated account, emit validated envelopes through the injected
// `emit` port, and resolve their own declared inbound secrets on demand. A
// missing required secret is a typed NOT_CONFIGURED, never an empty credential.
import { ProviderError, str } from './http.mjs';
import { resolveSecret } from '../security/secrets.mjs';

/** Resolve declared inbound secret fields; `{field: required}`. */
export function inboundSecrets(account, spec) {
  const out = {};
  for (const [name, required] of Object.entries(spec)) {
    const secret = account?.secrets?.[`inbound.${name}`];
    const resolved = secret ? resolveSecret(secret) : null;
    const value = resolved && resolved.ok ? str(resolved.value) : '';
    if (required === true && value === '') {
      throw new ProviderError('NOT_CONFIGURED', `${account?.channelId ?? 'channel'} 入站未配置：${name} 未填写`);
    }
    out[name] = value;
  }
  return out;
}

/** Public (non-secret) inbound config values. */
export function inboundPublic(account, names) {
  const out = {};
  for (const name of names) out[name] = str(account?.config?.inbound?.[name]);
  return out;
}

/** A private-chat reply context carried with every inbound envelope. */
export function replyContextFor(account, { userId, chatId, transportData = {}, expiresAt = null }) {
  return { accountId: account.id, userId, chatId, chatType: 'private', transportData, expiresAt };
}

/** Build a shape-validated inbound envelope (conversation.requireEnvelope). */
export function inboundEnvelope({
  account, epoch, eventId, userId, chatId, chatType = 'private', kind = 'message',
  messageId = null, text = '', attachments = [], callback = null, replyContext = null,
}) {
  const envelope = {
    accountId: account.id,
    epoch,
    eventId,
    userId,
    chatId,
    chatType,
    kind,
    messageId,
    text,
    attachments: [...attachments],
  };
  if (callback !== null) envelope.callback = callback;
  envelope.replyContext = replyContext ?? replyContextFor(account, { userId, chatId });
  return envelope;
}

/** Plain-text rendering of control content (text, then action labels as a hint). */
export function controlText(content) {
  const text = str(content?.text);
  const actions = Array.isArray(content?.actions) ? content.actions : [];
  if (actions.length === 0) return text;
  const labels = actions.map((a) => str(a?.label ?? a?.id)).filter((x) => x !== '');
  if (labels.length === 0) return text;
  return `${text}${text === '' ? '' : '\n'}[${labels.join(' | ')}]`;
}

export function controlActions(content) {
  return Array.isArray(content?.actions) ? content.actions.filter((a) => a && typeof a === 'object') : [];
}

/** Split text into platform-sized chunks (codepoint safe). */
export function chunkText(text, max) {
  const s = str(text);
  if (s === '') return [''];
  const chars = [...s];
  if (chars.length <= max) return [s];
  const out = [];
  for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max).join(''));
  return out;
}

/** A cancellable sleep: resolves early when the signal aborts. */
export function sleep(ms, signal = null) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

/** Combine two optional abort signals into one. */
export function combineSignals(...signals) {
  const live = signals.filter((s) => s && typeof s.addEventListener === 'function');
  if (live.length === 0) return new AbortController().signal;
  if (live.length === 1) return live[0];
  const controller = new AbortController();
  for (const s of live) {
    if (s.aborted) { controller.abort(); break; }
    s.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/** Run an async loop body in the background; start() must not block on it. */
export function backgroundLoop(startBody) {
  const controller = new AbortController();
  const promise = Promise.resolve().then(() => startBody(controller.signal)).catch(() => null);
  return {
    signal: controller.signal,
    async stop() {
      controller.abort();
      await promise;
    },
  };
}

export function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}