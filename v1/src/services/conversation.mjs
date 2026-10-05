// Conversation service (T11; 03-SERVICES-RPC.md 入站会话, 18-WIRING.md 链4,
// W02/W15/W16/W25). Authenticated inbound -> command authorization / turn routing.
//
// Three delivery semantics, aligned with the Host Agent API (reference
// src/inbound/conversation.mjs): a message from a paired chat is `followup` when
// the session is idle, `inject` when it is busy (queued to the next boundary),
// and `steer` when the text starts with `!` (idle steer degrades to followup).
// `stop` is serialized by the session arbiter and wins over later work.
//
// Commands are a constrained session-control surface, not global administration:
// /route is read-only, /quiet only an owner may set on the bound session, and no
// IM command can edit credentials/destinations/roles. Groups refuse every control
// path; outbound group notifications stay independent.
//
// R12: inbound attachments are provider download descriptors (they may embed a
// platform token URL). They are turned into secret-free Host AttachmentRefs by
// MediaService — bounded, cancellable, never relaxed to private networks — before
// Host.submit; a raw URL/token is never handed to the Host.
import { randomUUID } from 'node:crypto';
import { DomainError, conflict, notFound, validationError } from '../domain/errors.mjs';
import { LIMITS, codepointLength } from '../domain/limits.mjs';
import { commit } from '../storage/store.mjs';
import { appendActivity } from './activity.mjs';
import { upsertReplyContext } from './reply-contexts.mjs';
import {
  lookupReplyRefByToken, lookupReplyRefById, markReplyRefUsed, revokeReplyRefsForPrincipal,
} from './reply-refs.mjs';
import { settleInteraction, refreshInteractionTargets } from './interactions.mjs';
import { resolveSessionForPrincipal, resolveRouteTargets } from './routes.mjs';
import { createEffect, applyEffectResult, requireRequestId } from './effects.mjs';
import { admitInboundAttachment } from './media.mjs';
import {
  reserveCorrelation, bindCorrelationTurn, soleLiveCorrelationForSession, completeCorrelation,
} from './correlations.mjs';

export const COMMAND_SPECS = Object.freeze({
  help: 'any',
  whoami: 'any',
  pair: 'unpaired',
  status: 'member',
  tasks: 'member',
  sessions: 'member',
  use: 'member',
  route: 'member',
  stop: 'member',
  approve: 'member',
  reject: 'member',
  answer: 'member',
  unpair: 'member',
  quiet: 'owner',
  unquiet: 'owner',
});

export const COMMAND_LIST = Object.freeze(Object.keys(COMMAND_SPECS));
export const REPLY_ACTIONS = Object.freeze(['approve', 'reject', 'answer']);

const PAGE_SIZE = 20;

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}

function newIdOf(ctx) {
  return typeof ctx?.newId === 'function' ? ctx.newId() : randomUUID();
}

function forbidden(message) {
  return new DomainError('FORBIDDEN', message);
}

// ---------------------------------------------------------------------------
// parsing & authorization (pure)
// ---------------------------------------------------------------------------

/** Parse `/name args` (case-insensitive name). Returns null for plain text. */
export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceAt = trimmed.search(/\s/);
  const head = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
  const name = head.slice(1).toLowerCase();
  const args = (spaceAt === -1 ? '' : trimmed.slice(spaceAt)).trim();
  return { name, args, raw: trimmed };
}

export function isGroupEnvelope(envelope) {
  return envelope?.chatType === 'group';
}

export function commandRole(principal) {
  if (!principal) return 'unpaired';
  return principal.role === 'owner' ? 'owner' : 'member';
}

/**
 * The per-entrypoint/per-action permission table (W15): unknown commands and
 * out-of-role commands fail closed instead of falling through to chat.
 */
export function authorizeCommand(principal, name) {
  const spec = COMMAND_SPECS[name];
  if (!spec) throw notFound(`unknown command /${name}`);
  const role = commandRole(principal);
  if (spec === 'any') return role;
  if (spec === 'unpaired') {
    if (principal) throw forbidden('/pair is only available before pairing');
    return role;
  }
  if (!principal) throw forbidden('pair this chat before using that command');
  if (principal.enabled !== true) throw forbidden('this identity is disabled');
  if (spec === 'member') return role;
  if (role !== 'owner') throw forbidden(`/${name} is owner-only`);
  return role;
}

/** Find the paired principal for one account+user; null when the chat is unpaired. */
export function lookupPrincipal(draft, { accountId, userId }) {
  for (const principal of Object.values(draft.principals)) {
    if (principal.accountId === accountId && principal.userId === userId) return principal;
  }
  return null;
}

// ---------------------------------------------------------------------------
// authorization helpers (R03)
// ---------------------------------------------------------------------------

/**
 * Check if a principal is authorized to access a session.
 * - owner: authorized for all sessions
 * - member: authorized only for sessions in their sessionIds list
 */
export function isSessionAuthorized(principal, sessionId) {
  if (!principal || !sessionId) return false;
  if (principal.role === 'owner') return true;
  return (principal.sessionIds ?? []).includes(sessionId);
}

/**
 * Filter sessions/tasks list by principal authorization.
 * - owner: sees all
 * - member: sees only authorized sessions
 */
export function filterByAuthorization(items, principal, key = 'id') {
  if (!principal) return [];
  if (principal.role === 'owner') return items;
  const authorized = new Set(principal.sessionIds ?? []);
  // N01: a TaskView is authorized by its `sessionId`, never by its own `id`
  // (session and task id spaces are independent).
  return items.filter((item) => authorized.has(item?.[key]));
}

// ---------------------------------------------------------------------------
// session binding (shared with RPC bindings.set)
// ---------------------------------------------------------------------------

export function setBinding(draft, { principalId, sessionId, now = Date.now() }) {
  const principal = draft.principals[principalId];
  if (!principal) throw notFound('principal not found');
  if (typeof sessionId !== 'string' || sessionId === '') throw validationError('sessionId is required');
  draft.bindings[principal.id] = { principalId: principal.id, sessionId, updatedAt: now };
  return { principalId: principal.id, sessionId };
}

export function getBinding(draft, principalId) {
  const binding = draft.bindings[principalId];
  if (!binding) return null;
  if (!draft.principals[principalId]) return null;
  return { principalId: binding.principalId, sessionId: binding.sessionId };
}

// ---------------------------------------------------------------------------
// inbound envelope validation
// ---------------------------------------------------------------------------

function requireEnvelope(envelope) {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw validationError('inbound envelope must be an object');
  }
  for (const key of ['accountId', 'userId', 'chatId', 'eventId']) {
    const value = envelope[key];
    if (typeof value !== 'string' || value === '') throw validationError(`envelope.${key} is required`);
  }
  if (envelope.kind !== 'message' && envelope.kind !== 'callback') {
    throw validationError('envelope.kind must be message|callback');
  }
}

/**
 * Validate the authenticated inbound envelope and resolve who is speaking.
 * Returns null when the event must be ignored (stale epoch / group control).
 */
export function classifyInbound(draft, envelope, ctx = {}) {
  requireEnvelope(envelope);
  const account = draft.accounts[envelope.accountId];
  if (!account) throw notFound('account not found');
  if (Number.isInteger(ctx.epoch) && envelope.epoch !== undefined && envelope.epoch !== ctx.epoch) {
    return { stale: true };
  }
  if (isGroupEnvelope(envelope)) return { group: true, account };
  const principal = lookupPrincipal(draft, { accountId: envelope.accountId, userId: envelope.userId });
  return { account, principal };
}

// ---------------------------------------------------------------------------
// command execution
// ---------------------------------------------------------------------------

function requireBinding(draft, principal) {
  const binding = getBinding(draft, principal.id);
  if (!binding) throw conflict('no session is bound; use /sessions then /use <id>');
  return binding.sessionId;
}

function helpText(principal) {
  const base = ['/help', '/whoami'];
  if (!principal) return [...base, '/pair <code>'].join(' ');
  const member = ['/status', '/tasks', '/sessions', '/use <id>', '/route', '/stop', '/approve <REF>', '/reject <REF>', '/answer <REF> <json>', '/unpair'];
  if (principal.role === 'owner') member.push('/quiet <on|off>', '/unquiet');
  return [...base, ...member].join(' ');
}

async function runReadCommand(store, name, args, { principal, account, envelope }, ctx) {
  const draft = store.snapshot();
  switch (name) {
    case 'help':
      return { reply: helpText(principal) };
    case 'whoami':
      if (!principal) return { reply: 'unpaired private chat' };
      return { reply: `principal=${principal.id} role=${principal.role} account=${account.id}` };
    case 'status': {
      const binding = getBinding(draft, principal.id);
      const connection = `account=${account.id} enabled=${account.enabled} control=${account.controlEnabled}`;
      if (!binding) return { reply: `${connection}; no session bound, use /sessions then /use <id>` };
      return { reply: `${connection}; session=${binding.sessionId}` };
    }
    case 'sessions':
    case 'tasks': {
      const host = ctx.host;
      if (!host) throw new DomainError('UNSUPPORTED', 'the host cannot list sessions');
      const list = name === 'sessions' ? await host.listSessions() : await host.listTasks();
      // R03/N01: filter by authorization before pagination; tasks authorize on sessionId.
      const filtered = filterByAuthorization(list, principal, name === 'tasks' ? 'sessionId' : 'id');
      const page = pageArg(args);
      const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      const label = rows.map((row) => row.id).join(' ');
      return { reply: label === '' ? `no ${name} on page ${page}` : `page ${page}: ${label}` };
    }
    case 'route': {
      const sessionId = requireBinding(draft, principal);
      const resolved = resolveRouteTargets(draft, { sessionId });
      return { reply: `destinationIds=${JSON.stringify(resolved.destinationIds)} quiet=${resolved.quiet}` };
    }
    default:
      throw new DomainError('INTERNAL', `unhandled read command ${name}`);
  }
}

function pageArg(args) {
  if (args === '') return 1;
  const page = Number(args);
  if (!Number.isInteger(page) || page < 1) throw validationError('page must be a positive integer');
  return page;
}

function parseAnswerJson(args) {
  const spaceAt = args.search(/\s/);
  if (spaceAt === -1) throw validationError('usage: /answer <REF> {"choiceIds":[],"text":""}');
  const ref = args.slice(0, spaceAt);
  const body = args.slice(spaceAt).trim();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw validationError('answer payload must be JSON like {"choiceIds":["a"],"text":""}');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw validationError('answer payload must be an object');
  }
  const choiceIds = parsed.choiceIds ?? null;
  const text = parsed.text ?? null;
  if (choiceIds !== null && !Array.isArray(choiceIds)) throw validationError('choiceIds must be an array');
  if (text !== null && typeof text !== 'string') throw validationError('text must be a string');
  if ((choiceIds === null || choiceIds.length === 0) && (text === null || text === '')) {
    throw validationError('an answer needs at least one choiceId or text');
  }
  return { ref, choiceIds, text };
}

async function runActionCommand(store, name, args, { principal, account, envelope, replyContextId }, ctx) {
  const now = nowOf(ctx);
  if (name === 'approve' || name === 'reject' || name === 'answer') {
    const parsed = name === 'answer' ? parseAnswerJson(args) : { ref: args.trim(), choiceIds: null, text: null };
    if (parsed.ref === '') throw validationError(`usage: /${name} <REF>`);
    const snapshot = store.snapshot();
    const ref = lookupReplyRefById(snapshot, {
      refId: parsed.ref, accountId: account.id, principalId: principal.id, chatId: envelope.chatId, now,
    });
    const decision = name === 'approve' ? 'approve' : name === 'reject' ? 'reject' : 'answer';
    const interactionId = ref.interactionId;
    const opened = snapshot.interactions[interactionId];
    const result = await settleInteraction(store, {
      id: interactionId,
      expectedRevision: opened.revision,
      decision,
      ...(parsed.choiceIds !== null ? { choiceIds: parsed.choiceIds } : {}),
      ...(parsed.text !== null ? { text: parsed.text } : {}),
      requestId: requireRequestId(randomUUID()),
      actor: { kind: 'im', accountId: account.id, principalId: principal.id },
    }, { ...ctx, host: ctx.host, now });
    await commit(store, null, (draft) => {
      markReplyRefUsed(draft, ref.id);
      return null;
    });
    return { reply: `interaction ${interactionId} ${result.state}` };
  }
  if (name === 'stop') {
    // N01: read the CURRENT principal before any Host effect (never the snapshot
    // captured when the event was classified).
    const current = store.snapshot().principals[principal.id];
    if (!current || current.enabled !== true) throw forbidden('this identity is disabled');
    if (current.canConverse !== true) throw forbidden('this identity may not stop sessions (canConverse=false)');
    const sessionId = requireBinding(store.snapshot(), current);
    if (!isSessionAuthorized(current, sessionId)) throw forbidden('this session is not authorized for you');
    const arbiter = ctx.arbiterFor ? ctx.arbiterFor(sessionId) : null;
    const requestId = requireRequestId(randomUUID());
    const run = async () => {
      // Re-read right before the effect: a revocation while queued in the
      // arbiter must not still reach the Host.
      const latest = store.snapshot().principals[principal.id];
      if (!latest || latest.enabled !== true || latest.canConverse !== true
        || !isSessionAuthorized(latest, sessionId)) {
        throw forbidden('this session is no longer authorized for you');
      }
      return ctx.host.stop({ sessionId, requestId, signal: ctx.signal ?? new AbortController().signal });
    };
    const outcome = arbiter ? await arbiter.stop(run) : await run();
    return { reply: `session ${sessionId} stopped=${outcome?.stopped === true}` };
  }
  if (name === 'use') {
    const sessionId = args.trim();
    if (sessionId === '') throw validationError('usage: /use <sessionId>');
    const session = ctx.host ? await ctx.host.getSession(sessionId) : null;
    if (ctx.host && !session) throw notFound('unknown session');
    if (ctx.host && session && session.status === 'closed') throw conflict('that session is closed');
    return commit(store, null, (draft) => {
      // N01: re-read the principal inside the transaction; a stale closure copy
      // must not bind a session the identity no longer owns or may not converse on.
      const current = draft.principals[principal.id];
      if (!current || current.enabled !== true) throw forbidden('this identity is disabled');
      if (current.canConverse !== true) throw forbidden('this identity may not bind a session');
      if (!isSessionAuthorized(current, sessionId)) throw forbidden('this session is not authorized for you');
      const binding = setBinding(draft, { principalId: current.id, sessionId, now });
      appendActivity(draft, { kind: 'conversation', accountId: account.id, sessionId, status: 'bound' }, { now });
      return { reply: `bound session=${binding.sessionId}` };
    });
  }
  if (name === 'unpair') {
    // R10: only ever revoke the caller's own pairing — the binding, every
    // outstanding reply ref, and any live interaction target it still holds.
    return commit(store, null, (draft) => {
      const current = draft.principals[principal.id];
      if (!current) throw notFound('principal not found');
      if (current.accountId !== account.id) throw forbidden('principal belongs to another account');
      const affected = Object.values(draft.interactions)
        .filter((i) => (i.state === 'pending' || i.state === 'claimed')
          && i.targets.some((t) => t.principalId === current.id))
        .map((i) => i.id);
      revokeReplyRefsForPrincipal(draft, current.id);
      delete draft.bindings[current.id];
      delete draft.principals[current.id];
      // A pending target is a strong ref; recompute so the deleted principal
      // cannot leave a dangling target behind.
      for (const interactionId of affected) refreshInteractionTargets(draft, interactionId, { now });
      appendActivity(draft, { kind: 'account', accountId: account.id, status: 'unpaired' }, { now });
      return { reply: `unpaired account=${account.id} role=${current.role}` };
    });
  }
  if (name === 'quiet' || name === 'unquiet') {
    const sessionId = requireBinding(store.snapshot(), principal);
    let quiet;
    if (name === 'unquiet') quiet = false;
    else if (args.trim() === 'on') quiet = true;
    else if (args.trim() === 'off') quiet = false;
    else throw validationError('usage: /quiet <on|off>');
    return commit(store, null, (draft) => {
      setSessionQuiet(draft, sessionId, quiet, now, newIdOf(ctx));
      return { reply: `session ${sessionId} quiet=${quiet}` };
    });
  }
  throw new DomainError('INTERNAL', `unhandled action command ${name}`);
}

/** Owner-scoped quiet override on the bound session; destinations are never touched. */
function setSessionQuiet(draft, sessionId, quiet, now, id) {
  const existing = Object.values(draft.routes).find((r) => r.scope === 'session' && r.scopeId === sessionId);
  if (existing) {
    existing.quiet = quiet;
    existing.revision += 1;
    existing.updatedAt = now;
    return existing;
  }
  const route = {
    id, revision: 0, scope: 'session', scopeId: sessionId, destinationIds: null, quiet,
    createdAt: now, updatedAt: now,
  };
  draft.routes[route.id] = route;
  return route;
}

// ---------------------------------------------------------------------------
// turn routing
// ---------------------------------------------------------------------------

function emptySignal() {
  return new AbortController().signal;
}

/**
 * R12: turn provider download descriptors into secret-free Host AttachmentRefs.
 * Every byte goes through MediaService's bounded, cancellable download and
 * Host.saveAttachment; the token-bearing URL never reaches the Host, and any
 * failure aborts the turn instead of falling back to a raw-URL passthrough.
 */
async function admitDescriptors({ host, network, sessionId, requestId, descriptors, signal }) {
  if (descriptors.length === 0) return [];
  const declared = descriptors.reduce(
    (sum, item) => sum + (Number.isInteger(item?.size) && item.size >= 0 ? item.size : 0),
    0,
  );
  if (declared > LIMITS.MAX_ATTACHMENT_TOTAL_BYTES) {
    throw validationError(`attachments exceed ${LIMITS.MAX_ATTACHMENT_TOTAL_BYTES} total bytes`);
  }
  const refs = [];
  let total = 0;
  for (const descriptor of descriptors) {
    const ref = await admitInboundAttachment({ host, network, sessionId, requestId, attachment: descriptor, signal });
    total += ref.size;
    if (total > LIMITS.MAX_ATTACHMENT_TOTAL_BYTES) {
      throw validationError(`attachments exceed ${LIMITS.MAX_ATTACHMENT_TOTAL_BYTES} total bytes`);
    }
    refs.push(ref);
  }
  return refs;
}

async function converse(store, envelope, { account, principal }, ctx) {
  // N01: read the CURRENT principal before any Host effect (a revocation or
  // disable after classification must not still start a turn).
  const current = store.snapshot().principals[principal.id];
  if (!current || current.enabled !== true) throw forbidden('this identity is disabled');
  if (current.canConverse !== true) throw forbidden('this identity may not start conversations');
  const text = typeof envelope.text === 'string' ? envelope.text : '';
  if (codepointLength(text) > LIMITS.MAX_MESSAGE_CODEPOINTS) {
    throw validationError(`message exceeds ${LIMITS.MAX_MESSAGE_CODEPOINTS} codepoints`);
  }
  // R12: an attachment-only message is valid; a message with neither usable text
  // nor an attachment is not (a steer still requires body text).
  const descriptors = Array.isArray(envelope.attachments) ? envelope.attachments : [];
  if (descriptors.length > LIMITS.MAX_ATTACHMENTS) {
    throw validationError(`attachments exceed the ${LIMITS.MAX_ATTACHMENTS} item cap`);
  }
  const steerIntent = text.startsWith('!');
  const body = steerIntent ? text.slice(1).trim() : text;
  const hasBody = codepointLength(body.trim()) > 0;
  if (steerIntent && !hasBody) throw validationError('message text is empty after steer prefix');
  if (!hasBody && descriptors.length === 0) throw validationError('message text is empty');

  const snapshot = store.snapshot();
  const { sessionId } = resolveSessionForPrincipal(snapshot, principal.id, {
    activeSessionIds: ctx.activeSessionIds ?? null,
  });

  const host = ctx.host;
  if (!host) throw new DomainError('UNSUPPORTED', 'the host cannot receive conversation turns');
  const session = await host.getSession(sessionId).catch(() => null);
  const running = session?.status === 'running';

  let mode;
  let correlationId;
  if (running) {
    const live = soleLiveCorrelationForSession(store.snapshot(), sessionId);
    if (!live || live.principalId !== principal.id) {
      throw conflict('no unique in-flight turn to attach to');
    }
    mode = steerIntent ? 'steer' : 'inject';
    correlationId = live.id;
  } else {
    mode = 'followup'; // an idle steer is equivalent to a followup
    correlationId = null;
  }

  const requestId = requireRequestId(randomUUID());
  const now = nowOf(ctx);
  const signal = ctx.signal ?? emptySignal();
  // Admit media BEFORE recording the submit effect: a crash mid-download must not
  // leave a `started` leaf that claims a turn the Host never received (W11).
  const attachments = await admitDescriptors({
    host, network: ctx.network, sessionId, requestId, descriptors, signal,
  });
  let prepared;
  if (mode === 'followup') {
    prepared = await commit(store, null, (draft) => {
      const { correlation } = reserveCorrelation(draft, {
        accountId: account.id,
        principalId: principal.id,
        replyContextId: current.replyContextId,
        sessionId,
        requestId,
      }, { now, newId: ctx.newId });
      const effect = createEffect(draft, {
        requestKey: correlation.requestKey,
        accountId: account.id,
        destinationId: null,
        kind: 'hostSubmit',
      }, { now, newId: ctx.newId });
      applyEffectResult(draft, effect.id, { status: 'started', now });
      return { correlationId: correlation.id, effectId: effect.id };
    });
  } else {
    const live = store.snapshot().correlations[correlationId];
    prepared = await commit(store, null, (draft) => {
      const effect = createEffect(draft, {
        requestKey: live.requestKey,
        accountId: account.id,
        destinationId: null,
        kind: 'hostSubmit',
      }, { now, newId: ctx.newId });
      applyEffectResult(draft, effect.id, { status: 'started', now });
      return { correlationId, effectId: effect.id };
    });
  }

  const submit = () => host.submit({
    sessionId,
    mode,
    text: body,
    attachments,
    requestId,
    signal,
  });
  const arbiter = ctx.arbiterFor ? ctx.arbiterFor(sessionId) : null;
  let result;
  try {
    result = arbiter
      ? await (mode === 'steer' ? arbiter.steer(submit) : mode === 'inject' ? arbiter.steer(submit) : arbiter.submit(submit))
      : await submit();
  } catch (error) {
    await commit(store, null, (draft) => {
      applyEffectResult(draft, prepared.effectId, {
        status: error?.code === 'CANCELLED' ? 'cancelled' : 'failed',
        errorCode: typeof error?.code === 'string' ? error.code : 'INTERNAL',
        now: nowOf(ctx),
      });
      if (mode === 'followup') cancelLive(draft, prepared.correlationId, nowOf(ctx));
      appendActivity(draft, { kind: 'conversation', accountId: account.id, sessionId, status: 'submit-failed' }, { now: nowOf(ctx) });
      return null;
    });
    throw error;
  }

  await commit(store, null, (draft) => {
    applyEffectResult(draft, prepared.effectId, { status: 'accepted', now: nowOf(ctx) });
    if (mode === 'followup' && typeof result?.hostRef === 'string') {
      bindCorrelationTurn(draft, prepared.correlationId, {
        hostRef: result.hostRef,
        turnId: typeof result.turnId === 'string' ? result.turnId : null,
        now: nowOf(ctx),
      });
    }
    appendActivity(draft, { kind: 'conversation', accountId: account.id, sessionId, status: mode }, { now: nowOf(ctx) });
    return null;
  });
  return { mode, sessionId, correlationId: prepared.correlationId, hostRef: result?.hostRef ?? null };
}

function cancelLive(draft, correlationId, now) {
  const correlation = draft.correlations[correlationId];
  if (correlation && correlation.state !== 'completed') {
    correlation.state = 'cancelled';
    correlation.updatedAt = now;
  }
}

// ---------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------

/**
 * Handle one authenticated inbound event end-to-end: refresh the reply context,
 * dispatch a command or route a turn to the Host, and send one control reply.
 * Returns a small summary; a group or stale event is quietly ignored.
 */
export async function handleInbound(store, envelope, ctx = {}) {
  const classified = classifyInbound(store.snapshot(), envelope, ctx);
  if (classified.stale) return { handled: false, ignored: 'STALE_EPOCH' };
  if (classified.group) return { handled: false, ignored: 'GROUP_CONTROL_DENIED' };
  const { account, principal } = classified;
  const now = nowOf(ctx);

  const replyContextId = await commit(store, null, (draft) => {
    const context = upsertReplyContext(draft, {
      accountId: account.id,
      userId: envelope.userId,
      chatId: envelope.chatId,
      chatType: 'private',
      transportData: envelope.replyContext?.transportData ?? {},
      expiresAt: envelope.replyContext?.expiresAt ?? null,
      ...(principal ? { principalId: principal.id } : {}),
    }, { now });
    return context.id;
  });

  const reply = async (content) => {
    if (typeof ctx.controlReply !== 'function') return null;
    return ctx.controlReply({
      accountId: account.id,
      replyContextId,
      content: { text: content, attachments: [], actions: [] },
      requestId: randomUUID(),
      signal: ctx.signal ?? null,
    });
  };

  try {
    if (envelope.kind === 'callback') {
      const outcome = await handleCallback(store, envelope, { account, principal, replyContextId }, ctx);
      return { handled: true, kind: 'callback', ...outcome };
    }

    const command = parseCommand(envelope.text ?? '');
    if (command !== null) {
      authorizeCommand(principal, command.name);
      if (!principal) {
        if (command.name === 'pair') {
          const outcome = await redeemPair(store, envelope, account, replyContextId, command.args, ctx);
          await reply(outcome.message);
          return { handled: true, kind: 'command', name: 'pair', paired: outcome.paired };
        }
        await reply(await runReadCommand(store, command.name, command.args, { principal, account, envelope }, ctx).then((r) => r.reply));
        return { handled: true, kind: 'command', name: command.name };
      }
      if (command.name in COMMAND_SPECS && ['approve', 'reject', 'answer', 'stop', 'use', 'quiet', 'unquiet', 'unpair'].includes(command.name)) {
        const result = await runActionCommand(store, command.name, command.args, { principal, account, envelope, replyContextId }, ctx);
        await reply(result.reply);
        return { handled: true, kind: 'command', name: command.name };
      }
      const result = await runReadCommand(store, command.name, command.args, { principal, account, envelope }, ctx);
      await reply(result.reply);
      return { handled: true, kind: 'command', name: command.name };
    }

    if (!principal) {
      await reply('pair this chat first: /pair <code>');
      return { handled: true, kind: 'rejected', code: 'NOT_PAIRED' };
    }
    const outcome = await converse(store, envelope, { account, principal }, ctx);
    return { handled: true, kind: 'converse', ...outcome };
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'INTERNAL';
    await reply(`error ${code}: ${error?.message ?? 'failed'}`).catch(() => null);
    throw error;
  }
}

async function handleCallback(store, envelope, { account, principal, replyContextId }, ctx) {
  const callback = envelope.callback;
  if (callback === null || typeof callback !== 'object' || typeof callback.token !== 'string') {
    throw validationError('callback envelope requires a token');
  }
  if (!principal) throw forbidden('pair this chat before answering');
  const ref = await commit(store, null, (draft) => {
    const found = lookupReplyRefByToken(draft, {
      token: callback.token,
      accountId: account.id,
      chatId: envelope.chatId,
      principalId: principal.id,
      now: nowOf(ctx),
    });
    return structuredClone(found);
  });
  const opened = store.snapshot().interactions[ref.interactionId];
  const result = await settleInteraction(store, {
    id: ref.interactionId,
    expectedRevision: opened.revision,
    decision: ref.action,
    requestId: requireRequestId(randomUUID()),
    actor: { kind: 'im', accountId: account.id, principalId: principal.id },
  }, { ...ctx, now: nowOf(ctx) });
  await commit(store, null, (draft) => {
    markReplyRefUsed(draft, ref.id);
    return null;
  });
  if (typeof ctx.controlReply === 'function') {
    await ctx.controlReply({
      accountId: account.id,
      replyContextId,
      content: { text: `interaction ${ref.interactionId} ${result.state}`, attachments: [], actions: [] },
      requestId: randomUUID(),
      signal: ctx.signal ?? null,
    }).catch(() => null);
  }
  return { interactionId: ref.interactionId, state: result.state };
}

async function redeemPair(store, envelope, account, replyContextId, code, ctx) {
  const redeem = ctx.redeemPairing;
  if (typeof redeem !== 'function') {
    throw new DomainError('UNSUPPORTED', 'pairing redemption is unavailable');
  }
  const principal = await redeem({
    accountId: account.id,
    userId: envelope.userId,
    code: code.trim(),
    replyContextId,
  });
  return { paired: true, message: `paired as ${principal.role}` };
}

export { completeCorrelation };