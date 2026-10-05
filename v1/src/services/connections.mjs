// Connection creation (03-SERVICES-RPC.md "已合并的连接与运行时接口").
// connections.create creates an Account and its first Destination in ONE
// transaction: any failure leaves no orphan account or destination.
import { validationError } from '../domain/errors.mjs';
import { commit } from '../storage/store.mjs';
import { appendActivity } from './activity.mjs';
import { insertAccount, accountView, requireLabel } from './accounts.mjs';
import { insertDestination, destinationView } from './destinations.mjs';

/**
 * @param {object} input {channelId,label,config,secretChanges,notificationEnabled,
 *   controlEnabled,destination:{label,kind,target,secretChanges},makeDefault}
 * @returns {Promise<{account:object,destination:object}>}
 */
export function createConnection(store, input, ctx = {}) {
  const destinationInput = input?.destination;
  if (destinationInput === null || typeof destinationInput !== 'object' || Array.isArray(destinationInput)) {
    throw validationError('destination is required');
  }
  requireLabel(destinationInput.label, 'destination.label');
  return commit(store, ctx.expectedGlobalRevision ?? null, (draft) => {
    const account = insertAccount(draft, {
      channelId: input.channelId,
      label: input.label,
      config: input.config,
      secretChanges: input.secretChanges,
      notificationEnabled: input.notificationEnabled === undefined ? true : input.notificationEnabled,
      controlEnabled: input.controlEnabled === true,
      enabled: input.enabled,
    }, ctx);
    const destination = insertDestination(draft, {
      accountId: account.id,
      label: destinationInput.label,
      kind: destinationInput.kind,
      target: destinationInput.target,
      secretChanges: destinationInput.secretChanges,
    }, ctx);
    // makeDefault appends (never replaces) and advances settings.revision once.
    if (input.makeDefault === true) {
      draft.settings.defaultDestinationIds.push(destination.id);
      draft.settings.revision += 1;
    }
    appendActivity(draft, { kind: 'connection', accountId: account.id, status: 'created' }, { now: ctx?.now ?? Date.now() });
    return { account: accountView(account, draft), destination: destinationView(destination) };
  });
}