// Windows logon autostart (src/autostart.js + `teamclaude autostart`).
//
// The real Task Scheduler is never touched: the CLI tests point
// TEAMCLAUDE_POWERSHELL_BIN at a fake that keeps "tasks" in a JSON file and
// records every call, so they check what the CLI asks for (one task per
// config, re-enabling replaces it, --config names the same task everywhere)
// without registering anything at logon. The launch tests start a real proxy
// from a temp config exactly as the logon task would, and stop it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  autostartLogPath,
  autostartTaskName,
  buildAutostartAction,
  defaultConfigPath,
  describeAutostart,
  powershellBin,
  quoteWindowsArg,
} from '../src/autostart.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const windowsOnly = process.platform === 'win32' ? false : 'Task Scheduler autostart is Windows-only';

// ── pure helpers ──

test('task name: readable for the default config, hashed per other config, per provider', () => {
  const home = 'C:\\Users\\me';
  const def = defaultConfigPath('anthropic', home);
  assert.equal(autostartTaskName({ provider: 'anthropic', configPath: def, home }), 'TeamClaude-Autostart');
  assert.equal(autostartTaskName({ provider: 'anthropic', configPath: def.toUpperCase(), home }), 'TeamClaude-Autostart');
  assert.equal(autostartTaskName({ provider: 'codex', configPath: defaultConfigPath('codex', home), home }), 'TeamCodex-Autostart');
  const a = autostartTaskName({ provider: 'anthropic', configPath: 'D:\\tmp\\a.json', home });
  const b = autostartTaskName({ provider: 'anthropic', configPath: 'D:\\tmp\\b.json', home });
  assert.match(a, /^TeamClaude-Autostart-[0-9a-f]{8}$/);
  assert.notEqual(a, b, 'two configs never share (and replace) one task');
  assert.equal(a, autostartTaskName({ provider: 'anthropic', configPath: 'D:\\tmp\\a.json', home }), 'stable');
});

test('log path sits next to the config', () => {
  assert.equal(autostartLogPath('C:\\x\\teamclaude.json'), 'C:\\x\\teamclaude.log');
});

test('Windows argument quoting round-trips through the MSVC rules', () => {
  assert.equal(quoteWindowsArg('C:\\plain\\node.exe'), 'C:\\plain\\node.exe');
  assert.equal(quoteWindowsArg('C:\\Program Files\\nodejs\\node.exe'), '"C:\\Program Files\\nodejs\\node.exe"');
  assert.equal(quoteWindowsArg('C:\\with space\\'), '"C:\\with space\\\\"', 'a trailing backslash is doubled before the closing quote');
  assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArg(''), '""');
});

test('the task action runs node hidden under a headless conhost with absolute paths', () => {
  const action = buildAutostartAction({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    entryPath: 'C:\\repo\\src\\index.js',
    provider: 'anthropic',
    configPath: 'C:\\Users\\me\\.config\\teamclaude.json',
    systemRoot: 'C:\\Windows',
  });
  assert.equal(action.execute, join('C:\\Windows', 'System32', 'conhost.exe'));
  assert.ok(action.arguments.startsWith('--headless "C:\\Program Files\\nodejs\\node.exe" '));
  assert.match(action.arguments, / autostart launch --config /);
  assert.doesNotMatch(action.arguments, /--dashboard/);

  const codex = buildAutostartAction({
    nodePath: 'C:\\n\\node.exe', entryPath: 'C:\\repo\\src\\index.js', provider: 'codex',
    configPath: 'C:\\c.json', dashboard: true, systemRoot: 'C:\\Windows',
  });
  assert.match(codex.arguments, /index\.js codex autostart launch --config C:\\c\.json --dashboard$/);
});

test('status reading: off, on, disabled by hand, dashboard flag, stale paths', () => {
  const expected = buildAutostartAction({
    nodePath: 'C:\\n\\node.exe', entryPath: 'C:\\repo\\src\\index.js', provider: 'anthropic',
    configPath: 'C:\\c.json', systemRoot: 'C:\\Windows',
  });
  assert.deepEqual(describeAutostart(null, expected, 'T'),
    { supported: true, taskName: 'T', registered: false, enabled: false, dashboard: false, stale: false });
  const on = describeAutostart({ state: 'Ready', ...expected }, expected, 'T');
  assert.equal(on.enabled, true);
  assert.equal(on.stale, false);
  const withDashboard = describeAutostart({ state: 'Running', execute: expected.execute, arguments: `${expected.arguments} --dashboard` }, expected, 'T');
  assert.equal(withDashboard.dashboard, true);
  assert.equal(withDashboard.stale, false, 'the dashboard flag alone is not staleness');
  const disabled = describeAutostart({ state: 'Disabled', ...expected }, expected, 'T');
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.disabledInScheduler, true);
  const moved = describeAutostart({ state: 'Ready', execute: expected.execute, arguments: expected.arguments.replace('C:\\n\\node.exe', 'D:\\old\\node.exe') }, expected, 'T');
  assert.equal(moved.stale, true);
});

test('PowerShell is called by absolute path unless overridden', () => {
  assert.equal(powershellBin({ SystemRoot: 'C:\\Windows' }),
    join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.equal(powershellBin({ TEAMCLAUDE_POWERSHELL_BIN: 'C:\\fake.js' }), 'C:\\fake.js');
});

// ── CLI against a fake Task Scheduler ──

const FAKE_POWERSHELL = `
const fs = require('node:fs');
const store = process.env.FAKE_SCHEDULER_STORE;
const tasks = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {};
const op = process.env.TC_AUTOSTART_OP;
const name = process.env.TC_AUTOSTART_TASK;
fs.appendFileSync(store + '.calls', JSON.stringify({ op, name }) + '\\n');
if (op === 'query') {
  const t = tasks[name];
  console.log(JSON.stringify({ task: t ? { state: t.state, execute: t.execute, arguments: t.arguments } : null }));
} else if (op === 'register') {
  tasks[name] = { state: 'Ready', execute: process.env.TC_AUTOSTART_EXECUTE, arguments: process.env.TC_AUTOSTART_ARGUMENTS, workdir: process.env.TC_AUTOSTART_WORKDIR };
  fs.writeFileSync(store, JSON.stringify(tasks));
  console.log('{"ok":true}');
} else if (op === 'unregister') {
  const removed = Boolean(tasks[name]);
  delete tasks[name];
  fs.writeFileSync(store, JSON.stringify(tasks));
  console.log(JSON.stringify({ removed }));
} else {
  console.error('unknown op ' + op);
  process.exit(3);
}
`;

async function fakeScheduler(dir) {
  const bin = join(dir, 'fake-powershell.cjs');
  await writeFile(bin, FAKE_POWERSHELL);
  const store = join(dir, 'tasks.json');
  return {
    env: { TEAMCLAUDE_POWERSHELL_BIN: bin, FAKE_SCHEDULER_STORE: store },
    tasks: async () => (existsSync(store) ? JSON.parse(await readFile(store, 'utf8')) : {}),
  };
}

function runCli(cliArgs, env, timeout = 60_000) {
  return new Promise(resolve => {
    execFile(process.execPath, [entry, ...cliArgs], { encoding: 'utf8', env, timeout, windowsHide: true },
      (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

function baseEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.TEAMCLAUDE_PROVIDER;
  return env;
}

test('enable registers one task; enabling again replaces it instead of adding a second', { skip: windowsOnly, timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-autostart-'));
  try {
    const sched = await fakeScheduler(dir);
    const configPath = join(dir, 'config.json');
    const env = baseEnv({ ...sched.env, TEAMCLAUDE_CONFIG: configPath });
    const name = autostartTaskName({ provider: 'anthropic', configPath });

    const first = await runCli(['autostart', 'enable'], env);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Autostart: on/);
    const second = await runCli(['autostart', 'enable', '--dashboard'], env);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Dashboard: opens at logon/);

    const tasks = await sched.tasks();
    assert.deepEqual(Object.keys(tasks), [name], 'still exactly one task');
    const task = tasks[name];
    assert.match(task.execute, /conhost\.exe$/i);
    assert.ok(task.arguments.startsWith(`--headless ${quoteWindowsArg(process.execPath)} ${quoteWindowsArg(entry)} autostart launch --config `));
    assert.ok(task.arguments.includes(quoteWindowsArg(configPath)), 'the config path is absolute and explicit');
    assert.match(task.arguments, / --dashboard$/);

    const status = await runCli(['autostart'], env);
    assert.match(status.stdout, new RegExp(`Task:\\s+${name}`));
    assert.doesNotMatch(status.stdout, /Warning/, 'a task registered by this runtime is not stale');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('disable removes the task; disabling again says it was already off', { skip: windowsOnly, timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-autostart-'));
  try {
    const sched = await fakeScheduler(dir);
    const env = baseEnv({ ...sched.env, TEAMCLAUDE_CONFIG: join(dir, 'config.json') });
    assert.equal((await runCli(['autostart', 'enable'], env)).status, 0);
    const off = await runCli(['autostart', 'disable'], env);
    assert.equal(off.status, 0, off.stderr);
    assert.match(off.stdout, /Autostart disabled: removed/);
    assert.deepEqual(await sched.tasks(), {});
    const again = await runCli(['autostart', 'disable'], env);
    assert.match(again.stdout, /already off/);
    assert.match((await runCli(['autostart', 'status'], env)).stdout, /Autostart: off/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('--config names the same task for enable, status and disable (no TEAMCLAUDE_CONFIG)', { skip: windowsOnly, timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-autostart-'));
  try {
    const sched = await fakeScheduler(dir);
    const configPath = join(dir, 'other.json');
    const env = baseEnv(sched.env);
    delete env.TEAMCLAUDE_CONFIG;
    const name = autostartTaskName({ provider: 'anthropic', configPath });

    assert.equal((await runCli(['autostart', 'enable', '--config', configPath], env)).status, 0);
    assert.deepEqual(Object.keys(await sched.tasks()), [name], 'named after --config, not the default config');
    assert.match((await runCli(['autostart', '--config', configPath], env)).stdout, /Autostart: on/);
    const off = await runCli(['autostart', 'disable', '--config', configPath], env);
    assert.match(off.stdout, /Autostart disabled: removed/);
    assert.deepEqual(await sched.tasks(), {});
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('a scheduler failure is reported with its message and a non-zero exit', { skip: windowsOnly, timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-autostart-'));
  try {
    const bin = join(dir, 'broken-powershell.cjs');
    await writeFile(bin, "console.error('Register-ScheduledTask : Access is denied.'); process.exit(1);\n");
    const env = baseEnv({ TEAMCLAUDE_POWERSHELL_BIN: bin, TEAMCLAUDE_CONFIG: join(dir, 'config.json') });
    const res = await runCli(['autostart', 'enable'], env);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Autostart enable failed: .*Access is denied/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

// ── launch: what the logon task runs ──

async function unusedPort() {
  const holder = http.createServer();
  await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address();
  await new Promise(resolve => holder.close(resolve));
  return port;
}

async function killRecordedServer(statePath) {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    for (const pid of [state.workerPid, state.pid]) {
      try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  } catch { /* no state */ }
}

test('launch starts one hidden proxy from absolute paths, logs it, and does not start a second', { timeout: 180_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-autostart-launch-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'config.server.json');
  const port = await unusedPort();
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-autostart-test' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    accounts: [{ name: 'api-a', type: 'apikey', apiKey: 'test-api-key' }],
  }));
  // Like the logon task: no TEAMCLAUDE_CONFIG, only --config.
  const env = baseEnv({});
  delete env.TEAMCLAUDE_CONFIG;
  try {
    const first = await runCli(['autostart', 'launch', '--config', configPath], env, 90_000);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const status = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
    assert.equal(status.status, 200);

    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.ok(state.lifecycle.supervisor.command.includes(entry), 'the supervisor runs the absolute entry path');
    const log = await readFile(join(dir, 'config.log'), 'utf8');
    assert.match(log, /\[autostart\] launch .*starting the proxy/);
    assert.match(log, /\[autostart\] proxy started on port \d+/);
    assert.match(log, /\[TeamClaude\]|TeamClaude/, 'the proxy writes its own output to the same log');

    const second = await runCli(['autostart', 'launch', '--config', configPath], env, 90_000);
    assert.equal(second.status, 0, second.stderr);
    assert.match(await readFile(join(dir, 'config.log'), 'utf8'), /proxy already running on port \d+ .*not starting another/);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).pid, state.pid, 'the same server is still the one running');

    // The CLI may spell the same config differently (forward slashes, case)
    // and must still recognise — and stop — the server the task started.
    const respelled = process.platform === 'win32'
      ? `${dirname(configPath).toLowerCase().replace(/\\/g, '/')}/config.json`
      : configPath;
    let stopped = await runCli(['stop'], baseEnv({ TEAMCLAUDE_CONFIG: respelled }), 60_000);
    if (/could not be verified/.test(stopped.stderr)) {
      // One refusal under load is known (identity read via PowerShell); retry once.
      await delay(500);
      stopped = await runCli(['stop'], baseEnv({ TEAMCLAUDE_CONFIG: respelled }), 60_000);
    }
    assert.match(`${stopped.stdout}${stopped.stderr}`, /Stopped TeamClaude server/);
  } finally {
    await killRecordedServer(statePath);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('launch logs a proxy that refuses to start and exits non-zero', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-autostart-launch-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: await unusedPort(), apiKey: 'tc-autostart-test' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    accounts: [],
  }));
  const env = baseEnv({});
  delete env.TEAMCLAUDE_CONFIG;
  try {
    const res = await runCli(['autostart', 'launch', '--config', configPath], env, 90_000);
    assert.notEqual(res.status, 0);
    const log = await readFile(join(dir, 'config.log'), 'utf8');
    assert.match(log, /No accounts configured/);
    assert.match(log, /\[autostart\] failed: Proxy failed to start/);
  } finally {
    await killRecordedServer(join(dir, 'config.server.json'));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
