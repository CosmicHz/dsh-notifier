// serverchan outbound provider (04-PROVIDERS.md, reference adapters/serverchan.mjs).
// POST <endpoint> as a form (title + desp markdown); `code === 0` means accepted.
// SC3 enterprise keys (`sctp<shard>t...`) use the numeric shard subdomain; Turbo
// keys use sctapi.ftqq.com. The old sendKey/sctKey aliases are removed in v1.
import { ProviderError, postForm, str, timeoutOf } from '../http.mjs';
import { capabilitiesOf } from '../specs.mjs';

export const id = 'serverchan';

const TURBO_BASE = 'https://sctapi.ftqq.com';

/**
 * Derive the push endpoint from the SENDKEY (single source of truth; not cached).
 * A malformed `sctp` key (missing `sctp<digits>t`) fails closed.
 */
export function endpointOf(sendkey) {
  const key = str(sendkey).trim();
  if (!/^sctp/i.test(key)) return `${TURBO_BASE}/${encodeURIComponent(key)}.send`;
  const match = /^sctp(\d+)t/i.exec(key);
  if (match === null) {
    throw new ProviderError('NOT_CONFIGURED', 'serverchan SC3 SENDKEY 格式无效：应为 sctp<数字>t...（见 https://sct.ftqq.com）');
  }
  // Whole key urlencoded: path-segment injection cannot escape this request path.
  return `https://${match[1]}.push.ft07.com/send/${encodeURIComponent(key)}.send`;
}

export function resolve(config = {}) {
  const sct = str(config.sct).trim();
  if (sct === '') {
    throw new ProviderError('NOT_CONFIGURED', 'serverchan 未配置：sct（Server酱 SENDKEY，扫码关注获取，见 https://sct.ftqq.com）未填写');
  }
  endpointOf(sct); // fail-closed on malformed SC3 keys at config time
  return { sct, timeoutMs: timeoutOf(config.timeoutMs, 10000) };
}

export function validate(config = {}) {
  resolve(config);
}

export async function send({ config, message, signal, network }) {
  const resolved = resolve(config ?? {});
  const url = endpointOf(resolved.sct);
  const response = await postForm(network, url, { title: message.title, desp: message.content }, {
    timeoutMs: resolved.timeoutMs, channel: 'serverchan', signal,
  });
  if (typeof response.json?.code !== 'number') {
    throw new ProviderError('BAD_UPSTREAM_RESPONSE', 'serverchan 返回格式异常：缺少 code', response.text.slice(0, 200));
  }
  if (response.json.code !== 0) {
    throw new ProviderError('API_ERROR', `serverchan 返回错误 ${response.json.code}: ${response.json.message ?? '未知错误'}`);
  }
  return { status: 'accepted' };
}

export const provider = Object.freeze({ id, capabilities: capabilitiesOf(id), resolve, validate, send });
export default provider;