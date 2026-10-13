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

async function sweepStaleResults(dir, names) {
  const cutoff = Date.now() - STALE_RESULT_MS;
  await Promise.all(names
    .filter(name => name.endsWith('.res') || name.includes('.res.tmp-'))
    .map(async name => {
      const path = join(dir, name);
      try {
        if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
      } catch { /* already gone */ }
    }));
}

/** Claim every pending request: unlinking it is the claim, so a request the CLI withdrew is skipped. */
async function claimReloadRequests(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  await sweepStaleResults(dir, names);
  const claimed = [];
  for (const name of names) {
    if (!name.endsWith('.req')) continue;
    const nonce = name.slice(0, -'.req'.length);
    if (!NONCE_RE.test(nonce)) continue;
    try {
      await rm(requestPath(dir, nonce));
      claimed.push(nonce);
    } catch { /* withdrawn by its CLI meanwhile */ }
  }
  return claimed;
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
 * Worker side of one signal: claim pending requests, run `reload`, answer every
 * claimed request, then re-check for requests posted while it ran (their SIGHUP
 * may have been coalesced with the one being handled) and serve them with a
 * fresh pass. Never throws — a failed reload is returned (and reported to the
 * waiting CLIs) so the caller keeps the worker running. `ackError` reports a
 * claim/result-write failure separately: the reload may have applied while a
 * waiting CLI never learns of it.
 */
export async function runConfirmedReload({ dir, reload, onResultError = () => {} }) {
  let ackError = null;
  const noteAckError = err => {
    ackError ??= err?.message || String(err);
    onResultError(err);
  };
  const claim = () => claimReloadRequests(dir).catch(err => { noteAckError(err); return []; });

  const claimedAll = [];
  let failure = null;
  // No pass cap: SIGHUPs can coalesce, so a request left pending here might
  // never get a step of its own. The loop ends as soon as a re-claim comes back
  // empty; a request that cannot be claimed is not returned by claim(), so an
  // unremovable file cannot spin it.
  let claimed = await claim();
  for (;;) {
    let outcome;
    try {
      await reload();
      outcome = { ok: true };
    } catch (err) {
      outcome = { ok: false, error: err?.message || String(err) };
      failure = outcome.error;
    }
    const result = { ...outcome, pid: process.pid, finishedAt: new Date().toISOString() };
    await Promise.all(claimed.map(nonce => writeReloadResult(dir, nonce, result).catch(noteAckError)));
    claimedAll.push(...claimed);
    claimed = await claim();
    if (claimed.length === 0) break;
  }
  return failure === null
    ? { ok: true, claimed: claimedAll, ackError }
    : { ok: false, error: failure, claimed: claimedAll, ackError };
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
