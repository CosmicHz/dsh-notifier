// Bark outbound provider (04-PROVIDERS.md, reference adapters/bark.mjs).
// Bark V2 JSON POST to <server>/<key>; `code === 200` means accepted.
import { ProviderError, postJson, str, timeoutOf } from '../http.mjs';
import { capabilitiesOf } from '../specs.mjs';

export const id = 'bark';
const DEFAULT_SERVER = 'https://api.day.app';
const LEVELS = new Set(['passive', 'active', 'timeSensitive', 'critical']);

/** Compose the Bark endpoint: an explicit barkUrl wins, else server + key. */
export function barkEndpoint(cfg = {}) {
  const full = str(cfg.barkUrl).trim();
  if (full !== '') return full.replace(/\/+$/, '');
  const key = str(cfg.key).trim();
  if (key === '') return '';
  const server = (str(cfg.server).trim() || DEFAULT_SERVER).replace(/\/+$/, '');
  return `${server}/${key}`;
}

export function resolve(config = {}) {
  const endpoint = barkEndpoint(config);
  if (endpoint === '') {
    throw new ProviderError('NOT_CONFIGURED', 'bark 未配置：key（Bark 设备 key，App 内获取）未填写');
  }
  const resolved = { endpoint, timeoutMs: timeoutOf(config.timeoutMs, 5000) };
  const device = str(config.device).trim();
  if (device !== '') resolved.device = device;
  return resolved;
}

export function validate(config = {}) {
  resolve(config);
}

export async function send({ config, message, signal, network }) {
  const resolved = resolve(config ?? {});
  const body = { title: message.title, body: message.content };
  if (message.group !== undefined) body.group = message.group;
  if (message.level !== undefined && LEVELS.has(message.level)) body.level = message.level;
  if (resolved.device !== undefined) body.device = resolved.device;
  const response = await postJson(network, resolved.endpoint, body, {
    timeoutMs: resolved.timeoutMs, channel: 'Bark', signal,
  });
  if (typeof response.json?.code !== 'number') {
    throw new ProviderError('BAD_UPSTREAM_RESPONSE', 'bark 返回格式异常：缺少 code', response.text.slice(0, 200));
  }
  if (response.json.code !== 200) {
    throw new ProviderError('API_ERROR', `bark 返回错误 ${response.json.code}: ${response.json.message ?? '未知错误'}`);
  }
  return { status: 'accepted' };
}

export const provider = Object.freeze({ id, capabilities: capabilitiesOf(id), resolve, validate, send });
export default provider;