// wecom-app outbound provider (04-PROVIDERS.md, reference adapters/wecom-app.mjs).
// Two-step: GET gettoken (corpid+secret) -> POST message/send (touser+agentid).
// The token is cached by createTokenManager and refreshed before expiry; a rejected
// token (40014/42001) invalidates the cache and retries the send exactly once.
import { ProviderError, getJson, postJson, str, timeoutOf } from '../http.mjs';
import { capabilitiesOf } from '../specs.mjs';
import { createTokenManager, normalizeTtlMs } from '../tokens.mjs';

export const id = 'wecom-app';

const TOKEN_URL = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken';
const SEND_URL = 'https://qyapi.weixin.qq.com/cgi-bin/message/send';
const INVALID_TOKEN_CODES = new Set([40014, 42001]);

// One token manager per (corpid, secret) so caching survives across sends; the
// provider is stateless otherwise. Bounded FIFO keeps memory from growing forever.
const TOKEN_MANAGERS = new Map();
const TOKEN_MANAGERS_MAX = 128;

function tokenManagerFor(corpid, secret, timeoutMs, network) {
  const key = `${corpid}\u0000${secret}`;
  const existing = TOKEN_MANAGERS.get(key);
  if (existing !== undefined) {
    // The NetworkPort is injected per send; refresh it so a cached manager never
    // holds a stale port (the token itself stays cached across sends).
    existing.network = network;
    return existing.manager;
  }
  const entry = { network };
  entry.manager = createTokenManager(async () => {
    const url = `${TOKEN_URL}?corpid=${encodeURIComponent(corpid)}&corpsecret=${encodeURIComponent(secret)}`;
    const response = await getJson(entry.network, url, { timeoutMs, channel: 'wecom-app' });
    const payload = response.json;
    if (typeof payload?.access_token !== 'string' || payload.access_token === '') {
      throw new ProviderError('API_ERROR', `wecom-app 换取 access_token 失败（${payload?.errcode ?? '无码'}）: ${payload?.errmsg ?? '检查 corpid 与 secret 是否匹配'}`);
    }
    // expires_in is seconds; normalize to ms (invalid TTL is a corrupt upstream).
    return { token: payload.access_token, expiresInMs: normalizeTtlMs(Number(payload.expires_in) * 1000, 'expires_in') };
  }, { now: () => Date.now() });
  TOKEN_MANAGERS.set(key, entry);
  if (TOKEN_MANAGERS.size > TOKEN_MANAGERS_MAX) {
    TOKEN_MANAGERS.delete(TOKEN_MANAGERS.keys().next().value);
  }
  return entry.manager;
}

export function resolve(config = {}) {
  const corpid = str(config.corpid).trim();
  const secret = str(config.secret).trim();
  const agentIdRaw = str(config.agentId).trim();
  const missing = [];
  if (corpid === '') missing.push('corpid（企业 ID，企业微信管理后台「我的企业」页）');
  if (secret === '') missing.push('secret（应用 Secret，管理后台「应用管理」→ 对应应用页）');
  if (agentIdRaw === '') missing.push('agentId（应用 AgentId，同一页面顶部，数字）');
  if (missing.length > 0) {
    throw new ProviderError('NOT_CONFIGURED', `wecom-app 未配置：${missing.join('、')} 未填写`);
  }
  if (!Number.isFinite(Number(agentIdRaw))) {
    throw new ProviderError('NOT_CONFIGURED', 'wecom-app 配置非法：agentId 必须是数字');
  }
  return {
    corpid,
    secret,
    agentId: Number(agentIdRaw),
    touser: str(config.toUser).trim() || '@all',
    msgtype: str(config.msgtype).trim() === 'markdown' ? 'markdown' : 'text',
    timeoutMs: timeoutOf(config.timeoutMs, 10000),
  };
}

export function validate(config = {}) {
  resolve(config);
}

export async function send({ config, message, signal, network }) {
  const resolved = resolve(config ?? {});
  const manager = tokenManagerFor(resolved.corpid, resolved.secret, resolved.timeoutMs, network);
  const content = message.title.length > 0 ? `${message.title}\n${message.content}` : message.content;
  const body = {
    touser: resolved.touser,
    msgtype: resolved.msgtype,
    agentid: resolved.agentId,
    [resolved.msgtype]: { content },
  };
  const attempt = async (token) => {
    const url = `${SEND_URL}?access_token=${encodeURIComponent(token)}`;
    const response = await postJson(network, url, body, {
      timeoutMs: resolved.timeoutMs, channel: 'wecom-app', signal,
    });
    if (response.json === null) {
      throw new ProviderError('BAD_UPSTREAM_RESPONSE', `wecom-app 返回非 JSON 响应（HTTP ${response.status}）`, response.text.slice(0, 200));
    }
    return response.json;
  };

  let payload = await attempt(await manager.get());
  if (typeof payload?.errcode === 'number' && payload.errcode !== 0 && INVALID_TOKEN_CODES.has(payload.errcode)) {
    manager.invalidate();
    payload = await attempt(await manager.get(true));
  }
  if (payload?.errcode !== 0) {
    const hint = payload?.errcode === 40056 ? '（agentid 不匹配：确认 AgentId 属于该 Secret 对应的应用）' : '';
    throw new ProviderError('API_ERROR', `wecom-app 返回错误 ${payload?.errcode ?? '(无码)'}: ${payload?.errmsg ?? '未知错误'}${hint}`);
  }
  return { status: 'accepted' };
}

export const provider = Object.freeze({ id, capabilities: capabilitiesOf(id), resolve, validate, send });
export default provider;