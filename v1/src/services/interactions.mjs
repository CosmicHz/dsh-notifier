// Interactions service (T10; 02-DATA.md Interaction, 03-SERVICES-RPC.md
// interactions.*, 18-WIRING.md 链5, C01-C05).
//
// An interaction is a Host-pending approval/question/action. The store record is
// the single source of truth for "who may still answer": targets are recomputed
// from the CURRENT policy, never trusted from the card that was sent. Settlement
// is claim-then-call-then-record: the claim (permission, revision, expiry) is one
// transaction, the Host call happens outside the store mutex, and only then is the
// terminal state written. The Host stays the final authority — its
// `already_handled` is never upgraded into a success.
import { randomUUID } from 'node:crypto';
import { DomainError, conflict, notFound, validationError } from '../domain/errors.mjs';
import { LIMITS, codepointLength } from '../domain/limits.mjs';
import { commit } from '../storage/store.mjs';
import { appendActivity } from './activity.mjs';
import { paginate, filterHash, requireId } from './accounts.mjs';
import { assertReplyContextUsable } from './reply-contexts.mjs';
import { revokeReplyRefsForInteraction, activeReplyRefsForInteraction } from './reply-refs.mjs';
import { createEffect, applyEffectResult, requireRequestId } from './effects.mjs';

export const INTERACTION_STATES = Object.freeze([
  'pending', 'claimed', 'resolved', 'rejected', 'expired', 'cancelled', 'uncertain',
]);
export const INTERACTION_TYPES = Object.freeze(['approval', 'question', 'action']);
export const INTERACTION_DECISIONS = Object.freeze(['approve', 'reject', 'answer']);

const TERMINAL = new Set(['resolved', 'rejected', 'expired', 'cancelled', 'uncertain']);

/** Error codes that prove the Host never accepted the settlement (safe to retry). */
const DEFINITIVE_FAILURES = new Set([
  'VALIDATION', 'FORBIDDEN', 'NOT_FOUND', 'UNSUPPORTED', 'EXPIRED', 'CONFLICT', 'CAPACITY', 'ALREADY_HANDLED',
]);

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}

function newIdOf(ctx) {
  return typeof ctx?.newId === 'function' ? ctx.newId() : randomUUID();
}

function bad(message, errors) {
  return validationError(message, errors ?? null);
}

// ---------------------------------------------------------------------------
// authorization
// ---------------------------------------------------------------------------

/**
 * A principal may observe a session when it is enabled, its account is enabled
 * with control enabled, its reply context is still usable, and it is either the
 * account owner or explicitly authorized for this session.
 */
export function observeAllowed(draft, principal, sessionId, now) {
  if (!principal || principal.enabled !== true) return false;
  const account = draft.accounts[principal.accountId];
  if (!account || account.enabled !== true || account.controlEnabled !== true) return false;
  const context = draft.replyContexts[principal.replyContextId];
  if (!context || context.accountId !== account.id) return false;
  try {
    assertReplyContextUsable(context, now);
  } catch {
    return false;
  }
  if (principal.role === 'owner') return true;
  return Array.isArray(principal.sessionIds) && principal.sessionIds.includes(sessionId);
}

/** Recompute the pending target list for one interaction from current policy. */
export function computeTargets(draft, { sessionId, now = Date.now() }) {
  const targets = [];
  for (const principal of Object.values(draft.principals)) {
    if (!observeAllowed(draft, principal, sessionId, now)) continue;
    targets.push({
      accountId: principal.accountId,
      principalId: principal.id,
      replyContextId: principal.replyContextId,
      policyRevision: draft.accounts[principal.accountId].policyRevision,
    });
  }
  targets.sort((a, b) => (a.principalId < b.principalId ? -1 : 1));
  return targets;
}

/** Actor shapes accepted by claim/settle: the trusted host admission or an IM principal. */
function actorKeyOf(actor) {
  if (!actor || typeof actor !== 'object') return null;
  if (actor.kind === 'local-owner') return 'local-owner';
  if (actor.kind === 'im' && typeof actor.accountId === 'string' && typeof actor.principalId === 'string') {
    return `im:${actor.accountId}:${actor.principalId}`;
  }
  return null;
}

/**
 * Whether an actor is currently authorized to settle this interaction. A
 * local-owner is always allowed (Native path); an IM actor must be one of the
 * recomputed targets, so a revoked principal loses access even if it still holds
 * an old card.
 */
export function authorizeSettle(draft, interaction, actor, now) {
  const key = actorKeyOf(actor);
  if (key === null) throw new DomainError('FORBIDDEN', 'settle actor is not authenticated');
  if (actor.kind === 'local-owner') return { actorKey: key, target: null };
  const target = interaction.targets.find(
    (t) => t.accountId === actor.accountId && t.principalId === actor.principalId,
  );
  if (!target) throw new DomainError('FORBIDDEN', 'actor is not a target of this interaction');
  const principal = draft.principals[actor.principalId];
  if (!observeAllowed(draft, principal, interaction.sessionId, now)) {
    throw new DomainError('FORBIDDEN', 'actor lost observe permission');
  }
  return { actorKey: key, target };
}

// ---------------------------------------------------------------------------
// creation
// ---------------------------------------------------------------------------

function normalizeChoices(choices) {
  if (!Array.isArray(choices)) throw bad('choices must be an array');
  const seen = new Set();
  return choices.map((choice, i) => {
    if (choice === null || typeof choice !== 'object' || Array.isArray(choice)) throw bad(`choices[${i}] must be an object`);
    const keys = Object.keys(choice);
    for (const key of keys) if (key !== 'id' && key !== 'label') throw bad(`choices[${i}].${key} is not allowed`);
    if (typeof choice.id !== 'string' || choice.id === '' || choice.id.length > LIMITS.MAX_ID_LENGTH) throw bad(`choices[${i}].id is invalid`);
    if (typeof choice.label !== 'string' || codepointLength(choice.label) < 1 || codepointLength(choice.label) > LIMITS.MAX_NAME_CODEPOINTS) {
      throw bad(`choices[${i}].label is invalid`);
    }
    if (seen.has(choice.id)) throw bad(`choices[${i}].id is duplicated`);
    seen.add(choice.id);
    return { id: choice.id, label: choice.label };
  });
}

/**
 * Open a pending interaction from a Host request. Targets are computed here, not
 * supplied by the caller: an unauthenticated request must never name its own
 * recipients.
 */
export function openInteraction(draft, input, ctx = {}) {
  const type = input?.type;
  if (!INTERACTION_TYPES.includes(type)) throw bad(`type must be one of ${INTERACTION_TYPES.join('|')}`);
  if (typeof input?.sessionId !== 'string' || input.sessionId === '') throw bad('sessionId is required');
  if (typeof input?.hostRef !== 'string' || input.hostRef === '') throw bad('hostRef is required');
  if (input.turnId !== null && input.turnId !== undefined && typeof input.turnId !== 'string') throw bad('turnId must be string|null');
  if (typeof input?.prompt !== 'string' || codepointLength(input.prompt) < 1 || codepointLength(input.prompt) > LIMITS.MAX_MESSAGE_CODEPOINTS) {
    throw bad('prompt is invalid');
  }
  const now = nowOf(ctx);
  const expiresAt = Number.isInteger(input?.expiresAt) && input.expiresAt > now
    ? input.expiresAt
    : now + LIMITS.INTERACTION_TTL_MS;

  const pending = Object.values(draft.interactions).filter((i) => i.state === 'pending' || i.state === 'claimed').length;
  if (pending >= LIMITS.MAX_PENDING_INTERACTIONS) {
    throw new DomainError('CAPACITY', `pending interactions exceed ${LIMITS.MAX_PENDING_INTERACTIONS}`);
  }

  const interaction = {
    id: input?.id ?? newIdOf(ctx),
    revision: 0,
    type,
    sessionId: input.sessionId,
    turnId: input.turnId ?? null,
    hostRef: input.hostRef,
    prompt: input.prompt,
    choices: normalizeChoices(input?.choices ?? []),
    multiple: input?.multiple === true,
    allowText: input?.allowText === true,
    targets: computeTargets(draft, { sessionId: input.sessionId, now }),
    state: 'pending',
    recovery: 'live',
    expiresAt,
    claim: null,
    result: null,
    createdAt: now,
    updatedAt: now,
  };
  draft.interactions[interaction.id] = interaction;
  pruneInteractions(draft, { now });
  appendActivity(draft, { kind: 'interaction', sessionId: interaction.sessionId, status: 'opened' }, { now });
  return interaction;
}

// ---------------------------------------------------------------------------
// target refresh (revocation)
// ---------------------------------------------------------------------------

function targetKey(t) {
  return `${t.accountId}\u0000${t.principalId}`;
}

/**
 * Recompute targets for a live interaction after a policy change. Still-authorized
 * principals keep their target (their refs are re-signed by the caller); removed
 * principals lose theirs and their tokens are revoked. A Native-only interaction
 * (no IM targets) is never cancelled just because one target is gone.
 */
export function refreshInteractionTargets(draft, interactionId, ctx = {}) {
  const interaction = draft.interactions[interactionId];
  if (!interaction) throw notFound('interaction not found');
  if (TERMINAL.has(interaction.state)) return { added: [], removed: [] };
  const now = nowOf(ctx);
  const current = interaction.targets;
  const next = computeTargets(draft, { sessionId: interaction.sessionId, now });
  const currentKeys = new Set(current.map(targetKey));
  const nextKeys = new Set(next.map(targetKey));
  const removed = current.filter((t) => !nextKeys.has(targetKey(t)));
  const added = next.filter((t) => !currentKeys.has(targetKey(t)));
  interaction.targets = next;
  interaction.revision += 1;
  interaction.updatedAt = now;
  for (const target of removed) {
    for (const ref of activeReplyRefsForInteraction(draft, interaction.id)) {
      if (ref.principalId === target.principalId) ref.state = 'revoked';
    }
  }
  return { added, removed };
}

// ---------------------------------------------------------------------------
// claim / settle
// ---------------------------------------------------------------------------

function normalizeResult(interaction, input) {
  const decision = input?.decision;
  if (!INTERACTION_DECISIONS.includes(decision)) throw bad(`decision must be one of ${INTERACTION_DECISIONS.join('|')}`);
  const errors = [];
  if (interaction.type === 'question') {
    if (decision === 'approve') errors.push('question interactions accept reject|answer only');
  } else if (decision === 'answer') {
    errors.push(`${interaction.type} interactions accept approve|reject only`);
  }
  const choiceIds = input?.choiceIds ?? null;
  if (choiceIds !== null) {
    if (!Array.isArray(choiceIds)) errors.push('choiceIds must be an array');
    else {
      const valid = new Set(interaction.choices.map((c) => c.id));
      if (choiceIds.length > interaction.choices.length) errors.push('choiceIds has more entries than choices');
      for (const id of choiceIds) {
        if (typeof id !== 'string' || !valid.has(id)) errors.push(`choiceIds contains unknown choice ${String(id)}`);
      }
      if (new Set(choiceIds).size !== choiceIds.length) errors.push('choiceIds contains duplicates');
      if (interaction.multiple === false && choiceIds.length > 1) errors.push('multiple=false allows at most one choice');
    }
  }
  const text = input?.text ?? null;
  if (text !== null) {
    if (typeof text !== 'string') errors.push('text must be a string');
    else if (codepointLength(text) > LIMITS.MAX_ANSWER_CODEPOINTS) errors.push(`text exceeds ${LIMITS.MAX_ANSWER_CODEPOINTS} codepoints`);
    if (interaction.allowText !== true) errors.push('text is not allowed for this interaction');
  }
  // An approval/action must carry a decision; a question answer must carry a choice or text.
  if (decision === 'answer') {
    const hasChoice = Array.isArray(choiceIds) && choiceIds.length > 0;
    const hasText = typeof text === 'string' && codepointLength(text) > 0;
    if (!hasChoice && !hasText) errors.push('answer requires choiceIds or text');
  }
  if (errors.length) throw bad('invalid interaction result', errors);
  return {
    decision,
    choiceIds: choiceIds === null ? null : [...choiceIds],
    text,
    code: null,
  };
}

/**
 * Atomically claim an interaction inside a store mutator. Returns the claim plus
 * a durable `hostSettle` effect that the caller must settle next.
 * @returns {{interaction:object, effectId:string, requestKey:string}}
 */
export function claimInteraction(draft, input, ctx = {}) {
  const interaction = draft.interactions[input?.id];
  if (!interaction) throw notFound('interaction not found');
  if (interaction.state === 'resolved' || interaction.state === 'rejected') {
    throw new DomainError('ALREADY_HANDLED', 'interaction is already settled');
  }
  if (interaction.state === 'cancelled' || interaction.state === 'expired') {
    throw new DomainError('EXPIRED', `interaction is ${interaction.state}`);
  }
  if (interaction.state === 'uncertain') {
    throw new DomainError('UNCERTAIN', 'interaction outcome could not be confirmed');
  }
  if (input.expectedRevision !== interaction.revision) {
    throw conflict('interaction revision changed', { currentRevision: interaction.revision });
  }
  const now = nowOf(ctx);
  if (now >= interaction.expiresAt) {
    throw new DomainError('EXPIRED', 'interaction expired');
  }
  if (interaction.state === 'claimed') {
    // A live claim is already being settled; never run two Host settlements.
    if (interaction.recovery === 'live') throw conflict('interaction is already being settled', { currentRevision: interaction.revision });
    throw new DomainError('UNCERTAIN', 'interaction outcome could not be confirmed');
  }
  const auth = authorizeSettle(draft, interaction, input?.actor, now);
  const result = normalizeResult(interaction, input);

  const requestId = requireRequestId(typeof input?.requestId === 'string' ? input.requestId : randomUUID());
  const requestKey = JSON.stringify(['hostSettle', interaction.id, requestId]);
  const effect = createEffect(draft, {
    requestKey,
    accountId: auth.target?.accountId ?? null,
    destinationId: null,
    kind: 'hostSettle',
  }, { now, newId: ctx.newId });
  applyEffectResult(draft, effect.id, { status: 'started', now });

  interaction.state = 'claimed';
  interaction.recovery = 'live';
  interaction.claim = { effectId: effect.id, actorKey: auth.actorKey, at: now };
  interaction.result = result;
  interaction.revision += 1;
  interaction.updatedAt = now;
  appendActivity(draft, { kind: 'interaction', sessionId: interaction.sessionId, status: 'claimed' }, { now });
  return { interaction, effectId: effect.id, requestKey };
}

/**
 * Record the terminal state of a claimed interaction after the Host answered.
 * Does not touch the Host; the caller owns that call.
 */
export function resolveClaim(draft, id, { status, now = Date.now() } = {}) {
  const interaction = draft.interactions[id];
  if (!interaction) throw notFound('interaction not found');
  if (TERMINAL.has(interaction.state)) return interaction;
  if (status === 'already_handled') {
    interaction.state = 'uncertain';
    interaction.recovery = 'unconfirmed';
    interaction.result = { ...(interaction.result ?? {}), code: 'ALREADY_HANDLED' };
  } else {
    interaction.state = interaction.result?.decision === 'reject' ? 'rejected' : 'resolved';
    interaction.recovery = 'live';
  }
  interaction.revision += 1;
  interaction.updatedAt = now;
  revokeReplyRefsForInteraction(draft, interaction.id);
  appendActivity(draft, { kind: 'interaction', sessionId: interaction.sessionId, status: interaction.state }, { now });
  return interaction;
}

/** Roll a definitively-failed claim back to pending so the user can retry. */
export function releaseClaim(draft, id, { errorCode, now = Date.now() } = {}) {
  const interaction = draft.interactions[id];
  if (!interaction) throw notFound('interaction not found');
  if (interaction.state !== 'claimed') return interaction;
  interaction.state = 'pending';
  interaction.recovery = 'live';
  interaction.claim = null;
  interaction.result = null;
  interaction.revision += 1;
  interaction.updatedAt = now;
  return interaction;
}

/** Mark a claimed interaction as unconfirmed (the Host may or may not have acted). */
export function markClaimUnconfirmed(draft, id, { errorCode, now = Date.now() } = {}) {
  const interaction = draft.interactions[id];
  if (!interaction) throw notFound('interaction not found');
  if (interaction.state !== 'claimed') return interaction;
  interaction.recovery = 'unconfirmed';
  interaction.revision += 1;
  interaction.updatedAt = now;
  interaction.result = { ...(interaction.result ?? {}), code: errorCode ?? 'UNCERTAIN' };
  return interaction;
}

/**
 * Full settlement flow. Requires `ctx.host` (HostPort) and `ctx.signal`.
 * @param {import('../storage/store.mjs').Store} store
 */
export async function settleInteraction(store, input, ctx = {}) {
  const host = ctx.host;
  if (!host || typeof host.settleInteraction !== 'function') {
    throw new DomainError('UNSUPPORTED', 'no HostPort is available to settle interactions');
  }
  const signal = ctx.signal ?? new AbortController().signal;
  const now = nowOf(ctx);
  const requestId = requireRequestId(typeof input?.requestId === 'string' ? input.requestId : randomUUID());

  const claim = await commit(store, ctx.expectedGlobalRevision ?? null, (draft) => {
    const { interaction, effectId, requestKey } = claimInteraction(draft, { ...input, requestId }, { now, newId: ctx.newId });
    return {
      id: interaction.id,
      hostRef: interaction.hostRef,
      decision: interaction.result.decision,
      choiceIds: interaction.result.choiceIds,
      text: interaction.result.text,
      effectId,
      requestKey,
      revision: interaction.revision,
    };
  });

  let hostResult;
  try {
    hostResult = await host.settleInteraction({
      hostRef: claim.hostRef,
      decision: claim.decision,
      ...(claim.choiceIds !== null ? { choiceIds: claim.choiceIds } : {}),
      ...(claim.text !== null ? { text: claim.text } : {}),
      requestId,
      signal,
    });
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'INTERNAL';
    await commit(store, null, (draft) => {
      const effectStatus = code === 'ALREADY_HANDLED' ? 'uncertain'
        : code === 'CANCELLED' ? 'cancelled'
          : DEFINITIVE_FAILURES.has(code) ? 'failed' : 'uncertain';
      applyEffectResult(draft, claim.effectId, { status: effectStatus, errorCode: code, now: nowOf(ctx) });
      if (code === 'ALREADY_HANDLED') {
        resolveClaim(draft, claim.id, { status: 'already_handled', now: nowOf(ctx) });
      } else if (DEFINITIVE_FAILURES.has(code)) {
        releaseClaim(draft, claim.id, { errorCode: code, now: nowOf(ctx) });
      } else {
        markClaimUnconfirmed(draft, claim.id, { errorCode: code, now: nowOf(ctx) });
      }
    });
    if (error instanceof DomainError) throw error;
    throw new DomainError('UNCERTAIN', `Host settlement failed: ${error?.message ?? 'unknown error'}`, { code });
  }

  const status = hostResult?.status === 'already_handled' ? 'already_handled' : 'resolved';
  const outcome = await commit(store, null, (draft) => {
    applyEffectResult(draft, claim.effectId, {
      status: status === 'already_handled' ? 'uncertain' : 'confirmed',
      errorCode: status === 'already_handled' ? 'ALREADY_HANDLED' : null,
      now: nowOf(ctx),
    });
    const interaction = resolveClaim(draft, claim.id, { status, now: nowOf(ctx) });
    return { state: interaction.state, result: interaction.result, alreadyHandled: status === 'already_handled' };
  });
  if (outcome.alreadyHandled) {
    throw new DomainError('ALREADY_HANDLED', 'the Host already handled this interaction');
  }
  return { state: outcome.state, result: outcome.result };
}

// ---------------------------------------------------------------------------
// views and queries
// ---------------------------------------------------------------------------

/**
 * Redacted view for managers: never exposes claim.actorKey, targets or hostRef.
 * Source names are the account labels the interaction was offered to.
 */
export function interactionView(draft, interaction, { now = Date.now() } = {}) {
  const sources = [];
  const seen = new Set();
  for (const target of interaction.targets ?? []) {
    if (seen.has(target.accountId)) continue;
    seen.add(target.accountId);
    const account = draft.accounts[target.accountId];
    sources.push({ accountId: target.accountId, label: account?.label ?? null });
  }
  const overdue = now >= interaction.expiresAt;
  const canSettle = interaction.state === 'pending' && !overdue;
  let disabledReason = null;
  if (interaction.state === 'pending') disabledReason = overdue ? 'expired' : null;
  else if (interaction.state === 'claimed' && interaction.recovery !== 'live') disabledReason = 'unconfirmed';
  else if (interaction.state === 'claimed') disabledReason = 'settling';
  else disabledReason = 'already-handled';
  return {
    id: interaction.id,
    revision: interaction.revision,
    type: interaction.type,
    sessionId: interaction.sessionId,
    turnId: interaction.turnId,
    prompt: interaction.prompt,
    choices: structuredClone(interaction.choices),
    multiple: interaction.multiple,
    allowText: interaction.allowText,
    state: interaction.state,
    recovery: interaction.recovery,
    expiresAt: interaction.expiresAt,
    result: interaction.result === null ? null : structuredClone(interaction.result),
    sources,
    canSettle,
    disabledReason,
    createdAt: interaction.createdAt,
    updatedAt: interaction.updatedAt,
  };
}

export function listInteractions(store, { state = 'pending', type = null, search = null, limit = 50, cursor = null } = {}) {
  const draft = store.snapshot();
  if (state !== null && !INTERACTION_STATES.includes(state)) throw bad(`state must be one of ${INTERACTION_STATES.join('|')}`);
  if (type !== null && !INTERACTION_TYPES.includes(type)) throw bad(`type must be one of ${INTERACTION_TYPES.join('|')}`);
  const needle = typeof search === 'string' && search !== '' ? search.toLowerCase() : null;
  const rows = Object.values(draft.interactions)
    .filter((i) => state === null || i.state === state)
    .filter((i) => type === null || i.type === type)
    .filter((i) => needle === null || i.prompt.toLowerCase().includes(needle))
    .sort((a, b) => a.expiresAt - b.expiresAt || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const filter = { state, type, search: needle };
  const page = paginate(rows, filterHash(filter), { limit, cursor });
  return { ...page, items: page.items.map((i) => interactionView(draft, i)) };
}

export function getInteraction(store, { id }) {
  const draft = store.snapshot();
  requireId(id);
  const interaction = draft.interactions[id];
  if (!interaction) throw notFound('interaction not found');
  return interactionView(draft, interaction);
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

/** Cancel unclaimed interactions for a stopped turn (arbiter stop wins). */
export function cancelInteractionsForTurn(draft, { sessionId, turnId = null, now = Date.now() } = {}) {
  let count = 0;
  for (const interaction of Object.values(draft.interactions)) {
    if (interaction.state !== 'pending') continue;
    if (interaction.sessionId !== sessionId) continue;
    if (turnId !== null && interaction.turnId !== null && interaction.turnId !== turnId) continue;
    interaction.state = 'cancelled';
    interaction.revision += 1;
    interaction.updatedAt = now;
    revokeReplyRefsForInteraction(draft, interaction.id);
    count += 1;
  }
  return count;
}

/** Expire overdue interactions; a claimed one cannot be proven and goes uncertain. */
export function expireInteractions(draft, { now = Date.now() } = {}) {
  let expired = 0;
  let uncertainCount = 0;
  for (const interaction of Object.values(draft.interactions)) {
    if (interaction.expiresAt > now) continue;
    if (interaction.state === 'pending') {
      interaction.state = 'expired';
      interaction.revision += 1;
      interaction.updatedAt = now;
      revokeReplyRefsForInteraction(draft, interaction.id);
      expired += 1;
    } else if (interaction.state === 'claimed') {
      interaction.state = 'uncertain';
      interaction.recovery = 'unconfirmed';
      interaction.revision += 1;
      interaction.updatedAt = now;
      uncertainCount += 1;
    }
  }
  return { expired, uncertain: uncertainCount };
}

/**
 * Restart reconciliation. A pending interaction is queried against the Host:
 * only an explicit `pending` keeps it executable, while an unknown/unqueryable
 * reference becomes unconfirmed (never silently retried). A claimed interaction
 * whose settlement was in flight cannot be proven and becomes uncertain.
 */
export async function reconcileInteractions(draft, { host, now = Date.now() } = {}) {
  const result = { pending: 0, resolved: 0, cancelled: 0, uncertain: 0, unconfirmed: 0 };
  for (const interaction of Object.values(draft.interactions)) {
    if (interaction.state === 'claimed') {
      interaction.state = 'uncertain';
      interaction.recovery = 'unconfirmed';
      interaction.revision += 1;
      interaction.updatedAt = now;
      result.uncertain += 1;
      continue;
    }
    if (interaction.state !== 'pending') continue;
    let status = 'unknown';
    if (host && typeof host.queryInteraction === 'function') {
      try {
        const out = await host.queryInteraction(interaction.hostRef);
        status = out?.status ?? 'unknown';
      } catch {
        status = 'unknown';
      }
    }
    if (status === 'pending') {
      interaction.recovery = 'live';
      result.pending += 1;
    } else if (status === 'resolved') {
      interaction.state = 'resolved';
      interaction.result = { decision: 'unknown', choiceIds: null, text: null, code: 'RECOVERED' };
      interaction.revision += 1;
      interaction.updatedAt = now;
      result.resolved += 1;
    } else if (status === 'cancelled') {
      interaction.state = 'cancelled';
      interaction.revision += 1;
      interaction.updatedAt = now;
      result.cancelled += 1;
    } else {
      interaction.recovery = 'unconfirmed';
      result.unconfirmed += 1;
    }
  }
  return result;
}

/** Delete terminal interactions past the retention window / above the cap. */
export function pruneInteractions(draft, { now = Date.now() } = {}) {
  const cutoff = now - LIMITS.TERMINAL_INTERACTION_RETENTION_MS;
  for (const [id, interaction] of Object.entries(draft.interactions)) {
    if (TERMINAL.has(interaction.state) && interaction.updatedAt < cutoff) delete draft.interactions[id];
  }
  const terminalIds = Object.keys(draft.interactions)
    .filter((id) => TERMINAL.has(draft.interactions[id].state));
  if (terminalIds.length <= LIMITS.MAX_TERMINAL_INTERACTIONS) return;
  terminalIds.sort((a, b) => draft.interactions[a].updatedAt - draft.interactions[b].updatedAt || (a < b ? -1 : 1));
  for (let i = 0; i < terminalIds.length - LIMITS.MAX_TERMINAL_INTERACTIONS; i++) delete draft.interactions[terminalIds[i]];
}

export function isTerminalInteraction(interaction) {
  return TERMINAL.has(interaction?.state);
}

export { TERMINAL as TERMINAL_INTERACTION_STATES };