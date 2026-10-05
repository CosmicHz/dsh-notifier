// Shared outbound provider plumbing (04-PROVIDERS.md).
// Providers never touch sockets directly: every user-controllable request goes
// through the injected NetworkPort (src/security/network.mjs) so SSRF/DNS-pinning,
// redirect refusal, stream caps, timeouts and cancellation stay in one place.
import { fieldsFor } from '../domain/descriptors.mjs';
import { resolveSecret } from '../security/secrets.mjs';
import { LIMITS } from '../domain/limits.mjs';

/** Stable provider error codes; receipts and logs consume these, not raw messages. */
export const PROVIDER_ERROR_CODES = Object.freeze([
  'NOT_CONFIGURED',
  'HTTP_ERROR',
  'API_ERROR',
  'TIMEOUT',
  'NETWORK_ERROR',
  'BAD_UPSTREAM_RESPONSE',
  'UNSAFE_TARGET',
  'CANCELLED',
  'UNSUPPORTED',
  'API_ERROR',
]);

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const NOT_ACCEPTED_NETWORK = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNRESET']);

/**
 * A provider failure with a public message (safe for UI/logs) and an internal
 * detail (raw upstream text / socket error; logs only).
 */
export class ProviderError extends Error {
  constructor(code, publicMessage, detail = null, extra = {}) {
    super(publicMessage);
    this.name = 'ProviderError';
    this.code = code;
    this.publicMessage = publicMessage;
    this.detail = detail ?? '';
    this.retryable = extra.retryable === true;
    this.retryAfterMs = Number.isInteger(extra.retryAfterMs) ? extra.retryAfterMs : null;
    this.uncertain = extra.uncertain === true;
    this.accepted = extra.accepted === true;
    this.status = Number.isInteger(extra.status) ? extra.status : null;
    if (extra.text !== undefined) this.text = extra.text;
    if (extra.json !== undefined) this.json = extra.json;
  }
}

export function isProviderError(value) {
  return value instanceof ProviderError;
}

/** Clamp an explicit timeout to the frozen 1000..60000 window. */
export function timeoutOf(value, fallback = LIMITS.NETWORK_TIMEOUT_MS) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ProviderError('NOT_CONFIGURED', 'timeoutMs 必须是数字');
  if (n < 1000 || n > 60000) throw new ProviderError('NOT_CONFIGURED', 'timeoutMs 必须在 1000..60000 之间');
  return n;
}

export function str(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function num(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

/**
 * Assemble a flat provider config from a stored account + destination.
 * Public values come from account.config.outbound / destination.target; secret
 * envelopes are resolved on demand (env refs never persist). Names collide only
 * when the descriptor assigns one owner, so a plain merge is safe.
 */
export function assembleProviderConfig(account, destination = null, { env = process.env } = {}) {
  const channelId = account?.channelId;
  const config = {};
  for (const owner of ['account', 'destination']) {
    const source = owner === 'account' ? account : destination;
    if (source === null || source === undefined) continue;
    for (const field of fieldsFor(channelId, 'outbound', owner)) {
      if (field.exposure !== 'public') continue;
      const value = owner === 'account' ? account.config?.outbound?.[field.field] : destination.target?.[field.field];
      if (value !== undefined && value !== null) config[field.field] = value;
    }
    for (const field of fieldsFor(channelId, 'outbound', owner)) {
      if (field.exposure !== 'secret') continue;
      const secret = owner === 'account' ? account.secrets?.[field.path] : destination?.secrets?.[field.path];
      if (secret === undefined || secret === null) continue;
      // Pass field descriptor for typed decoding (R08 fix)
      const resolved = resolveSecret(secret, env, field);
      if (resolved.ok) config[field.field] = resolved.value;
    }
  }
  return config;
}

const decoder = new TextDecoder('utf-8', { fatal: false });

export function decodeText(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (typeof bytes === 'string') return bytes;
  return decoder.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

export function tryParseJson(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '' || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

export function encodeJsonBody(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function encodeFormBody(value) {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(value ?? {})) {
    if (raw === undefined || raw === null || raw === '') continue;
    if (Array.isArray(raw)) for (const item of raw) params.append(key, String(item));
    else params.append(key, String(raw));
  }
  return new TextEncoder().encode(params.toString());
}

export function setTimeoutAbort(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function retryAfterMsOf(headers) {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  const value = str(raw).trim();
  if (value === '') return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

function httpErrorMeta(status, headers) {
  if (!RETRYABLE_STATUS.has(status)) return { retryable: false, uncertain: false };
  if (status === 429) {
    const retryAfterMs = retryAfterMsOf(headers);
    if (retryAfterMs !== null && retryAfterMs > 30000) return { retryable: false, uncertain: false };
    return { retryable: true, retryAfterMs, uncertain: false };
  }
  return { retryable: true, uncertain: false };
}

function mapNetworkError(error, channel) {
  if (error instanceof ProviderError) return error;
  const code = error?.code;
  const detail = error?.detail ?? error?.message ?? String(error);
  if (code === 'CANCELLED') return new ProviderError('CANCELLED', `${channel} 请求已取消`, detail, { uncertain: true });
  if (code === 'TIMEOUT') return new ProviderError('TIMEOUT', `${channel} 请求超时`, detail, { uncertain: true });
  if (code === 'UNSAFE_TARGET') return new ProviderError('UNSAFE_TARGET', error.message, detail, { uncertain: false });
  if (code === 'TOO_LARGE') return new ProviderError('BAD_UPSTREAM_RESPONSE', `${channel} 响应超过大小上限`, detail, { uncertain: false });
  if (code === 'UNSUPPORTED_PROTOCOL') return new ProviderError('NOT_CONFIGURED', error.message, detail, { uncertain: false });
  if (code === 'REDIRECT') return new ProviderError('NETWORK_ERROR', `${channel} 拒绝重定向响应`, detail, { uncertain: true });
  if (code === 'NETWORK_ERROR') {
    const refused = NOT_ACCEPTED_NETWORK.has(String(detail).split(':')[0].trim());
    return new ProviderError('NETWORK_ERROR', `${channel} 网络请求失败`, detail, {
      // A refused connection proves the provider never accepted the request, so
      // it is safe to retry; any other network failure stays uncertain.
      retryable: refused,
      uncertain: !refused,
    });
  }
  return new ProviderError('NETWORK_ERROR', `${channel} 网络请求失败`, detail, { retryable: true, uncertain: true });
}

/**
 * One request through the NetworkPort, normalized to {status, headers, text, json}.
 * Non-2xx responses raise HTTP_ERROR with status/text/json + retry metadata.
 */
export async function request(network, {
  url, method = 'POST', headers = {}, body,
  timeoutMs = LIMITS.NETWORK_TIMEOUT_MS, channel = '渠道',
  allowPrivateNetwork = false, signal, maxBytes = LIMITS.MAX_RPC_BYTES,
  throwOnHttpError = true,
} = {}) {
  if (network === null || typeof network?.request !== 'function') {
    throw new ProviderError('UNSUPPORTED', `${channel} 缺少网络端口`);
  }
  let response;
  try {
    response = await network.request({
      url, method, headers, body,
      timeoutMs, maxBytes, allowPrivateNetwork, signal, channel,
    });
  } catch (error) {
    throw mapNetworkError(error, channel);
  }
  const text = decodeText(response.body);
  const json = tryParseJson(text);
  const out = {
    status: response.status,
    headers: response.headers ?? {},
    text,
    json,
  };
  if (throwOnHttpError && (response.status < 200 || response.status >= 300)) {
    throw new ProviderError('HTTP_ERROR', `${channel} 返回 HTTP ${response.status}`, text.slice(0, 200), {
      status: response.status, text, json, ...httpErrorMeta(response.status, response.headers),
    });
  }
  return out;
}

export function postJson(network, url, body, opts = {}) {
  return request(network, {
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...(opts.headers ?? {}) },
    body: encodeJsonBody(body ?? {}),
    ...opts,
  });
}

export function postForm(network, url, body, opts = {}) {
  return request(network, {
    url,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', ...(opts.headers ?? {}) },
    body: encodeFormBody(body ?? {}),
    ...opts,
  });
}

export function postText(network, url, text, opts = {}) {
  return request(network, {
    url,
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8', ...(opts.headers ?? {}) },
    body: new TextEncoder().encode(String(text ?? '')),
    ...opts,
  });
}

export function getJson(network, url, opts = {}) {
  return request(network, { url, method: 'GET', headers: { accept: 'application/json', ...(opts.headers ?? {}) }, ...opts });
}

/**
 * Secret fields whose descriptor type is not `string` are stored as
 * JSON.stringify'd literals (spec/FIELD-CONSTRAINTS.json secretSerialization).
 * Decode them back to the declared shape; a plain string passes through.
 */
export function decodeJsonValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '' || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

/** Best-effort human-readable failure reason from a JSON payload / text body. */
export function describeFailure(json, text) {
  if (json !== null && typeof json === 'object') {
    const detail = json.errmsg ?? json.message ?? json.error ?? json.reason ?? json.msg ?? json.errors;
    if (typeof detail === 'string' && detail.length > 0) return detail.slice(0, 200);
    if (Array.isArray(detail)) return detail.map(String).join('; ').slice(0, 200);
    const code = json.errcode ?? json.code ?? json.ret ?? json.retcode;
    if (typeof code === 'number') return `错误码 ${code}`;
  }
  return typeof text === 'string' && text.length > 0 ? text.slice(0, 200) : '';
}