import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeConfigDir, claudeCredentialsPath, claudeTranscriptRoot } from '../src/claude-paths.js';
import { importCredentials } from '../src/oauth.js';

test('CLAUDE_CONFIG_DIR wins over ~/.claude for credentials and transcripts', () => {
  const env = { CLAUDE_CONFIG_DIR: join(tmpdir(), 'claude-work') };
  assert.equal(claudeConfigDir(env), env.CLAUDE_CONFIG_DIR);
  assert.equal(claudeCredentialsPath(env), join(env.CLAUDE_CONFIG_DIR, '.credentials.json'));
  assert.equal(claudeTranscriptRoot(env), join(env.CLAUDE_CONFIG_DIR, 'projects'));
});

test('unset or blank CLAUDE_CONFIG_DIR falls back to ~/.claude', () => {
  for (const env of [{}, { CLAUDE_CONFIG_DIR: '' }, { CLAUDE_CONFIG_DIR: '   ' }]) {
    assert.equal(claudeConfigDir(env), join(homedir(), '.claude'));
    assert.equal(claudeCredentialsPath(env), join(homedir(), '.claude', '.credentials.json'));
  }
});

test('import reads the credentials file under CLAUDE_CONFIG_DIR', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-claude-dir-'));
  try {
    await writeFile(join(dir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'at-from-config-dir', refreshToken: 'rt', expiresAt: 1 },
    }));
    const creds = await importCredentials(claudeCredentialsPath({ CLAUDE_CONFIG_DIR: dir }));
    assert.equal(creds.accessToken, 'at-from-config-dir');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
