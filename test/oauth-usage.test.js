import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { runAccountControl } from '../src/account-controls.js';
import {
  applyOauthUsage,
  createOauthUsagePoller,
  parseOauthUsage,
  resolveUsagePollIntervalMs,
} from '../src/oauth-usage.js';

const HOUR = 3600_000;
const UPSTREAM = 'https://upstream.example';
const RESET_5H = '2026-10-15T14:00:00.000Z';
const RESET_7D = '2026-10-20T09:00:00.000Z';

function usageBody({ five = 43, seven = 12 } = {}) {
  return {
    five_hour: { utilization: five, resets_at: RESET_5H },
    seven_day: { utilization: seven, resets_at: RESET_7D },
  };
}

function makeManager(defs) {
  const am = new AccountManager(defs.map(def => ({
    name: def.name,
    type: def.type ?? 'oauth',
    ...(def.type === 'apikey'
      ? { apiKey: `key-${def.name}` }
      : { accessToken: `tok-${def.name}`, refreshToken: 'r', expiresAt: def.expiresAt ?? Date.now() + HOUR }),
  })), 0.98);
  am.accounts.forEach((a, i) => {
    const def = defs[i];
    if (def.enabled === false) a.enabled = false;
    if (def.inflight) a.inflight = def.inflight;
    if (def.lastUsed) a.usage.lastUsed = def.lastUsed;
    if (def.type !== 'apikey') {
      a.quota.unified5h = 0.17;
      a.quota.unified5hReset = Date.parse('2026-10-15T13:00:00.000Z');
      a.quota.unified7d = 0.05;
      a.quota.unified7dReset = Date.parse('2026-10-19T00:00:00.000Z');
      a.quota.unifiedStatus = 'allowed';
    }
  });
  return am;
}

/** A fake fetch answering per Authorization token; records every call. */
function fakeFetch(answers = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const token = init.headers.authorization.replace('Bearer ', '');
    const answer = answers[token] ?? { status: 200, body: usageBody() };
    if (answer.throws) throw new Error(answer.throws);
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      body: { cancel: async () => {} },
      json: async () => {
        if (answer.badJson) throw new SyntaxError('Unexpected token');
        return answer.body;
      },
    };
  };
  return { impl, calls };
}

function poller(am, fetchImpl, extra = {}) {
  return createOauthUsagePoller({
    accountManager: am,
    upstream: UPSTREAM,
    intervalMs: 5 * 60_000,
    fetchImpl,
    log: () => {},
    logError: () => {},
    ...extra,
  });
}

test('a poll writes the official 5h/7d numbers and resets, and leaves unifiedStatus alone', async () => {
  const am = makeManager([{ name: 'maqluba195' }]);
  const { impl, calls } = fakeFetch({ 'tok-maqluba195': { status: 200, body: usageBody({ five: 43, seven: 12 }) } });
  let updated = 0;
  const p = poller(am, impl, { onUpdated: () => { updated += 1; } });

  const outcome = await p.pollAll();

  assert.deepEqual(outcome, { targets: 1, updated: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${UPSTREAM}/api/oauth/usage`);
  assert.equal(calls[0].headers.authorization, 'Bearer tok-maqluba195');
  const q = am.accounts[0].quota;
  assert.equal(q.unified5h, 0.43);
  assert.equal(q.unified5hReset, Date.parse(RESET_5H));
  assert.equal(q.unified7d, 0.12);
  assert.equal(q.unified7dReset, Date.parse(RESET_7D));
  assert.equal(q.unifiedStatus, 'allowed', 'only response headers decide unifiedStatus');
  assert.equal(updated, 1, 'snapshot hook fires once per pass that changed something');
});

test('a failed poll (401, 429, network, bad body) changes neither quota nor account status', async () => {
  const cases = [
    { status: 401 },
    { status: 429 },
    { throws: 'ECONNRESET' },
    { status: 200, badJson: true },
    { status: 200, body: {} },
  ];
  for (const answer of cases) {
    const am = makeManager([{ name: 'a' }]);
    const before = structuredClone({ quota: am.accounts[0].quota, status: am.accounts[0].status });
    let updated = 0;
    const p = poller(am, fakeFetch({ 'tok-a': answer }).impl, { onUpdated: () => { updated += 1; } });

    const outcome = await p.pollAll();

    assert.equal(outcome.updated, 0, JSON.stringify(answer));
    assert.deepEqual(am.accounts[0].quota, before.quota, JSON.stringify(answer));
    assert.equal(am.accounts[0].status, before.status, JSON.stringify(answer));
    assert.equal(am.accounts[0].errorReason, undefined);
    assert.equal(updated, 0, 'nothing changed, nothing to persist');
    assert.equal(am.accounts[0]._usagePolling, false, 'the account can be polled again');
  }
});

test('failure is logged once per streak and recovery once', async () => {
  const am = makeManager([{ name: 'a' }]);
  const answers = { 'tok-a': { status: 429 } };
  const { impl } = fakeFetch(answers);
  const errors = [];
  const logs = [];
  const p = poller(am, impl, { logError: m => errors.push(m), log: m => logs.push(m) });

  await p.pollAll({ force: true });
  await p.pollAll({ force: true });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /HTTP 429/);

  answers['tok-a'] = { status: 200, body: usageBody() };
  await p.pollAll({ force: true });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /recovered/);
});

test('a window without a usable utilization AND reset time is left as it was', () => {
  assert.deepEqual(parseOauthUsage({ five_hour: null, seven_day: { utilization: 5 } }), { fiveHour: null, sevenDay: null });
  const quota = { unified5h: 0.3, unified5hReset: 111, unified7d: 0.4, unified7dReset: 222 };
  const applied = applyOauthUsage(quota, parseOauthUsage({
    five_hour: { utilization: 'x', resets_at: RESET_5H },
    seven_day: { utilization: 50, resets_at: RESET_7D },
  }));
  assert.equal(applied, true);
  assert.equal(quota.unified5h, 0.3);
  assert.equal(quota.unified5hReset, 111);
  assert.equal(quota.unified7d, 0.5);
});

test('accounts that are busy, disabled, API-key, token-expiring or freshly updated are skipped', async () => {
  const now = Date.now();
  const am = makeManager([
    { name: 'busy', inflight: 1 },
    { name: 'off', enabled: false },
    { name: 'key', type: 'apikey' },
    { name: 'expiring', expiresAt: now + 60_000 },
    { name: 'fresh', lastUsed: new Date(now - 60_000).toISOString() },
    { name: 'stale', lastUsed: new Date(now - 10 * 60_000).toISOString() },
  ]);
  const { impl, calls } = fakeFetch();
  const p = poller(am, impl);

  const outcome = await p.pollAll();

  assert.deepEqual(outcome, { targets: 1, updated: 1 });
  assert.deepEqual(calls.map(c => c.headers.authorization), ['Bearer tok-stale']);
});

test('the dashboard button (force) skips only the staleness test', async () => {
  const now = Date.now();
  const am = makeManager([
    { name: 'busy', inflight: 1 },
    { name: 'off', enabled: false },
    { name: 'key', type: 'apikey' },
    { name: 'expiring', expiresAt: now + 60_000 },
    { name: 'fresh', lastUsed: new Date(now - 60_000).toISOString() },
  ]);
  const { impl, calls } = fakeFetch();
  const p = poller(am, impl);

  const outcome = await p.pollAll({ force: true });

  assert.deepEqual(outcome, { targets: 1, updated: 1 });
  assert.deepEqual(calls.map(c => c.headers.authorization), ['Bearer tok-fresh']);
});

test('overlapping passes send one request per account', async () => {
  const am = makeManager([{ name: 'a' }, { name: 'b' }]);
  const { impl, calls } = fakeFetch();
  const p = poller(am, impl);

  const [first, second] = await Promise.all([p.pollAll(), p.pollAll()]);

  assert.equal(calls.length, 2, 'a and b once each');
  assert.deepEqual([first.targets, second.targets].sort(), [0, 2]);
});

test('a just-polled account is not polled again before the interval', async () => {
  const am = makeManager([{ name: 'a' }]);
  const { impl, calls } = fakeFetch();
  let clock = Date.now();
  const p = poller(am, impl, { now: () => clock });

  await p.pollAll();
  clock += 60_000;
  await p.pollAll();
  assert.equal(calls.length, 1);
  clock += 5 * 60_000;
  await p.pollAll();
  assert.equal(calls.length, 2);
});

test('interval 0 starts no timer; a positive interval polls on each tick', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const offManager = makeManager([{ name: 'a' }]);
    const off = fakeFetch();
    const offPoller = poller(offManager, off.impl, { intervalMs: 0 });
    offPoller.start();
    mock.timers.tick(10 * 60_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(off.calls.length, 0);
    offPoller.stop();

    const onManager = makeManager([{ name: 'a' }]);
    const on = fakeFetch();
    const onPoller = poller(onManager, on.impl, { intervalMs: 1000 });
    onPoller.start();
    mock.timers.tick(1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(on.calls.length, 1);
    onPoller.stop();
    mock.timers.tick(5000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(on.calls.length, 1, 'stop() ends the timer');
  } finally {
    mock.timers.reset();
  }
});

// The poll stamps `_usagePolledAt` when the answer arrives, a little after
// the tick. Without slack the next tick sees "interval minus latency" and
// skips, so the real cadence was twice the setting (60 s → 120 s).
test('every tick polls even when the answer arrives late; a header update still skips one tick', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const intervalMs = 60_000;
    const latencyMs = 300;
    const am = makeManager([{ name: 'a' }]);
    const base = Date.now();
    let clock = base;
    const { impl, calls } = fakeFetch();
    const slowFetch = async (url, init) => {
      clock += latencyMs;
      return impl(url, init);
    };
    const p = poller(am, slowFetch, { intervalMs, now: () => clock });
    const tickTo = async n => {
      clock = base + n * intervalMs;
      mock.timers.tick(intervalMs);
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    };
    p.start();

    for (let n = 1; n <= 5; n++) await tickTo(n);
    assert.equal(calls.length, 5, 'one poll per tick, not one per two ticks');

    // Proxied traffic refreshed the numbers half an interval ago: that tick
    // has nothing to learn, so it stays skipped.
    am.accounts[0].usage.lastUsed = new Date(base + 5.5 * intervalMs).toISOString();
    await tickTo(6);
    assert.equal(calls.length, 5);
    await tickTo(7);
    assert.equal(calls.length, 6);
    p.stop();
  } finally {
    mock.timers.reset();
  }
});

test('usagePollIntervalMs: default 5 min, 0 = off, junk = default', () => {
  assert.equal(resolveUsagePollIntervalMs({}), 5 * 60_000);
  assert.equal(resolveUsagePollIntervalMs({ usagePollIntervalMs: 0 }), 0);
  assert.equal(resolveUsagePollIntervalMs({ usagePollIntervalMs: 90_000 }), 90_000);
  assert.equal(resolveUsagePollIntervalMs({ usagePollIntervalMs: -1 }), 5 * 60_000);
  assert.equal(resolveUsagePollIntervalMs({ usagePollIntervalMs: 'soon' }), 5 * 60_000);
});

test('refresh-usage runs the poll without a target account and reports the counts', async () => {
  const answer = await runAccountControl({
    accountManager: { accounts: [] },
    refreshUsage: async () => ({ targets: 3, updated: 2 }),
  }, { action: 'refresh-usage' });
  assert.deepEqual(answer, { statusCode: 200, body: { ok: true, action: 'refresh-usage', targets: 3, updated: 2 } });

  const none = await runAccountControl({ accountManager: { accounts: [] }, refreshUsage: async () => null }, { action: 'refresh-usage' });
  assert.equal(none.statusCode, 404);
  assert.equal(none.body.error.reason, 'unsupported');
});

// ── through the real proxy server ───────────────────────────────────────────

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function withUsageProxy(config, fn) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(usageBody({ five: 43, seven: 12 })));
  });
  const upstreamPort = await listen(upstream);
  const am = makeManager([{ name: 'a' }]);
  const hooks = { snapshots: 0, onUsagePolled() { this.snapshots += 1; } };
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, warmupIntervalMs: 0, ...config }, hooks);
  await listen(proxy);
  try {
    await fn({ am, proxy, seen, hooks });
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('the proxy polls the official endpoint on its timer and saves a snapshot', async () => {
  await withUsageProxy({ usagePollIntervalMs: 40 }, async ({ am, seen, hooks }) => {
    const deadline = Date.now() + 3000;
    while (am.accounts[0].quota.unified5h !== 0.43 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(am.accounts[0].quota.unified5h, 0.43);
    assert.equal(am.accounts[0].quota.unified7d, 0.12);
    assert.equal(seen[0].url, '/api/oauth/usage');
    assert.equal(seen[0].authorization, 'Bearer tok-a');
    assert.ok(hooks.snapshots >= 1);
  });
});

test('usagePollIntervalMs: 0 keeps the timer off, but the dashboard button still polls', async () => {
  await withUsageProxy({ usagePollIntervalMs: 0 }, async ({ am, proxy, seen }) => {
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(seen.length, 0);
    assert.equal(am.accounts[0].quota.unified5h, 0.17);

    const outcome = await proxy.refreshOauthUsage();
    assert.deepEqual(outcome, { targets: 1, updated: 1 });
    assert.equal(am.accounts[0].quota.unified5h, 0.43);
  });
});
