import { extname } from 'node:path';

const NODE_SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

// A launcher given as a .js/.mjs/.cjs file runs under this Node. Windows can only
// spawn .exe/.com without a shell, so this is how a script launcher (and the test
// fakes) can stand in for claude/codex there. Native binaries pass through as-is.
export function spawnTarget(bin, args, execPath = process.execPath) {
  if (NODE_SCRIPT_EXTENSIONS.has(extname(bin).toLowerCase())) {
    return [execPath, [bin, ...args]];
  }
  return [bin, args];
}
