// webhook outbound provider: the generic fallback (04-PROVIDERS.md, reference
// adapters/webhook.mjs). POST JSON {title, content, timestamp, level?, group?}.
// `url` is a user-controllable target: security/network provides the SSRF guard at
// request time; allowPrivateNetwork is the explicit local-owner escape hatch.
import { ProviderError, decodeJsonValue, postJson, str, timeoutOf } from '../http.mjs';
import { capabilitiesOf } from '../specs.mjs';

export const id = 'webhook';

/** Normalize headers to a string-valued record; non-scalar values are dropped. */
export function normalizeHeaders(raw) {
  const value = decodeJsonValue(raw);
  const headers = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return headers;
  for (const [key, item] of Object.entries(value)) {
    if (key === '') continue;
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      headers[key] = String(item);
    }
  }
  return headers;
}

export function resolve(config = {}) {
  const url = str(config.url).trim();
  if (url === '') {
    throw new ProviderError('NOT_CONFIGURED', 'webhook 未配置：url（接收 POST JSON 的 webhook 地址）未填写');
  }
  return {
    url,
    headers: normalizeHeaders(config.headers),
    allowPrivateNetwork: config.allowPrivateNetwork === true,
    timeoutMs: timeoutOf(config.timeoutMs, 10000),
  };
}

export function validate(config = {}) {
  resolve(config);
}

export async function send({ config, message, signal, network }) {
  const resolved = resolve(config ?? {});
  const body = {
    title: message.title,
    content: message.content,
    timestamp: new Date().toISOString(),
  };
  if (message.level !== undefined) body.level = message.level;
  if (message.group !== undefined) body.group = message.group;
  await postJson(network, resolved.url, body, {
    headers: resolved.headers,
    timeoutMs: resolved.timeoutMs,
    channel: 'webhook',
    allowPrivateNetwork: resolved.allowPrivateNetwork,
    signal,
  });
  return { status: 'accepted' };
}

export const provider = Object.freeze({ id, capabilities: capabilitiesOf(id), resolve, validate, send });
export default provider;