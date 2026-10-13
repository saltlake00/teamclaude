import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnTarget } from '../src/spawn-target.js';

test('native launchers pass through unchanged', () => {
  assert.deepEqual(spawnTarget('claude', ['--model', 'sonnet']), ['claude', ['--model', 'sonnet']]);
  assert.deepEqual(spawnTarget('C:\\bin\\claude.exe', ['-p']), ['C:\\bin\\claude.exe', ['-p']]);
});

test('script launchers run under this Node with the script first', () => {
  for (const ext of ['.js', '.mjs', '.cjs', '.JS']) {
    const bin = join('fake', `claude${ext}`);
    assert.deepEqual(spawnTarget(bin, ['--resume', 'abc'], '/node'), ['/node', [bin, '--resume', 'abc']]);
  }
});

test('a .js launcher receives the original argv when spawned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-spawn-target-'));
  try {
    const script = join(dir, 'claude.js');
    await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const result = spawnSync(...spawnTarget(script, ['--model', 'fable', 'two words']), { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['--model', 'fable', 'two words']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
