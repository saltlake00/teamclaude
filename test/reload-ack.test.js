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
