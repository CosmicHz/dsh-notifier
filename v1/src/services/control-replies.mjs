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
import { createEffect, applyEffectResult } from './effects.mjs';

const MAX_CONTROL_ACTIONS = 16;

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
  const actions = content.actions ?? [];
  if (!Array.isArray(actions) || actions.length > MAX_CONTROL_ACTIONS) {
    throw validationError(`content.actions must be an array of at most ${MAX_CONTROL_ACTIONS}`);
  }
  return { text, attachments: [...attachments], actions: [...actions] };
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
  const requestKey = JSON.stringify(['controlReply', accountId, replyContextId, requestId]);
  const attempted = await commit(store, null, (draft) => {
    const effect = createEffect(draft, { requestKey, accountId, destinationId: null, kind: 'controlReply' }, { now });
    applyEffectResult(draft, effect.id, { status: 'started', now });
    return effect.id;
  });

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
    await commit(store, null, (draft) => {
      applyEffectResult(draft, attempted, {
        status: error?.uncertain === true ? 'uncertain' : error?.code === 'CANCELLED' ? 'cancelled' : 'failed',
        errorCode: typeof error?.code === 'string' ? error.code : 'INTERNAL',
        now,
      });
      const receipt = controlReceipt({ account, requestId, status: error?.uncertain ? 'uncertain' : 'failed', delivery: 'none', effectIds: [attempted], providerMessageIds: [], errorCode: error?.code ?? 'INTERNAL', now });
      draft.receipts[receipt.id] = receipt;
      appendActivity(draft, { kind: 'control', accountId, status: receipt.status, code: receipt.errorCode }, { now });
    });
    throw error;
  }

  const status = result?.status === 'confirmed' ? 'confirmed' : 'accepted';
  const providerMessageId = typeof result?.providerMessageId === 'string' && result.providerMessageId !== '' ? result.providerMessageId : null;
  return commit(store, null, (draft) => {
    applyEffectResult(draft, attempted, { status, providerMessageId, now });
    const receipt = controlReceipt({
      account, requestId, status, delivery: 'complete', effectIds: [attempted],
      providerMessageIds: providerMessageId ? [providerMessageId] : [], errorCode: null, now,
    });
    draft.receipts[receipt.id] = receipt;
    appendActivity(draft, { kind: 'control', accountId, status, code: null }, { now });
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