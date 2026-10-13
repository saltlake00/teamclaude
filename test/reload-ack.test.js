import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newReloadNonce,
  requestConfirmedReload,
  runConfirmedReload,
  createReloadQueue,
  MAX_CLAIMS_PER_STEP,
  normalizeReloadTimeoutMs,
  DEFAULT_RELOAD_CONFIRM_TIMEOUT_MS,
} from '../src/reload-ack.js';

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'teamclaude-reload-ack-'));
}

// A stand-in for the worker's SIGHUP handler: the CLI "signal" schedules the
// worker-side confirmed reload on the next tick, exactly like a real signal.
function workerSignal(dir, reload) {
  let done = null;
  const signal = () => {
    done = new Promise(resolve => setImmediate(resolve))
      .then(() => runConfirmedReload({ dir, reload }));
  };
  return { signal, finished: () => done };
}

test('success: the CLI reports applied only after the worker finished its reload', async () => {
  const dir = join(await tempDir(), 'config.reload');
  let applied = false;
  const worker = workerSignal(dir, async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    applied = true;
  });
  try {
    const outcome = await requestConfirmedReload({
      dir, signal: worker.signal, timeoutMs: 2000, pollMs: 10,
    });
    assert.equal(outcome.status, 'applied');
    assert.equal(applied, true, 'applied must not be reported before the reload ran');
    await worker.finished();
    assert.deepEqual(await readdir(dir), [], 'request and result files are consumed');
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('worker exception: a failed reload is reported as failed with its error', async () => {
  const dir = join(await tempDir(), 'config.reload');
  const worker = workerSignal(dir, async () => {
    throw new Error('sync exploded');
  });
  try {
    const outcome = await requestConfirmedReload({
      dir, signal: worker.signal, timeoutMs: 2000, pollMs: 10,
    });
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error, /sync exploded/);
    const result = await worker.finished();
    assert.equal(result.ok, false, 'the worker-side helper reports the failure without throwing');
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('timeout: no confirmation within the limit is unconfirmed and withdraws the request', async () => {
  const dir = join(await tempDir(), 'config.reload');
  try {
    const started = Date.now();
    const outcome = await requestConfirmedReload({
      dir, signal: () => {}, timeoutMs: 150, pollMs: 10,
    });
    assert.equal(outcome.status, 'unconfirmed');
    assert.equal(outcome.reason, 'timeout');
    assert.ok(Date.now() - started >= 150, 'waits for the full limit');
    assert.deepEqual(await readdir(dir), [], 'the abandoned request is removed');
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('old worker: a signal that is accepted but never answered is unconfirmed', async () => {
  const dir = join(await tempDir(), 'config.reload');
  let signalled = 0;
  try {
    // An older worker re-reads the config on SIGHUP but knows nothing about
    // request files, so it never writes a result.
    const outcome = await requestConfirmedReload({
      dir, signal: () => { signalled += 1; }, timeoutMs: 120, pollMs: 10,
    });
    assert.equal(signalled, 1);
    assert.equal(outcome.status, 'unconfirmed');
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('worker exit: a worker that dies before answering is unconfirmed without waiting the full limit', async () => {
  const dir = join(await tempDir(), 'config.reload');
  try {
    const started = Date.now();
    const outcome = await requestConfirmedReload({
      dir, signal: () => {}, timeoutMs: 5000, pollMs: 10, isWorkerAlive: () => false,
    });
    assert.equal(outcome.status, 'unconfirmed');
    assert.equal(outcome.reason, 'worker-exited');
    assert.ok(Date.now() - started < 2000);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('signal failure: an undeliverable signal is unconfirmed and withdraws the request', async () => {
  const dir = join(await tempDir(), 'config.reload');
  try {
    const outcome = await requestConfirmedReload({
      dir, signal: () => { throw new Error('ESRCH'); }, timeoutMs: 1000, pollMs: 10,
    });
    assert.equal(outcome.status, 'unconfirmed');
    assert.match(outcome.reason, /ESRCH/);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('other requests: a result for a different nonce is ignored and left for its owner', async () => {
  const dir = join(await tempDir(), 'config.reload');
  const other = newReloadNonce();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${other}.res`), JSON.stringify({ ok: true }));
    const outcome = await requestConfirmedReload({
      dir, signal: () => {}, timeoutMs: 120, pollMs: 10,
    });
    assert.equal(outcome.status, 'unconfirmed', 'another request\'s success must not count as ours');
    assert.deepEqual(await readdir(dir), [`${other}.res`]);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('other requests: a reload that claimed only another nonce does not answer ours', async () => {
  const dir = join(await tempDir(), 'config.reload');
  const mine = newReloadNonce();
  const other = newReloadNonce();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${other}.req`), '');
    // The worker claims and answers `other` before our request exists.
    await runConfirmedReload({ dir, reload: async () => {} });
    assert.deepEqual(await readdir(dir), [`${other}.res`]);
    const outcome = await requestConfirmedReload({
      dir, nonce: mine, signal: () => {}, timeoutMs: 120, pollMs: 10,
    });
    assert.equal(outcome.status, 'unconfirmed');
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('malformed result: an unreadable result for our nonce is a failure, not a success', async () => {
  const dir = join(await tempDir(), 'config.reload');
  try {
    let nonce = null;
    const outcome = await requestConfirmedReload({
      dir,
      signal: () => {
        nonce = readdirSync(dir).find(name => name.endsWith('.req')).slice(0, -'.req'.length);
        writeFileSync(join(dir, `${nonce}.res`), '{not json');
      },
      timeoutMs: 1000,
      pollMs: 10,
    });
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error, /unreadable/);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('request directory is private even when it already existed with wider permissions', { skip: process.platform === 'win32' }, async () => {
  const dir = join(await tempDir(), 'config.reload');
  try {
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);
    await requestConfirmedReload({ dir, signal: () => {}, timeoutMs: 20, pollMs: 5 });
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('one reload answers every request it claimed, and only those', async () => {
  const dir = join(await tempDir(), 'config.reload');
  const a = newReloadNonce();
  const b = newReloadNonce();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${a}.req`), '');
    await writeFile(join(dir, `${b}.req`), '');
    await writeFile(join(dir, 'not-a-nonce.req'), '');
    const result = await runConfirmedReload({ dir, reload: async () => {} });
    assert.equal(result.ok, true);
    assert.deepEqual(result.claimed.sort(), [a, b].sort());
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, [`${a}.res`, `${b}.res`, 'not-a-nonce.req'].sort());
    const body = JSON.parse(await readFile(join(dir, `${a}.res`), 'utf8'));
    assert.equal(body.ok, true);
    assert.equal(body.nonce, a);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('late request: a request posted after the claim is answered by a follow-up step even if its signal was coalesced', async () => {
  const dir = join(await tempDir(), 'config.reload');
  const first = newReloadNonce();
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let reloads = 0;
  const results = [];
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${first}.req`), '');
    const queue = createReloadQueue({
      dir,
      reload: async () => {
        reloads += 1;
        if (reloads === 1) await firstGate;
      },
      onResult: result => results.push(result),
    });
    queue.trigger();
    // The first step has claimed `first` and is still reloading.
    while ((await readdir(dir)).includes(`${first}.req`)) await new Promise(r => setTimeout(r, 5));
    let posted = false;
    const late = requestConfirmedReload({
      dir,
      // Coalesced with the in-flight one: no new SIGHUP step is scheduled.
      signal: () => { posted = true; },
      timeoutMs: 2000,
      pollMs: 10,
    });
    while (!posted) await new Promise(r => setTimeout(r, 5));
    releaseFirst();
    assert.equal((await late).status, 'applied');
    await queue.whenIdle();
    assert.equal(reloads, 2, 'the late request gets its own reload after its save');
    assert.deepEqual(results.map(r => r.claimed.length), [1, 1]);
    const leftovers = (await readdir(dir)).filter(name => name !== `${first}.res`);
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('late requests: requests that keep arriving during each step are all answered', async () => {
  const dir = join(await tempDir(), 'config.reload');
  const arrivals = 12;
  const posted = [];
  const claimed = [];
  let reloads = 0;
  try {
    await mkdir(dir, { recursive: true });
    const queue = createReloadQueue({
      dir,
      reload: async () => {
        reloads += 1;
        // A new CLI (with a coalesced signal) arrives during each of the first
        // `arrivals` steps, plus a burst of three during the first one.
        if (reloads > arrivals) return;
        const burst = reloads === 1 ? 3 : 1;
        for (let i = 0; i < burst; i++) {
          const nonce = newReloadNonce();
          posted.push(nonce);
          await writeFile(join(dir, `${nonce}.req`), '');
        }
      },
      onResult: result => claimed.push(...result.claimed),
    });
    queue.trigger();
    await queue.whenIdle();
    assert.equal(posted.length, arrivals + 2);
    assert.deepEqual(claimed.sort(), [...posted].sort(), 'every late request is claimed and answered');
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, posted.map(nonce => `${nonce}.res`).sort(), 'no request is left behind');
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('bounded steps: a burst larger than the per-step limit is served in several bounded steps', async () => {
  const dir = join(await tempDir(), 'config.reload');
  const nonces = Array.from({ length: 7 }, () => newReloadNonce());
  const batches = [];
  try {
    await mkdir(dir, { recursive: true });
    for (const nonce of nonces) await writeFile(join(dir, `${nonce}.req`), '');
    const queue = createReloadQueue({
      dir,
      reload: async () => {},
      maxClaims: 3,
      onResult: result => batches.push(result.claimed),
    });
    queue.trigger();
    await queue.whenIdle();
    assert.deepEqual(batches.map(batch => batch.length), [3, 3, 1], 'no step claims more than the limit');
    assert.deepEqual(batches.flat().sort(), [...nonces].sort());
    assert.equal(MAX_CLAIMS_PER_STEP > 0, true);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('no spin: a request file that cannot be claimed does not keep the queue stepping', async () => {
  const dir = join(await tempDir(), 'config.reload');
  const stuck = newReloadNonce();
  let reloads = 0;
  try {
    // A directory under a valid request name cannot be unlinked as a file.
    await mkdir(join(dir, `${stuck}.req`, 'x'), { recursive: true });
    const queue = createReloadQueue({ dir, reload: async () => { reloads += 1; } });
    queue.trigger();
    await queue.whenIdle();
    assert.equal(reloads, 1, 'one signal, one reload');
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('ack failure: a reload that succeeded but could not record a result reports the ack error', async () => {
  const dir = join(await tempDir(), 'config.reload');
  const nonce = newReloadNonce();
  const errors = [];
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${nonce}.req`), '');
    // A directory squatting on the result path makes the final rename fail.
    await mkdir(join(dir, `${nonce}.res`, 'blocker'), { recursive: true });
    const result = await runConfirmedReload({
      dir, reload: async () => {}, onResultError: err => errors.push(err),
    });
    assert.equal(result.ok, true, 'the config itself was applied');
    assert.ok(result.ackError, 'the missing confirmation is reported separately');
    assert.equal(errors.length, 1);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('worker reload without any pending request still runs and writes nothing', async () => {
  const dir = join(await tempDir(), 'missing', 'config.reload');
  let ran = false;
  try {
    const result = await runConfirmedReload({ dir, reload: async () => { ran = true; } });
    assert.equal(ran, true, 'a plain SIGHUP (no CLI request) still reloads');
    assert.equal(result.ok, true);
    assert.deepEqual(result.claimed, []);
  } finally {
    await rm(join(dir, '..', '..'), { recursive: true, force: true });
  }
});

test('reload timeout parsing falls back to the default for invalid values', () => {
  assert.equal(normalizeReloadTimeoutMs(undefined), DEFAULT_RELOAD_CONFIRM_TIMEOUT_MS);
  assert.equal(normalizeReloadTimeoutMs('abc'), DEFAULT_RELOAD_CONFIRM_TIMEOUT_MS);
  assert.equal(normalizeReloadTimeoutMs('0'), DEFAULT_RELOAD_CONFIRM_TIMEOUT_MS);
  assert.equal(normalizeReloadTimeoutMs('-5'), DEFAULT_RELOAD_CONFIRM_TIMEOUT_MS);
  assert.equal(normalizeReloadTimeoutMs('750'), 750);
});
