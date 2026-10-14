import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDashboard, DASHBOARD_CSRF_HEADER } from '../src/dashboard.js';

const KEY = 'tc-test-key';
const LIFECYCLE = 'lifecycle-1';
const HEADER = 'x-teamcodex-lifecycle-id';

const NAMED = {
  usableCount: 1,
  totalCount: 1,
  accounts: [{ name: 'a@example.com', accountUuid: 'uuid-a', type: 'oauth', quota: {}, usage: {} }],
};

async function start({ controls = true } = {}) {
  const actions = [];
  let dashboard;
  const server = http.createServer((req, res) => {
    if (!dashboard.handle(req, res, true)) {
      res.writeHead(599);
      res.end('not dashboard');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  dashboard = createDashboard({
    port,
    proxyApiKey: KEY,
    lifecycleId: LIFECYCLE,
    lifecycleHeader: HEADER,
    fetchStatus: async () => structuredClone(NAMED),
    controlAccount: controls
      ? async request => {
          actions.push(request);
          return request.accountUuid === 'uuid-missing'
            ? { statusCode: 404, body: { error: { type: 'not_found_error', reason: 'not-found', message: 'gone' } } }
            : { statusCode: 200, body: { ok: true, action: request.action, changed: true } };
        }
      : null,
  });
  return { port, actions, close: () => new Promise(resolve => server.close(resolve)) };
}

function request(port, path, { method = 'GET', headers = {}, body = null } = {}) {
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
    if (body != null) req.write(body);
    req.end();
  });
}

/** Mint a code, trade it for a cookie, and read the CSRF token from the named status. */
async function session(srv) {
  const minted = await request(srv.port, '/teamclaude/dashboard/session', {
    method: 'POST',
    headers: { 'x-api-key': KEY, [HEADER]: LIFECYCLE, 'content-length': '0' },
  });
  const { code } = JSON.parse(minted.body);
  const exchanged = await request(srv.port, `/teamclaude/dashboard?code=${code}`);
  const cookie = exchanged.headers['set-cookie'][0].split(';')[0];
  const status = JSON.parse((await request(srv.port, '/teamclaude/dashboard/status', { headers: { cookie } })).body);
  return { cookie, csrf: status.dashboard.csrf };
}

function action(srv, { cookie, csrf }, overrides = {}) {
  const payload = JSON.stringify(overrides.payload ?? { action: 'disable', accountUuid: 'uuid-a', name: 'a@example.com' });
  const headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    origin: `http://127.0.0.1:${srv.port}`,
    'sec-fetch-site': 'same-origin',
    ...(cookie ? { cookie } : {}),
    ...(csrf ? { [DASHBOARD_CSRF_HEADER]: csrf } : {}),
    ...overrides.headers,
  };
  for (const [k, v] of Object.entries(headers)) if (v === undefined) delete headers[k];
  return request(srv.port, '/teamclaude/dashboard/action', {
    method: overrides.method ?? 'POST',
    headers,
    body: overrides.method === 'GET' ? null : payload,
  });
}

test('only a named session receives a CSRF token; the redacted status has none', async () => {
  const srv = await start();
  try {
    const anonymous = JSON.parse((await request(srv.port, '/teamclaude/dashboard/status')).body);
    assert.equal(anonymous.dashboard.identity, false);
    assert.equal('csrf' in anonymous.dashboard, false);

    const s1 = await session(srv);
    const s2 = await session(srv);
    assert.match(s1.csrf, /^[A-Za-z0-9_-]{40,}$/);
    assert.notEqual(s1.csrf, s2.csrf, 'one token per session');
  } finally {
    await srv.close();
  }
});

test('a correct same-origin request with cookie and token reaches the worker', async () => {
  const srv = await start();
  try {
    const s = await session(srv);
    const ok = await action(srv, s);
    assert.equal(ok.status, 200, ok.body);
    assert.deepEqual(JSON.parse(ok.body), { ok: true, action: 'disable', changed: true });
    assert.deepEqual(srv.actions, [{ action: 'disable', accountUuid: 'uuid-a', name: 'a@example.com' }]);

    const missing = await action(srv, s, { payload: { action: 'enable', accountUuid: 'uuid-missing' } });
    assert.equal(missing.status, 404, 'the worker verdict passes through');
    assert.equal(JSON.parse(missing.body).error.reason, 'not-found');
  } finally {
    await srv.close();
  }
});

test('the write path refuses every request missing one of its proofs', async () => {
  const srv = await start();
  try {
    const s = await session(srv);
    const other = await session(srv);
    const cases = [
      ['no cookie', 403, { cookie: null, csrf: s.csrf }],
      ['unknown cookie', 403, { cookie: 'tc_dash_1=forged', csrf: s.csrf }],
      ['no CSRF token', 403, { cookie: s.cookie }],
      ['wrong CSRF token', 403, { ...s, headers: { [DASHBOARD_CSRF_HEADER]: 'x'.repeat(43) } }],
      ['another session\'s token', 403, { cookie: s.cookie, csrf: other.csrf }],
      ['cross-site', 403, { ...s, headers: { 'sec-fetch-site': 'cross-site' } }],
      ['same-site', 403, { ...s, headers: { 'sec-fetch-site': 'same-site' } }],
      ['no Sec-Fetch-Site', 403, { ...s, headers: { 'sec-fetch-site': undefined } }],
      ['foreign Origin', 403, { ...s, headers: { origin: 'http://evil.example' } }],
      ['no Origin', 403, { ...s, headers: { origin: undefined } }],
      ['other Host', 403, { ...s, headers: { host: 'evil.example:80' } }],
      ['GET', 405, { ...s, method: 'GET' }],
      ['form content type', 415, { ...s, headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
      ['unknown action', 400, { ...s, payload: { action: 'delete', accountUuid: 'uuid-a' } }],
      ['no target', 400, { ...s, payload: { action: 'disable' } }],
      ['oversized body', 413, { ...s, payload: { action: 'disable', name: 'x'.repeat(2000) } }],
    ];
    for (const [label, expected, { cookie = null, csrf = null, ...overrides }] of cases) {
      const res = await action(srv, { cookie, csrf }, overrides);
      assert.equal(res.status, expected, `${label}: ${res.body}`);
    }
    assert.equal(srv.actions.length, 0, 'nothing refused ever reached the worker');
  } finally {
    await srv.close();
  }
});

test('without a control hook the route is 404 and no token is issued', async () => {
  const srv = await start({ controls: false });
  try {
    const s = await session(srv);
    assert.equal(s.csrf, undefined);
    const res = await action(srv, { cookie: s.cookie, csrf: 'x' });
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});
