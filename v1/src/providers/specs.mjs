// Declarative spec channels (T23) + the compile step that turns a data-only spec
// into a standard outbound provider. Protocol facts are ported from the frozen
// reference adapters (see 04-PROVIDERS.md); nothing here is imported at runtime.
import { channelById, descriptors } from '../domain/descriptors.mjs';
import {
  ProviderError, isProviderError, postJson, postForm, postText, describeFailure, str, timeoutOf,
} from './http.mjs';

/** Title + single newline + body (most IM channels). */
const joinText = (msg) => (msg.title.length > 0 ? `${msg.title}\n${msg.content}` : msg.content);
/** Title + blank line + body (markdown channels). */
const joinPara = (msg) => (msg.title.length > 0 ? `${msg.title}\n\n${msg.content}` : msg.content);

const NTFY_PRIORITY = { critical: 5, timeSensitive: 5, active: 4, passive: 3 };
const ntfyPriority = (msg) => (msg.silent === true ? 2 : NTFY_PRIORITY[msg.level] ?? 3);

const GOTIFY_PRIORITY = { critical: 8, timeSensitive: 8, active: 5, passive: 3 };
const gotifyPriority = (msg) => (msg.silent === true ? 2 : GOTIFY_PRIORITY[msg.level] ?? 4);

const is2xx = ({ status }) => status >= 200 && status < 300;

const legacyTextOf = (value) => (value === undefined || value === null ? '' : String(value).trim());

/**
 * Qmsg 3.0 migration: v3 targets are bound in the Qmsg console, so request-level
 * single-chat targets are rejected explicitly instead of silently dropped.
 */
function migrateQmsgLegacy(cfg) {
  const type = legacyTextOf(cfg.type);
  const qq = legacyTextOf(cfg.qq);
  const bot = legacyTextOf(cfg.bot);
  const next = { ...cfg };
  delete next.type;
  delete next.qq;
  delete next.bot;
  if (type === 'group') {
    if (qq === '' && legacyTextOf(next.group) === '') {
      throw new ProviderError('NOT_CONFIGURED', 'qmsg 未配置：群推送需要 group（群号）');
    }
    if (legacyTextOf(next.group) === '') next.group = qq;
    return next;
  }
  if (type !== '' || qq !== '' || bot !== '') {
    throw new ProviderError('NOT_CONFIGURED', 'Qmsg 3.0 不再支持通过请求参数指定单聊 QQ / bot，请在 Qmsg 控制台绑定目标后删除旧 qq/bot 配置');
  }
  return next;
}

const WPS_OFFICIAL_HOSTS = new Set(['woa.wps.cn', 'xz.wps.cn', '365.kdocs.cn']);
const WPS_WEBHOOK_PATH = '/api/v1/webhook/send';

function normalizeWpsWebhookHost(raw) {
  let candidate = str(raw).trim();
  if (candidate === '') return null;
  if (/^http:\/\//i.test(candidate)) return null;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  let parsed = null;
  try { parsed = new URL(candidate); } catch { parsed = null; }
  if (parsed === null || !WPS_OFFICIAL_HOSTS.has(parsed.hostname)) return null;
  const path = parsed.pathname.includes(WPS_WEBHOOK_PATH) ? parsed.pathname.replace(/\/+$/, '') : WPS_WEBHOOK_PATH;
  return `${parsed.origin}${path}`;
}

/** Resolve a WPS webhook to origin+standard path and reject non-official hosts. */
function normalizeWpsWebhook(raw) {
  let candidate = str(raw).trim();
  if (candidate === '') throw new ProviderError('NOT_CONFIGURED', 'wps-bot 未配置：webhook 地址未填写');
  if (/^http:\/\//i.test(candidate)) throw new ProviderError('NOT_CONFIGURED', 'wps-bot 未配置：webhook 只允许 https');
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  let parsed = null;
  try { parsed = new URL(candidate); } catch { parsed = null; }
  if (parsed === null || !WPS_OFFICIAL_HOSTS.has(parsed.hostname)) {
    throw new ProviderError('NOT_CONFIGURED', 'wps-bot 未配置：webhook 必须是 woa.wps.cn / xz.wps.cn / 365.kdocs.cn 的官方地址');
  }
  const path = parsed.pathname.includes(WPS_WEBHOOK_PATH) ? parsed.pathname.replace(/\/+$/, '') : WPS_WEBHOOK_PATH;
  return `${parsed.origin}${path}${parsed.search}`;
}

/** The 16 declarative channels (T23). Data only: request/ok/fail are pure functions. */
export const SPEC_CHANNELS = Object.freeze({
  slack: {
    label: 'Slack',
    fields: { webhook: { required: true, secret: true, desc: 'Slack Incoming Webhook 完整地址' } },
    encode: 'json',
    ssrfGuard: true,
    request: (cfg, msg) => ({ url: cfg.webhook, body: { text: joinPara(msg) } }),
    ok: ({ status }) => status === 200,
    fail: ({ status, text }) => (status === 403 ? 'webhook 无效或已失效（403）：到 Slack App → Incoming Webhooks 重新复制地址' : String(text ?? '').slice(0, 120)),
    validate: (resolved) => {
      let host = '';
      try { host = new URL(resolved.webhook).hostname; } catch { host = ''; }
      if (host !== 'hooks.slack.com') {
        throw new ProviderError('NOT_CONFIGURED', 'slack 未配置：webhook 必须是 https://hooks.slack.com/services/ 开头的 Incoming Webhook 地址');
      }
    },
  },

  discord: {
    label: 'Discord',
    fields: { webhook: { required: true, secret: true, desc: 'Discord Webhook 完整地址' } },
    encode: 'json',
    ssrfGuard: true,
    request: (cfg, msg) => {
      const content = joinText(msg);
      if (content.length > 2000) {
        throw new ProviderError('API_ERROR', `discord 推送失败：内容超过 Discord 上限 2000 字符（当前 ${content.length}）`);
      }
      return { url: cfg.webhook, body: { content } };
    },
    ok: is2xx,
    fail: ({ status }) => (status === 404 ? 'webhook 已删除（404）：到 Discord 服务器设置重新创建 Webhook' : ''),
  },

  wecom: {
    label: '企业微信群机器人',
    fields: {
      webhook: { secret: true, desc: '机器人完整 webhook 地址（与 key 二选一）' },
      key: { secret: true, desc: '机器人 key（webhook 地址 ?key= 后面的部分）' },
    },
    encode: 'json',
    ssrfGuard: true,
    request: (cfg, msg) => ({
      url: cfg.webhook !== '' ? cfg.webhook : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(cfg.key)}`,
      body: { msgtype: 'markdown', markdown: { content: joinPara(msg) } },
    }),
    ok: ({ json }) => json?.errcode === 0,
    fail: ({ json }) => (json?.errcode === 93100 ? '机器人不可用（93100）：企业微信管理后台确认群机器人未被停用' : json?.errmsg),
    validate: (resolved) => {
      if (resolved.webhook === '' && resolved.key === '') {
        throw new ProviderError('NOT_CONFIGURED', 'wecom 未配置：webhook 与 key 必须填一个');
      }
    },
  },

  mattermost: {
    label: 'Mattermost',
    fields: {
      server: { desc: 'Mattermost 服务器地址（与 webhook 二选一时给全地址可省略）' },
      hookId: { secret: true, desc: 'Incoming Webhook 的 id' },
      webhook: { secret: true, desc: 'Incoming Webhook 完整地址（与 server+hookId 二选一）' },
    },
    encode: 'json',
    ssrfGuard: true,
    request: (cfg, msg) => ({
      url: cfg.webhook !== '' ? cfg.webhook : `${str(cfg.server).replace(/\/+$/, '')}/hooks/${encodeURIComponent(cfg.hookId)}`,
      body: { text: joinPara(msg) },
    }),
    ok: is2xx,
    validate: (resolved) => {
      if (resolved.webhook === '' && resolved.hookId === '') throw new ProviderError('NOT_CONFIGURED', 'mattermost 未配置：webhook 与 server+hookId 必须填一组');
      if (resolved.webhook === '' && resolved.server === '') throw new ProviderError('NOT_CONFIGURED', 'mattermost 未配置：用 hookId 时必须同时填 server');
    },
  },

  gchat: {
    label: 'Google Chat',
    fields: { webhook: { required: true, secret: true, desc: 'Google Chat 空间 Incoming Webhook' } },
    encode: 'json',
    ssrfGuard: true,
    request: (cfg, msg) => ({ url: cfg.webhook, body: { text: joinText(msg) } }),
    ok: is2xx,
  },

  teams: {
    label: 'Microsoft Teams',
    fields: { webhook: { required: true, secret: true, desc: 'Teams Workflows Incoming Webhook URL' } },
    encode: 'json',
    ssrfGuard: true,
    request: (cfg, msg) => ({
      url: cfg.webhook,
      body: {
        type: 'message',
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              ...(msg.title.length > 0 ? [{ type: 'TextBlock', text: msg.title, weight: 'Bolder', wrap: true }] : []),
              { type: 'TextBlock', text: msg.content, wrap: true },
            ],
          },
        }],
      },
    }),
    ok: is2xx,
  },

  ntfy: {
    label: 'ntfy',
    fields: {
      server: { default: 'https://ntfy.sh', desc: 'ntfy 服务器地址，默认 ntfy.sh' },
      topic: { required: true, desc: '订阅 topic 名' },
      auth: { secret: true, desc: '可选鉴权头原值（Basic ... / Bearer ...）' },
    },
    encode: 'json',
    ssrfGuard: true,
    request: (cfg, msg) => ({
      url: `${(cfg.server || 'https://ntfy.sh').replace(/\/+$/, '')}`,
      headers: { ...(cfg.auth !== '' ? { authorization: cfg.auth } : {}) },
      body: {
        topic: cfg.topic,
        ...(msg.title.length > 0 ? { title: msg.title } : {}),
        message: msg.content,
        priority: ntfyPriority(msg),
      },
    }),
    ok: is2xx,
    fail: ({ json }) => json?.error ?? json?.http_error,
  },

  gotify: {
    label: 'Gotify',
    fields: {
      server: { required: true, desc: 'Gotify 服务器地址' },
      appToken: { required: true, secret: true, desc: '应用 token' },
    },
    encode: 'json',
    ssrfGuard: true,
    request: (cfg, msg) => ({
      url: `${cfg.server.replace(/\/+$/, '')}/message`,
      headers: { 'x-gotify-key': cfg.appToken },
      body: { title: msg.title, message: msg.content, priority: gotifyPriority(msg) },
    }),
    ok: is2xx,
  },

  pushover: {
    label: 'Pushover',
    timeoutMs: 15000,
    fields: {
      token: { required: true, secret: true, desc: '应用 API token' },
      user: { required: true, secret: true, desc: '用户/群组 key' },
    },
    encode: 'form',
    request: (cfg, msg) => ({
      url: 'https://api.pushover.net/1/messages.json',
      body: {
        token: cfg.token,
        user: cfg.user,
        title: msg.title,
        message: msg.content,
        ...(msg.silent !== true && msg.level === 'timeSensitive' ? { sound: 'siren' } : {}),
      },
    }),
    ok: ({ json }) => json?.status === 1,
    fail: ({ json }) => (Array.isArray(json?.errors) ? json.errors.join('; ') : json?.errors),
  },

  chanify: {
    label: 'Chanify',
    fields: {
      baseUrl: { default: 'https://api.chanify.net/v1/sender', desc: 'Chanify 服务地址' },
      token: { required: true, secret: true, desc: '设备 token' },
    },
    encode: 'form',
    ssrfGuard: true,
    request: (cfg, msg) => ({
      url: `${(cfg.baseUrl || 'https://api.chanify.net/v1/sender').replace(/\/+$/, '')}/${encodeURIComponent(cfg.token)}`,
      body: { title: msg.title, text: msg.content },
    }),
    ok: is2xx,
  },

  pushdeer: {
    label: 'PushDeer',
    fields: {
      pushKey: { required: true, secret: true, desc: 'PushKey' },
      endpoint: { default: 'https://api2.pushdeer.com', desc: '服务地址' },
    },
    encode: 'form',
    ssrfGuard: true,
    request: (cfg, msg) => ({
      url: `${(cfg.endpoint || 'https://api2.pushdeer.com').replace(/\/+$/, '')}/message/push`,
      body: { pushkey: cfg.pushKey, text: msg.title, desp: msg.content, type: 'markdown' },
    }),
    ok: ({ json }) => json?.code === 0,
    fail: ({ json }) => json?.error,
  },

  xizhi: {
    label: '息知',
    fields: { key: { required: true, secret: true, desc: '息知 key' } },
    encode: 'json',
    request: (cfg, msg) => ({
      url: `https://xizhi.qqoq.net/${encodeURIComponent(cfg.key)}.send`,
      body: { title: msg.title, content: msg.content },
    }),
    ok: ({ json }) => json?.code === 200,
    fail: ({ json }) => json?.msg,
  },

  qmsg: {
    label: 'Qmsg酱',
    fields: {
      key: { required: true, secret: true, desc: 'Qmsg key' },
      group: { desc: '群推送的群号（留空=单聊）' },
    },
    encode: 'form',
    preresolve: migrateQmsgLegacy,
    request: (cfg, msg) => ({
      url: `https://qmsg.zendee.cn/v3/send/${encodeURIComponent(cfg.key)}`,
      body: { msg: joinText(msg), ...(cfg.group !== '' ? { group: cfg.group } : {}) },
    }),
    ok: ({ json }) => json?.success === true,
    fail: ({ json }) => json?.message,
  },

  igot: {
    label: 'iGot',
    fields: { key: { required: true, secret: true, desc: 'iGot key' } },
    encode: 'json',
    request: (cfg, msg) => ({
      url: `https://push.hellyw.com/${encodeURIComponent(cfg.key)}`,
      body: { title: msg.title, content: msg.content, automaticallyCopy: 0 },
    }),
    ok: ({ json }) => json?.ret === 0,
    fail: ({ json }) => json?.errMsg,
  },

  onebot: {
    label: 'QQ OneBot 11',
    fields: {
      baseUrl: { required: true, desc: 'OneBot HTTP 服务地址，如 http://127.0.0.1:3000' },
      accessToken: { secret: true, desc: '可选 access token' },
      messageType: { default: 'private', desc: 'private=私聊 / group=群聊' },
      userId: { desc: '私聊目标 QQ 号', type: 'number' },
      groupId: { desc: '群号', type: 'number' },
    },
    encode: 'json',
    ssrfGuard: 'private-ok',
    request: (cfg, msg) => ({
      url: `${cfg.baseUrl.replace(/\/+$/, '')}/send_msg`,
      headers: cfg.accessToken !== '' ? { authorization: `Bearer ${cfg.accessToken}` } : {},
      body: {
        message_type: cfg.messageType || 'private',
        message: [{ type: 'text', data: { text: joinText(msg) } }],
        ...(cfg.messageType === 'group' ? { group_id: cfg.groupId } : { user_id: cfg.userId }),
      },
    }),
    ok: ({ json }) => json?.retcode === 0 && json?.status !== 'failed',
    fail: ({ json }) => (json?.retcode === 1404 ? 'OneBot 未实现该接口（1404）' : json?.wording ?? json?.echo),
    validate: (resolved) => {
      if (resolved.messageType !== 'private' && resolved.messageType !== 'group') {
        throw new ProviderError('NOT_CONFIGURED', 'onebot 未配置：messageType 只能是 private 或 group');
      }
      if (resolved.messageType === 'group' && (resolved.groupId === undefined || resolved.groupId === null)) {
        throw new ProviderError('NOT_CONFIGURED', 'onebot 未配置：messageType 为 group 时 groupId（群号）未填写');
      }
      if (resolved.messageType !== 'group' && (resolved.userId === undefined || resolved.userId === null)) {
        throw new ProviderError('NOT_CONFIGURED', 'onebot 未配置：私聊推送 userId（QQ 号）未填写');
      }
    },
  },

  'wps-bot': {
    label: 'WPS 协作群机器人',
    fixedOptions: true,
    fields: {
      webhook: { required: true, secret: true, desc: 'WPS 协作群机器人完整 webhook 地址（含 ?key=）' },
      msgtype: { default: 'text', plain: true, desc: '消息类型：text（默认）或 markdown' },
    },
    encode: 'json',
    ssrfGuard: true,
    preresolve: (cfg) => {
      const key = str(cfg?.webhookKey).trim();
      if (key === '' || str(cfg?.webhook).trim() !== '') return cfg;
      const hostRaw = str(cfg?.webhookHost).trim();
      const fallback = 'https://woa.wps.cn';
      const host = normalizeWpsWebhookHost(hostRaw === '' ? fallback : hostRaw) ?? (hostRaw === '' ? fallback : hostRaw);
      return { ...cfg, webhook: `${host}?key=${encodeURIComponent(key)}` };
    },
    request: (cfg, msg) => {
      if (cfg.msgtype === 'markdown') {
        return { url: cfg.webhook, body: { msgtype: 'markdown', markdown: { text: joinPara(msg) } } };
      }
      return { url: cfg.webhook, body: { msgtype: 'text', text: { content: joinText(msg) } } };
    },
    ok: is2xx,
    fail: ({ status }) => (status === 401 || status === 403 || status === 404
      ? 'webhook key 无效或群机器人已失效：请到 WPS 协作群重新添加机器人，复制新 webhook 地址更新 webhook 字段'
      : ''),
    validate: (resolved) => {
      if (resolved.msgtype !== 'text' && resolved.msgtype !== 'markdown') {
        throw new ProviderError('NOT_CONFIGURED', 'wps-bot 未配置：msgtype 只能是 text 或 markdown');
      }
      resolved.webhook = normalizeWpsWebhook(resolved.webhook);
    },
  },
});

/** Capabilities come from the frozen descriptors so registry and channels agree. */
export function capabilitiesOf(channelId) {
  const descriptor = descriptors().find((d) => d.id === channelId);
  return descriptor?.capabilities ?? Object.freeze({
    outbound: false, inbound: false, controlReply: false, login: false,
    replyLookup: false, media: false, buttons: false, updateMessage: false,
  });
}

function fieldValueOf(field, raw) {
  if (field.type === 'number') {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
    return undefined;
  }
  if (typeof raw === 'string') return raw;
  if (raw === undefined || raw === null) return '';
  return String(raw);
}

/** Compile one spec into the standard outbound provider interface. */
export function makeSpecProvider(id, spec, capabilities = capabilitiesOf(id)) {
  const label = spec.label ?? id;

  function resolve(cfg = {}) {
    if (typeof spec.preresolve === 'function') cfg = spec.preresolve(cfg) ?? cfg;
    const resolved = {};
    for (const [key, field] of Object.entries(spec.fields ?? {})) {
      const value = fieldValueOf(field, cfg[key]);
      const missing = value === '' || value === undefined || value === null;
      if (missing && field.required === true) {
        throw new ProviderError('NOT_CONFIGURED', `${label} 未配置：${key}${field.desc ? `（${field.desc}）` : ''} 未填写`);
      }
      // Only substitute a real declared default; a field with no default keeps the
      // typed empty value ('', undefined) so `x !== ''` request guards stay correct.
      resolved[key] = missing && field.default != null ? field.default : value;
    }
    if (typeof spec.validate === 'function') spec.validate(resolved);
    if (spec.fixedOptions === true) resolved.timeoutMs = spec.timeoutMs ?? 10000;
    else resolved.timeoutMs = timeoutOf(cfg.timeoutMs, spec.timeoutMs ?? 10000);
    resolved.allowPrivateNetwork = cfg.allowPrivateNetwork === true;
    return resolved;
  }

  function validate(config = {}) {
    resolve(config);
  }

  async function send({ config, message, signal, network }) {
    const resolved = resolve(config ?? {});
    const request = spec.request(resolved, message);
    const url = str(request?.url);
    if (url === '') throw new ProviderError('NOT_CONFIGURED', `${label} 请求构造失败：url 为空`);
    const allowPrivateNetwork = spec.ssrfGuard === 'private-ok' || resolved.allowPrivateNetwork === true;
    const options = {
      timeoutMs: resolved.timeoutMs,
      channel: label,
      allowPrivateNetwork,
      signal,
    };
    let response;
    // Only forward an explicit header map; passing `headers: undefined` would
    // otherwise win the later `...opts` spread and wipe the content-type.
    const headerOption = request.headers !== undefined ? { headers: request.headers } : {};
    try {
      const encode = spec.encode ?? 'json';
      if (encode === 'form') response = await postForm(network, url, request.body ?? {}, { ...options, ...headerOption });
      else if (encode === 'text') response = await postText(network, url, request.text ?? message.content, { ...options, ...headerOption });
      else response = await postJson(network, url, request.body ?? {}, { ...options, ...headerOption });
    } catch (error) {
      if (isProviderError(error) && error.code === 'HTTP_ERROR' && typeof spec.fail === 'function') {
        const hint = str(spec.fail({ status: error.status, json: error.json, text: error.text })).slice(0, 200);
        if (hint !== '') {
          throw new ProviderError(error.retryable ? 'HTTP_ERROR' : 'API_ERROR', `${label} 推送失败（HTTP ${error.status}）: ${hint}`, error.detail, {
            retryable: error.retryable, retryAfterMs: error.retryAfterMs, uncertain: error.uncertain, status: error.status,
          });
        }
      }
      throw error;
    }
    const pass = spec.ok({ status: response.status, json: response.json, text: response.text, cfg: resolved, msg: message });
    if (pass !== true) {
      const reason = typeof spec.fail === 'function'
        ? str(spec.fail({ status: response.status, json: response.json, text: response.text })).slice(0, 200)
        : describeFailure(response.json, response.text);
      throw new ProviderError('API_ERROR', `${label} 推送失败${reason !== '' ? `: ${reason}` : `（HTTP ${response.status}）`}`, null, { status: response.status });
    }
    return { status: spec.confirmed === true ? 'confirmed' : 'accepted' };
  }

  return Object.freeze({ id, capabilities, resolve, validate, send });
}

/** All 16 spec providers keyed by channel id. */
export const specProviders = Object.freeze(
  Object.fromEntries(Object.entries(SPEC_CHANNELS).map(([id, spec]) => [id, makeSpecProvider(id, spec)])),
);