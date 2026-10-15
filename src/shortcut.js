// Windows shortcuts (.lnk) that open the dashboard with one click.
//
// `teamclaude shortcut --desktop|--start-menu|--dir <path> [--remove]` lands
// here. A shortcut runs the same hidden launcher as the logon task
// (src/autostart.js `buildAutostartAction`): `conhost.exe --headless <node>
// <entry> [codex] autostart launch --config <path> --dashboard`, which starts
// the proxy when none answers yet and then opens the dashboard window.
// Targeting node.exe directly would open a terminal window for the whole
// launch (measured 2026-10-14: three Windows Terminal windows; zero with the
// headless conhost).
//
// Every path in the shortcut is absolute. A server started from a relative
// entry path cannot be matched by the CLI's process-identity check from
// another directory, so `stop`/live reload would refuse it.
//
// Values reach PowerShell through environment variables, never by splicing
// them into the script (same rule as src/autostart.js).

import { execFile } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAutostartAction, powershellBin } from './autostart.js';
import { spawnTarget } from './spawn-target.js';

/** assets/teamclaude.ico next to src/ (shipped through package.json `files`). */
export const SHORTCUT_ICON_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'teamclaude.ico');

// Shell folders resolved by [Environment]::GetFolderPath: the Desktop may be
// redirected (OneDrive), so %USERPROFILE%\Desktop is not a safe guess.
export const SHORTCUT_FOLDERS = Object.freeze({ desktop: 'Desktop', 'start-menu': 'Programs' });

const SHORTCUT_TIMEOUT_MS = 30_000;

function requireAbsolute(label, value) {
  if (!value || !isAbsolute(String(value))) throw new Error(`${label} must be an absolute path: ${value}`);
  return String(value);
}

/** What one shortcut contains. Pure; every path must already be absolute. */
export function buildShortcutSpec({
  nodePath,
  entryPath,
  provider,
  configPath,
  iconPath = SHORTCUT_ICON_PATH,
  systemRoot,
}) {
  const action = buildAutostartAction({
    nodePath: requireAbsolute('node path', nodePath),
    entryPath: requireAbsolute('entry path', entryPath),
    provider,
    configPath: requireAbsolute('config path', configPath),
    dashboard: true,
    ...(systemRoot ? { systemRoot } : {}),
  });
  const codex = provider === 'codex';
  return {
    fileName: codex ? 'TeamCodex.lnk' : 'TeamClaude.lnk',
    target: action.execute,
    arguments: action.arguments,
    workingDirectory: dirname(entryPath),
    iconLocation: `${requireAbsolute('icon path', iconPath)},0`,
    description: codex
      ? 'Open the TeamCodex dashboard (starts the proxy if needed)'
      : 'Open the TeamClaude dashboard (starts the proxy if needed)',
  };
}

const PS_PREAMBLE = [
  "$ErrorActionPreference = 'Stop'",
  '$dir = if ($env:TC_SHORTCUT_SPECIAL) { [Environment]::GetFolderPath($env:TC_SHORTCUT_SPECIAL) } else { $env:TC_SHORTCUT_DIR }',
  "if (-not $dir) { throw 'shortcut folder could not be resolved' }",
  '$path = Join-Path $dir $env:TC_SHORTCUT_FILE',
].join('\n');

export const SHORTCUT_SCRIPTS = Object.freeze({
  create: `${PS_PREAMBLE}
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
$lnk.TargetPath = $env:TC_SHORTCUT_TARGET
$lnk.Arguments = $env:TC_SHORTCUT_ARGUMENTS
$lnk.WorkingDirectory = $env:TC_SHORTCUT_WORKDIR
$lnk.IconLocation = $env:TC_SHORTCUT_ICON
$lnk.Description = $env:TC_SHORTCUT_DESCRIPTION
$lnk.Save()
[pscustomobject]@{ path = $path } | ConvertTo-Json -Compress`,
  remove: `${PS_PREAMBLE}
$removed = Test-Path -LiteralPath $path
if ($removed) { Remove-Item -LiteralPath $path }
[pscustomobject]@{ path = $path; removed = $removed } | ConvertTo-Json -Compress`,
});

/** Where a location flag points: a shell folder name or an explicit directory. */
export function shortcutFolderValues(location) {
  if (location.special) return { SPECIAL: location.special };
  return { DIR: resolve(location.dir) };
}

/** Create or remove one shortcut; resolves `{ path, removed? }`. */
export function runShortcutScript(op, spec, location, env = process.env) {
  const script = SHORTCUT_SCRIPTS[op];
  if (!script) return Promise.reject(new Error(`unknown shortcut operation: ${op}`));
  const values = {
    ...shortcutFolderValues(location),
    FILE: spec.fileName,
    TARGET: spec.target,
    ARGUMENTS: spec.arguments,
    WORKDIR: spec.workingDirectory,
    ICON: spec.iconLocation,
    DESCRIPTION: spec.description,
  };
  const childEnv = { ...env };
  for (const [key, value] of Object.entries(values)) childEnv[`TC_SHORTCUT_${key}`] = String(value);
  const [cmd, cmdArgs] = spawnTarget(powershellBin(env), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ]);
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, cmdArgs, {
      env: childEnv,
      encoding: 'utf8',
      windowsHide: true,
      timeout: SHORTCUT_TIMEOUT_MS,
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
        reject(new Error(`unexpected PowerShell answer: ${line.slice(0, 200) || '(empty)'}`));
      }
    });
  });
}

