// Notifications service (T14; 03-SERVICES-RPC.md public facade + 04-PROVIDERS.md
// retry/segment + 02-DATA.md Receipt/Effect).
//
// Responsibilities:
//  - resolve target destinations via routes (session -> agent -> workspace -> global -> settings)
//  - segment long text; a partially-sent message is never retried as a whole (D01)
//  - retry per level, only for confirmed-not-accepted retryable responses (Retry-After aware)
//  - layer evidence: a provider "accepted" is never promoted to "confirmed" (D02)
//  - bound concurrency/queue (global 16 / per-account 4 / queue 256) (D03)
//  - persist Receipts + Effects so the evidence survives restarts
import { randomUUID } from 'node:crypto';
import { DomainError, validationError } from '../domain/errors.mjs';
import { LIMITS, codepointLength } from '../domain/limits.mjs';
import { commit } from '../storage/store.mjs';
import { appendActivity } from './activity.mjs';
import { resolveRouteTargets } from './routes.mjs';
import { assembleProviderConfig } from '../providers/http.mjs';
import { getProvider, hasProvider } from '../providers/registry.mjs';

export const NOTIFY_LEVELS = Object.freeze(['passive', 'active', 'timeSensitive']);

// passive: 1 attempt (no retry); active: 1 retry; timeSensitive: 2 retries.
const RETRY_POLICY = Object.freeze({
  passive: Object.freeze({ attempts: 1, backoffMs: 0 }),
  active: Object.freeze({ attempts: 2, backoffMs: 1000 }),
  timeSensitive: Object.freeze({ attempts: 3, backoffMs: 1000 }),
});

const RETRY_AFTER_CAP_MS = 30000;
const RETRY_JITTER_MS = 250;
const DEFAULT_SEGMENT_CODEPOINTS = 1200;
const RETENTION_WINDOW_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeLevel(level) {
  return NOTIFY_LEVELS.includes(level) ? level : 'active';
}

export function retryPolicyOf(level) {
  return RETRY_POLICY[normalizeLevel(level)];
}

/** Exponential backoff, floored by an upstream Retry-After, plus bounded jitter. */
export function backoffFor(attemptNo, policy, error = null, random = Math.random) {
  const base = policy.backoffMs * 2 ** (attemptNo - 1);
  const retryAfter = Number(error?.retryAfterMs);
  const scheduled = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(base, retryAfter) : base;
  const jitter = Math.floor(random() * (RETRY_JITTER_MS + 1));
  return Math.min(scheduled, RETRY_AFTER_CAP_MS) + jitter;
}

// --- segmentation ----------------------------------------------------------

/** Split text at <= maxCodepoints, preferring sentence-ending punctuation. */
export function segmentText(text, { maxCodepoints = DEFAULT_SEGMENT_CODEPOINTS } = {}) {
  const chars = Array.from(text);
  if (chars.length <= maxCodepoints) return [text];
  const segments = [];
  let current = [];
  let currentLength = 0;
  let lastBreak = -1;
  const flush = () => {
    if (current.length > 0) {
      segments.push(current.join(''));
      current = [];
      currentLength = 0;
      lastBreak = -1;
    }
  };
  for (const char of chars) {
    current.push(char);
    currentLength += 1;
    if (SENTENCE_END.has(char)) lastBreak = currentLength;
    if (currentLength >= maxCodepoints) {
      if (lastBreak > 0 && lastBreak < currentLength) {
        const tail = current.slice(lastBreak);
        current = current.slice(0, lastBreak);
        segments.push(current.join(''));
        current = tail;
        currentLength = tail.length;
        lastBreak = -1;
      } else {
        flush();
      }
    }
  }
  flush();
  return segments.length > 0 ? segments : [''];
}

const SENTENCE_END = new Set(['。', '！', '？', '；', '.', '!', '?', ';', '\n']);

/**
 * Build provider message pieces. A single segment keeps the original title; a
 * multi-segment message folds the title into the leading segment (matching the
 * reference behaviour) and drops it from the rest.
 */
export function segmentMessage(message, { maxCodepoints = DEFAULT_SEGMENT_CODEPOINTS } = {}) {
  const title = typeof message?.title === 'string' ? message.title : '';
  const content = typeof message?.content === 'string' ? message.content : '';
  const merged = title !== '' && content !== '' ? `${title}\n\n${content}` : title || content;
  const parts = segmentText(merged, { maxCodepoints });
  const base = { ...message };
  if (parts.length === 1) return [{ ...base, title, content }];
  return parts.map((part) => ({ ...base, title: '', content: part }));
}

// --- delivery engine -------------------------------------------------------

function errorCodeOf(error) {
  if (error === null || error === undefined) return null;
  const code = typeof error.code === 'string' ? error.code : '';
  return code.length >= 1 && code.length <= 64 ? code : 'INTERNAL';
}

function defaultSleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deliver one already-resolved message to one provider, with segmentation,
 * retry and evidence layering. Pure with respect to the store: the caller owns
 * persistence.
 * @returns {Promise<{status:string, delivery:string, providerMessageIds:string[],
 *   segmentCount:number, sentCount:number, errorCode:string|null, error:Error|null,
 *   attempts:Array<{attempt:number, outcomes:Array<object>}>}>}
 */
export async function runDelivery({
  provider,
  config,
  message,
  level = 'active',
  signal = null,
  network = null,
  sleep = defaultSleep,
  random = Math.random,
  maxCodepoints = DEFAULT_SEGMENT_CODEPOINTS,
}) {
  const normalizedLevel = normalizeLevel(level);
  const pieces = segmentMessage({ ...message, level: normalizedLevel }, { maxCodepoints });
  const policy = retryPolicyOf(normalizedLevel);
  const attempts = [];
  const providerMessageIds = [];
  let sent = 0;
  let allConfirmed = true;
  let completed = false;
  let lastError = null;

  for (let attemptNo = 1; attemptNo <= policy.attempts; attemptNo++) {
    const outcomes = [];
    let attemptError = null;
    for (let index = 0; index < pieces.length; index++) {
      try {
        const result = await provider.send({ config, message: pieces[index], signal, network });
        const confirmed = result?.status === 'confirmed';
        const providerMessageId =
          typeof result?.providerMessageId === 'string' && result.providerMessageId !== ''
            ? result.providerMessageId
            : null;
        if (providerMessageId !== null) providerMessageIds.push(providerMessageId);
        if (!confirmed) allConfirmed = false;
        outcomes.push({ index, ok: true, status: confirmed ? 'confirmed' : 'accepted', providerMessageId });
        sent += 1;
      } catch (error) {
        allConfirmed = false;
        outcomes.push({
          index,
          ok: false,
          status: error?.uncertain === true ? 'uncertain' : error?.code === 'CANCELLED' ? 'cancelled' : 'failed',
          errorCode: errorCodeOf(error),
        });
        attemptError = error;
        break; // stop: later segments are never attempted after a failure
      }
    }
    attempts.push({ attempt: attemptNo, outcomes });
    if (attemptError === null) {
      completed = true;
      lastError = null;
      break;
    }
    lastError = attemptError;
    // D01: once a segment was accepted, never resend the whole message.
    if (outcomes.some((outcome) => outcome.ok)) break;
    const retryable = attemptError?.retryable === true && attemptError?.uncertain !== true;
    if (!retryable || attemptNo >= policy.attempts) break;
    await sleep(backoffFor(attemptNo, policy, attemptError, random));
  }

  const delivery = completed ? 'complete' : sent > 0 ? 'partial' : 'none';
  let status;
  if (completed) status = allConfirmed ? 'confirmed' : 'accepted';
  else if (lastError?.uncertain === true) status = 'uncertain';
  else status = 'failed';

  return {
    status,
    delivery,
    providerMessageIds,
    segmentCount: pieces.length,
    sentCount: sent,
    errorCode: status === 'accepted' || status === 'confirmed' ? null : errorCodeOf(lastError),
    error: lastError,
    attempts,
  };
}

// --- bounded concurrency ---------------------------------------------------

/**
 * Global/per-account concurrency with a bounded wait queue. Queue overflow is a
 * CAPACITY error rather than unbounded memory growth (D03).
 */
export function createSendLimiter({
  globalMax = LIMITS.NETWORK_CONCURRENCY_GLOBAL,
  perAccountMax = LIMITS.NETWORK_CONCURRENCY_PER_ACCOUNT,
  queueMax = LIMITS.SEND_QUEUE_MAX,
} = {}) {
  let running = 0;
  const perAccount = new Map();
  const queue = [];
  const countOf = (key) => perAccount.get(key) ?? 0;
  const canStart = (key) => running < globalMax && countOf(key) < perAccountMax;

  function release(key) {
    running -= 1;
    const next = countOf(key) - 1;
    if (next <= 0) perAccount.delete(key);
    else perAccount.set(key, next);
    pump();
  }

  function start(key, task) {
    running += 1;
    perAccount.set(key, countOf(key) + 1);
    let result;
    try {
      result = Promise.resolve(task());
    } catch (error) {
      result = Promise.reject(error);
    }
    return result.finally(() => release(key));
  }

  function pump() {
    while (queue.length > 0 && canStart(queue[0].key)) {
      const entry = queue.shift();
      if (entry.signal?.aborted) {
        entry.reject(new DomainError('CANCELLED', 'send cancelled while queued'));
        continue;
      }
      entry.resolve(start(entry.key, entry.task));
    }
  }

  function run(key, task, { signal = null } = {}) {
    if (signal?.aborted) return Promise.reject(new DomainError('CANCELLED', 'send cancelled'));
    if (canStart(key)) return start(key, task);
    if (queue.length >= queueMax) {
      return Promise.reject(new DomainError('CAPACITY', `send queue is full (${queueMax})`));
    }
    return new Promise((resolve, reject) => {
      queue.push({ key, task, signal, resolve, reject });
    });
  }

  return {
    run,
    get running() {
      return running;
    },
    get queued() {
      return queue.length;
    },
  };
}

const defaultLimiter = createSendLimiter();

// --- persistence -----------------------------------------------------------

function pruneWindow(draft, collectionName, max, now) {
  const collection = draft[collectionName];
  const cutoff = now - RETENTION_WINDOW_MS;
  for (const [id, item] of Object.entries(collection)) {
    if (item.createdAt < cutoff) delete collection[id];
  }
  const ids = Object.keys(collection);
  if (ids.length <= max) return;
  ids.sort((a, b) => collection[a].createdAt - collection[b].createdAt || (a < b ? -1 : 1));
  for (let i = 0; i < ids.length - max; i++) delete collection[ids[i]];
}

function makeActivity(accountId, sessionId, status, code) {
  return { kind: 'notify', accountId: accountId ?? null, sessionId: sessionId ?? null, status, code: code ?? null };
}

async function persistSkipped(store, { requestId, kind, destination, account, errorCode, now, sessionId }) {
  const receiptId = randomUUID();
  return commit(store, null, (draft) => {
    const receipt = {
      id: receiptId,
      requestId,
      destinationId: destination.id,
      accountId: account.id,
      kind,
      status: 'skipped',
      delivery: 'none',
      effectIds: [],
      providerMessageIds: [],
      destinationLabel: destination.label ?? null,
      errorCode: errorCode ?? null,
      createdAt: now,
    };
    draft.receipts[receipt.id] = receipt;
    pruneWindow(draft, 'receipts', LIMITS.MAX_RECEIPTS, now);
    appendActivity(draft, makeActivity(account.id, sessionId, 'skipped', errorCode), { now });
    return receipt;
  });
}

async function persistResult(store, { requestId, kind, destination, account, requestKey, result, now, sessionId }) {
  const receiptId = randomUUID();
  return commit(store, null, (draft) => {
    const effectIds = [];
    for (const attempt of result.attempts ?? []) {
      for (const outcome of attempt.outcomes ?? []) {
        const effect = {
          id: randomUUID(),
          requestKey,
          accountId: account?.id ?? null,
          destinationId: destination?.id ?? null,
          segmentIndex: outcome.index,
          attempt: attempt.attempt,
          kind: 'notify',
          status: outcome.status,
          providerMessageId: outcome.providerMessageId ?? null,
          errorCode: outcome.errorCode ?? null,
          createdAt: now,
          updatedAt: now,
        };
        draft.effects[effect.id] = effect;
        effectIds.push(effect.id);
      }
    }
    const receipt = {
      id: receiptId,
      requestId,
      destinationId: destination?.id ?? null,
      accountId: account.id,
      kind,
      status: result.status,
      delivery: result.delivery,
      effectIds,
      providerMessageIds: [...new Set(result.providerMessageIds ?? [])],
      destinationLabel: destination?.label ?? null,
      errorCode: result.errorCode ?? null,
      createdAt: now,
    };
    draft.receipts[receipt.id] = receipt;
    pruneWindow(draft, 'receipts', LIMITS.MAX_RECEIPTS, now);
    pruneWindow(draft, 'effects', LIMITS.MAX_EFFECTS, now);
    appendActivity(draft, makeActivity(account.id, sessionId, receipt.status, receipt.errorCode), { now });
    return receipt;
  });
}

// --- target resolution + facade --------------------------------------------

function classifyTarget(state, destinationId) {
  const destination = state.destinations?.[destinationId];
  if (!destination) return { ready: false, errorCode: 'NOT_FOUND' };
  const account = state.accounts?.[destination.accountId];
  if (!account) return { ready: false, errorCode: 'NOT_FOUND' };
  if (destination.enabled !== true) return { ready: false, destination, account, errorCode: 'DISABLED' };
  if (account.enabled !== true || account.notificationEnabled !== true) {
    return { ready: false, destination, account, errorCode: 'DISABLED' };
  }
  if (!hasProvider(account.channelId)) {
    return { ready: false, destination, account, errorCode: 'UNSUPPORTED' };
  }
  return { ready: true, destination, account };
}

function requestKeyOf(actor, method, requestId) {
  const kind = typeof actor?.kind === 'string' && actor.kind !== '' ? actor.kind : 'local-owner';
  const id = typeof actor?.id === 'string' && actor.id !== '' ? actor.id : 'local';
  const key = JSON.stringify([kind, id, method, requestId]);
  if (key.length > 512) throw validationError('requestKey is too long');
  return key;
}

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}

function requireRequestId(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw validationError('requestId must be a UUID');
  }
  return value;
}

async function deliverTo(store, { destination, account, requestId, kind, message, level, requestKey, ctx, now, sessionId }) {
  const provider = getProvider(account.channelId);
  const config = assembleProviderConfig(account, destination, { env: ctx.env ?? process.env });
  const limiter = ctx.limiter ?? defaultLimiter;
  let result;
  try {
    result = await limiter.run(
      account.id,
      () =>
        runDelivery({
          provider,
          config,
          message,
          level,
          signal: ctx.signal ?? null,
          network: ctx.network ?? null,
          sleep: ctx.sleep,
          random: ctx.random,
          maxCodepoints: ctx.segmentMaxCodepoints ?? DEFAULT_SEGMENT_CODEPOINTS,
        }),
      { signal: ctx.signal ?? null },
    );
  } catch (error) {
    result = {
      status: 'failed',
      delivery: 'none',
      providerMessageIds: [],
      attempts: [],
      errorCode: errorCodeOf(error),
    };
  }
  return persistResult(store, { requestId, kind, destination, account, requestKey, result, now, sessionId });
}

export async function notify(store, input, ctx = {}) {
  const requestId = requireRequestId(input?.requestId);
  const title = input?.title ?? '';
  if (typeof title !== 'string') throw validationError('title must be a string');
  const text = input?.text;
  if (typeof text !== 'string' || codepointLength(text) < 1) throw validationError('text is required');
  if (codepointLength(text) > LIMITS.MAX_MESSAGE_CODEPOINTS) {
    throw validationError(`text exceeds ${LIMITS.MAX_MESSAGE_CODEPOINTS} codepoints`);
  }
  if (codepointLength(title) > LIMITS.MAX_MESSAGE_CODEPOINTS) throw validationError('title is too long');
  const level = input?.level === undefined ? 'active' : input.level;
  if (!NOTIFY_LEVELS.includes(level)) throw validationError(`level must be one of ${NOTIFY_LEVELS.join('/')}`);

  const now = nowOf(ctx);
  const state = store.snapshot();
  const resolved = resolveRouteTargets(state, {
    sessionId: input?.sessionId ?? null,
    agentId: input?.agentId ?? null,
    workspaceId: input?.workspaceId ?? null,
  });
  let destinationIds;
  if (input?.destinationIds !== undefined && input?.destinationIds !== null) {
    if (!Array.isArray(input.destinationIds)) throw validationError('destinationIds must be an array');
    destinationIds = input.destinationIds;
  } else {
    destinationIds = resolved.destinationIds;
  }
  destinationIds = [...new Set(destinationIds)];
  const quiet = resolved.quiet === true;

  if (destinationIds.length === 0) {
    await commit(store, null, (draft) => {
      appendActivity(draft, makeActivity(null, input?.sessionId ?? null, 'skipped', 'NO_TARGET'), { now });
      return null;
    });
    return { receipts: [] };
  }

  const requestKey = requestKeyOf(ctx.actor, 'notify', requestId);
  const message = { title, content: text, level };
  const receipts = [];
  for (const destinationId of destinationIds) {
    const target = classifyTarget(state, destinationId);
    if (!target.destination || !target.account) continue; // dangling refs: no receipt
    if (quiet || !target.ready) {
      const receipt = await persistSkipped(store, {
        requestId,
        kind: 'notification',
        destination: target.destination,
        account: target.account,
        errorCode: quiet ? 'QUIET' : target.errorCode,
        now,
        sessionId: input?.sessionId ?? null,
      });
      receipts.push(receipt);
      continue;
    }
    const receipt = await deliverTo(store, {
      destination: target.destination,
      account: target.account,
      requestId,
      kind: 'notification',
      message,
      level,
      requestKey,
      ctx,
      now,
      sessionId: input?.sessionId ?? null,
    });
    receipts.push(receipt);
  }
  return { receipts };
}

export async function testNotification(store, input, ctx = {}) {
  const requestId = requireRequestId(input?.requestId);
  const destinationId = input?.destinationId;
  if (typeof destinationId !== 'string' || destinationId === '') {
    throw validationError('destinationId is required');
  }
  const now = nowOf(ctx);
  const state = store.snapshot();
  const target = classifyTarget(state, destinationId);
  if (!target.destination || !target.account) throw validationError('unknown destination');
  const requestKey = requestKeyOf(ctx.actor, 'notifications.test', requestId);
  const message = { title: 'dsh-notifier v1', content: 'Test notification', level: 'active' };
  if (!target.ready) {
    return persistSkipped(store, {
      requestId,
      kind: 'notification',
      destination: target.destination,
      account: target.account,
      errorCode: target.errorCode,
      now,
      sessionId: null,
    });
  }
  return deliverTo(store, {
    destination: target.destination,
    account: target.account,
    requestId,
    kind: 'notification',
    message,
    level: 'active',
    requestKey,
    ctx,
    now,
    sessionId: null,
  });
}