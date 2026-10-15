// Account controls requested by the web dashboard (stage 2). The supervisor
// authenticates the browser and relays one request over IPC; the worker runs
// it here against its live AccountManager, because only the worker knows the
// live order, availability and current account.
//
// Settings (enabled, priority) are persisted first through `persist` (the
// caller wires atomicConfigUpdate + applyTuiAccountMutation, the TUI's own
// save path) and applied to the live manager only after the write succeeded,
// so a failed write changes nothing. The order rules are the TUI's
// (src/account-order.js). A switch is temporary and never persisted
// (AccountManager.switchTo).

import { autoRanking, moveRanking, rankingChanges } from './account-order.js';

export const ACCOUNT_CONTROL_ACTIONS = Object.freeze(['enable', 'disable', 'up', 'down', 'auto', 'switch']);

function result(statusCode, body) {
  return { statusCode, body };
}

function refused(statusCode, type, reason, message) {
  return result(statusCode, { error: { type, reason, message } });
}

/**
 * Find the target the way the status snapshot names it: by accountUuid when
 * the snapshot carried one (never falling back to a name, which could pick a
 * different account), else by a name that must be unique among accounts
 * without a UUID (API-key accounts).
 */
export function findControlAccount(accounts, { accountUuid, name } = {}) {
  if (typeof accountUuid === 'string' && accountUuid.length > 0) {
    return accounts.find(a => a.accountUuid === accountUuid) || null;
  }
  if (typeof name !== 'string' || name.length === 0) return null;
  const matches = accounts.filter(a => !a.accountUuid && a.name === name);
  return matches.length === 1 ? matches[0] : null;
}

/** Mirror a persisted field onto the in-memory config entry (UUID first, then name), like the TUI. */
function mirrorConfig(config, account, fields) {
  const accounts = Array.isArray(config?.accounts) ? config.accounts : [];
  const cfg = (account.accountUuid && accounts.find(c => c.accountUuid === account.accountUuid))
    || accounts.find(c => c.name === account.name);
  if (!cfg) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete cfg[key];
    else cfg[key] = value;
  }
}

/**
 * @param {object} deps
 * @param {import('./account-manager.js').AccountManager} deps.accountManager
 * @param {object} [deps.config]  the worker's in-memory config (kept in step)
 * @param {(mutation: object) => Promise<void>} deps.persist  TUI-style mutation writer
 * @param {{ action: string, accountUuid?: string|null, name?: string }} request
 * @returns {Promise<{ statusCode: number, body: object }>}
 */
export async function runAccountControl({ accountManager, config, persist, refreshUsage }, request) {
  const action = request?.action;
  // Fleet-wide: no target account. Runs the official usage poll once, now
  // (src/oauth-usage.js); the worker answers { targets, updated }.
  if (action === 'refresh-usage') {
    const outcome = refreshUsage ? await refreshUsage() : null;
    if (!outcome) {
      return refused(404, 'not_found_error', 'unsupported',
        'This proxy has no official usage endpoint to poll.');
    }
    return result(200, { ok: true, action, targets: outcome.targets, updated: outcome.updated });
  }
  if (!ACCOUNT_CONTROL_ACTIONS.includes(action)) {
    return refused(400, 'invalid_request_error', 'unknown-action', `Unknown account action "${action}".`);
  }
  const account = findControlAccount(accountManager.accounts, request);
  if (!account) {
    return refused(404, 'not_found_error', 'not-found', 'No such account in the running proxy.');
  }
  const ok = changed => result(200, { ok: true, action, changed, account: account.name });

  if (action === 'switch') {
    const outcome = accountManager.switchTo(account);
    if (!outcome.switched) {
      return refused(409, 'invalid_request_error', outcome.reason,
        'This account cannot take requests right now, so it cannot become the current account.');
    }
    if (outcome.changed) console.log(`[TeamClaude] Dashboard: switched to account "${account.name}"`);
    return ok(outcome.changed);
  }

  if (action === 'enable' || action === 'disable') {
    const enabled = action === 'enable';
    if ((account.enabled !== false) === enabled) return ok(false);
    // Same stored shape as the TUI: an enabled account carries no flag.
    const fields = { enabled: enabled ? undefined : false };
    await persist({ type: 'patch', account, fields });
    mirrorConfig(config, account, fields);
    accountManager.setEnabled(account, enabled);
    console.log(`[TeamClaude] Dashboard: ${enabled ? 'enabled' : 'disabled'} account "${account.name}"`);
    return ok(true);
  }

  const ranked = action === 'auto'
    ? autoRanking(accountManager.accounts, account)
    : moveRanking(accountManager.accounts, account, action === 'up' ? -1 : +1);
  const changes = ranked ? rankingChanges(accountManager.accounts, ranked) : [];
  if (changes.length === 0) return ok(false);
  // Write `null` (not a deleted key) to clear, as the TUI does.
  await persist({
    type: 'batchPatch',
    patches: changes.map(c => ({ account: c.account, fields: { priority: c.priority } })),
  });
  for (const c of changes) {
    mirrorConfig(config, c.account, { priority: c.priority });
    accountManager.setPriority(c.account, c.priority);
  }
  console.log(`[TeamClaude] Dashboard: reordered accounts (${action} "${account.name}")`);
  return ok(true);
}
