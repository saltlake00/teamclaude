// Fake claude/codex launchers for CLI tests.
//
// POSIX: the fake is an extension-less shebang script that a PATH lookup finds.
// Windows: CreateProcess cannot run a shebang script and a PATH lookup only
// finds .exe/.com, so the fake is a .js file that the launcher runs under Node
// (src/spawn-target.js) and that must be named through the *_BIN override.
import { delimiter, join } from 'node:path';

const isWindows = process.platform === 'win32';

export function fakeCliPath(dir, name) {
  return join(dir, isWindows ? `${name}.js` : name);
}

export function pathWith(dir, rest = process.env.PATH) {
  return `${dir}${delimiter}${rest}`;
}

// Spread into a child env next to PATH. Empty on POSIX so the PATH lookup stays
// the thing under test there.
export function fakeClaudeEnv(fakePath) {
  return isWindows ? { TEAMCLAUDE_CLAUDE_BIN: fakePath } : {};
}

export function fakeCodexEnv(fakePath) {
  return isWindows ? { TEAMCODEX_CODEX_BIN: fakePath } : {};
}

// Point the child at a throwaway home. Windows os.homedir() reads USERPROFILE,
// not HOME, and an inherited CLAUDE_CONFIG_DIR would move the transcript root
// out of that home (spawn ignores undefined values, so this unsets it).
export function isolatedHome(root) {
  return { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: undefined };
}
