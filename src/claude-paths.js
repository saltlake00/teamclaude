import { homedir } from 'node:os';
import { join } from 'node:path';

// Claude Code keeps credentials and transcripts under CLAUDE_CONFIG_DIR when it
// is set, and under ~/.claude otherwise. Follow the same rule so import and
// transcript lookups read the account the client is actually logged into.
export function claudeConfigDir(env = process.env) {
  const dir = env?.CLAUDE_CONFIG_DIR;
  return typeof dir === 'string' && dir.trim() !== '' ? dir : join(homedir(), '.claude');
}

export function claudeCredentialsPath(env = process.env) {
  return join(claudeConfigDir(env), '.credentials.json');
}

export function claudeTranscriptRoot(env = process.env) {
  return join(claudeConfigDir(env), 'projects');
}
