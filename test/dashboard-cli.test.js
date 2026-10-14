import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('teamclaude dashboard --print opens a one-time URL that unlocks account names', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-dashboard-'));
  const configPath = join(dir, 'config.json');
  const port = await unusedPort();
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-dashboard-test' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    language: 'ko',
    accounts: [{ name: 'api-dash', type: 'apikey', apiKey: 'test-api-key' }],
  }));
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  delete env.TEAMCLAUDE_PROVIDER;
  delete env.TEAMCLAUDE_LANG;
  const child = spawn(process.execPath, [entry, 'server'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.resume();
  child.stderr.resume();

  try {
    await waitForStatus(port);

    const page = await fetch(`http://127.0.0.1:${port}/teamclaude/dashboard`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html lang="ko"/, 'config language reaches the page');

    const anonymous = await (await fetch(`http://127.0.0.1:${port}/teamclaude/dashboard/status`)).json();
    assert.equal(anonymous.dashboard.identity, false);
    assert.equal(anonymous.accounts[0].name, undefined);
    assert.equal(anonymous.totalCount, 1);

    const printed = await runCli(['dashboard', '--print'], env);
    assert.equal(printed.status, 0, printed.stderr);
    const url = printed.stdout.trim();
    assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/teamclaude/dashboard\\?code=[A-Za-z0-9_-]+$`));

    const exchanged = await fetch(url, { redirect: 'manual' });
    assert.equal(exchanged.status, 303);
    const cookie = exchanged.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'the printed URL must mint a session cookie');

    const named = await (await fetch(`http://127.0.0.1:${port}/teamclaude/dashboard/status`, { headers: { cookie } })).json();
    assert.equal(named.dashboard.identity, true);
    assert.equal(named.accounts[0].name, 'api-dash');
    assert.equal('lifecycleId' in named, false);

    // The same URL cannot be replayed.
    const replay = await fetch(url, { redirect: 'manual' });
    assert.equal(replay.headers.get('set-cookie'), null);
  } finally {
    await stopChild(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaude dashboard reports a missing server instead of opening anything', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-dashboard-none-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: await unusedPort(), apiKey: 'tc-dashboard-test' },
    accounts: [],
  }));
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  delete env.TEAMCLAUDE_PROVIDER;
  try {
    const res = await runCli(['dashboard'], env);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /No running proxy/);
    assert.equal(res.stdout, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
