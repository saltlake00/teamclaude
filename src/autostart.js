// Windows logon autostart through the per-user Task Scheduler.
//
// `teamclaude autostart enable|disable|status` and the web dashboard switch
// both land here. The task runs at logon of the CURRENT user, at the user's
// normal (limited) rights, so registering it needs no administrator:
// `Register-ScheduledTask` with an explicit principal works unelevated, while
// `schtasks /create /sc onlogon` is refused with "Access is denied" (measured
// on Windows 11 26200, 2026-10-14).
//
// The action is `conhost.exe --headless <node> <entry> [codex] autostart launch
// --config <path> [--dashboard]`. node.exe is a console program, so starting
// it directly from a logon task opens a terminal window; a headless conhost
// gives it a console nobody sees. The launcher only starts the server (hidden,
// logging to a file next to the config) when none answers yet, then exits.
//
// The scheduled task is the single source of truth: "enabled" means the task
// exists and is not disabled in Task Scheduler, and the dashboard option is
// the `--dashboard` flag inside the task's own arguments. Nothing is mirrored
// into the config file, so a task removed by hand reads as off.
//
// Values reach PowerShell through environment variables, never by splicing
// them into the script, so a path with quotes or `$` cannot change the command.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnTarget } from './spawn-target.js';

export const AUTOSTART_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const AUTOSTART_LAUNCH_WAIT_MS = 60_000;
const SCHEDULER_TIMEOUT_MS = 60_000;

export function autostartSupported(platform = process.platform) {
  return platform === 'win32';
}

/** The config file a provider uses when neither TEAMCLAUDE_CONFIG nor XDG_CONFIG_HOME is set. */
export function defaultConfigPath(provider, home = homedir()) {
  return join(home, '.config', provider === 'codex' ? 'teamcodex.json' : 'teamclaude.json');
}

function samePath(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

/**
 * One task per provider and config file. The default config keeps a readable
 * name; any other config (a test, a second pool) gets a short hash suffix so
 * it can never replace the real one.
 */
export function autostartTaskName({ provider, configPath, home = homedir() }) {
  const base = provider === 'codex' ? 'TeamCodex-Autostart' : 'TeamClaude-Autostart';
  if (samePath(configPath, defaultConfigPath(provider, home))) return base;
  const digest = createHash('sha1').update(resolve(configPath).toLowerCase()).digest('hex').slice(0, 8);
  return `${base}-${digest}`;
}

/** `<config without .json>.log`, next to the `.server.json` state file. */
export function autostartLogPath(configPath) {
  return configPath.replace(/\.json$/, '') + '.log';
}

/** Quote one argument the way the MSVC runtime (and node.exe) splits command lines. */
export function quoteWindowsArg(arg) {
  const s = String(arg);
  if (s !== '' && !/[\s"]/.test(s)) return s;
  let out = '"';
  let slashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      slashes += 1;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(slashes) + ch;
    }
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

/**
 * The task action for this runtime. `nodePath` and `entryPath` must be absolute:
 * a relative entry would be resolved against the task's working directory, and
 * the CLI's process-identity check cannot match a server started that way.
 */
export function buildAutostartAction({
  nodePath,
  entryPath,
  provider,
  configPath,
  dashboard = false,
  systemRoot = process.env.SystemRoot || 'C:\\Windows',
}) {
  const launchArgs = [
    nodePath,
    resolve(entryPath),
    ...(provider === 'codex' ? ['codex'] : []),
    'autostart',
    'launch',
    '--config',
    resolve(configPath),
    ...(dashboard ? ['--dashboard'] : []),
  ];
  return {
    execute: join(systemRoot, 'System32', 'conhost.exe'),
    arguments: ['--headless', ...launchArgs.map(quoteWindowsArg)].join(' '),
  };
}

function withoutDashboardFlag(args) {
  return String(args).replace(/\s--dashboard(?=\s|$)/g, '');
}

/**
 * Status from a queried task (null = no task). `stale` means the task starts a
 * different node, entry or config than this runtime would register, e.g. after
 * Node was reinstalled elsewhere — enabling again rewrites it.
 */
export function describeAutostart(task, expected, taskName) {
  if (!task) return { supported: true, taskName, registered: false, enabled: false, dashboard: false, stale: false };
  const args = String(task.arguments ?? '');
  const disabledInScheduler = task.state === 'Disabled';
  return {
    supported: true,
    taskName,
    registered: true,
    enabled: !disabledInScheduler,
    disabledInScheduler,
    dashboard: /\s--dashboard(?=\s|$)/.test(args),
    stale: !expected
      ? false
      : String(task.execute ?? '').toLowerCase() !== expected.execute.toLowerCase()
        || withoutDashboardFlag(args) !== withoutDashboardFlag(expected.arguments),
  };
}

const PS_PREAMBLE = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "$name = $env:TC_AUTOSTART_TASK",
  "$found = Get-ScheduledTask -TaskPath '\\' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq $name }",
].join('\n');

export const SCHEDULER_SCRIPTS = Object.freeze({
  query: `${PS_PREAMBLE}
if ($null -eq $found) { '{"task":null}'; exit 0 }
$a = @($found.Actions)[0]
[pscustomobject]@{ task = [pscustomobject]@{ state = [string]$found.State; execute = [string]$a.Execute; arguments = [string]$a.Arguments } } | ConvertTo-Json -Compress -Depth 3`,
  register: `${PS_PREAMBLE}
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $env:TC_AUTOSTART_EXECUTE -Argument $env:TC_AUTOSTART_ARGUMENTS -WorkingDirectory $env:TC_AUTOSTART_WORKDIR
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = 'PT10S'
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Starts the TeamClaude proxy at logon (teamclaude autostart).' -Force | Out-Null
'{"ok":true}'`,
  unregister: `${PS_PREAMBLE}
if ($null -eq $found) { '{"removed":false}'; exit 0 }
Unregister-ScheduledTask -TaskName $name -TaskPath '\\' -Confirm:$false
'{"removed":true}'`,
});

/** Absolute Windows PowerShell (a PATH lookup could be shadowed); TEAMCLAUDE_POWERSHELL_BIN overrides it (tests). */
export function powershellBin(env = process.env) {
  if (env.TEAMCLAUDE_POWERSHELL_BIN) return env.TEAMCLAUDE_POWERSHELL_BIN;
  return join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Run one scheduler script; resolves its parsed JSON answer, rejects with PowerShell's error text. */
export function runSchedulerScript(op, values = {}, env = process.env) {
  const script = SCHEDULER_SCRIPTS[op];
  if (!script) return Promise.reject(new Error(`unknown scheduler operation: ${op}`));
  const [cmd, cmdArgs] = spawnTarget(powershellBin(env), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ]);
  const childEnv = { ...env, TC_AUTOSTART_OP: op };
  for (const [key, value] of Object.entries(values)) childEnv[`TC_AUTOSTART_${key}`] = String(value);
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, cmdArgs, {
      env: childEnv,
      encoding: 'utf8',
      windowsHide: true,
      timeout: SCHEDULER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(' ');
        reject(new Error(detail || err.message));
        return;
      }
      const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try {
        resolvePromise(JSON.parse(line));
      } catch {
        reject(new Error(`unexpected Task Scheduler answer: ${line.slice(0, 200) || '(empty)'}`));
      }
    });
  });
}

/**
 * The autostart controller for one runtime (the CLI and the supervisor both
 * build one). Calls are serialized so a double click cannot interleave a
 * register with an unregister.
 */
export function createAutostart({
  nodePath = process.execPath,
  entryPath,
  provider,
  configPath,
  env = process.env,
  platform = process.platform,
  home = homedir(),
}) {
  const taskName = autostartTaskName({ provider, configPath, home });
  const expected = (dashboard = false) => buildAutostartAction({
    nodePath, entryPath, provider, configPath, dashboard, systemRoot: env.SystemRoot,
  });
  let chain = Promise.resolve();
  const serial = fn => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  async function read() {
    if (!autostartSupported(platform)) return { supported: false, taskName };
    const answer = await runSchedulerScript('query', { TASK: taskName }, env);
    return describeAutostart(answer?.task ?? null, expected(), taskName);
  }

  async function set({ enabled, dashboard = false }) {
    if (!autostartSupported(platform)) throw new Error('Autostart is only available on Windows.');
    if (enabled) {
      const action = expected(Boolean(dashboard));
      await runSchedulerScript('register', {
        TASK: taskName,
        EXECUTE: action.execute,
        ARGUMENTS: action.arguments,
        WORKDIR: home,
      }, env);
    } else {
      await runSchedulerScript('unregister', { TASK: taskName }, env);
    }
    return read();
  }

  return {
    taskName,
    logPath: autostartLogPath(resolve(configPath)),
    read: () => serial(read),
    set: opts => serial(() => set(opts)),
  };
}
