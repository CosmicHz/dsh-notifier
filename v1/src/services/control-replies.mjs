// Control replies (W01, 04-PROVIDERS.md, 18-WIRING.md 回程).
//
// A control reply is the return path to the chat that asked, NOT a notification:
// it ignores the notification route and quiet flag, but it does require the
// account to be enabled with controlEnabled and a usable reply context. Without
// a return path it fails with CONTEXT_EXPIRED instead of guessing a destination.
import { randomUUID } from 'node:crypto';
import { DomainError, notFound, unsupported, validationError } from '../domain/errors.mjs';
import { LIMITS, codepointLength } from '../domain/limits.mjs';
import { commit } from '../storage/store.mjs';
import { appendActivity } from './activity.mjs';
import { getProvider } from '../providers/registry.mjs';
import { assertReplyContextUsable } from './reply-contexts.mjs';
import { createEffect, applyEffectResult, beginRequest, completeRequest, aggregateEffectStatus } from './effects.mjs';

const MAX_CONTROL_ACTIONS = 16;
// Telegram (and the tightest platform we support) allows 64 UTF-8 bytes of
// callback data; the service rejects an over-long token instead of silently
// dropping the button somewhere down the provider chain (R07).
export const MAX_CALLBACK_DATA_BYTES = 64;

/**
 * Normalize card actions to the frozen `{label, token}` contract (spec/ports.d.ts
 * Content.actions). `token` is the opaque reply token; a label is display-only.
 */
export function normalizeControlActions(actions) {
  if (actions === null || actions === undefined) return [];
  if (!Array.isArray(actions)) throw validationError('content.actions must be an array');
  if (actions.length > MAX_CONTROL_ACTIONS) {
    throw validationError(`content.actions must be an array of at most ${MAX_CONTROL_ACTIONS}`);
  }
  return actions.map((action, i) => {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) {
      throw validationError(`content.actions[${i}] must be an object`);
    }
    for (const key of Object.keys(action)) {
      if (key !== 'label' && key !== 'token') throw validationError(`content.actions[${i}].${key} is not allowed`);
    }
    const label = action.label;
    const token = action.token;
    if (typeof label !== 'string' || codepointLength(label) < 1 || codepointLength(label) > LIMITS.MAX_NAME_CODEPOINTS) {
      throw validationError(`content.actions[${i}].label is invalid`);
    }
    if (typeof token !== 'string' || token === '') throw validationError(`content.actions[${i}].token is invalid`);
    if (Buffer.byteLength(token, 'utf8') > MAX_CALLBACK_DATA_BYTES) {
      throw validationError(`content.actions[${i}].token exceeds ${MAX_CALLBACK_DATA_BYTES} UTF-8 bytes`);
    }
    return { label, token };
  });
}

export function normalizeControlContent(content) {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    throw validationError('content must be an object');
  }
  const text = content.text ?? '';
  if (typeof text !== 'string') throw validationError('content.text must be a string');
  if (codepointLength(text) > LIMITS.MAX_MESSAGE_CODEPOINTS) {
    throw validationError(`content.text exceeds ${LIMITS.MAX_MESSAGE_CODEPOINTS} codepoints`);
  }
  const attachments = content.attachments ?? [];
  if (!Array.isArray(attachments)) throw validationError('content.attachments must be an array');
  return { text, attachments: [...attachments], actions: normalizeControlActions(content.actions) };
}

function classifyControlAccount(state, accountId) {
  const account = state.accounts?.[accountId];
  if (!account) return { error: notFound('account not found') };
  if (account.enabled !== true || account.controlEnabled !== true) {
    return { error: new DomainError('FORBIDDEN', 'account control is disabled') };
  }
  return { account };
}

/**
 * Send one control reply through the account's inbound channel.
 * @param {import('../storage/store.mjs').Store} store
 * @param {{accountId:string,replyContextId:string,content:object,requestId?:string,signal?:AbortSignal}} input
 */
export async function sendControlReply(store, input, ctx = {}) {
  const accountId = input?.accountId;
  const replyContextId = input?.replyContextId;
  const requestId = typeof input?.requestId === 'string' && input.requestId !== '' ? input.requestId : randomUUID();
  if (typeof accountId !== 'string' || accountId === '') throw validationError('accountId is required');
  if (typeof replyContextId !== 'string' || replyContextId === '') throw validationError('replyContextId is required');
  const content = normalizeControlContent(input?.content);

  const state = store.snapshot();
  const target = classifyControlAccount(state, accountId);
  if (target.error) throw target.error;
  const account = target.account;
  const replyContext = state.replyContexts?.[replyContextId];
  if (!replyContext) throw notFound('reply context not found');
  if (replyContext.accountId !== accountId) throw validationError('reply context belongs to another account');
  assertReplyContextUsable(replyContext, ctx.now ?? Date.now());

  const provider = ctx.provider ?? getProvider(account.channelId);
  if (provider.capabilities?.controlReply !== true || typeof provider.sendControlReply !== 'function') {
    throw unsupported(`channel ${account.channelId} has no control-reply capability`);
  }

  const now = Number.isInteger(ctx.now) ? ctx.now : Date.now();
  const actor = { kind: 'control', id: accountId };
  // R13: one logical control send is idempotent by requestId, and the decided
  // evidence is written before the external call.
  const prepared = await commit(store, null, (draft) => {
    const begun = beginRequest(draft, {
      actor,
      method: 'controlReply',
      requestId,
      payload: { accountId, replyContextId, content },
      kind: 'effect',
      now,
    });
    if (begun.replayed) return { replayed: true, status: begun.status, result: begun.result, key: begun.key };
    const effect = createEffect(draft, { requestKey: begun.key, accountId, destinationId: null, kind: 'controlReply' }, { now });
    applyEffectResult(draft, effect.id, { status: 'started', now });
    return { replayed: false, key: begun.key, effectId: effect.id };
  });
  if (prepared.replayed) {
    if (prepared.status === 'done' && prepared.result !== null && prepared.result !== undefined) return prepared.result;
    if (prepared.status === 'uncertain') throw new DomainError('UNCERTAIN', 'control reply outcome is uncertain; not resent');
    throw new DomainError('CONFLICT', 'control reply with this requestId is already in flight');
  }
  const requestKey = prepared.key;
  const attempted = prepared.effectId;

  let result;
  try {
    result = await provider.sendControlReply({
      account,
      replyContext,
      content,
      signal: ctx.signal ?? null,
      network: ctx.network ?? null,
    });
  } catch (error) {
    const segments = Array.isArray(error?.segments) ? error.segments : null;
    const receipt = segments && segments.length > 0
      ? await finalizeSegments(store, { key: requestKey, seedEffectId: attempted, account, requestId, segments, now, delivery: error?.delivery })
      : await commit(store, null, (draft) => {
        applyEffectResult(draft, attempted, {
          status: error?.uncertain === true ? 'uncertain' : error?.code === 'CANCELLED' ? 'cancelled' : 'failed',
          errorCode: typeof error?.code === 'string' ? error.code : 'INTERNAL',
          now,
        });
        const receipt = controlReceipt({ account, requestId, status: error?.uncertain ? 'uncertain' : 'failed', delivery: 'none', effectIds: [attempted], providerMessageIds: [], errorCode: error?.code ?? 'INTERNAL', now });
        draft.receipts[receipt.id] = receipt;
        completeRequest(draft, requestKey, receipt, { now });
        appendActivity(draft, { kind: 'control', accountId, status: receipt.status, code: receipt.errorCode }, { now });
        return receipt;
      });
    if (error instanceof Error && receipt) error.receipt = receipt;
    throw error;
  }

  // A platform 200 proves receipt, never delivery: keep `accepted` unless the
  // provider explicitly confirmed. Segment evidence is preserved per leaf (R13).
  const segments = Array.isArray(result?.segments) ? result.segments : null;
  if (segments && segments.length > 0) {
    return finalizeSegments(store, {
      key: requestKey, seedEffectId: attempted, account, requestId, segments,
      now, delivery: result?.delivery, fallbackStatus: result?.status === 'confirmed' ? 'confirmed' : 'accepted',
    });
  }
  const status = result?.status === 'confirmed' ? 'confirmed' : 'accepted';
  const providerMessageId = typeof result?.providerMessageId === 'string' && result.providerMessageId !== '' ? result.providerMessageId : null;
  return commit(store, null, (draft) => {
    applyEffectResult(draft, attempted, { status, providerMessageId, now });
    const receipt = controlReceipt({
      account, requestId, status, delivery: result?.delivery === 'partial' ? 'partial' : 'complete', effectIds: [attempted],
      providerMessageIds: providerMessageId ? [providerMessageId] : [], errorCode: null, now,
    });
    draft.receipts[receipt.id] = receipt;
    completeRequest(draft, requestKey, receipt, { now });
    appendActivity(draft, { kind: 'control', accountId, status, code: null }, { now });
    return receipt;
  });
}

/** Persist one effect per segment, preserving partial success across a failure. */
async function finalizeSegments(store, { key, seedEffectId, account, requestId, segments, now, delivery = null, fallbackStatus = null }) {
  return commit(store, null, (draft) => {
    const effectIds = [];
    const providerMessageIds = [];
    for (const seg of segments) {
      const effect = createEffect(draft, {
        requestKey: key,
        accountId: account.id,
        destinationId: null,
        kind: 'controlReply',
        segmentIndex: Number.isInteger(seg?.index) ? seg.index : effectIds.length,
        attempt: 1,
        ...(effectIds.length === 0 ? { id: seedEffectId } : {}),
      }, { now });
      const status = seg?.status === 'accepted' || seg?.status === 'confirmed' ? seg.status
        : seg?.status === 'uncertain' ? 'uncertain' : seg?.status === 'cancelled' ? 'cancelled' : 'failed';
      applyEffectResult(draft, effect.id, {
        status,
        providerMessageId: typeof seg?.providerMessageId === 'string' ? seg.providerMessageId : null,
        errorCode: seg?.errorCode ?? null,
        now,
      });
      if (typeof seg?.providerMessageId === 'string' && seg.providerMessageId !== '') providerMessageIds.push(seg.providerMessageId);
      effectIds.push(effect.id);
    }
    const agg = aggregateEffectStatus(effectIds.map((id) => draft.effects[id]));
    const status = agg.status === 'skipped' && fallbackStatus !== null ? fallbackStatus : agg.status;
    const receipt = controlReceipt({
      account, requestId, status,
      delivery: delivery ?? agg.delivery,
      effectIds,
      providerMessageIds,
      errorCode: agg.status === 'accepted' || agg.status === 'confirmed' ? null : (draft.effects[effectIds.at(-1)]?.errorCode ?? 'INTERNAL'),
      now,
    });
    draft.receipts[receipt.id] = receipt;
    completeRequest(draft, key, receipt, { now });
    appendActivity(draft, { kind: 'control', accountId: account.id, status: receipt.status, code: receipt.errorCode }, { now });
    return receipt;
  });
}

function controlReceipt({ account, requestId, status, delivery, effectIds, providerMessageIds, errorCode, now }) {
  return {
    id: randomUUID(),
    requestId,
    destinationId: null,
    accountId: account.id,
    kind: 'control',
    status,
    delivery,
    effectIds,
    providerMessageIds,
    destinationLabel: null,
    errorCode,
    createdAt: now,
  };
}