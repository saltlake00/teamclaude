// Official usage poll for OAuth (Claude subscription) accounts.
//
// The proxy normally learns an account's 5h/7d utilization only from the
// rate-limit headers of responses that pass through it. Usage spent anywhere
// else (the Claude app, another device) never flows through here, so the
// numbers silently freeze — measured 2026-10-15: dashboard 17%, official 43%.
// Account selection (switchThreshold, soonest-weekly-reset ordering) reads the
// same numbers, so the drift is not only cosmetic.
//
//   GET <upstream>/api/oauth/usage      with that account's OAuth access token
//   { five_hour: { utilization: 0-100, resets_at: ISO }, seven_day: { ... } }
//
// The endpoint spends no inference tokens. Like the warm-up probes, the poll is
// best-effort and side-effect-light:
//  - it never refreshes tokens (a background refresh failure could park an
//    account before any real request proved auth), so an account whose token is
//    about to expire is skipped until the client path renews it;
//  - a failure (401, 429, network, bad body) never touches account status;
//  - it only writes the four unified-window fields. `unifiedStatus` stays the
//    business of response headers: it says whether a request was admitted.
//  - one request per account at a time, and never while a client request is in
//    flight on that account.

import { isTokenExpiringSoon } from './oauth.js';

export const OAUTH_USAGE_PATH = '/api/oauth/usage';
export const DEFAULT_USAGE_POLL_INTERVAL_MS = 5 * 60 * 1000;
// The supervisor waits 10 s for a dashboard action answer; stay under it.
export const USAGE_POLL_TIMEOUT_MS = 8_000;

/**
 * How old an account's numbers must be for a timer tick to poll it.
 * `_usagePolledAt` is stamped when the answer arrives, up to the request
 * timeout after the tick, so comparing against the full interval made the next
 * tick fall short by that latency and skip: the real cadence was twice the
 * setting. The slack covers the latency (capped at half an interval, so a
 * header refresh in the second half of an interval still saves a poll).
 */
export function usageStaleAfterMs(intervalMs) {
  return intervalMs - Math.min(USAGE_POLL_TIMEOUT_MS + 1000, intervalMs / 2);
}

/** `config.usagePollIntervalMs`: default 5 min, 0 = off, junk = default. */
export function resolveUsagePollIntervalMs(config) {
  const value = config?.usagePollIntervalMs;
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_USAGE_POLL_INTERVAL_MS;
}

function parseWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const utilization = Number(window.utilization);
  const reset = Date.parse(window.resets_at);
  if (!Number.isFinite(utilization) || utilization < 0 || !Number.isFinite(reset)) return null;
  return { utilization: utilization / 100, reset };
}

/**
 * Normalize an /api/oauth/usage body. A window is kept only when BOTH its
 * utilization and reset time are usable: a utilization without a reset time
 * could never be swept when the window rolls over.
 */
export function parseOauthUsage(payload) {
  return {
    fiveHour: parseWindow(payload?.five_hour),
    sevenDay: parseWindow(payload?.seven_day),
  };
}

/** Fold a parsed answer into quota. Returns true when anything was written. */
export function applyOauthUsage(quota, parsed) {
  let applied = false;
  if (parsed.fiveHour) {
    quota.unified5h = parsed.fiveHour.utilization;
    quota.unified5hReset = parsed.fiveHour.reset;
    applied = true;
  }
  if (parsed.sevenDay) {
    quota.unified7d = parsed.sevenDay.utilization;
    quota.unified7dReset = parsed.sevenDay.reset;
    applied = true;
  }
  return applied;
}

/**
 * @param {object} deps
 * @param {{ accounts: object[] }} deps.accountManager
 * @param {string} deps.upstream           e.g. https://api.anthropic.com
 * @param {number} deps.intervalMs         0 = no timer (manual poll still works)
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @param {() => void} [deps.onUpdated]    called once after a pass that changed quota
 * @param {(msg: string) => void} [deps.log]
 */
export function createOauthUsagePoller({
  accountManager,
  upstream,
  intervalMs,
  fetchImpl = fetch,
  now = Date.now,
  onUpdated = null,
  log = msg => console.log(msg),
  logError = msg => console.error(msg),
}) {
  let closed = false;
  let timer = null;
  const abort = new AbortController();
  const endpoint = `${String(upstream).replace(/\/$/, '')}${OAUTH_USAGE_PATH}`;
  const staleAfterMs = usageStaleAfterMs(intervalMs);

  /** Last time this account's numbers were refreshed, by header or by poll. */
  function lastUpdateAt(account) {
    const header = Date.parse(account.usage?.lastUsed);
    return Math.max(account._usagePolledAt ?? 0, Number.isFinite(header) ? header : 0);
  }

  function eligible(account, force) {
    if (closed || account.enabled === false) return false;
    if (account.type !== 'oauth' || !account.credential) return false;
    if (account.inflight !== 0 || account._usagePolling) return false;
    if (isTokenExpiringSoon(account.expiresAt)) return false;
    if (!force && now() - lastUpdateAt(account) < staleAfterMs) return false;
    return true;
  }

  async function fetchUsage(account) {
    const ac = new AbortController();
    const onClose = () => ac.abort();
    abort.signal.addEventListener('abort', onClose, { once: true });
    const timeout = setTimeout(() => ac.abort(), USAGE_POLL_TIMEOUT_MS);
    try {
      const res = await fetchImpl(endpoint, {
        headers: { accept: 'application/json', authorization: `Bearer ${account.credential}` },
        signal: ac.signal,
      });
      if (!res.ok) {
        await res.body?.cancel?.();
        return { ok: false, reason: `HTTP ${res.status}` };
      }
      return { ok: true, payload: await res.json() };
    } catch (err) {
      return { ok: false, reason: err?.message || 'network error' };
    } finally {
      clearTimeout(timeout);
      abort.signal.removeEventListener('abort', onClose);
    }
  }

  async function pollAccount(account) {
    account._usagePolling = true;
    try {
      const outcome = await fetchUsage(account);
      // Removed (or the proxy closed) while the request was in flight.
      if (closed || accountManager.accounts[account.index] !== account) return false;
      const applied = outcome.ok && applyOauthUsage(account.quota, parseOauthUsage(outcome.payload));
      if (applied) {
        account._usagePolledAt = now();
        if (account._usagePollFailed) {
          account._usagePollFailed = false;
          log(`[TeamClaude] Official usage poll recovered for "${account.name}"`);
        }
        return true;
      }
      // One line per failure streak, not one per tick.
      if (!account._usagePollFailed) {
        account._usagePollFailed = true;
        logError(`[TeamClaude] Official usage poll failed for "${account.name}" (${outcome.ok ? 'no usable windows' : outcome.reason}) — usage stays as last measured`);
      }
      return false;
    } finally {
      account._usagePolling = false;
    }
  }

  /**
   * One pass. `force` (dashboard button) skips only the staleness test; the
   * other guards stay. Returns { targets, updated }.
   */
  async function pollAll({ force = false } = {}) {
    if (closed) return { targets: 0, updated: 0 };
    const targets = accountManager.accounts.filter(a => eligible(a, force));
    // pollAccount raises `_usagePolling` synchronously, in the same tick as the
    // filter above, so an overlapping pass cannot pick the same account.
    const results = await Promise.all(targets.map(pollAccount));
    const updated = results.filter(Boolean).length;
    if (updated > 0) {
      try { onUpdated?.(); } catch { /* snapshot persistence is best-effort */ }
    }
    return { targets: targets.length, updated };
  }

  function start() {
    if (closed || timer || !(intervalMs > 0)) return;
    timer = setInterval(() => { pollAll().catch(() => { /* best-effort */ }); }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    abort.abort();
  }

  return { pollAll, start, stop, eligible: (a, force = false) => eligible(a, force) };
}
