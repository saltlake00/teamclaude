import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { autoRanking, moveRanking, rankedAccounts, rankingChanges } from '../src/account-order.js';
import { findControlAccount, runAccountControl } from '../src/account-controls.js';
import { applyTuiAccountMutation } from '../src/tui.js';

const HOUR = 3600_000;

function makeManager() {
  const config = {
    accounts: [
      { name: 'a', type: 'oauth', accountUuid: 'uuid-a', accessToken: 't-a', refreshToken: 'r-a', expiresAt: Date.now() + HOUR },
      { name: 'b', type: 'oauth', accountUuid: 'uuid-b', accessToken: 't-b', refreshToken: 'r-b', expiresAt: Date.now() + HOUR },
      { name: 'c', type: 'apikey', apiKey: 'k-c' },
      { name: 'd', type: 'apikey', apiKey: 'k-d' },
    ],
  };
  const am = new AccountManager(structuredClone(config.accounts), 0.98);
  // Measured and healthy, so availability is not decided by warm-up.
  const now = Date.now();
  am.accounts.forEach((a, i) => {
    a.quota.unified5h = 0.1;
    a.quota.unified5hReset = now + HOUR;
    a.quota.unified7d = 0.1;
    a.quota.unified7dReset = now + (i + 1) * HOUR;
  });
  return { am, config };
}

/** A persist() that applies the mutation to a "disk" copy the way the worker does. */
function diskPersist(disk, am, { fail = false } = {}) {
  const writes = [];
  return {
    writes,
    persist: async mutation => {
      if (fail) throw new Error('disk full');
      writes.push(mutation);
      applyTuiAccountMutation(disk, disk, am, mutation);
    },
  };
}

const names = list => list.map(a => a.name);

test('order rules match the TUI: unranked up joins the bottom, top up is a no-op, last down un-ranks', () => {
  const { am } = makeManager();
  const [a, b, c] = am.accounts;
  b.priority = 0;
  c.priority = 1;

  assert.deepEqual(names(rankedAccounts(am.accounts)), ['b', 'c']);
  assert.deepEqual(names(moveRanking(am.accounts, a, -1)), ['b', 'c', 'a'], 'unranked up → lowest ranked');
  assert.deepEqual(names(moveRanking(am.accounts, c, -1)), ['c', 'b'], 'swap with the one above');
  assert.equal(moveRanking(am.accounts, b, -1), null, 'already at the top');
  assert.equal(moveRanking(am.accounts, a, +1), null, 'unranked has nothing below');
  assert.deepEqual(names(moveRanking(am.accounts, b, +1)), ['c', 'b'], 'swap with the one below');
  assert.deepEqual(names(moveRanking(am.accounts, c, +1)), ['b'], 'last ranked down → un-rank');
  assert.deepEqual(names(autoRanking(am.accounts, b)), ['c']);
  assert.equal(moveRanking(am.accounts, { name: 'ghost' }, -1), null);

  // Applying renumbers to contiguous 0..n-1 and clears the rest.
  const changes = rankingChanges(am.accounts, [c, a]);
  assert.deepEqual(changes.map(x => [x.account.name, x.priority]), [['a', 1], ['b', null], ['c', 0]]);
});

test('targets resolve by UUID only when one is given, else by a unique UUID-less name', () => {
  const { am } = makeManager();
  assert.equal(findControlAccount(am.accounts, { accountUuid: 'uuid-b', name: 'a' })?.name, 'b');
  assert.equal(findControlAccount(am.accounts, { accountUuid: 'uuid-x', name: 'a' }), null, 'no name fallback');
  assert.equal(findControlAccount(am.accounts, { name: 'c' })?.name, 'c');
  assert.equal(findControlAccount(am.accounts, { name: 'a' }), null, 'an OAuth account is named by its UUID');
  assert.equal(findControlAccount(am.accounts, {}), null);
});

test('disable/enable persist first, then change the live manager and the in-memory config', async () => {
  const { am, config } = makeManager();
  const disk = structuredClone(config);
  const { persist, writes } = diskPersist(disk, am);

  const off = await runAccountControl({ accountManager: am, config, persist }, { action: 'disable', accountUuid: 'uuid-a' });
  assert.equal(off.statusCode, 200);
  assert.equal(off.body.changed, true);
  assert.equal(am.accounts[0].enabled, false);
  assert.equal(disk.accounts[0].enabled, false);
  assert.equal(config.accounts[0].enabled, false);
  assert.notEqual(am.getActiveAccount()?.name, 'a', 'a disabled account leaves the rotation');

  const again = await runAccountControl({ accountManager: am, config, persist }, { action: 'disable', accountUuid: 'uuid-a' });
  assert.equal(again.body.changed, false);
  assert.equal(writes.length, 1, 'a no-op writes nothing');

  const on = await runAccountControl({ accountManager: am, config, persist }, { action: 'enable', accountUuid: 'uuid-a' });
  assert.equal(on.statusCode, 200);
  assert.equal(am.accounts[0].enabled, true);
  assert.equal('enabled' in disk.accounts[0], false, 'enabled accounts carry no flag, like the TUI');
});

test('a failed write changes nothing live', async () => {
  const { am, config } = makeManager();
  const { persist } = diskPersist(structuredClone(config), am, { fail: true });
  await assert.rejects(
    runAccountControl({ accountManager: am, config, persist }, { action: 'disable', name: 'c' }),
    /disk full/,
  );
  assert.equal(am.accounts[2].enabled, true);
  assert.equal(config.accounts[2].enabled, undefined);
});

test('order actions write contiguous priorities to disk and the live manager', async () => {
  const { am, config } = makeManager();
  const disk = structuredClone(config);
  const { persist } = diskPersist(disk, am);
  const run = request => runAccountControl({ accountManager: am, config, persist }, request);

  assert.equal((await run({ action: 'up', name: 'd' })).body.changed, true);
  assert.equal((await run({ action: 'up', accountUuid: 'uuid-b' })).body.changed, true);
  assert.equal((await run({ action: 'up', accountUuid: 'uuid-b' })).body.changed, true);
  assert.deepEqual(am.accounts.map(a => a.priority), [null, 0, null, 1]);
  assert.deepEqual(disk.accounts.map(a => a.priority ?? null), [null, 0, null, 1]);
  assert.equal(am.getActiveAccount().name, 'b', 'rank #1 becomes the primary');

  assert.equal((await run({ action: 'up', accountUuid: 'uuid-b' })).body.changed, false, 'top stays top');
  assert.equal((await run({ action: 'down', name: 'd' })).body.changed, true, 'last ranked down un-ranks');
  assert.deepEqual(am.accounts.map(a => a.priority), [null, 0, null, null]);
  assert.equal((await run({ action: 'auto', accountUuid: 'uuid-b' })).body.changed, true);
  assert.deepEqual(disk.accounts.map(a => a.priority ?? null), [null, null, null, null]);
});

test('switch moves the current account without persisting, and refuses an unavailable one', async () => {
  const { am, config } = makeManager();
  const disk = structuredClone(config);
  const { persist, writes } = diskPersist(disk, am);
  am.reevalIntervalMs = 5 * 60_000;
  am.getActiveAccount();
  const run = request => runAccountControl({ accountManager: am, config, persist }, request);

  const res = await run({ action: 'switch', name: 'd' });
  assert.equal(res.statusCode, 200);
  assert.equal(am.accounts[am.currentIndex].name, 'd');
  assert.equal(am.getActiveAccount().name, 'd', 'held until the next periodic re-evaluation');
  assert.equal(writes.length, 0);

  am.accounts[2].rateLimitedUntil = Date.now() + HOUR;
  am.accounts[2].status = 'throttled';
  const refused = await run({ action: 'switch', name: 'c' });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.body.error.reason, 'unavailable');
  assert.equal(am.accounts[am.currentIndex].name, 'd');

  assert.equal((await run({ action: 'switch', name: 'nobody' })).statusCode, 404);
  assert.equal((await run({ action: 'delete', name: 'd' })).statusCode, 400, 'no delete action');
});

test('noteRequestError counts per account and rides along in status usage', () => {
  const { am } = makeManager();
  am.noteRequestError(am.accounts[1]);
  am.noteRequestError(am.accounts[1]);
  const status = am.getStatus({ includeIdentity: true });
  assert.equal(status.accounts[1].usage.totalErrors, 2);
  assert.equal(status.accounts[0].usage.totalErrors, 0);
});
