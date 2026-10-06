// DSH plugin entry (T26; 05-HOST-CLI.md, 01-DECISIONS.md).
//
//   name='dsh-notifier', inject=['tools'], apply(ctx) -> disposer
//
// The real DSH runtime is never imported: every host seam is read defensively
// from the injected `ctx` (documented rc.2 shapes only) and handed to
// createApplication(). The in-process facade is published with
// ctx.provide('notifierV1', facade) (never ctx.notifierV1 = ...), and the
// tools / service registration are released pairwise by the returned disposer.
import { DomainError } from './domain/errors.mjs';
import { createApplication } from './runtime/application.mjs';

export const name = 'dsh-notifier';
export const inject = ['tools'];

const SERVICE_NAME = 'notifierV1';

// ---------------------------------------------------------------------------
// defensive ctx -> seam bundle (documented rc.2 seams only)
// ---------------------------------------------------------------------------

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function idOf(value) {
  if (typeof value === 'string' && value !== '') return value;
  if (isRecord(value) && typeof value.id === 'string' && value.id !== '') return value.id;
  return null;
}

/** Read an optional cordis service without throwing when it is absent. */
function readService(ctx, serviceName) {
  try {
    if (typeof ctx?.get === 'function') {
      const service = ctx.get(serviceName, false);
      return service === undefined || service === null ? null : service;
    }
  } catch { /* absent service is not fatal */ }
  try {
    const service = ctx?.[serviceName];
    return service === undefined || service === null ? null : service;
  } catch { return null; }
}

function conversationFromAgents(agents) {
  const resolve = async (sessionId) => {
    if (typeof agents.get === 'function') {
      const found = await agents.get(sessionId);
      if (isRecord(found)) return found;
    }
    if (typeof agents.list === 'function') {
      const list = await agents.list();
      return (Array.isArray(list) ? list : []).find((item) => idOf(item?.id) === sessionId) ?? null;
    }
    return null;
  };
  const deliver = (method) => async ({ sessionId, text, attachments, signal }) => {
    const agent = await resolve(sessionId);
    const fn = agent?.[method];
    if (typeof fn !== 'function') throw new DomainError('UNSUPPORTED', `${name}: agent cannot ${method}`);
    return fn.call(agent, { text, attachments, signal });
  };
  return {
    followup: deliver('followup'),
    inject: deliver('inject'),
    steer: deliver('steer'),
    async stop({ sessionId, signal }) {
      const agent = await resolve(sessionId);
      if (typeof agent?.stop !== 'function') throw new DomainError('UNSUPPORTED', `${name}: agent cannot stop`);
      const out = await agent.stop({ signal });
      return { stopped: out?.stopped === true };
    },
  };
}

function attachmentsFrom(service) {
  const saveMethod = typeof service.saveFile === 'function'
    ? 'saveFile'
    : (typeof service.saveImage === 'function' ? 'saveImage' : null);
  const readMethod = typeof service.read === 'function'
    ? 'read'
    : (typeof service.load === 'function' ? 'load' : (typeof service.get === 'function' ? 'get' : null));
  return {
    async save({ name, mime, bytes }) {
      if (saveMethod === null) throw new DomainError('UNSUPPORTED', `${name}: attachments cannot save`);
      const ref = saveMethod === 'saveImage'
        ? await service.saveImage({ data: bytes, mediaType: mime, ...(name ? { name } : {}) })
        : await service[saveMethod]({ data: bytes, ...(name ? { name } : {}) });
      const id = idOf(ref?.attachmentId) ?? idOf(ref?.id);
      if (id === null) throw new DomainError('INTERNAL', `${name}: attachment save returned no id`);
      return { id, name: name ?? '', mime: mime ?? 'application/octet-stream', size: bytes.byteLength };
    },
    async read({ attachmentId }) {
      if (readMethod === null) throw new DomainError('UNSUPPORTED', `${name}: attachments cannot read`);
      const found = await service[readMethod]({ attachmentId });
      return {
        name: typeof found?.name === 'string' ? found.name : '',
        mime: typeof found?.mime === 'string' ? found.mime : 'application/octet-stream',
        bytes: found?.bytes instanceof Uint8Array ? found.bytes : new Uint8Array(found?.data ?? []),
      };
    },
  };
}

function webServerFrom(service) {
  const mountMethod = typeof service.mount === 'function'
    ? 'mount'
    : (typeof service.mountCallback === 'function' ? 'mountCallback' : null);
  if (mountMethod === null) return null;
  return { mount: (x) => service[mountMethod](x) };
}

function interactionsFrom(userQuestions) {
  return {
    async settle(request) {
      if (typeof userQuestions.settle === 'function') return userQuestions.settle(request);
      if (typeof userQuestions.answer === 'function') return userQuestions.answer(request);
      throw new DomainError('UNSUPPORTED', `${name}: userQuestions cannot settle`);
    },
    async query(hostRef) {
      if (typeof userQuestions.query === 'function') return userQuestions.query(hostRef);
      return { status: 'unknown' };
    },
  };
}

/**
 * Build the DSH seam bundle from a cordis ctx. Anything missing simply stays
 * absent, so the matching capability reports false and degrades honestly.
 */
export function dshFromCtx(ctx) {
  // Every service is read through the non-throwing `ctx.get(name, false)` first:
  // a cordis proxy throws on undeclared service property access.
  const agents = readService(ctx, 'agents');
  const userQuestions = readService(ctx, 'userQuestions');
  const attachmentsService = readService(ctx, 'attachments');
  const tasksService = readService(ctx, 'tasks');
  const webService = readService(ctx, 'webServer');
  return {
    events: typeof ctx?.on === 'function' ? { on: (event, handler, options) => ctx.on(event, handler, options) } : null,
    sessions: agents === null ? null : { list: () => agents.list?.(), get: (id) => agents.get?.(id) },
    tasks: tasksService !== null && typeof tasksService.list === 'function' ? { list: () => tasksService.list() } : null,
    conversation: agents === null ? null : conversationFromAgents(agents),
    interactions: userQuestions === null ? null : interactionsFrom(userQuestions),
    attachments: attachmentsService === null ? null : attachmentsFrom(attachmentsService),
    webServer: webService === null ? null : webServerFrom(webService),
  };
}

// ---------------------------------------------------------------------------
// tool DTOs (05-HOST-CLI.md "工具DTO与可信上下文")
// ---------------------------------------------------------------------------

const RECEIPTS_SCHEMA = {
  type: 'object',
  properties: { receipts: { type: 'array', items: { type: 'object' } } },
  additionalProperties: true,
};
const ASK_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    choiceIds: { type: 'array', items: { type: 'string' } },
    text: { type: ['string', 'null'] },
  },
  additionalProperties: true,
};

/** Trusted call context: scope/actor come from the host, never from the model. */
function callContext(execContext) {
  const agent = isRecord(execContext?.agent) ? execContext.agent : null;
  const session = isRecord(agent?.session) ? agent.session : (isRecord(execContext?.session) ? execContext.session : null);
  const sessionId = idOf(session?.id) ?? idOf(execContext?.sessionId);
  const agentId = idOf(agent?.id) ?? sessionId;
  const workspaceId = idOf(agent?.workspace?.id) ?? idOf(session?.workspace?.id) ?? idOf(execContext?.workspaceId);
  const callId = idOf(execContext?.callId) ?? idOf(execContext?.toolCallId) ?? idOf(execContext?.id);
  return {
    sessionId,
    agentId,
    workspaceId,
    callId,
    turnId: idOf(execContext?.turnId),
    localAdmin: execContext?.localAdmin === true || execContext?.admin === true,
    signal: execContext?.signal ?? null,
  };
}

const renderReceipts = (_args, value) => [{
  type: 'text',
  text: `通知已提交：${Array.isArray(value?.receipts) ? value.receipts.length : 0} 个接收方`,
}];
const renderAsk = (_args, value) => [{
  type: 'text',
  text: `提问结果：${value?.status ?? 'unknown'}`,
}];

function notifyTool(application) {
  return {
    name: 'notify',
    description: '发送一条通知到用户配置并授权的推送目标。scope 与 actor 由宿主调用上下文注入，模型不得填写。',
    parameters: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: '可选；缺省时由本次工具调用 id 稳定派生，重试不变' },
        title: { type: 'string' },
        text: { type: 'string' },
        level: { type: 'string', enum: ['passive', 'active', 'timeSensitive'] },
        destinationIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['text'],
    },
    output: { schema: RECEIPTS_SCHEMA, render: renderReceipts },
    execute: (args, execContext) => application.notify(args ?? {}, callContext(execContext)),
  };
}

function notifyTestTool(application) {
  return {
    name: 'notify_test',
    description: '向一个推送目标发送测试通知，验证配置。仅在本地管理上下文中可用。',
    parameters: {
      type: 'object',
      properties: { destinationId: { type: 'string' } },
      required: ['destinationId'],
    },
    output: { schema: RECEIPTS_SCHEMA, render: renderReceipts },
    execute: (args, execContext) => application.notifyTest(args ?? {}, callContext(execContext)),
  };
}

function askUserTool(application) {
  return {
    name: 'ask_user',
    description: '向用户提出一个问题并等待单一赢家作答。scope 由宿主调用上下文注入。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        choices: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, label: { type: 'string' } },
            required: ['id', 'label'],
          },
        },
        multiple: { type: 'boolean' },
        allowText: { type: 'boolean' },
        timeoutMs: { type: 'number' },
      },
      required: ['prompt'],
    },
    output: { schema: ASK_SCHEMA, render: renderAsk },
    execute: (args, execContext) => application.askUser(args ?? {}, callContext(execContext)),
  };
}

/** Register notify/notify_test/ask_user; returns a disposer releasing them. */
export function registerTools(ctx, application) {
  if (typeof ctx?.tools?.register !== 'function') return null;
  const disposers = [];
  for (const tool of [notifyTool(application), notifyTestTool(application), askUserTool(application)]) {
    const dispose = ctx.tools.register(tool);
    if (typeof dispose === 'function') disposers.push(dispose);
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose(); } catch { /* unregister failures are never fatal */ }
    }
  };
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

function warn(logger, message) {
  try { logger?.warn?.(`[${name}] ${message}`); } catch { /* logging is never fatal */ }
}

export function apply(ctx, config = {}) {
  const logger = ctx?.logger ?? null;
  const application = createApplication({
    dsh: dshFromCtx(ctx),
    stateDir: typeof config?.stateDir === 'string' ? config.stateDir : null,
    logger,
  });

  const disposers = [];
  const release = (fn) => { if (typeof fn === 'function') disposers.push(fn); };

  // 1. publish the facade (stable object; reports NOT-READY until start resolves)
  if (typeof ctx?.provide === 'function') {
    release(ctx.provide(SERVICE_NAME, application.facade));
  } else {
    warn(logger, 'host has no ctx.provide(); the notifierV1 service is not exposed');
  }

  // 2. construct -> start, then register the executable tools only when the
  //    plugin is actually serviceable. A damaged/degraded state registers no
  //    write tool ("进入损坏 state 时只提供诊断/恢复，不注册可执行写操作").
  const ready = Promise.resolve()
    .then(() => application.start())
    .then(() => {
      const health = application.health();
      if (application.state !== 'running' || health.status !== 'ready') {
        warn(logger, `health=${health.status} (${health.code ?? 'ok'}); executable tools are not registered`);
        return;
      }
      release(registerTools(ctx, application));
    })
    .catch((error) => {
      warn(logger, `startup failed: ${error?.code ?? error?.message ?? 'error'}`);
    });

  // 3. returned disposer: wait for start, then release everything in reverse.
  return async () => {
    await ready.catch(() => {});
    for (const dispose of disposers.splice(0).reverse()) {
      try { await dispose(); } catch (error) {
        warn(logger, `release failed: ${error?.code ?? error?.message ?? 'error'}`);
      }
    }
    await application.dispose();
  };
}
