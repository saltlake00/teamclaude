// Web dashboard startup switch: GET/POST /teamclaude/dashboard/autostart.
// The scheduler itself is faked here (test/autostart.test.js covers the CLI
// against a fake PowerShell); this file pins the route's boundary: a named
// session for reads, the full write-guard set for changes, strict body shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDashboard, DASHBOARD_CSRF_HEADER } from '../src/dashboard.js';
import { dashboardText, renderAutostartHtml } from '../src/dashboard-view.js';

const KEY = 'tc-test-key';
const LIFECYCLE = 'lifecycle-1';
const HEADER = 'x-teamcodex-lifecycle-id';
const PATH = '/teamclaude/dashboard/autostart';

const OFF = { supported: true, taskName: 'TeamClaude-Autostart', registered: false, enabled: false, dashboard: false, stale: false };

async function start({ autostart = true, failSet = false } = {}) {
  const calls = [];
  let state = { ...OFF };
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
    fetchStatus: async () => ({ usableCount: 0, totalCount: 0, accounts: [] }),
    controlAccount: async () => ({ statusCode: 200, body: { ok: true } }),
    autostart: autostart
      ? {
          read: async () => ({ ...state }),
          set: async opts => {
            calls.push(opts);
            if (failSet) throw new Error('Access is denied.');
            state = opts.enabled
              ? { ...OFF, registered: true, enabled: true, dashboard: opts.dashboard }
              : { ...OFF };
            return { ...state };
          },
        }
      : null,
  });
  return { port, calls, close: () => new Promise(resolve => server.close(resolve)) };
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

async function session(srv) {
  const minted = await request(srv.port, '/teamclaude/dashboard/session', {
    method: 'POST',
    headers: { 'x-api-key': KEY, [HEADER]: LIFECYCLE, 'content-length': '0' },
  });
  const { code } = JSON.parse(minted.body);
  const exchanged = await request(srv.port, `/teamclaude/dashboard?code=${code}`);
  const cookie = exchanged.headers['set-cookie'][0].split(';')[0];
  const status = JSON.parse((await request(srv.port, '/teamclaude/dashboard/status', { headers: { cookie } })).body);
  return { cookie, csrf: status.dashboard.csrf, status };
}

function post(srv, { cookie, csrf }, payload, headerOverrides = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return request(srv.port, PATH, {
    method: 'POST',
    headers: {
      cookie,
      [DASHBOARD_CSRF_HEADER]: csrf,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      origin: `http://127.0.0.1:${srv.port}`,
      'content-length': String(Buffer.byteLength(body)),
      ...headerOverrides,
    },
    body,
  });
}

test('status advertises the startup switch only to a named session', async () => {
  const srv = await start();
  try {
    const anonymous = JSON.parse((await request(srv.port, '/teamclaude/dashboard/status')).body);
    assert.equal(anonymous.dashboard.autostart, undefined);
    const { status } = await session(srv);
    assert.equal(status.dashboard.autostart, true);
  } finally {
    await srv.close();
  }
});

test('reading the startup state needs a session and refuses cross-site reads', async () => {
  const srv = await start();
  try {
    const noSession = await request(srv.port, PATH);
    assert.equal(noSession.status, 403);
    assert.equal(noSession.headers['x-teamclaude-reason'], 'session');
    const s = await session(srv);
    const crossSite = await request(srv.port, PATH, { headers: { cookie: s.cookie, 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    const ok = await request(srv.port, PATH, { headers: { cookie: s.cookie } });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), OFF);
  } finally {
    await srv.close();
  }
});

test('changing the startup state passes every write guard before touching the scheduler', async () => {
  const srv = await start();
  try {
    const s = await session(srv);
    const refusals = [
      [{ enabled: true }, { [DASHBOARD_CSRF_HEADER]: 'wrong' }, 403],
      [{ enabled: true }, { 'sec-fetch-site': 'cross-site' }, 403],
      [{ enabled: true }, { origin: 'http://evil.example' }, 403],
      [{ enabled: true }, { cookie: 'tc_dash_1=nope' }, 403],
      [{ enabled: true }, { 'content-type': 'text/plain' }, 415],
      [{ enabled: 'yes' }, {}, 400],
      [{ enabled: true, dashboard: 'yes' }, {}, 400],
      ['not json', {}, 400],
      [{ enabled: true, pad: 'x'.repeat(2000) }, {}, 413],
    ];
    for (const [payload, headers, expected] of refusals) {
      const res = await post(srv, s, payload, headers);
      assert.equal(res.status, expected, `${JSON.stringify(headers)} ${String(JSON.stringify(payload)).slice(0, 40)}`);
    }
    assert.deepEqual(srv.calls, [], 'no refused request reached the scheduler');
    const put = await request(srv.port, PATH, { method: 'PUT', headers: { cookie: s.cookie } });
    assert.equal(put.status, 405);
  } finally {
    await srv.close();
  }
});

test('turning startup on (with the dashboard) and off returns the new state', async () => {
  const srv = await start();
  try {
    const s = await session(srv);
    const on = await post(srv, s, { enabled: true, dashboard: true });
    assert.equal(on.status, 200);
    assert.equal(JSON.parse(on.body).dashboard, true);
    const off = await post(srv, s, { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(JSON.parse(off.body).registered, false);
    assert.deepEqual(srv.calls, [{ enabled: true, dashboard: true }, { enabled: false, dashboard: false }]);
  } finally {
    await srv.close();
  }
});

test('a scheduler failure is reported as an autostart error, not a worker outage', async () => {
  const srv = await start({ failSet: true });
  try {
    const s = await session(srv);
    const res = await post(srv, s, { enabled: true });
    assert.equal(res.status, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.error.reason, 'autostart');
    assert.match(body.error.message, /Access is denied/);
  } finally {
    await srv.close();
  }
});

test('without an autostart controller (non-Windows) the route is 404 and the switch is not offered', async () => {
  const srv = await start({ autostart: false });
  try {
    const s = await session(srv);
    assert.equal(s.status.dashboard.autostart, undefined);
    assert.equal((await request(srv.port, PATH, { headers: { cookie: s.cookie } })).status, 404);
  } finally {
    await srv.close();
  }
});

test('the startup card renders the state, warnings and busy lock', () => {
  const ko = dashboardText('ko');
  const en = dashboardText('en');
  assert.match(renderAutostartHtml(null, ko), /작업 스케줄러 확인 중/);
  assert.match(renderAutostartHtml(null, ko, { error: 'boom' }), /작업 스케줄러 오류: boom/);
  assert.equal(renderAutostartHtml({ supported: false }, en), '');

  const off = renderAutostartHtml(OFF, en);
  assert.doesNotMatch(off, /data-autostart="enabled"[^>]*checked/);
  assert.match(off, /data-autostart="dashboard"[^>]*disabled/, 'the dashboard option needs startup on');

  const on = renderAutostartHtml({ ...OFF, registered: true, enabled: true, dashboard: true, taskName: 'T<x>' }, en);
  assert.match(on, /data-autostart="enabled"[^>]*checked/);
  assert.match(on, /data-autostart="dashboard"[^>]*checked/);
  assert.doesNotMatch(on, /data-autostart="dashboard"[^>]*disabled/);
  assert.match(on, /T&lt;x&gt;/, 'the task name is escaped');

  const busy = renderAutostartHtml({ ...OFF, registered: true, enabled: true }, en, { busy: true });
  assert.equal((busy.match(/ disabled>/g) || []).length, 2);

  const warn = renderAutostartHtml({ ...OFF, registered: true, enabled: false, disabledInScheduler: true, stale: true }, en);
  assert.match(warn, /disabled in Task Scheduler/);
  assert.match(warn, /different Node/);
  assert.doesNotMatch(warn, /data-autostart="enabled"[^>]*checked/, 'a disabled task reads as off');
});
