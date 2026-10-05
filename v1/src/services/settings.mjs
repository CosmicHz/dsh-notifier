// Settings service (02-DATA.md; 03-SERVICES-RPC.md settings.*).
// settings.revision is a separate optimistic counter; a change advances it once.
import { conflict, validationError } from '../domain/errors.mjs';
import { LIMITS } from '../domain/limits.mjs';
import { commit } from '../storage/store.mjs';
import { appendActivity } from './activity.mjs';

const PATCHABLE = new Set(['defaultDestinationIds', 'quiet', 'activityRetentionDays']);

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}

export function getSettings(store) {
  return structuredClone(store.snapshot().settings);
}

export function updateSettings(store, input, ctx = {}) {
  return commit(store, ctx.expectedGlobalRevision ?? null, (draft) => {
    const settings = draft.settings;
    if (input?.expectedRevision !== settings.revision) {
      throw conflict('settings revision changed', { currentRevision: settings.revision });
    }
    const patch = input?.patch ?? {};
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw validationError('patch must be an object');
    }
    const errors = [];
    for (const key of Object.keys(patch)) if (!PATCHABLE.has(key)) errors.push(`patch.${key}: field is not writable`);
    if (errors.length) throw validationError('invalid settings patch', errors);

    const next = structuredClone(settings);
    if ('defaultDestinationIds' in patch) {
      if (!Array.isArray(patch.defaultDestinationIds)) errors.push('defaultDestinationIds must be an array');
      else {
        next.defaultDestinationIds = [...patch.defaultDestinationIds];
        for (const id of next.defaultDestinationIds) {
          if (typeof id !== 'string' || !draft.destinations[id]) errors.push(`defaultDestinationIds: unknown destination ${id}`);
        }
      }
    }
    if ('quiet' in patch) {
      if (typeof patch.quiet !== 'boolean') errors.push('quiet must be a boolean');
      else next.quiet = patch.quiet;
    }
    if ('activityRetentionDays' in patch) {
      const days = patch.activityRetentionDays;
      if (!Number.isInteger(days) || days < LIMITS.ACTIVITY_RETENTION_MIN_DAYS || days > LIMITS.ACTIVITY_RETENTION_MAX_DAYS) {
        errors.push(`activityRetentionDays must be ${LIMITS.ACTIVITY_RETENTION_MIN_DAYS}..${LIMITS.ACTIVITY_RETENTION_MAX_DAYS}`);
      } else next.activityRetentionDays = days;
    }
    if (errors.length) throw validationError('invalid settings patch', errors);

    next.revision = settings.revision + 1;
    draft.settings = next;
    appendActivity(draft, { kind: 'maintenance', status: 'settings-updated' }, { now: nowOf(ctx) });
    return structuredClone(next);
  });
}