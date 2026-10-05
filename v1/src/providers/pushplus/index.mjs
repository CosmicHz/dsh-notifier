// pushplus outbound provider (04-PROVIDERS.md, reference adapters/pushplus.mjs).
// POST https://www.pushplus.plus/send; `code === 200` means accepted (async delivery).
import { ProviderError, postJson, str, timeoutOf } from '../http.mjs';
import { capabilitiesOf } from '../specs.mjs';

export const id = 'pushplus';

const ENDPOINT = 'https://www.pushplus.plus/send';
const TEMPLATES = new Set(['html', 'txt', 'json', 'markdown']);
// pushplus message API V1.18 public channel enum (frozen reference comment).
const ALLOWED_CHANNELS = new Set([
  'wechat', 'app', 'extension', 'webhook', 'clawbot', 'cmcc', 'qq', 'cp', 'mail', 'sms', 'voice',
]);

/** Validate + normalize config; missing/invalid throws a guided ProviderError. */
export function resolve(config = {}) {
  const token = str(config.token).trim();
  if (token === '') {
    throw new ProviderError('NOT_CONFIGURED', 'pushplus 未配置：token（扫码关注推推公众号获取，见 https://www.pushplus.plus）未填写');
  }
  const template = str(config.template).trim() || 'markdown';
  if (!TEMPLATES.has(template)) {
    throw new ProviderError('NOT_CONFIGURED', `pushplus 配置非法：template 仅支持 ${[...TEMPLATES].join('/')}（当前：${template}）`);
  }
  const channel = str(config.channel).trim();
  if (channel !== '' && !ALLOWED_CHANNELS.has(channel)) {
    throw new ProviderError('NOT_CONFIGURED', `pushplus 配置非法：channel 仅支持 ${[...ALLOWED_CHANNELS].join('/')}（当前：${channel}）`);
  }
  return {
    token,
    template,
    channel,
    topic: str(config.topic).trim(),
    option: str(config.option).trim(),
    timeoutMs: timeoutOf(config.timeoutMs, 10000),
  };
}

export function validate(config = {}) {
  resolve(config);
}

export async function send({ config, message, signal, network }) {
  const resolved = resolve(config ?? {});
  const body = {
    token: resolved.token,
    title: message.title,
    content: message.content,
    template: resolved.template,
  };
  if (resolved.topic !== '') body.topic = resolved.topic;
  if (resolved.channel !== '') body.channel = resolved.channel;
  if (resolved.option !== '') body.option = resolved.option;
  const response = await postJson(network, ENDPOINT, body, {
    timeoutMs: resolved.timeoutMs, channel: 'pushplus', signal,
  });
  if (typeof response.json?.code !== 'number') {
    throw new ProviderError('BAD_UPSTREAM_RESPONSE', 'pushplus 返回格式异常：缺少 code', response.text.slice(0, 200));
  }
  if (response.json.code !== 200) {
    throw new ProviderError('API_ERROR', `pushplus 返回错误 ${response.json.code}: ${response.json.msg ?? '未知错误'}`);
  }
  return { status: 'accepted' };
}

export const provider = Object.freeze({ id, capabilities: capabilitiesOf(id), resolve, validate, send });
export default provider;