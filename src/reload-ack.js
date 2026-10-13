// Confirmed account reload between the CLI and the running proxy worker.
//
// SIGHUP carries no payload, so the request identity travels through a small
// per-config directory next to the config file (`<config>.reload/`):
//
//   1. The CLI saves the config, writes `<nonce>.req`, then sends SIGHUP.
//   2. The worker, when its reload step actually starts, claims (unlinks) every
//      pending `<nonce>.req`, re-reads the config from disk, applies it, and
//      writes `<nonce>.res` with the outcome for each nonce it claimed.
//   3. The CLI waits for ITS `<nonce>.res` only and reports success only on
//      `{ ok: true }`.
//
// Correctness: a request file is written after the config save, and the worker
// claims it before it re-reads the config, so a result for that nonce always
// comes from a reload that saw the CLI's change. Several requests may be
// answered by one reload; a result for another nonce never counts.
//
// "Applied" therefore means "the running server re-read the config at or after
// this CLI's save" — the same last-writer-wins contract as the config file. If
// another CLI saved a conflicting change later (`disable` racing `enable`), the
// live state ends equal to the disk state, which is also what serialized
// one-reload-per-request processing would end with. Per-request revision
// matching would instead fail the earlier CLI although nothing is wrong. A worker
// that predates this protocol never writes a result, which the CLI reports as
// "unconfirmed" after the timeout.

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_RELOAD_CONFIRM_TIMEOUT_MS = 10_000;
const NONCE_RE = /^[0-9a-f]{32}$/;
// Results nobody collected (the CLI gave up or died) are swept on later reloads.
const STALE_RESULT_MS = 5 * 60_000;

export function newReloadNonce() {
  return randomBytes(16).toString('hex');
}

export function normalizeReloadTimeoutMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RELOAD_CONFIRM_TIMEOUT_MS;
}

const requestPath = (dir, nonce) => join(dir, `${nonce}.req`);
const resultPath = (dir, nonce) => join(dir, `${nonce}.res`);

async function writeExclusive(path, data) {
  const fh = await open(path, 'wx', 0o600);
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}

// ── worker side ─────────────────────────────────────────────

// Requests claimed (and results written) per reload step. A burst larger than
// this is served by follow-up steps instead of one unbounded fan-out.
export const MAX_CLAIMS_PER_STEP = 64;

async function sweepStaleResults(dir, names) {
  const cutoff = Date.now() - STALE_RESULT_MS;
  for (const name of names) {
    if (!name.endsWith('.res') && !name.includes('.res.tmp-')) continue;
    const path = join(dir, name);
    try {
      if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
    } catch { /* already gone */ }
  }
}

async function listRequestNonces(dir, { sweep = false } = {}) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  if (sweep) await sweepStaleResults(dir, names);
  return names
    .filter(name => name.endsWith('.req'))
    .map(name => name.slice(0, -'.req'.length))
    .filter(nonce => NONCE_RE.test(nonce));
}

/**
 * Claim up to `limit` pending requests: unlinking is the claim, so a request
 * its CLI withdrew (or one that cannot be removed) is skipped. `attempted`
 * lists every nonce tried, claimed or not.
 */
async function claimReloadRequests(dir, limit) {
  const attempted = (await listRequestNonces(dir, { sweep: true })).slice(0, limit);
  const claimed = [];
  for (const nonce of attempted) {
    try {
      await rm(requestPath(dir, nonce));
      claimed.push(nonce);
    } catch { /* withdrawn meanwhile, or not removable */ }
  }
  return { claimed, attempted };
}

async function writeReloadResult(dir, nonce, result) {
  const path = resultPath(dir, nonce);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeExclusive(tmp, JSON.stringify({ ...result, nonce }) + '\n');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * One reload step: claim a bounded batch of pending requests, run `reload`,
 * and answer every claimed request. Never throws — a failed reload is returned
 * (and reported to the waiting CLIs) so the caller keeps the worker running.
 * `ackError` reports a claim/result-write failure separately: the reload may
 * have applied while a waiting CLI never learns of it. `pending` is true when a
 * request this step did not try is waiting (batch overflow, or posted during
 * the reload — its SIGHUP may have been coalesced with the one being handled).
 * A request that was tried but could not be claimed does not count, so an
 * unremovable file cannot make the caller spin.
 */
export async function runConfirmedReload({
  dir, reload, onResultError = () => {}, maxClaims = MAX_CLAIMS_PER_STEP,
}) {
  let ackError = null;
  const noteAckError = err => {
    ackError ??= err?.message || String(err);
    onResultError(err);
  };

  let claimed = [];
  let attempted = [];
  try {
    ({ claimed, attempted } = await claimReloadRequests(dir, maxClaims));
  } catch (err) {
    noteAckError(err);
  }
  let outcome;
  try {
    await reload();
    outcome = { ok: true };
  } catch (err) {
    outcome = { ok: false, error: err?.message || String(err) };
  }
  const result = { ...outcome, pid: process.pid, finishedAt: new Date().toISOString() };
  for (const nonce of claimed) {
    await writeReloadResult(dir, nonce, result).catch(noteAckError);
  }
  let pending = false;
  try {
    const tried = new Set(attempted);
    pending = (await listRequestNonces(dir)).some(nonce => !tried.has(nonce));
  } catch (err) {
    noteAckError(err);
  }
  return { ...outcome, claimed, ackError, pending };
}

/**
 * Serialize reload steps (one per SIGHUP) and keep stepping while requests the
 * last step did not try are waiting, so a request whose SIGHUP was coalesced is
 * still answered. Each step is bounded (`maxClaims`) and goes back through the
 * same FIFO chain, so a step for a fresh SIGHUP is never starved by follow-ups;
 * every step is a full reload of the current config either way.
 */
export function createReloadQueue({ dir, reload, onResult = () => {}, onResultError, maxClaims }) {
  let chain = Promise.resolve();
  const trigger = () => {
    chain = chain
      .then(() => runConfirmedReload({ dir, reload, onResultError, maxClaims }))
      .then(result => {
        onResult(result);
        if (result.pending) trigger();
      })
      .catch(err => onResult({ ok: false, error: err?.message || String(err), claimed: [], pending: false }));
    return chain;
  };
  // Resolves once no step is queued or running (tests and shutdown paths).
  const whenIdle = async () => {
    for (;;) {
      const current = chain;
      await current;
      if (current === chain) return;
    }
  };
  return { trigger, whenIdle };
}

// ── CLI side ────────────────────────────────────────────────

async function takeResult(dir, nonce) {
  const path = resultPath(dir, nonce);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  await rm(path, { force: true });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 'failed', error: 'unreadable reload result' };
  }
  if (body?.nonce !== nonce) return { status: 'failed', error: 'reload result for a different request' };
  return body.ok === true
    ? { status: 'applied' }
    : { status: 'failed', error: typeof body.error === 'string' ? body.error : 'unknown error' };
}

/**
 * CLI side: post a request, deliver the signal, and wait for this request's
 * result. Resolves to `{ status: 'applied' }`, `{ status: 'failed', error }`,
 * or `{ status: 'unconfirmed', reason }`.
 */
export async function requestConfirmedReload({
  dir,
  signal,
  timeoutMs = DEFAULT_RELOAD_CONFIRM_TIMEOUT_MS,
  pollMs = 50,
  isWorkerAlive = () => true,
  nonce = newReloadNonce(),
}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies on creation; tighten a pre-existing directory too.
  if (process.platform !== 'win32') await chmod(dir, 0o700);
  await writeExclusive(requestPath(dir, nonce), '');
  const withdraw = () => rm(requestPath(dir, nonce), { force: true }).catch(() => {});

  try {
    signal();
  } catch (err) {
    await withdraw();
    return { status: 'unconfirmed', reason: `could not signal the worker: ${err.message}` };
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await takeResult(dir, nonce);
    if (result) return result;
    if (!isWorkerAlive()) {
      // The worker may have answered right before exiting.
      const last = await takeResult(dir, nonce);
      if (last) return last;
      await withdraw();
      return { status: 'unconfirmed', reason: 'worker-exited' };
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  await withdraw();
  // A result written between the last poll and the withdrawal still counts.
  return (await takeResult(dir, nonce)) || { status: 'unconfirmed', reason: 'timeout' };
}
