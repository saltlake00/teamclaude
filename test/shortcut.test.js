import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { buildShortcutSpec, SHORTCUT_ICON_PATH } from '../src/shortcut.js';
import { isolatedHome } from './helpers/fake-cli.js';

const entry = fileURLToPath(new URL('../src/teamclaude.js', import.meta.url));
const isWindows = process.platform === 'win32';

const base = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  entryPath: 'C:\\tools\\teamclaude\\src\\teamclaude.js',
  provider: 'anthropic',
  configPath: 'C:\\Users\\me\\.config\\teamclaude.json',
  iconPath: 'C:\\tools\\teamclaude\\assets\\teamclaude.ico',
  systemRoot: 'C:\\Windows',
};

test('shortcut runs the hidden launcher with absolute paths and opens the dashboard', { skip: !isWindows }, () => {
  const spec = buildShortcutSpec(base);
  assert.equal(spec.fileName, 'TeamClaude.lnk');
  assert.equal(spec.target, 'C:\\Windows\\System32\\conhost.exe');
  assert.equal(spec.arguments,
    '--headless "C:\\Program Files\\nodejs\\node.exe" C:\\tools\\teamclaude\\src\\teamclaude.js'
    + ' autostart launch --config C:\\Users\\me\\.config\\teamclaude.json --dashboard');
  assert.equal(spec.iconLocation, 'C:\\tools\\teamclaude\\assets\\teamclaude.ico,0');
  assert.equal(spec.workingDirectory, 'C:\\tools\\teamclaude\\src');
});

test('codex shortcut targets the codex pool under its own name', { skip: !isWindows }, () => {
  const spec = buildShortcutSpec({ ...base, provider: 'codex' });
  assert.equal(spec.fileName, 'TeamCodex.lnk');
  assert.match(spec.arguments, /\\teamclaude\.js codex autostart launch --config /);
});

test('shortcut refuses relative paths', { skip: !isWindows }, () => {
  for (const key of ['nodePath', 'entryPath', 'configPath', 'iconPath']) {
    assert.throws(() => buildShortcutSpec({ ...base, [key]: 'relative\\thing' }), /must be an absolute path/, key);
  }
});

test('the default icon is the shipped asset', () => {
  assert.ok(existsSync(SHORTCUT_ICON_PATH), SHORTCUT_ICON_PATH);
  assert.equal(SHORTCUT_ICON_PATH, resolve(fileURLToPath(new URL('../assets/teamclaude.ico', import.meta.url))));
});

function runCli(cliArgs, env) {
  return new Promise(done => {
    execFile(process.execPath, [entry, ...cliArgs], { encoding: 'utf8', env, timeout: 60_000, windowsHide: true },
      (err, stdout, stderr) => done({ status: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

function readShortcut(path) {
  const script = '$l = (New-Object -ComObject WScript.Shell).CreateShortcut($env:TC_TEST_LNK);'
    + ' [pscustomobject]@{ target = $l.TargetPath; arguments = $l.Arguments; icon = $l.IconLocation; workdir = $l.WorkingDirectory } | ConvertTo-Json -Compress';
  return new Promise((done, fail) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', env: { ...process.env, TC_TEST_LNK: path }, windowsHide: true, timeout: 30_000 },
      (err, stdout, stderr) => (err ? fail(new Error(stderr || err.message)) : done(JSON.parse(stdout.trim()))));
  });
}

test('teamclaude shortcut --dir writes a .lnk with absolute paths, --remove deletes it', { skip: !isWindows }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tc-shortcut-'));
  try {
    const dir = join(root, 'with space');
    await mkdir(dir);
    const configPath = join(root, 'config.json');
    const env = { ...process.env, ...isolatedHome(root), TEAMCLAUDE_CONFIG: configPath };
    delete env.CLAUDE_CONFIG_DIR;

    const preview = await runCli(['shortcut'], env);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Arguments: --headless /);
    assert.ok(!existsSync(join(dir, 'TeamClaude.lnk')), 'preview must not write a shortcut');

    const created = await runCli(['shortcut', '--dir', dir], env);
    assert.equal(created.status, 0, created.stderr);
    const lnk = join(dir, 'TeamClaude.lnk');
    assert.ok(existsSync(lnk), created.stdout);

    const read = await readShortcut(lnk);
    assert.match(read.target, /\\System32\\conhost\.exe$/i);
    assert.ok(read.arguments.startsWith('--headless '), read.arguments);
    assert.ok(read.arguments.includes(process.execPath), read.arguments);
    assert.ok(read.arguments.includes(` ${entry} autostart launch --config ${configPath} --dashboard`), read.arguments);
    assert.equal(read.icon.toLowerCase(), `${SHORTCUT_ICON_PATH},0`.toLowerCase());
    assert.equal(resolve(read.workdir).toLowerCase(), resolve(entry, '..').toLowerCase());

    const removed = await runCli(['shortcut', '--dir', dir, '--remove'], env);
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /^Removed /m);
    assert.ok(!existsSync(lnk));

    const again = await runCli(['shortcut', '--dir', dir, '--remove'], env);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^No shortcut at /m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
