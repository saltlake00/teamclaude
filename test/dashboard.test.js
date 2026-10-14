import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDashboard, DASHBOARD_CODE_TTL_MS } from '../src/dashboard.js';

const KEY = 'tc-test-key';
const LIFECYCLE = 'lifecycle-1';
const HEADER = 'x-teamcodex-lifecycle-id';

const NAMED = {
  currentAccount: 'a@example.com',
  lifecycleId: LIFECYCLE,
  usableCount: 1,
  totalCount: 1,
  accounts: [{ name: 'a@example.com', accountUuid: 'uuid-a', type: 'oauth', quota: {}, usage: {} }],
};
const REDACTED = {
  usableCount: 1,
  totalCount: 1,
  accounts: [{ type: 'oauth', quota: {}, usage: {} }],
};

/** A server whose only handler is the dashboard; `local` simulates the supervisor's isLocal. */
async function start({ local = true, language = 'ko', now } = {}) {
  const calls = [];
  let port;
  let dashboard;
  const server = http.createServer((req, res) => {
    if (!dashboard.handle(req, res, local)) {
      res.writeHead(599);
      res.end('not dashboard');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  dashboard = createDashboard({
    port,
    proxyApiKey: KEY,
    lifecycleId: LIFECYCLE,
    lifecycleHeader: HEADER,
    language,
    now,
    fetchStatus: async identity => {
      calls.push(identity);
      return structuredClone(identity ? NAMED : REDACTED);
    },
  });
  return {
    port,
    calls,
    dashboard,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function request(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: { host: `127.0.0.1:${port}`, ...headers },
      agent: false,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function mint(srv, headers = {}) {
  return request(srv.port, '/teamclaude/dashboard/session', {
    method: 'POST',
    headers: { 'x-api-key': KEY, [HEADER]: LIFECYCLE, 'content-length': '0', ...headers },
  });
}

async function login(srv) {
  const minted = await mint(srv);
  assert.equal(minted.status, 200, minted.body);
  const { code } = JSON.parse(minted.body);
  const exchanged = await request(srv.port, `/teamclaude/dashboard?code=${code}`, {
    headers: { 'sec-fetch-site': 'none' },
  });
  assert.equal(exchanged.status, 303);
  const cookie = exchanged.headers['set-cookie']?.[0];
  assert.ok(cookie, 'code exchange must set the session cookie');
  return { code, cookie: cookie.split(';')[0], exchanged };
}

test('page is served with a strict CSP, no-store, and the configured language', async () => {
  const srv = await start({ language: 'ko' });
  try {
    const res = await request(srv.port, '/teamclaude/dashboard');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(res.body, /<html lang="ko" data-lang="ko">/);
    assert.match(res.body, /최근 활동/);
    // A data: icon keeps the browser from asking the proxy for /favicon.ico,
    // which the worker would forward upstream.
    assert.match(res.body, /<link rel="icon" href="data:/);

    const en = await request(srv.port, '/teamclaude/dashboard?lang=en');
    assert.match(en.body, /<html lang="en"/);

    const view = await request(srv.port, '/teamclaude/dashboard/view.js');
    assert.equal(view.status, 200);
    assert.match(view.headers['content-type'], /javascript/);
    assert.match(view.body, /export function buildViewModel/);
    const client = await request(srv.port, '/teamclaude/dashboard/client.js');
    assert.match(client.body, /from '\.\/view\.js'/);

    assert.equal((await request(srv.port, '/teamclaude/dashboard/nope')).status, 404);
    assert.equal((await request(srv.port, '/teamclaude/status')).status, 599, 'other paths are not handled');
    assert.equal((await request(srv.port, '/teamclaude/dashboardx')).status, 599);
  } finally {
    await srv.close();
  }
});

test('without a session the status is fetched redacted and the lifecycle id never leaks', async () => {
  const srv = await start();
  try {
    const res = await request(srv.port, '/teamclaude/dashboard/status', { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(srv.calls, [false]);
    assert.equal(body.dashboard.identity, false);
    assert.equal(body.dashboard.port, srv.port);
    assert.equal(body.accounts[0].name, undefined);
    // A client-sent proxy key does not unlock names on this route: only the cookie does.
    await request(srv.port, '/teamclaude/dashboard/status', { headers: { 'x-api-key': KEY, 'x-teamcodex-status-identity': '1' } });
    assert.deepEqual(srv.calls, [false, false]);
  } finally {
    await srv.close();
  }
});

test('a minted code becomes an HttpOnly SameSite=Strict cookie that unlocks names', async () => {
  const srv = await start();
  try {
    const { cookie, exchanged } = await login(srv);
    assert.equal(exchanged.headers.location, '/teamclaude/dashboard', 'redirect drops the code from the URL');
    const setCookie = exchanged.headers['set-cookie'][0];
    assert.match(setCookie, new RegExp(`^tc_dash_${srv.port}=`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\/teamclaude\/dashboard/);

    const res = await request(srv.port, '/teamclaude/dashboard/status', { headers: { cookie, 'sec-fetch-site': 'same-origin' } });
    const body = JSON.parse(res.body);
    assert.deepEqual(srv.calls, [true]);
    assert.equal(body.dashboard.identity, true);
    assert.equal(body.accounts[0].name, 'a@example.com');
    assert.equal('lifecycleId' in body, false, 'lifecycle id is stripped even from the named snapshot');

    const forged = await request(srv.port, '/teamclaude/dashboard/status', { headers: { cookie: `tc_dash_${srv.port}=forged` } });
    assert.equal(JSON.parse(forged.body).dashboard.identity, false);
  } finally {
    await srv.close();
  }
});

test('codes are single-use and expire after the TTL', async () => {
  let t = 1_000_000;
  const srv = await start({ now: () => t });
  try {
    const { code } = await login(srv);
    const reused = await request(srv.port, `/teamclaude/dashboard?code=${code}`);
    assert.equal(reused.status, 303);
    assert.equal(reused.headers['set-cookie'], undefined, 'a used code mints nothing');

    const { code: late } = JSON.parse((await mint(srv)).body);
    t += DASHBOARD_CODE_TTL_MS + 1;
    const expired = await request(srv.port, `/teamclaude/dashboard?code=${late}`);
    assert.equal(expired.headers['set-cookie'], undefined, 'an expired code mints nothing');
  } finally {
    await srv.close();
  }
});

test('minting a code requires the proxy key AND the live lifecycle id', async () => {
  const srv = await start();
  try {
    assert.equal((await mint(srv, { 'x-api-key': 'wrong' })).status, 403);
    assert.equal((await mint(srv, { [HEADER]: 'stale-lifecycle' })).status, 403);
    assert.equal((await mint(srv, { 'x-api-key': '' })).status, 403);
    assert.equal((await mint(srv, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await request(srv.port, '/teamclaude/dashboard/session')).status, 405);
    assert.equal((await mint(srv)).status, 200);
  } finally {
    await srv.close();
  }
});

test('remote peers, foreign Host headers and cross-site reads are refused', async () => {
  const remote = await start({ local: false });
  try {
    assert.equal((await request(remote.port, '/teamclaude/dashboard')).status, 403);
    assert.equal((await request(remote.port, '/teamclaude/dashboard/status')).status, 403);
    assert.deepEqual(remote.calls, []);
  } finally {
    await remote.close();
  }

  const srv = await start();
  try {
    // DNS rebinding: a hostile name resolving to 127.0.0.1 still sends its own Host.
    const rebound = await request(srv.port, '/teamclaude/dashboard/status', { headers: { host: `evil.example:${srv.port}` } });
    assert.equal(rebound.status, 403);
    assert.equal((await request(srv.port, '/teamclaude/dashboard', { headers: { host: 'evil.example' } })).status, 403);
    assert.equal((await request(srv.port, '/teamclaude/dashboard', { headers: { host: `localhost:${srv.port}` } })).status, 200);

    const { cookie } = await login(srv);
    for (const headers of [
      { cookie, 'sec-fetch-site': 'cross-site' },
      { cookie, 'sec-fetch-site': 'same-site' },
      { cookie, origin: 'https://evil.example' },
    ]) {
      const res = await request(srv.port, '/teamclaude/dashboard/status', { headers });
      assert.equal(res.status, 403, JSON.stringify(headers));
    }
    // A cross-site navigation cannot redeem a code either.
    const { code } = JSON.parse((await mint(srv)).body);
    const crossNav = await request(srv.port, `/teamclaude/dashboard?code=${code}`, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossNav.headers['set-cookie'], undefined);

    assert.equal((await request(srv.port, '/teamclaude/dashboard/status', { method: 'POST' })).status, 405);
    assert.deepEqual(srv.calls, []);
  } finally {
    await srv.close();
  }
});

test('the supervisor hook never throws on odd request targets and ignores non-dashboard paths', () => {
  const dashboard = createDashboard({
    port: 3456, proxyApiKey: KEY, lifecycleId: LIFECYCLE, lifecycleHeader: HEADER,
    fetchStatus: async () => ({}),
  });
  const res = { writeHead() { throw new Error('must not respond'); }, end() {} };
  for (const url of ['http://[bad', '*', '', undefined, '/v1/messages', '/teamclaude/status', '/teamclaude/dashboardx']) {
    assert.equal(dashboard.handle({ url, method: 'GET', headers: {} }, res, true), false, String(url));
  }
});

test('a worker that is restarting yields a retryable 503', async () => {
  const srv = await start();
  try {
    const server = http.createServer((req, res) => dashboard.handle(req, res, true));
    const dashboard = createDashboard({
      port: srv.port,
      proxyApiKey: KEY,
      lifecycleId: LIFECYCLE,
      lifecycleHeader: HEADER,
      fetchStatus: async () => { throw new Error('Proxy worker is restarting.'); },
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: '/teamclaude/dashboard/status', headers: { host: `127.0.0.1:${srv.port}` }, agent: false }, r => {
          r.resume();
          r.on('end', () => resolve(r));
        }).on('error', reject);
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.headers['retry-after'], '1');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  } finally {
    await srv.close();
  }
});
