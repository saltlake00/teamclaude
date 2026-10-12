import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildResumeCommand,
  claimSessionLease,
  claimSessionOnce,
  inspectClaudeProcess,
  inspectClaudeProcessTree,
  readPrivateJson,
  releaseSessionLease,
  releaseSessionClaim,
  resolveTrustedClaudePath,
  sessionClaimExists,
  sameClaudeProcess,
  unresolvedRecoverableApiErrorState,
  validSession,
} from './cmux-session-guards.js';

const execFileAsync = promisify(execFile);

const CMUX_BINARY_CANDIDATES = [
  '/opt/homebrew/bin/cmux',
  '/usr/local/bin/cmux',
  '/Applications/cmux.app/Contents/Resources/bin/cmux',
];

// The rescue loop runs from background contexts with a minimal PATH, and a
// PATH lookup would let any earlier `cmux` on PATH receive surface commands.
// So only known absolute install locations are probed; a non-standard install
// names its binary explicitly with TEAMCLAUDE_CMUX_BIN (absolute, executable).
export async function resolveCmuxBinary(env = process.env) {
  const isExecutable = path => access(path, constants.X_OK).then(() => true, () => false);
  const override = env.TEAMCLAUDE_CMUX_BIN;
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override) || !(await isExecutable(override))) {
      throw new Error('TEAMCLAUDE_CMUX_BIN must be an absolute path to an executable cmux.');
    }
    return override;
  }
  for (const candidate of CMUX_BINARY_CANDIDATES) {
    if (await isExecutable(candidate)) return candidate;
  }
  throw new Error('Unable to resolve the cmux executable (set TEAMCLAUDE_CMUX_BIN for a non-standard install).');
}

function sessions(store) {
  return store?.sessions && typeof store.sessions === 'object'
    ? Object.values(store.sessions)
    : [];
}

export function resolveRecoveryWindowId(tree, { surfaceId, workspaceId }) {
  const matches = [];
  for (const window of tree?.windows || []) {
    for (const workspace of window?.workspaces || []) {
      for (const pane of workspace?.panes || []) {
        if (pane?.surfaces?.some(surface => surface?.id === surfaceId)) {
          matches.push({ windowId: window.id, workspaceId: workspace.id });
        }
      }
    }
  }
  return matches.length === 1 && matches[0].workspaceId === workspaceId
    ? matches[0].windowId
    : null;
}

async function defaultResolveRecoveryWindow({ workspaceId, surfaceId }) {
  const cmuxBinary = await resolveCmuxBinary();
  const { stdout } = await execFileAsync(cmuxBinary, ['rpc', 'system.tree', '{}'], {
    timeout: 3000,
  });
  const tree = JSON.parse(stdout);
  const windowId = resolveRecoveryWindowId(tree, { surfaceId, workspaceId });
  if (typeof windowId !== 'string') {
    throw new Error('Unable to resolve the cmux window for the blocked session.');
  }
  return windowId;
}

// Marks a launch failure that provably ran nothing (no cmux binary, no target
// window, or the process could not be spawned). Only such failures release the
// recovery claim for a retry; a timeout or a cmux error after spawning is
// ambiguous (the workspace may exist) and keeps the claim so the event is never
// launched twice.
function notLaunched(error) {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  wrapped.recoveryNotLaunched = true;
  return wrapped;
}

async function defaultLaunchRecoveryWorkspace({
  workspaceId,
  surfaceId,
  windowId = null,
  cwd,
  sessionId,
  command,
}) {
  let cmuxBinary;
  let resolvedWindowId;
  try {
    cmuxBinary = await resolveCmuxBinary();
    resolvedWindowId = windowId || await defaultResolveRecoveryWindow({
      workspaceId,
      surfaceId,
    });
  } catch (error) {
    throw notLaunched(error);
  }
  try {
    await execFileAsync(cmuxBinary, [
      'new-workspace',
      '--window',
      resolvedWindowId,
      '--name',
      `Recovered Claude ${sessionId.slice(0, 8)}`,
      '--cwd',
      cwd,
      '--command',
      command,
      '--focus',
      'false',
    ], {
      timeout: 5000,
    });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') throw notLaunched(error);
    throw error;
  }
}

async function defaultReadStore(path) {
  return readPrivateJson(path);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !processAlive(pid);
}

export async function stopExistingSessionProcess(
  info,
  parentPid,
  { inspectProcess = inspectClaudeProcess } = {},
) {
  const pids = [info?.pid, parentPid].filter(
    (pid, index, values) => Number.isInteger(pid) && pid > 0 && values.indexOf(pid) === index,
  );
  const expected = new Map([[info?.pid, info?.processIdentity]]);
  if (Number.isInteger(parentPid)) {
    expected.set(parentPid, info?.launcherProcessIdentity);
  }
  for (const pid of pids) {
    let current;
    try {
      current = await inspectProcess(pid);
    } catch {
      return false;
    }
    if (!current?.alive
        || current.processIdentity !== expected.get(pid)
        || (Number.isInteger(parentPid)
          && pid === info?.pid
          && current.parentPid !== parentPid)) {
      return false;
    }
    if (pid === parentPid && current.surfaceId !== info.surfaceId) return false;
  }
  const stopOrder = [...pids].sort((left, right) => (
    left === parentPid ? -1 : right === parentPid ? 1 : 0
  ));
  // Stopping the launcher can let the child exit and its PID be reused, so
  // each PID is re-verified right before it is signalled. The identity carries
  // the process start time, so a reused PID never matches; an inspection
  // failure skips the signal (fail closed).
  const stillExpected = async pid => {
    try {
      const current = await inspectProcess(pid);
      return current?.alive === true && current.processIdentity === expected.get(pid);
    } catch {
      return false;
    }
  };
  for (const pid of stopOrder) {
    if (!await stillExpected(pid)) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  let stopped = true;
  for (const pid of stopOrder) {
    if (!await waitForProcessExit(pid, 2500)) stopped = false;
  }
  if (!stopped) {
    for (const pid of stopOrder) {
      if (!processAlive(pid)) continue;
      let current;
      try {
        current = await inspectProcess(pid);
      } catch {
        return false;
      }
      if (!current?.alive || current.processIdentity !== expected.get(pid)) return false;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    stopped = true;
    for (const pid of stopOrder) {
      if (!await waitForProcessExit(pid, 750)) stopped = false;
    }
  }
  return stopped;
}

// A permanent replay claim covers one recoverable error EVENT, not the whole
// session: a session that is rescued and later exhausts the fleet again records
// a new error and must be rescuable again, while the same event is never
// launched twice (even across supervisor restarts). The event is the record's
// uuid, or its timestamp when it has no uuid; a record with neither keeps the
// conservative per-session key. The transient lease stays per session.
function recoveryClaimKey(sessionId, state) {
  if (typeof state?.eventId === 'string' && state.eventId) return `${sessionId}@${state.eventId}`;
  return Number.isSafeInteger(state?.eventTimestampMs) && state.eventTimestampMs > 0
    ? `${sessionId}@${state.eventTimestampMs}`
    : sessionId;
}

function claimSession(claimKey, pending) {
  if (typeof pending?.sessionId === 'string') return pending.sessionId;
  const at = claimKey.indexOf('@');
  return at === -1 ? claimKey : claimKey.slice(0, at);
}

function fleetRetryStillActive(state, now = Date.now()) {
  if (state?.kind !== 'fleet_exhausted') return false;
  if (!Number.isSafeInteger(state.retryAfterSeconds)
      || state.retryAfterSeconds <= 0
      || !Number.isSafeInteger(state.timestampMs)
      || state.timestampMs < 0) return true;
  const deadline = state.timestampMs + state.retryAfterSeconds * 1000;
  if (!Number.isSafeInteger(deadline)) return true;
  return now < deadline;
}

function processStartedAfterRecoveryError(info, state) {
  return Number.isFinite(info?.processStartedAt)
    && Number.isFinite(state?.timestampMs)
    && info.processStartedAt * 1000 > state.timestampMs;
}

function processGone(info, pid) {
  return !info?.alive && !processAlive(pid);
}

function sameRegistrySession(left, right) {
  return left?.sessionId === right?.sessionId
    && left?.pid === right?.pid
    && left?.workspaceId === right?.workspaceId;
}

export async function rescueCmuxSessionsOnce({
  storePath,
  transcriptRoot,
  nodePath,
  scriptPath,
  configPath = null,
  attempted = new Set(),
  readStore = defaultReadStore,
  inspectProcess = inspectClaudeProcessTree,
  launchRecoveryWorkspace = defaultLaunchRecoveryWorkspace,
  resolveRecoveryWindow = null,
  claimRecovery = claimSessionOnce,
  releaseRecovery = releaseSessionClaim,
  claimLease = claimSessionLease,
  releaseLease = releaseSessionLease,
  sessionClaimed = sessionClaimExists,
  pendingLeases = new Map(),
  pendingClaims = new Map(),
  stopProcess = stopExistingSessionProcess,
  stopInspectProcess = inspectClaudeProcess,
  trustedClaudePath = null,
}) {
  let store;
  try {
    store = await readStore(storePath);
  } catch {
    return { scanned: 0, candidates: 0, rescued: 0, failed: 0 };
  }

  if (!trustedClaudePath && inspectProcess === inspectClaudeProcessTree) {
    try {
      trustedClaudePath = await resolveTrustedClaudePath();
    } catch {
      return { scanned: 0, candidates: 0, rescued: 0, failed: 0 };
    }
  }

  // A permanent claim must be released before its transient lease. If the
  // release was inconclusive, retain both identities so a later scan can
  // retry the claim first instead of opening a handoff/rescue race. Claims are
  // keyed per error event; the lease they guard is keyed per session.
  for (const [claimKey, pending] of pendingClaims) {
    const sessionId = claimSession(claimKey, pending);
    const claimIdentity = pending && typeof pending === 'object'
      && Object.hasOwn(pending, 'claimIdentity')
      ? pending.claimIdentity
      : pending;
    let claimReleaseFailed = false;
    try {
      await releaseRecovery(storePath, claimKey, claimIdentity);
    } catch {
      claimReleaseFailed = true;
    }
    if (claimReleaseFailed) continue;
    pendingClaims.delete(claimKey);
    attempted.delete(claimKey);
    const leaseIdentity = pending?.leaseIdentity ?? pendingLeases.get(sessionId);
    if (!leaseIdentity) continue;
    try {
      const released = await releaseLease(storePath, sessionId, leaseIdentity);
      if (released !== null) pendingLeases.delete(sessionId);
      else pendingLeases.set(sessionId, leaseIdentity);
    } catch {
      pendingLeases.set(sessionId, leaseIdentity);
    }
  }
  const sessionsWithPendingClaims = new Set(
    [...pendingClaims].map(([claimKey, pending]) => claimSession(claimKey, pending)),
  );
  for (const [sessionId, identity] of pendingLeases) {
    if (sessionsWithPendingClaims.has(sessionId)) continue;
    try {
      const released = await releaseLease(storePath, sessionId, identity);
      if (released !== null) pendingLeases.delete(sessionId);
    } catch {}
  }

  let candidates = 0;
  let rescued = 0;
  let failed = 0;
  const currentSessions = sessions(store);
  for (const session of currentSessions) {
    if (!validSession(store, session)) continue;
    const initialState = await unresolvedRecoverableApiErrorState(
      session.transcriptPath,
      transcriptRoot,
      session.sessionId,
    );
    if (!initialState) continue;
    candidates += 1;
    if (fleetRetryStillActive(initialState)) continue;
    // The claim key names this error event; the lease names the session.
    const key = recoveryClaimKey(session.sessionId, initialState);
    const leaseKey = session.sessionId;
    if (attempted.has(key) || pendingLeases.has(leaseKey)) continue;

    let freshStore;
    try {
      freshStore = await readStore(storePath);
    } catch {
      continue;
    }
    const fresh = sessions(freshStore).find(item => item?.sessionId === session.sessionId);
    if (!fresh
        || fresh.pid !== session.pid
        || fresh.workspaceId !== session.workspaceId
        || !validSession(freshStore, fresh)) continue;
    const freshState = await unresolvedRecoverableApiErrorState(
      fresh.transcriptPath,
      transcriptRoot,
      fresh.sessionId,
    );
    if (!freshState || fleetRetryStillActive(freshState)
        || recoveryClaimKey(session.sessionId, freshState) !== key) continue;

    const first = await inspectProcess(fresh.pid, fresh.sessionId);
    const firstGone = processGone(first, fresh.pid);
    if (!firstGone && !await sameClaudeProcess(fresh, first, trustedClaudePath)) continue;
    if (!firstGone && processStartedAfterRecoveryError(first, freshState)) continue;
    const second = await inspectProcess(fresh.pid, fresh.sessionId);
    const secondGone = processGone(second, fresh.pid);
    if (firstGone !== secondGone) continue;
    if (!secondGone && !await sameClaudeProcess(
      fresh,
      second,
      trustedClaudePath,
      first.processIdentity,
      first.launcherProcessIdentity,
    )) continue;
    if (!secondGone && processStartedAfterRecoveryError(second, freshState)) continue;

    let finalStore;
    try {
      finalStore = await readStore(storePath);
    } catch {
      continue;
    }
    const final = sessions(finalStore).find(item => item?.sessionId === fresh.sessionId);
    if (!final
        || final.pid !== fresh.pid
        || final.workspaceId !== fresh.workspaceId
        || !validSession(finalStore, final)) continue;
    const finalState = await unresolvedRecoverableApiErrorState(
      final.transcriptPath,
      transcriptRoot,
      final.sessionId,
    );
    if (!finalState || fleetRetryStillActive(finalState)
        || recoveryClaimKey(session.sessionId, finalState) !== key) continue;
    const finalInfo = await inspectProcess(final.pid, final.sessionId);
    const finalGone = processGone(finalInfo, final.pid);
    if (finalGone !== secondGone) continue;
    if (!finalGone && !await sameClaudeProcess(
      final,
      finalInfo,
      trustedClaudePath,
      first.processIdentity,
      first.launcherProcessIdentity,
    )) continue;
    if (!finalGone && processStartedAfterRecoveryError(finalInfo, finalState)) continue;

    const command = buildResumeCommand({
      cwd: final.cwd,
      sessionId: final.sessionId,
      nodePath,
      scriptPath,
      configPath,
      continueLastPrompt: !['ambiguous_connection', 'ambiguous_dispatch'].includes(finalState.kind),
    });
    let recoveryWindowId = null;
    if (resolveRecoveryWindow
        || launchRecoveryWorkspace === defaultLaunchRecoveryWorkspace) {
      try {
        recoveryWindowId = await (resolveRecoveryWindow || defaultResolveRecoveryWindow)({
          workspaceId: final.workspaceId,
          surfaceId: final.surfaceId,
        });
      } catch {
        continue;
      }
    }
    let claimOwned = false;
    let leaseOwned = false;
    const releaseLeaseForRetry = async () => {
      if (!leaseOwned) return true;
      const leaseIdentity = typeof leaseOwned === 'object' ? leaseOwned : null;
      try {
        const released = await releaseLease(storePath, leaseKey, leaseIdentity);
        if (released !== null) {
          leaseOwned = false;
          pendingLeases.delete(leaseKey);
        } else {
          pendingLeases.set(leaseKey, leaseIdentity);
        }
        return released !== null;
      } catch {
        // Keep the identity marked as owned when release is inconclusive. A
        // later scan must not clear attempted and race this actor's lease.
        pendingLeases.set(leaseKey, leaseIdentity);
        return false;
      }
    };
    const releaseClaimForRetry = async () => {
      if (!claimOwned) return releaseLeaseForRetry();
      const claimIdentity = typeof claimOwned === 'object' ? claimOwned : null;
      const leaseIdentity = typeof leaseOwned === 'object' ? leaseOwned : null;
      let claimReleaseFailed = false;
      try {
        await releaseRecovery(storePath, key, claimIdentity);
        // The built-in release returns false when the claim was already
        // replaced or removed. That is still a definitive result; only an
        // exception means the permanent claim release was inconclusive.
      } catch {
        claimReleaseFailed = true;
      }
      if (!claimReleaseFailed) {
        claimOwned = false;
        attempted.delete(key);
      }
      if (claimReleaseFailed) {
        pendingClaims.set(key, { claimIdentity, leaseIdentity, sessionId: leaseKey });
        return false;
      }
      // Keep the transient lease until the permanent claim has been removed.
      // Otherwise a handoff actor can acquire the lease in the gap and accept
      // the still-present claim, then this rescuer can delete it afterwards;
      // the next scan would replay Claude after Codex already took over.
      const leaseReleased = await releaseLeaseForRetry();
      return !claimReleaseFailed && leaseReleased;
    };
    let launchStarted = false;
    try {
      const lease = await claimLease(storePath, leaseKey);
      if (!lease) {
        // Another actor owns the transient lease. Do not poison this
        // rescuer's attempted set; a later scan may retry after that actor
        // exits without completing recovery.
        continue;
      }
      leaseOwned = lease;
      pendingLeases.set(leaseKey, lease);
      if (key !== leaseKey) {
        // An event-keyed claim cannot collide with the launcher's permanent
        // session-level Codex-handoff claim, so honour that claim explicitly
        // (under the lease the launcher also holds while writing it).
        let handedOff;
        try {
          handedOff = await sessionClaimed(storePath, leaseKey);
        } catch {
          handedOff = null;
        }
        if (handedOff !== false) {
          await releaseLeaseForRetry();
          if (handedOff === true) attempted.add(key);
          continue;
        }
      }
      const claim = await claimRecovery(storePath, key);
      if (!claim) {
        await releaseLeaseForRetry();
        attempted.add(key);
        continue;
      }
      claimOwned = claim;
      attempted.add(key);
      let claimedStore;
      try {
        claimedStore = await readStore(storePath);
      } catch {
        await releaseClaimForRetry();
        continue;
      }
      const claimed = sessions(claimedStore).find(item => item?.sessionId === session.sessionId);
      if (!claimed
          || !sameRegistrySession(claimed, final)
          || !validSession(claimedStore, claimed)) {
        await releaseClaimForRetry();
        continue;
      }
      const claimedState = await unresolvedRecoverableApiErrorState(
        claimed.transcriptPath,
        transcriptRoot,
        claimed.sessionId,
      );
      if (!claimedState || fleetRetryStillActive(claimedState)
          || recoveryClaimKey(session.sessionId, claimedState) !== key) {
        await releaseClaimForRetry();
        continue;
      }
      const claimedInfo = await inspectProcess(claimed.pid, claimed.sessionId);
      const claimedGone = processGone(claimedInfo, claimed.pid);
      if (claimedGone !== finalGone) {
        await releaseClaimForRetry();
        continue;
      }
      if (!claimedGone && !await sameClaudeProcess(
        claimed,
        claimedInfo,
        trustedClaudePath,
        finalInfo.processIdentity,
        finalInfo.launcherProcessIdentity,
      )) {
        await releaseClaimForRetry();
        continue;
      }
      if (!claimedGone && processStartedAfterRecoveryError(claimedInfo, claimedState)) {
        await releaseClaimForRetry();
        continue;
      }
      const recoveryParentPid = finalInfo.processRole === 'teamclaude-child'
        ? (finalInfo.launcherCommand?.pid ?? finalInfo.parentPid)
        : null;
      if ((finalInfo.processRole === 'teamclaude-child'
          || finalInfo.processRole === 'legacy-native')
          && Number.isInteger(finalInfo.pid)
          && !await stopProcess(finalInfo, recoveryParentPid, { inspectProcess: stopInspectProcess })) {
        await releaseClaimForRetry();
        failed += 1;
        continue;
      }
      if (finalInfo.processRole === 'teamclaude-child'
          || finalInfo.processRole === 'legacy-native') {
        const afterStopInfo = await inspectProcess(final.pid, final.sessionId);
        if (afterStopInfo?.alive
            || processAlive(final.pid)
            || processAlive(recoveryParentPid)) {
          await releaseClaimForRetry();
          failed += 1;
          continue;
        }
      }
      const afterStopState = await unresolvedRecoverableApiErrorState(
        final.transcriptPath,
        transcriptRoot,
        final.sessionId,
      );
      if (!afterStopState || fleetRetryStillActive(afterStopState)
          || recoveryClaimKey(session.sessionId, afterStopState) !== key) {
        await releaseClaimForRetry();
        continue;
      }
      if (finalInfo.processRole === 'teamclaude-child'
          || finalInfo.processRole === 'legacy-native') {
        const beforeLaunchInfo = await inspectProcess(final.pid, final.sessionId);
        if (beforeLaunchInfo?.alive || processAlive(final.pid)) {
          await releaseClaimForRetry();
          failed += 1;
          continue;
        }
      } else if (finalGone && processAlive(final.pid)) {
        await releaseClaimForRetry();
        failed += 1;
        continue;
      }
      launchStarted = true;
      await launchRecoveryWorkspace({
        workspaceId: final.workspaceId,
        surfaceId: final.surfaceId,
        windowId: recoveryWindowId,
        cwd: final.cwd,
        sessionId: final.sessionId,
        command,
      });
      rescued += 1;
      await releaseLeaseForRetry();
      claimOwned = false;
    } catch (error) {
      // Keep the permanent replay claim when workspace launch is ambiguous;
      // before launch, or when the launch provably ran nothing (no cmux
      // binary/window, spawn ENOENT/EACCES), there is no replay ambiguity, so
      // release both claims and allow a later scan to retry the session.
      if (launchStarted && error?.recoveryNotLaunched !== true) {
        await releaseLeaseForRetry();
      } else {
        await releaseClaimForRetry();
      }
      failed += 1;
    }
  }
  return { scanned: currentSessions.length, candidates, rescued, failed };
}

export function createCmuxSessionRescuer({
  enabled,
  ready = () => true,
  intervalMs = 1000,
  log = message => console.error(message),
  ...options
}) {
  let timer = null;
  let scanPromise = null;
  const attempted = new Set();
  const pendingLeases = new Map();
  const pendingClaims = new Map();

  const scanNow = () => {
    if (!enabled || !ready()) {
      return Promise.resolve({ scanned: 0, candidates: 0, rescued: 0, failed: 0 });
    }
    if (scanPromise) return scanPromise;
    scanPromise = rescueCmuxSessionsOnce({
      ...options,
      attempted,
      pendingLeases,
      pendingClaims,
    })
      .then(result => {
        if (result.rescued > 0) {
          log(`[TeamClaude] Continued ${result.rescued} blocked Claude session(s) in new supervised cmux workspaces.`);
        }
        if (result.failed > 0) {
          log(`[TeamClaude] Cmux recovery workspace launch was uncertain for ${result.failed} blocked Claude session(s); not replaying in this supervisor run.`);
        }
        return result;
      })
      .catch(err => {
        log(`[TeamClaude] Existing Claude session rescue failed: ${err.message}`);
        return { scanned: 0, candidates: 0, rescued: 0, failed: 0 };
      })
      .finally(() => {
        scanPromise = null;
      });
    return scanPromise;
  };

  return {
    scanNow,
    start() {
      if (!enabled || timer) return;
      void scanNow();
      const period = Number.isFinite(intervalMs)
        ? Math.max(500, Math.floor(intervalMs))
        : 1000;
      timer = setInterval(() => {
        void scanNow();
      }, period);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}

export function defaultCmuxRescuePaths() {
  return {
    storePath: join(homedir(), '.cmuxterm', 'claude-hook-sessions.json'),
    transcriptRoot: join(homedir(), '.claude', 'projects'),
  };
}
