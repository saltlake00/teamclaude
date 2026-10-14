import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function unusedPort() {
  const holder = http.createServer();
  await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address();
  await new Promise(resolve => holder.close(resolve));
  return port;
}

async function waitForStatus(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
      if (res.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('proxy did not start');
}

function runCli(cliArgs, env) {
  return new Promise(resolve => {
    execFile(process.execPath, [entry, ...cliArgs], { encoding: 'utf8', env, timeout: 30_000 },
      (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(6500)]);
  if (child.exitCode == null && child.signalCode == null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

/** What the dashboard page sends: same-origin fetch metadata, cookie and CSRF header. */
function postAction(port, { cookie, csrf }, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/teamclaude/dashboard/action',
      method: 'POST',
      agent: false,
      headers: {
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'x-teamclaude-csrf': csrf,
        cookie,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('dashboard actions reach the config file and the running worker', { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-dashboard-actions-'));
  const configPath = join(dir, 'config.json');
  const port = await unusedPort();
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-dashboard-actions-test' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    tokenRefreshIntervalMs: 0,
    accounts: [
      { name: 'api-a', type: 'apikey', apiKey: 'test-key-a' },
      { name: 'api-b', type: 'apikey', apiKey: 'test-key-b' },
    ],
  }));
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  delete env.TEAMCLAUDE_PROVIDER;
  delete env.TEAMCLAUDE_LANG;
  const child = spawn(process.execPath, [entry, 'server'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.resume();
  child.stderr.resume();

  const disk = async () => JSON.parse(await readFile(configPath, 'utf8')).accounts;
  try {
    await waitForStatus(port);
    const printed = await runCli(['dashboard', '--print'], env);
    assert.equal(printed.status, 0, printed.stderr);
    const exchanged = await fetch(printed.stdout.trim(), { redirect: 'manual' });
    const cookie = exchanged.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const named = async () => (await fetch(`http://127.0.0.1:${port}/teamclaude/dashboard/status`, { headers: { cookie } })).json();
    const first = await named();
    const csrf = first.dashboard.csrf;
    assert.ok(csrf, 'the named status carries the CSRF token');
    const session = { cookie, csrf };
    const live = (status, name) => status.accounts.find(a => a.name === name);

    const off = await postAction(port, session, { action: 'disable', name: 'api-a' });
    assert.equal(off.status, 200, off.body);
    assert.equal((await disk()).find(a => a.name === 'api-a').enabled, false, 'written to the config file');
    let status = await named();
    assert.equal(live(status, 'api-a').enabled, false, 'applied to the running worker');
    assert.equal(status.currentAccount, 'api-b', 'a disabled current account is left at once');

    const up = await postAction(port, session, { action: 'up', name: 'api-b' });
    assert.equal(up.status, 200, up.body);
    assert.equal((await disk()).find(a => a.name === 'api-b').priority, 0);
    assert.equal(live(await named(), 'api-b').priority, 0);

    const on = await postAction(port, session, { action: 'enable', name: 'api-a' });
    assert.equal(on.status, 200, on.body);
    assert.equal('enabled' in (await disk()).find(a => a.name === 'api-a'), false);

    const switched = await postAction(port, session, { action: 'switch', name: 'api-a' });
    assert.equal(switched.status, 200, switched.body);
    status = await named();
    assert.equal(status.currentAccount, 'api-a', 'switch moves the live current account');
    assert.equal(live(status, 'api-a').enabled, true);
    assert.equal((await disk()).find(a => a.name === 'api-a').priority, undefined, 'a switch persists nothing');

    const missing = await postAction(port, session, { action: 'disable', name: 'api-zzz' });
    assert.equal(missing.status, 404, missing.body);

    const forged = await postAction(port, { cookie, csrf: 'not-the-token' }, { action: 'disable', name: 'api-b' });
    assert.equal(forged.status, 403);
    assert.equal(live(await named(), 'api-b').enabled, true, 'a refused request changed nothing');
  } finally {
    await stopChild(child);
    await rm(dir, { recursive: true, force: true });
  }
});
