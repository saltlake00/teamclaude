import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { TUI } from '../src/tui.js';
import {
  parseCodexCredits,
  codexCreditsUsable,
  formatCodexCreditBalance,
  formatCodexCreditsCompact,
  codexCreditRefusalEvidence,
} from '../src/codex-credits.js';

const HOUR = 3_600_000;

function codexAccount(name, extra = {}) {
  return {
    name,
    provider: 'codex',
    type: 'oauth',
    accessToken: `access-${name}`,
    accountId: `workspace-${name}`,
    expiresAt: Date.now() + HOUR,
    ...extra,
  };
}

function credits(balance, extra = {}) {
  return { balance, hasCredits: balance > 0, unlimited: false, overageLimitReached: false, ...extra };
}

// Measured codex accounts. `spent` marks the included weekly window as used up
// (100%); otherwise it sits at 10%. Weekly resets are staggered so use-or-lose
// has a strict order (lower index resets sooner).
function pool(specs, { useCredits = true } = {}) {
  // Default reevalIntervalMs: the first selection is a real priority pick
  // (lastEvalAt = 0), not "stay on index 0".
  const am = new AccountManager(specs.map(s => codexAccount(s.name)), 0.98);
  am.codexUseCredits = useCredits;
  const now = Date.now();
  specs.forEach((s, i) => {
    const q = am.accounts[i].quota;
    q.unified5h = 0.1;
    q.unified5hReset = now + HOUR;
    q.unified7d = s.spent ? 1 : 0.1;
    q.unified7dReset = now + (i + 1) * 24 * HOUR;
    q.codexCredits = s.credits ?? null;
    q.codexCreditsAt = now;
  });
  return am;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

test('parseCodexCredits reads the wham/usage credits object (string balance, flags)', () => {
  const parsed = parseCodexCredits({
    credits: {
      has_credits: true,
      unlimited: false,
      overage_limit_reached: false,
      balance: '61962.86707',
      approx_local_messages: [15625, 81250],
      approx_cloud_messages: [2500, 15625],
    },
  });
  assert.deepEqual(parsed, {
    balance: 61962.86707,
    hasCredits: true,
    unlimited: false,
    overageLimitReached: false,
  });
  assert.equal(parseCodexCredits({ credits: { has_credits: true, balance: 62500 } }).balance, 62500);
});

test('parseCodexCredits fails closed on absent or malformed payloads', () => {
  assert.equal(parseCodexCredits(null), null);
  assert.equal(parseCodexCredits({}), null);
  assert.equal(parseCodexCredits({ credits: null }), null);
  assert.equal(parseCodexCredits({ credits: [] }), null);
  assert.equal(parseCodexCredits({ credits: 'lots' }), null);
  // A balance that is not a finite non-negative number is unknown, not zero.
  assert.equal(parseCodexCredits({ credits: { has_credits: true, balance: '' } }).balance, null);
  assert.equal(parseCodexCredits({ credits: { has_credits: true, balance: 'abc' } }).balance, null);
  assert.equal(parseCodexCredits({ credits: { has_credits: true, balance: '-5' } }).balance, null);
  assert.equal(parseCodexCredits({ credits: { has_credits: true } }).balance, null);
  // Flags are strict booleans: a truthy string is not "true".
  assert.equal(parseCodexCredits({ credits: { has_credits: 'yes', balance: '5' } }).hasCredits, false);
});

test('codexCreditsUsable requires a positive balance (or unlimited) and no overage stop', () => {
  assert.equal(codexCreditsUsable(credits(62500)), true);
  assert.equal(codexCreditsUsable(credits(0.5)), true);
  assert.equal(codexCreditsUsable(credits(0)), false, 'zero balance');
  assert.equal(codexCreditsUsable(credits(100, { hasCredits: false })), false, 'has_credits false');
  assert.equal(codexCreditsUsable(credits(100, { overageLimitReached: true })), false, 'overage limit reached');
  assert.equal(codexCreditsUsable({ balance: null, hasCredits: true, unlimited: false, overageLimitReached: false }), false, 'unknown balance');
  assert.equal(codexCreditsUsable({ balance: null, hasCredits: true, unlimited: true, overageLimitReached: false }), true, 'unlimited');
  assert.equal(codexCreditsUsable({ balance: 5, hasCredits: true, unlimited: true, overageLimitReached: true }), false, 'overage stop beats unlimited');
  assert.equal(codexCreditsUsable(null), false);
});

test('credit refusal evidence: the reached-type header alone is never evidence', () => {
  // x-codex-rate-limit-reached-type means "included quota reached" — the
  // premise of every credit-backed dispatch, not a refusal to draw credits.
  for (const value of ['rate_limit_reached', 'usage_limit_reached', 'concurrency_limit', '']) {
    assert.equal(codexCreditRefusalEvidence({ reachedType: value }), false, value);
  }
  assert.equal(codexCreditRefusalEvidence({
    reachedType: 'rate_limit_reached',
    bodyText: '{"error":{"message":"Too many concurrent requests"}}',
  }), false, 'header + transient body');
  assert.equal(codexCreditRefusalEvidence({
    reachedType: 'rate_limit_reached',
    bodyText: '{"error":{"type":"usage_limit_reached"}}',
  }), true, 'the body class is what counts');
  assert.equal(codexCreditRefusalEvidence(), false);
});

test('credit refusal evidence: body is parsed, only error.code/type/message classes count', () => {
  // Positive: each allowlisted error class.
  for (const code of ['usage_limit_reached', 'usage_not_included', 'insufficient_quota']) {
    assert.equal(codexCreditRefusalEvidence({ bodyText: JSON.stringify({ error: { code } }) }), true, `code ${code}`);
    assert.equal(codexCreditRefusalEvidence({ bodyText: JSON.stringify({ error: { type: code } }) }), true, `type ${code}`);
  }
  for (const message of [
    'You are out of credits',
    'Insufficient credits to complete this request',
    'Your credit balance is exhausted',
  ]) {
    assert.equal(codexCreditRefusalEvidence({ bodyText: JSON.stringify({ error: { message } }) }), true, message);
  }
  // Usage-limit wording alone is NOT evidence (only error.code/type is): it also
  // appears in transient/concurrency messages.
  for (const message of [
    'Too many concurrent requests; check your usage limits.',
    'The usage limit has been reached',
  ]) {
    assert.equal(codexCreditRefusalEvidence({ bodyText: JSON.stringify({ error: { message } }) }), false, message);
  }
  assert.equal(codexCreditRefusalEvidence({
    bodyText: '{"error":{"message":"Too many concurrent requests; check your usage limits."}}',
  }), false, 'round-3 regression body');
  // Negative: the review's regression body — credit METADATA beside a transient error.
  const transientWithCredits = '{"error":{"message":"Too many concurrent requests"},"credits":{"has_credits":true,"balance":"62500"}}';
  assert.equal(codexCreditRefusalEvidence({ bodyText: transientWithCredits }), false);
  assert.equal(codexCreditRefusalEvidence({ reachedType: 'concurrency_limit', bodyText: transientWithCredits }), false);
  // "credit" outside error.* never counts, nor does non-JSON text.
  assert.equal(codexCreditRefusalEvidence({ bodyText: '{"note":"usage_limit_reached credit"}' }), false);
  assert.equal(codexCreditRefusalEvidence({ bodyText: 'usage limit reached (plain text)' }), false);
  assert.equal(codexCreditRefusalEvidence({ bodyText: '{"error":{"message":"Rate limit reset credits available"}}' }), false);
});

test('credit balance formatters', () => {
  assert.equal(formatCodexCreditBalance(credits(61962.86707)), '61,962.87');
  assert.equal(formatCodexCreditBalance(credits(62500)), '62,500');
  assert.equal(formatCodexCreditBalance({ balance: null, hasCredits: true, unlimited: true, overageLimitReached: false }), 'unlimited');
  assert.equal(formatCodexCreditBalance(null), null);
  assert.equal(formatCodexCreditsCompact(credits(62500)), '62.5k');
  assert.equal(formatCodexCreditsCompact(credits(61962.86707)), '62.0k');
  assert.equal(formatCodexCreditsCompact(credits(950)), '950');
  assert.equal(formatCodexCreditsCompact(credits(1_234_567)), '1.23M');
  assert.equal(formatCodexCreditsCompact(credits(0)), '0');
  assert.equal(formatCodexCreditsCompact(null), '-');
});

// ── Quota state, persistence, status ────────────────────────────────────────

test('updateCodexUsage stores credits with a freshness stamp; absent credits clear to null', () => {
  const am = new AccountManager([codexAccount('a')]);
  const before = Date.now();
  am.updateCodexUsage(0, { credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: '62500' } });
  const q = am.accounts[0].quota;
  assert.deepEqual(q.codexCredits, credits(62500));
  assert.ok(q.codexCreditsAt >= before);
  assert.equal(q.codexCreditsAt, q.codexUsageAt);

  am.updateCodexUsage(0, { rate_limit: {} });
  assert.equal(q.codexCredits, null, 'a poll without credits must not keep routing on a stale balance');
});

test('credits survive a quota snapshot round-trip and malformed snapshots are sanitized', () => {
  const am = pool([{ name: 'a', spent: true, credits: credits(1234.5) }]);
  const snapshot = JSON.parse(JSON.stringify(am.exportQuotaState()));
  assert.deepEqual(snapshot[0].quota.codexCredits, credits(1234.5));

  const restored = new AccountManager([codexAccount('a')]);
  restored.importQuotaState(snapshot);
  assert.deepEqual(restored.accounts[0].quota.codexCredits, credits(1234.5));
  assert.equal(restored.accounts[0].quota.codexCreditsAt, snapshot[0].quota.codexCreditsAt);

  const garbage = new AccountManager([codexAccount('a')]);
  garbage.importQuotaState([{ name: 'a', quota: { codexCredits: { balance: 'oops', hasCredits: 'yes' } } }]);
  assert.deepEqual(garbage.accounts[0].quota.codexCredits, {
    balance: null, hasCredits: false, unlimited: false, overageLimitReached: false,
  });
  const old = new AccountManager([codexAccount('a')]);
  old.importQuotaState([{ name: 'a', quota: { unified7d: 0.5 } }]);
  assert.equal(old.accounts[0].quota.codexCredits, null, 'older snapshots without the field load as unknown');
});

test('status exposes per-account credits (deep copy), creditBacked, and creditBackedCount', () => {
  const am = pool([
    { name: 'included', credits: credits(500) },
    { name: 'oncredit', spent: true, credits: credits(62500) },
    { name: 'dry', spent: true, credits: credits(0) },
  ]);
  let status = am.getStatus();
  assert.deepEqual(status.accounts[1].quota.codexCredits, credits(62500));
  assert.equal(typeof status.accounts[1].quota.codexCreditsAt, 'number');
  assert.deepEqual(status.accounts.map(a => a.usable), [true, false, false], 'usable keeps its included-quota meaning');
  // Included quota remains on "included": nothing is routable on credits yet.
  assert.deepEqual(status.accounts.map(a => a.creditBacked), [false, false, false]);
  assert.equal(status.creditBackedCount, 0);

  am.accounts[0].quota.unified7d = 1; // fleet-wide included exhaustion
  status = am.getStatus();
  assert.deepEqual(status.accounts.map(a => a.creditBacked), [true, true, false],
    'both accounts with a usable balance are now routable on credits; the dry one is not');
  assert.equal(status.usableCount, 0);
  assert.equal(status.creditBackedCount, 2);
  assert.equal(status.codexUseCredits, true);

  status.accounts[1].quota.codexCredits.balance = 1;
  assert.equal(am.accounts[1].quota.codexCredits.balance, 62500, 'status must not leak a live reference');
  const json = JSON.stringify(status);
  assert.doesNotMatch(json, /access-|workspace-/, 'credential-free');
});

// ── Routing ─────────────────────────────────────────────────────────────────

test('included quota is always preferred over a credit-backed account', () => {
  // The credit-backed account would win use-or-lose (soonest weekly reset).
  const am = pool([
    { name: 'oncredit', spent: true, credits: credits(62500) },
    { name: 'included', credits: credits(62500) },
  ]);
  assert.equal(am.getActiveAccount().name, 'included');
});

test('when no included quota remains, a credit-backed account serves', () => {
  const am = pool([
    { name: 'spent-dry', spent: true, credits: null },
    { name: 'oncredit', spent: true, credits: credits(10) },
  ]);
  assert.equal(am.getActiveAccount().name, 'oncredit');
});

test('among credit-backed accounts the largest balance wins (1,000-credit buckets)', () => {
  const am = pool([
    { name: 'small', spent: true, credits: credits(5_000) },
    { name: 'large', spent: true, credits: credits(60_000) },
    { name: 'mid', spent: true, credits: credits(30_000) },
  ]);
  assert.equal(am.getActiveAccount().name, 'large');

  // Within one bucket the balance does not churn the order: use-or-lose
  // (soonest weekly reset = lower index here) decides instead.
  const near = pool([
    { name: 'first', spent: true, credits: credits(60_100) },
    { name: 'second', spent: true, credits: credits(60_900) },
  ]);
  assert.equal(near.getActiveAccount().name, 'first');
});

test('zero balance, has_credits false, overage stop, and unknown credits are never routed on credits', () => {
  for (const c of [credits(0), credits(500, { hasCredits: false }), credits(500, { overageLimitReached: true }), null]) {
    const am = pool([{ name: 'a', spent: true, credits: c }]);
    assert.equal(am.getActiveAccount(), null, `credits=${JSON.stringify(c)}`);
  }
});

test('codexUseCredits=false restores the old behavior (exhausted means unavailable)', () => {
  const am = pool([
    { name: 'oncredit', spent: true, credits: credits(62500) },
  ], { useCredits: false });
  assert.equal(am.getActiveAccount(), null);
  assert.equal(am.getStatus().accounts[0].creditBacked, false);
  assert.equal(am.getStatus().creditBackedCount, 0);
});

test('Anthropic accounts never route on credits, even with a credits object present', () => {
  const am = new AccountManager([{ name: 'claude', type: 'oauth', accessToken: 't', expiresAt: Date.now() + HOUR }], 0.98, 0);
  const q = am.accounts[0].quota;
  q.unified5h = 0.1;
  q.unified5hReset = Date.now() + HOUR;
  q.unified7d = 1;
  q.unified7dReset = Date.now() + 24 * HOUR;
  q.codexCredits = credits(62500);
  assert.equal(am.getActiveAccount(), null);
  assert.equal(am.getStatus().accounts[0].creditBacked, false);
});

test('a sticky credit-backed primary yields at once when included quota comes back', () => {
  const am = pool([
    { name: 'a', spent: true, credits: credits(62500) },
    { name: 'b', spent: true, credits: credits(100) },
  ]);
  am.reevalIntervalMs = 60 * 60 * 1000; // periodic re-eval cannot explain the switch
  assert.equal(am.getActiveAccount().name, 'a');
  am.accounts[1].quota.unified7d = 0.2; // b's weekly window renewed
  assert.equal(am.getActiveAccount().name, 'b');
});

test('connection affinity does not pin a socket to credits while included quota is acquirable', async () => {
  const am = pool([
    { name: 'a', spent: true, credits: credits(62500) },
    { name: 'b', spent: true, credits: credits(100) },
  ]);
  const socket = {};
  const first = await am.acquireAccount(null, 0, null, socket);
  assert.equal(first.name, 'a');
  am.releaseAccount(first);
  am.accounts[1].quota.unified7d = 0.2;
  const second = await am.acquireAccount(null, 0, null, socket);
  assert.equal(second.name, 'b');
  am.releaseAccount(second);
});

test('an included account that is merely at its cap makes the request wait, never spill to credits', async () => {
  const am = pool([
    { name: 'included', credits: credits(5) },
    { name: 'oncredit', spent: true, credits: credits(62500) },
  ]);
  const included = am.accounts[0];
  included.maxConcurrent = 1;
  const held = await am.acquireAccount(null, 0);
  assert.equal(held, included);
  assert.equal(am._tryAcquire(), null, 'the credit account is not an overflow target');
  assert.equal(am.anyCapped(), true, 'the request is eligible to queue for the included slot');
  assert.equal(am.isCreditBacked(am.accounts[1]), false);
  const waiting = am.acquireAccount(null, 2000);
  setTimeout(() => am.releaseAccount(held), 30);
  const got = await waiting;
  assert.equal(got, included, 'the queued request gets the freed included slot');
  am.releaseAccount(got);
});

test('credits become eligible only once no account has included quota left', async () => {
  const am = pool([
    { name: 'included', credits: null },
    { name: 'oncredit', spent: true, credits: credits(62500) },
  ]);
  am.accounts[0].maxConcurrent = 1;
  const held = await am.acquireAccount(null, 0);
  assert.equal(held.name, 'included');
  am.releaseAccount(held);
  am.accounts[0].quota.unified7d = 1; // included quota now gone fleet-wide
  const started = Date.now();
  const got = await am.acquireAccount(null, 2000);
  assert.equal(got.name, 'oncredit');
  assert.ok(Date.now() - started < 500, 'served at once, no queue wait');
  am.releaseAccount(got);
});

test('an included account this request may not use does not block the credit tier', async () => {
  const am = pool([
    { name: 'included', credits: null },
    { name: 'oncredit', spent: true, credits: credits(62500) },
  ]);
  const scope = new Set([am.accounts[0]]); // e.g. credential-type filtered or already failed
  assert.equal(am.anyUsable(scope), true);
  const got = await am.acquireAccount(scope, 0);
  assert.equal(got?.name, 'oncredit');
  am.releaseAccount(got);
  // Without the request exclusion the same included account still wins.
  assert.equal(am.anyUsable(new Set([am.accounts[1]])), true);
  const plain = await am.acquireAccount(null, 0);
  assert.equal(plain.name, 'included');
  am.releaseAccount(plain);
});

test('a capped included account in scope still makes the request wait, an excluded one does not', async () => {
  const am = pool([
    { name: 'included', credits: null },
    { name: 'other-included', credits: null },
    { name: 'oncredit', spent: true, credits: credits(62500) },
  ]);
  am.accounts[0].maxConcurrent = 1;
  am.accounts[0].inflight = 1; // eligible but busy
  const scope = new Set([am.accounts[1]]); // the other included account is excluded for this request
  assert.equal(am._tryAcquire(scope), null, 'busy eligible included quota still outranks credits');
  assert.equal(am.anyCapped(scope), true);
  scope.add(am.accounts[0]); // now the busy one is excluded too
  const got = am._tryAcquire(scope);
  assert.equal(got?.name, 'oncredit');
  am.releaseAccount(got);
});

test('a merely-tried included account still holds the credit tier; an ineligible one does not', async () => {
  const am = pool([
    { name: 'included', credits: null },
    { name: 'oncredit', spent: true, credits: credits(62500) },
  ]);
  const tried = new Set([am.accounts[0]]);
  // Selection excludes the tried account, but the credit gate scope does not.
  assert.equal(am.anyUsable(tried, null, null), false);
  assert.equal(await am.acquireAccount(tried, 0, null, null, null, null, null), null);
  // Credit gate scope = accounts that cannot serve this request at all.
  assert.equal(am.anyUsable(tried, null, tried), true);
  const got = await am.acquireAccount(tried, 0, null, null, null, null, tried);
  assert.equal(got?.name, 'oncredit');
  am.releaseAccount(got);
});

test('the reset-credit deferral is judged within the request scope', async () => {
  const am = pool([
    { name: 'reset-holder', spent: true, credits: null },
    { name: 'oncredit', spent: true, credits: credits(62500) },
  ]);
  am.creditDeferral = (_model, scope) => !(scope && scope.has(am.accounts[0]));
  assert.equal(await am.acquireAccount(null, 0), null, 'a usable reset credit comes first');
  const got = await am.acquireAccount(new Set([am.accounts[0]]), 0);
  assert.equal(got?.name, 'oncredit', 'a reset credit this request cannot use does not defer credits');
  am.releaseAccount(got);
});

test('status creditBacked follows routing and never mutates account state', () => {
  const am = pool([
    { name: 'included', credits: null },
    { name: 'oncredit', spent: true, credits: credits(62500) },
  ]);
  // A lapsed throttle: routing heals it and serves on included quota.
  am.accounts[0].status = 'throttled';
  am.accounts[0].rateLimitedUntil = Date.now() - 1000;
  const status = am.getStatus();
  assert.equal(status.accounts[1].creditBacked, false, 'routing would pick the healed included account');
  assert.equal(status.creditBackedCount, 0);
  assert.equal(am.accounts[0].status, 'throttled', 'reading status must not heal the throttle');
  assert.equal(am.getActiveAccount().name, 'included', 'routing agrees');
});

test('status never reports an error row as creditBacked (lapsed send-failed cooldown)', () => {
  const am = pool([{ name: 'oncredit', spent: true, credits: credits(62500) }]);
  const account = am.accounts[0];
  am.markSendFailure(account, Date.now() - 10 * 60_000); // cooldown already lapsed
  assert.equal(account.status, 'error');
  const row = am.getStatus().accounts[0];
  assert.equal(row.status, 'error');
  assert.equal(row.creditBacked, false, 'an error row must not also claim to serve on credits');
  assert.equal(row.creditBacked, row.creditRecoverable, 'creditBacked and creditRecoverable agree');
  assert.equal(account.status, 'error', 'reading status must not heal the send-failed park');
  // Routing still performs the heal and then serves on credits.
  assert.equal(am.getActiveAccount()?.name, 'oncredit');
  assert.equal(account.status, 'active');
  assert.equal(am.getStatus().accounts[0].creditBacked, true);
});

test('a reset-credit deferral holds credit accounts out of selection', () => {
  const am = pool([{ name: 'oncredit', spent: true, credits: credits(62500) }]);
  let defer = true;
  am.creditDeferral = () => defer;
  assert.equal(am.getActiveAccount(), null, 'a free reset credit must be tried before paid credits');
  assert.equal(am.anyUsable(), false, 'the dead end is visible to the reset-credit path');
  defer = false;
  assert.equal(am.getActiveAccount().name, 'oncredit');
});

test('a credit refusal holds the account out until the refusal window passes', async () => {
  const am = pool([{ name: 'a', spent: true, credits: credits(62500) }]);
  const a = am.accounts[0];
  assert.equal(am.isCreditBacked(a), true);
  assert.equal(am.noteCreditRefusal(a, 40), true);
  assert.equal(am.getActiveAccount(), null);
  assert.equal(am.getStatus().accounts[0].creditBacked, false);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(am.getActiveAccount(), a);
  // An account that is not credit-backed is never marked.
  const fresh = pool([{ name: 'b', credits: credits(5) }]);
  assert.equal(fresh.noteCreditRefusal(fresh.accounts[0], 40), false);
});

// ── Server integration ──────────────────────────────────────────────────────

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met before timeout');
}

// Two codex accounts, both with the included weekly window spent. "rich" has
// credits, "dry" has none. The upstream answers inference per token according
// to `mode`.
async function startCreditHarness(extraConfig = {}, { resetCount = null, consumeCode = 'reset' } = {}) {
  const state = { richMode: 'accept', hits: { rich: 0, dry: 0 }, consumed: 0, events: [] };
  const weekly = () => ({
    used_percent: 100,
    limit_window_seconds: 604800,
    reset_at: Math.floor(Date.now() / 1000) + 5 * 24 * 3600,
  });
  const upstream = http.createServer((req, res) => {
    const who = req.headers.authorization === 'Bearer access-rich' ? 'rich' : 'dry';
    if (req.url === '/backend-api/wham/rate-limit-reset-credits/consume') {
      state.consumed++;
      state.events.push(`consume:${who}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: consumeCode, windows_reset: consumeCode === 'reset' ? 1 : 0 }));
      return;
    }
    if (req.url === '/backend-api/wham/usage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ...(resetCount != null && who === 'rich'
          ? { rate_limit_reset_credits: { available_count: resetCount, applicable_available_count: resetCount } }
          : {}),
        rate_limit: { allowed: false, limit_reached: true, primary_window: weekly() },
        credits: who === 'rich'
          ? { has_credits: true, unlimited: false, overage_limit_reached: false, balance: '62500' }
          : { has_credits: false, unlimited: false, overage_limit_reached: false, balance: '0' },
      }));
      return;
    }
    state.hits[who]++;
    state.events.push(`infer:${who}`);
    const quotaHeaders = {
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-window-minutes': '10080',
      'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 5 * 24 * 3600),
    };
    if (who === 'rich' && ['reject-gzip', 'reject-br', 'reject-gzip-garbage', 'reject-gzip-oversized'].includes(state.richMode)) {
      const refusal = JSON.stringify({ error: { type: 'usage_limit_reached', message: 'usage limit reached' } });
      let encoding = 'gzip';
      let bytes;
      if (state.richMode === 'reject-br') {
        encoding = 'br';
        bytes = brotliCompressSync(Buffer.from(refusal));
      } else if (state.richMode === 'reject-gzip-garbage') {
        bytes = Buffer.from('this is not gzip at all');
      } else if (state.richMode === 'reject-gzip-oversized') {
        // Decodes past the 16 KiB inspection bound: never inspected, never a hold.
        bytes = gzipSync(Buffer.from(JSON.stringify({
          error: { type: 'usage_limit_reached' }, padding: 'x'.repeat(40 * 1024),
        })));
      } else {
        bytes = gzipSync(Buffer.from(refusal));
      }
      res.writeHead(429, {
        'content-type': 'application/json', 'content-encoding': encoding, 'retry-after': '1', ...quotaHeaders,
      });
      res.end(bytes);
      return;
    }
    if (who === 'rich' && state.richMode === 'transient-once') {
      state.richMode = 'accept';
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1', ...quotaHeaders });
      res.end('{"error":{"message":"Too many concurrent requests"}}');
      return;
    }
    if (who === 'rich' && state.richMode === 'transient-header') {
      res.writeHead(429, {
        'content-type': 'application/json', 'retry-after': '1',
        'x-codex-rate-limit-reached-type': 'rate_limit_reached', ...quotaHeaders,
      });
      res.end('{"error":{"message":"Too many concurrent requests"}}');
      return;
    }
    if (who === 'rich' && state.richMode === 'transient-credits') {
      res.writeHead(429, {
        'content-type': 'application/json', 'retry-after': '1',
        'x-codex-rate-limit-reached-type': 'concurrency_limit', ...quotaHeaders,
      });
      res.end('{"error":{"message":"Too many concurrent requests"},"credits":{"has_credits":true,"balance":"62500"}}');
      return;
    }
    if (who === 'rich' && state.richMode === 'transient') {
      // Concurrency/transient limit: no usage-limit signal, short Retry-After.
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1', ...quotaHeaders });
      res.end(JSON.stringify({ error: { message: 'Too many concurrent requests' } }));
      return;
    }
    if (who === 'rich' && state.richMode === 'accept') {
      res.writeHead(200, { 'content-type': 'application/json', ...quotaHeaders });
      res.end(JSON.stringify({ id: 'paid-by-credits', usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '60',
      'x-codex-rate-limit-reached-type': 'rate_limit_reached',
      ...quotaHeaders,
    });
    res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'usage limit reached' } }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([codexAccount('rich'), codexAccount('dry')]);
  const proxy = createProxyServer(manager, {
    provider: 'codex',
    upstream: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
    activeWarmup: false,
    warmupIntervalMs: 0,
    codexUsageActiveMs: 0,
    ...extraConfig,
  });
  const proxyPort = await listen(proxy);
  const send = async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });
    return { status: response.status, body: await response.text() };
  };
  const status = async () => (await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`)).json();
  await waitFor(() => manager.accounts.every(a => a.quota.codexUsageAt != null));
  return {
    state, manager, send, status, url: `http://127.0.0.1:${proxyPort}/codex/responses`,
    close: () => Promise.all([closeServer(proxy), closeServer(upstream)]),
  };
}

test('server: wham/usage credits reach /teamclaude/status', async () => {
  const h = await startCreditHarness();
  try {
    const s = await h.status();
    const rich = s.accounts.find(a => a.quota.codexCredits?.balance === 62500);
    assert.ok(rich, JSON.stringify(s.accounts.map(a => a.quota.codexCredits)));
    assert.equal(rich.creditBacked, true);
    assert.equal(typeof rich.quota.codexCreditsAt, 'number');
    assert.equal(s.creditBackedCount, 1);
    assert.deepEqual(s.codexCredits, { enabled: true });
    assert.doesNotMatch(JSON.stringify(s), /access-rich|workspace-rich/);
  } finally {
    await h.close();
  }
});

test('server: a credit-backed account serves and a 2xx does not throttle it', async () => {
  const h = await startCreditHarness();
  try {
    const first = await h.send();
    assert.equal(first.status, 200, first.body);
    assert.match(first.body, /paid-by-credits/);
    const second = await h.send();
    assert.equal(second.status, 200, second.body);
    assert.equal(h.state.hits.rich, 2);
    assert.equal(h.state.hits.dry, 0, 'the account without credits is never tried');
    assert.equal(h.manager.accounts[0].status, 'active');
    assert.equal(h.manager.accounts[0].rateLimitedUntil, null);
  } finally {
    await h.close();
  }
});

test('server: a genuine limit 429 despite credits falls back to the old throttle without looping', async () => {
  const h = await startCreditHarness();
  try {
    h.state.richMode = 'reject';
    const res = await h.send();
    assert.equal(res.status, 429);
    assert.equal(h.state.hits.rich, 1, 'exactly one upstream attempt on the credit-backed account');
    assert.equal(h.state.hits.dry, 0);
    const rich = h.manager.accounts[0];
    assert.equal(rich.status, 'throttled');
    assert.equal(h.manager.isCreditBacked(rich), false, 'credits are refused for this account for a while');

    // Even once the short throttle lapses, the refusal keeps it out.
    rich.rateLimitedUntil = Date.now() - 1;
    const again = await h.send();
    assert.equal(again.status, 429);
    assert.equal(h.state.hits.rich, 1, 'no retry loop onto a refused credit account');
  } finally {
    await h.close();
  }
});

test('server: a credit refusal whose body cannot be inspected for lack of auxiliary budget is logged', async () => {
  // The response budget (8 KiB) is below the 16 KiB inspection reservation, so
  // the refusal evidence cannot be read. That must not pass silently: the
  // operator needs to know the 30-minute credit hold was skipped.
  const logs = [];
  const original = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); original(...args); };
  const h = await startCreditHarness({ maxBufferedResponseBytes: 8 * 1024 });
  try {
    h.state.richMode = 'reject';
    const res = await h.send();
    assert.equal(res.status, 429);
    assert.ok(logs.some(line => /credit refusal check skipped/.test(line) && /auxiliary/.test(line)),
      `expected an aux-budget log line, got: ${logs.join(' | ')}`);
  } finally {
    console.log = original;
    await h.close();
  }
});

test('server: a transient 429 on a credit-backed dispatch is not a credit refusal', async () => {
  const h = await startCreditHarness();
  try {
    h.state.richMode = 'transient';
    const before = Date.now();
    const res = await h.send();
    assert.equal(res.status, 429);
    const rich = h.manager.accounts[0];
    assert.equal(rich._creditRefusedUntil ?? null, null, 'no 30-minute credit hold without explicit evidence');
    assert.ok(rich.rateLimitedUntil <= before + 5_000, 'only the bounded Retry-After throttle applies');
    rich.rateLimitedUntil = Date.now() - 1; // the short throttle lapses
    h.state.richMode = 'accept';
    const again = await h.send();
    assert.equal(again.status, 200, 'the account serves on credits again right away');
  } finally {
    await h.close();
  }
});

test('server: a transient 429 with credit metadata and an unknown reached-type is not a credit refusal', async () => {
  const h = await startCreditHarness();
  try {
    h.state.richMode = 'transient-credits';
    const res = await h.send();
    assert.equal(res.status, 429);
    assert.equal(h.manager.accounts[0]._creditRefusedUntil ?? null, null);
  } finally {
    await h.close();
  }
});

test('server: rate_limit_reached header with a concurrency body is not a credit refusal', async () => {
  const h = await startCreditHarness();
  try {
    h.state.richMode = 'transient-header';
    const res = await h.send();
    assert.equal(res.status, 429);
    assert.equal(h.manager.accounts[0]._creditRefusedUntil ?? null, null);
  } finally {
    await h.close();
  }
});

// M-2 harness: "inc" has included quota (no credits), "rich" is credit-backed.
async function startMixedHarness() {
  const state = { incMode: 'transient', hits: { inc: 0, rich: 0 } };
  const reset = () => Math.floor(Date.now() / 1000) + 5 * 24 * 3600;
  const upstream = http.createServer((req, res) => {
    const who = req.headers.authorization === 'Bearer access-rich' ? 'rich' : 'inc';
    if (req.url === '/backend-api/wham/usage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        rate_limit: { primary_window: { used_percent: who === 'rich' ? 100 : 10, limit_window_seconds: 604800, reset_at: reset() } },
        credits: who === 'rich'
          ? { has_credits: true, unlimited: false, overage_limit_reached: false, balance: '62500' }
          : { has_credits: false, unlimited: false, overage_limit_reached: false, balance: '0' },
      }));
      return;
    }
    state.hits[who]++;
    if (who === 'inc' && state.incMode === 'transient') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end('{"error":{"message":"Too many concurrent requests"}}');
      return;
    }
    if (who === 'inc' && state.incMode === 'exhausted') {
      res.writeHead(429, {
        'content-type': 'application/json', 'retry-after': '60',
        'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '10080',
        'x-codex-primary-reset-at': String(reset()), 'x-codex-rate-limit-reached-type': 'rate_limit_reached',
      });
      res.end('{"error":{"type":"usage_limit_reached","message":"usage limit reached"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `served-by-${who}`, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([codexAccount('inc'), codexAccount('rich')]);
  const proxy = createProxyServer(manager, {
    provider: 'codex',
    upstream: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
    activeWarmup: false, warmupIntervalMs: 0, codexUsageActiveMs: 0,
  });
  const proxyPort = await listen(proxy);
  await waitFor(() => manager.accounts.every(a => a.quota.codexUsageAt != null));
  const send = async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });
    return { status: response.status, body: await response.text() };
  };
  return { state, manager, send, close: () => Promise.all([closeServer(proxy), closeServer(upstream)]) };
}

test('server: a transient 429 on the included account does not spill the request onto paid credits', async () => {
  const h = await startMixedHarness();
  try {
    h.state.incMode = 'transient';
    const res = await h.send();
    assert.equal(res.status, 429, 'the client gets the transient 429 (continuity off), not a credit-paid answer');
    assert.equal(h.state.hits.inc, 1);
    assert.equal(h.state.hits.rich, 0, 'no paid-credit dispatch for a merely-tried included account');
  } finally {
    await h.close();
  }
});

test('server: an included account genuinely exhausted mid-request unlocks credits for that request', async () => {
  const h = await startMixedHarness();
  try {
    h.state.incMode = 'exhausted';
    const res = await h.send();
    assert.equal(res.status, 200, res.body);
    assert.match(res.body, /served-by-rich/);
    assert.equal(h.state.hits.inc, 1);
    assert.equal(h.state.hits.rich, 1);
  } finally {
    await h.close();
  }
});

for (const mode of ['reject-gzip', 'reject-br']) {
  test(`server: a compressed (${mode.slice(7)}) usage_limit_reached 429 is decoded for inspection and holds credits`, async () => {
    const h = await startCreditHarness();
    try {
      h.state.richMode = mode;
      const res = await h.send();
      assert.equal(res.status, 429);
      const rich = h.manager.accounts[0];
      assert.ok(rich._creditRefusedUntil > Date.now(), 'explicit evidence inside a compressed body must count');
    } finally {
      await h.close();
    }
  });
}

for (const mode of ['reject-gzip-garbage', 'reject-gzip-oversized']) {
  test(`server: an undecodable or oversized compressed 429 (${mode}) is no evidence and does not crash`, async () => {
    const h = await startCreditHarness();
    try {
      h.state.richMode = mode;
      const res = await h.send();
      assert.equal(res.status, 429);
      assert.equal(h.manager.accounts[0]._creditRefusedUntil ?? null, null);
    } finally {
      await h.close();
    }
  });
}

test('server: a short throttle on a credit-backed account yields a short Retry-After, not the weekly reset', async () => {
  const h = await startCreditHarness();
  try {
    h.state.richMode = 'transient';
    assert.equal((await h.send()).status, 429);
    const res = await fetch(h.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });
    await res.text();
    assert.equal(res.status, 429);
    const retryAfter = Number(res.headers.get('retry-after'));
    assert.ok(retryAfter >= 1 && retryAfter <= 5, `Retry-After ${retryAfter}s must follow the 1s throttle, not the 5-day weekly reset`);
  } finally {
    await h.close();
  }
});

test('server: a credit refusal hold sets recovery to the hold expiry, not the weekly reset', async () => {
  const h = await startCreditHarness({ codexCreditRefusalMs: 90_000 });
  try {
    h.state.richMode = 'reject';
    assert.equal((await h.send()).status, 429);
    const res = await fetch(h.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });
    await res.text();
    const retryAfter = Number(res.headers.get('retry-after'));
    assert.ok(retryAfter >= 60 && retryAfter <= 95, `Retry-After ${retryAfter}s must be max(throttle 60s, hold 90s)`);
  } finally {
    await h.close();
  }
});

test('server: continuity waits out a short throttle on a credit-backed account instead of failing fast', async () => {
  const h = await startCreditHarness({
    continuityMode: true, continuityMaxWaitMs: 20_000, continuityMaxSleepMs: 2_000, continuityJitterMs: 0,
  });
  try {
    h.state.richMode = 'transient-once';
    const started = Date.now();
    const res = await h.send();
    assert.equal(res.status, 200, res.body);
    assert.match(res.body, /paid-by-credits/);
    assert.equal(h.state.hits.rich, 2);
    assert.ok(Date.now() - started < 15_000);
  } finally {
    await h.close();
  }
});

test('server: codexUseCredits=false keeps the old dead end', async () => {
  const h = await startCreditHarness({ codexUseCredits: false });
  try {
    const res = await h.send();
    assert.equal(res.status, 429);
    assert.equal(h.state.hits.rich + h.state.hits.dry, 0);
    const s = await h.status();
    assert.deepEqual(s.codexCredits, { enabled: false });
    assert.equal(s.creditBackedCount, 0);
    assert.equal(s.accounts.find(a => a.quota.codexCredits?.balance === 62500).creditBacked, false,
      'balances still display with routing off');
  } finally {
    await h.close();
  }
});

test('server: a free reset credit is redeemed before paid credits are spent', async () => {
  const h = await startCreditHarness({ codexResetCredits: true }, { resetCount: 1 });
  try {
    assert.equal(h.manager.accounts[0].quota.codexResetCredits, 1);
    const res = await h.send();
    assert.equal(res.status, 200, res.body);
    assert.equal(h.state.consumed, 1, 'the reset path ran');
    assert.deepEqual(h.state.events, ['consume:rich', 'infer:rich'],
      'the redemption happens before any inference that could draw credits');
  } finally {
    await h.close();
  }
});

test('server: with zero reset credits the credit-backed account serves directly', async () => {
  const h = await startCreditHarness({ codexResetCredits: true }, { resetCount: 0 });
  try {
    const res = await h.send();
    assert.equal(res.status, 200, res.body);
    assert.equal(h.state.consumed, 0);
    assert.deepEqual(h.state.events, ['infer:rich']);
  } finally {
    await h.close();
  }
});

test('server: a reset attempt that frees nothing falls through to paid credits in the same request', async () => {
  const h = await startCreditHarness({ codexResetCredits: true }, { resetCount: 1, consumeCode: 'no_credit' });
  try {
    const res = await h.send();
    assert.equal(res.status, 200, res.body);
    assert.equal(h.state.consumed, 1, 'exactly one reset attempt');
    assert.deepEqual(h.state.events, ['consume:rich', 'infer:rich']);
  } finally {
    await h.close();
  }
});

test('server: a charged reset-credit pass unlocks paid credits even while another account still holds a reset credit', async () => {
  // Fleet policy, two exhausted accounts that BOTH hold a reset credit and a
  // paid balance. The first consume fails ambiguously (HTTP 500), which ends
  // the request's single redemption pass and cools down only that account.
  // The other account is still reset-eligible, but this request may not
  // redeem again — so the paid-credit tier must open for it instead of the
  // request failing fast with a usage-limit 429.
  const state = { consumed: 0, events: [] };
  const reset = () => Math.floor(Date.now() / 1000) + 5 * 24 * 3600;
  const upstream = http.createServer((req, res) => {
    const who = req.headers.authorization === 'Bearer access-a' ? 'a' : 'b';
    if (req.url === '/backend-api/wham/rate-limit-reset-credits/consume') {
      state.consumed++;
      state.events.push(`consume:${who}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"internal error"}}');
      return;
    }
    if (req.url === '/backend-api/wham/usage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        rate_limit_reset_credits: { available_count: 1, applicable_available_count: 1 },
        rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: reset() } },
        credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: '62500' },
      }));
      return;
    }
    state.events.push(`infer:${who}`);
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-window-minutes': '10080',
      'x-codex-primary-reset-at': String(reset()),
    });
    res.end(JSON.stringify({ id: 'paid-by-credits', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([codexAccount('a'), codexAccount('b')]);
  const proxy = createProxyServer(manager, {
    provider: 'codex',
    upstream: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
    activeWarmup: false,
    warmupIntervalMs: 0,
    codexUsageActiveMs: 0,
    codexResetCredits: true,
    codexResetCreditsPolicy: 'fleet',
  });
  const proxyPort = await listen(proxy);
  try {
    await waitFor(() => manager.accounts.every(a => a.quota.codexUsageAt != null));
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.equal(state.consumed, 1, 'exactly one redemption attempt per request');
    assert.equal(state.events.filter(e => e.startsWith('infer:')).length, 1, `served on credits: ${state.events.join(',')}`);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

// ── CLI status and TUI ──────────────────────────────────────────────────────

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

function runCli(cliArgs, env) {
  return new Promise(resolve => {
    execFile(process.execPath, cliArgs, { encoding: 'utf8', env }, (err, stdout, stderr) =>
      resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

function statusAccount(name, quotaExtra, extra = {}) {
  return {
    name, accountUuid: `uuid-${name}`, type: 'oauth', provider: 'codex',
    status: 'active', errorReason: null, usable: false, creditBacked: false,
    enabled: true, priority: null,
    quota: {
      tokensLimit: null, tokensRemaining: null, requestsLimit: null, requestsRemaining: null,
      unified5h: 0.1, unified7d: 1, unified5hReset: null, unified7dReset: null,
      unifiedStatus: null, codexUsageAt: 1, modelWeekly: {}, resetsAt: null,
      tokensReset: null, requestsReset: null, codexCredits: null, codexCreditsAt: null,
      ...quotaExtra,
    },
    usage: { totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, lastUsed: null },
    inflight: 0, maxConcurrent: 3, rateLimitedUntil: null,
    ...extra,
  };
}

test('CLI status prints each codex account credit balance and the on-credits count', async () => {
  const accounts = [
    statusAccount('rich@example.com', { codexCredits: credits(61962.86707), codexCreditsAt: Date.now() }, { creditBacked: true }),
    statusAccount('stopped@example.com', { codexCredits: credits(10, { overageLimitReached: true }), codexCreditsAt: Date.now() }),
    statusAccount('plain@example.com', {}),
  ];
  const payload = {
    currentAccount: accounts[0].name, switchThreshold: 0.98,
    usableCount: 0, creditBackedCount: 1, totalCount: accounts.length,
    codexCredits: { enabled: true }, accounts,
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const port = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-credits-cli-'));
  const configPath = join(dir, 'teamcodex.json');
  await writeFile(configPath, JSON.stringify({ provider: 'codex', proxy: { port, apiKey: 'k' }, accounts: [] }));
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  delete env.TEAMCLAUDE_PROVIDER;
  try {
    const res = await runCli([entry, 'status'], env);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /On credits:\s+1 account/);
    assert.match(res.stdout, /Credits:\s+61,962\.87 balance — serving on credits/);
    assert.match(res.stdout, /Credits:\s+10 balance \(overage limit reached/);
    const plainBlock = res.stdout.split('plain@example.com')[1];
    assert.doesNotMatch(plainBlock, /Credits:/, 'no line when the server reported no credits object');
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

async function runCodexStatusCli(payload) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const port = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-credits-cli-off-'));
  const configPath = join(dir, 'teamcodex.json');
  await writeFile(configPath, JSON.stringify({ provider: 'codex', proxy: { port, apiKey: 'k' }, accounts: [] }));
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  delete env.TEAMCLAUDE_PROVIDER;
  try {
    return await runCli([entry, 'status'], env);
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
}

test('CLI status reports credit routing off from the top-level codexUseCredits field', async () => {
  const accounts = [statusAccount('rich@example.com', { codexCredits: credits(62500), codexCreditsAt: Date.now() })];
  const base = { currentAccount: accounts[0].name, switchThreshold: 0.98, usableCount: 0, totalCount: 1, accounts };
  const off = await runCodexStatusCli({ ...base, codexUseCredits: false, creditBackedCount: 0 });
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /Credit routing: off/);
  const on = await runCodexStatusCli({ ...base, codexUseCredits: true, creditBackedCount: 0 });
  assert.doesNotMatch(on.stdout, /Credit routing: off/);
  // An Anthropic-only pool reports codexUseCredits false too; it must not print the line.
  const claude = await runCodexStatusCli({
    ...base, codexUseCredits: false,
    accounts: [{ ...accounts[0], provider: 'anthropic', quota: { ...accounts[0].quota, codexCredits: null } }],
  });
  assert.doesNotMatch(claude.stdout, /Credit routing: off/);
});

const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

test('TUI codex rows show the credit balance and a credits status when serving on credits', () => {
  const am = pool([
    { name: 'oncredit', spent: true, credits: credits(62500) },
    { name: 'stopped', spent: true, credits: credits(950, { overageLimitReached: true }) },
    { name: 'unknown', spent: true },
  ]);
  const tui = new TUI({
    accountManager: am,
    config: { provider: 'codex', proxy: { port: 3457 }, accounts: [] },
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  const row0 = stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, true, true));
  const row1 = stripAnsi(tui._renderAcct(am.accounts[1], 1, 10, true, true));
  const row2 = stripAnsi(tui._renderAcct(am.accounts[2], 2, 10, true, true));
  assert.match(row0, /credits/);
  assert.match(row0, /Cr\s+62\.5k/);
  assert.match(row1, /Cr\s+950/);
  assert.doesNotMatch(row1, /credits/);
  assert.match(row2, /Cr\s+-/);
  // Narrow layouts (no third slot) still carry the balance.
  assert.match(stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, false, false)), /62\.5k/);
});
