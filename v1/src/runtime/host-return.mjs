// Host event return path (R11; 18-WIRING.md 链4/链5, 20-HOST-PROTOCOL-MAP.md
// "对话回程", W02).
//
// The runtime already buffers and dispatches typed HostEvents; this module turns
// the ones with a business meaning into durable store changes plus one control
// reply:
//   turn.output       cache the latest complete assistant answer for a turn
//   turn.completed     send the cached answer (or an explicit "no body" notice)
//   turn.failed        same, with a redacted failure code
//   interaction.opened open an Interaction, issue scoped reply refs and deliver
//                      the control card to each still-authorized target
//   session.closed     cancel the session's pending interactions/correlations
//
// The answer cache is process-only: it is not a log, and a restart loses it, so a
// turn that ends after a restart delivers the explicit "no body" notice instead of
// pretending the text was recovered.
import { randomUUID } from 'node:crypto';
import { LIMITS, codepointLength } from '../domain/limits.mjs';
import { commit } from '../storage/store.mjs';
import { appendActivity } from '../services/activity.mjs';
import { openInteraction, cancelInteractionsForTurn } from '../services/interactions.mjs';
import { issueReplyRef } from '../services/reply-refs.mjs';
import {
  correlationForTurn, liveCorrelationsForSession, completeCorrelation, cancelCorrelation, markCorrelationUncertain,
} from '../services/correlations.mjs';

/** Bounded live-answer cache; a turn that never ends must not grow memory. */
const MAX_CACHED_ANSWERS = 64;

const NO_BODY_COMPLETED = '任务已结束，请在DSH查看结果';

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function truncateCodepoints(text, max) {
  if (codepointLength(text) <= max) return text;
  return [...text].slice(0, max).join('');
}

function answerKey(sessionId, turnId) {
  return `${sessionId}\u0000${turnId}`;
}

function fallbackText(event) {
  if (event.type === 'turn.failed') {
    const code = typeof event.code === 'string' && event.code !== '' ? event.code : 'FAILED';
    return `任务失败（${code}），请在DSH查看结果`;
  }
  return NO_BODY_COMPLETED;
}

function actionLabel(decision) {
  return decision === 'approve' ? '批准' : '拒绝';
}

/**
 * @param {object} options
 * @param {import('../storage/store.mjs').Store} options.store
 * @param {(input:object)=>Promise<object>} options.controlReply manager control-reply port
 * @param {()=>number} [options.now]
 * @param {()=>string} [options.newId]
 * @param {object|null} [options.logger]
 */
export function createHostReturn({ store, controlReply, now = Date.now, newId = randomUUID, logger = null } = {}) {
  const answers = new Map();

  function warn(message) {
    try { logger?.warn?.(`[dsh-notifier/host-return] ${message}`); } catch { /* logging is never fatal */ }
  }

  function cacheAnswer(sessionId, turnId, text) {
    const key = answerKey(sessionId, turnId);
    answers.delete(key);
    answers.set(key, text);
    while (answers.size > MAX_CACHED_ANSWERS) {
      const oldest = answers.keys().next().value;
      answers.delete(oldest);
    }
  }

  function cachedAnswerFor(sessionId, turnId) {
    return answers.get(answerKey(sessionId, turnId)) ?? null;
  }

  function onTurnOutput(event) {
    if (typeof event.text !== 'string' || event.text.trim() === '') return;
    cacheAnswer(event.sessionId, event.turnId, truncateCodepoints(event.text, LIMITS.MAX_MESSAGE_CODEPOINTS));
  }

  async function onTurnEnd(event) {
    const cached = cachedAnswerFor(event.sessionId, event.turnId);
    answers.delete(answerKey(event.sessionId, event.turnId));
    const at = now();
    const correlation = correlationForTurn(store.snapshot(), { sessionId: event.sessionId, turnId: event.turnId });
    // A turn v1 never routed (e.g. a Native turn) has no return path to serve.
    if (!correlation) return;
    const principal = store.snapshot().principals[correlation.principalId];
    if (!principal || principal.enabled !== true) {
      await commit(store, null, (draft) => {
        cancelCorrelation(draft, correlation.id, { now: at });
        return null;
      });
      return;
    }

    const body = cached !== null && cached.trim() !== '' ? cached : fallbackText(event);
    let delivered = false;
    try {
      await controlReply({
        accountId: correlation.accountId,
        replyContextId: correlation.replyContextId,
        content: { text: body, attachments: [], actions: [] },
        requestId: newId(),
      });
      delivered = true;
    } catch (error) {
      warn(`turn reply failed: ${error?.code ?? error?.message ?? 'error'}`);
    }
    await commit(store, null, (draft) => {
      if (delivered) completeCorrelation(draft, correlation.id, { now: at });
      else markCorrelationUncertain(draft, correlation.id, { now: at });
      appendActivity(draft, {
        kind: 'conversation',
        accountId: correlation.accountId,
        sessionId: correlation.sessionId,
        status: delivered ? (event.type === 'turn.failed' ? 'turn-failed' : 'turn-completed') : 'turn-reply-failed',
      }, { now: at });
      return null;
    });
  }

  async function onInteractionOpened(event) {
    const request = event.request;
    if (!isRecord(request)) {
      warn('interaction.opened without a request payload');
      return;
    }
    const at = now();
    let opened;
    try {
      opened = await commit(store, null, (draft) => {
        const interaction = openInteraction(draft, {
          type: request.type,
          sessionId: request.sessionId,
          turnId: request.turnId ?? null,
          hostRef: request.hostRef,
          prompt: request.prompt,
          choices: request.choices ?? [],
          multiple: request.multiple === true,
          allowText: request.allowText === true,
          expiresAt: request.expiresAt,
        }, { now: at, newId });
        // Approvals/actions answer by button; a question answers with free text,
        // so its ref is surfaced as a /answer REF hint instead of a button.
        const decisions = interaction.type === 'question' ? ['answer'] : ['approve', 'reject'];
        const deliveries = interaction.targets.map((target) => {
          const actions = decisions.map((decision) => {
            const { ref, token } = issueReplyRef(draft, {
              accountId: target.accountId,
              principalId: target.principalId,
              replyContextId: target.replyContextId,
              interactionId: interaction.id,
              action: decision,
              expiresAt: interaction.expiresAt,
            }, { now: at, newId });
            return { decision, refId: ref.id, token };
          });
          return { accountId: target.accountId, replyContextId: target.replyContextId, actions };
        });
        return { interaction, deliveries };
      });
    } catch (error) {
      warn(`interaction.opened failed: ${error?.code ?? error?.message ?? 'error'}`);
      return;
    }

    for (const delivery of opened.deliveries) {
      try {
        await controlReply({
          accountId: delivery.accountId,
          replyContextId: delivery.replyContextId,
          content: cardContent(opened.interaction, delivery.actions),
          requestId: newId(),
        });
      } catch (error) {
        warn(`interaction card failed: ${error?.code ?? error?.message ?? 'error'}`);
      }
    }
  }

  async function onSessionClosed(event) {
    const at = now();
    await commit(store, null, (draft) => {
      cancelInteractionsForTurn(draft, { sessionId: event.sessionId, turnId: null, now: at });
      for (const correlation of liveCorrelationsForSession(draft, event.sessionId)) {
        cancelCorrelation(draft, correlation.id, { now: at });
      }
      return null;
    }).catch((error) => warn(`session.closed failed: ${error?.code ?? error?.message ?? 'error'}`));
  }

  async function handle(event) {
    switch (event?.type) {
      case 'turn.output':
        onTurnOutput(event);
        return;
      case 'turn.completed':
      case 'turn.failed':
        await onTurnEnd(event);
        return;
      case 'interaction.opened':
        await onInteractionOpened(event);
        return;
      case 'session.closed':
        await onSessionClosed(event);
        return;
      default:
        return;
    }
  }

  function dispose() {
    answers.clear();
  }

  return { handle, dispose, cachedAnswerFor };
}

/** Build the control-card content for one authorized target. */
function cardContent(interaction, actions) {
  if (interaction.type === 'question') {
    const answerRef = actions.find((a) => a.decision === 'answer');
    const choices = interaction.choices.map((c) => `${c.id}=${c.label}`).join(' ');
    const hint = choices === '' ? '"text":"..."' : '"choiceIds":["<选项id>"]';
    const text = truncateCodepoints(
      `${interaction.prompt}\n${choices === '' ? '' : `选项: ${choices}\n`}回复 /answer ${answerRef?.refId ?? ''} {${hint}}`,
      LIMITS.MAX_MESSAGE_CODEPOINTS,
    );
    return { text, attachments: [], actions: [] };
  }
  return {
    text: interaction.prompt,
    attachments: [],
    actions: actions.map((a) => ({ label: actionLabel(a.decision), token: a.token })),
  };
}
