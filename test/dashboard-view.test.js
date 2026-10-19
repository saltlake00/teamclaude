import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildViewModel,
  dashboardText,
  diffSnapshots,
  displayOrder,
  escapeHtml,
  formatCompact,
  formatRemaining,
  levelOf,
  renderAccountsHtml,
  renderActivityHtml,
  renderSummaryHtml,
} from '../src/dashboard-view.js';
import { tuiText } from '../src/tui-i18n.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const H = 60 * 60 * 1000;
const ko = dashboardText('ko');
const en = dashboardText('en');

function account(name, quota = {}, extra = {}) {
  return {
    ...(name == null ? {} : { name, accountUuid: `uuid-${name}` }),
    type: 'oauth',
    provider: 'anthropic',
    status: 'active',
    errorReason: null,
    subscription: { state: 'active' },
    usable: true,
    creditBacked: false,
    enabled: true,
    priority: null,
    quota: {
      unified5h: null, unified7d: null, unified5hReset: null, unified7dReset: null,
      tokensLimit: null, tokensRemaining: null, requestsLimit: null, requestsRemaining: null,
      resetsAt: null, modelWeekly: {},
      ...quota,
    },
    usage: { totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, lastUsed: null },
    inflight: 0,
    maxConcurrent: 3,
    ...extra,
  };
}

function payload(accounts, extra = {}) {
  return {
    switchThreshold: 0.98,
    usableCount: accounts.filter(a => a.usable).length,
    totalCount: accounts.length,
    accounts,
    host: { cpu: { usedPct: 23 }, memory: { usedPct: 92.4 } },
    dashboard: { identity: accounts.some(a => a.name), port: 3456 },
    ...extra,
  };
}

test('bar levels use the TUI 70%/90% thresholds', () => {
  assert.equal(levelOf(null), 'none');
  assert.equal(levelOf(0), 'ok');
  assert.equal(levelOf(0.699), 'ok');
  assert.equal(levelOf(0.7), 'warn');
  assert.equal(levelOf(0.899), 'warn');
  assert.equal(levelOf(0.9), 'crit');
  assert.equal(levelOf(1), 'crit');
});

test('remaining time is formatted per language and empty once passed', () => {
  assert.equal(formatRemaining(12 * 60 * 1000, ko), '12분');
  assert.equal(formatRemaining(2 * H + 13 * 60 * 1000, ko), '2시간 13분');
  assert.equal(formatRemaining(3 * H, ko), '3시간');
  assert.equal(formatRemaining(76 * H, ko), '3일 4시간');
  assert.equal(formatRemaining(2 * H + 13 * 60 * 1000, en), '2h 13m');
  assert.equal(formatRemaining(0, en), null);
  assert.equal(formatRemaining(-5, en), null);
  assert.equal(formatCompact(999), '999');
  assert.equal(formatCompact(1200), '1.2K');
  assert.equal(formatCompact(3_000_000), '3M');
});

test('dashboard status words match the TUI status column in both languages', () => {
  assert.deepEqual(ko.status, tuiText('ko').status);
  assert.deepEqual(en.status, tuiText('en').status);
});

test('order: ranked accounts first by priority, then weekly reset soonest', () => {
  const accounts = [
    account('late', { unified7d: 0.1, unified7dReset: NOW + 5 * 24 * H }),
    account('pinned2', {}, { priority: 1 }),
    account('soon', { unified7d: 0.4, unified7dReset: NOW + 1 * 24 * H }),
    account('pinned1', {}, { priority: 0 }),
    account('nodata'),
    // A passed reset ranks like no data (rollover), not first.
    account('rolled', { unified7d: 0.9, unified7dReset: NOW - H }),
  ];
  const { order } = displayOrder(accounts, NOW);
  assert.deepEqual(order.map(i => accounts[i].name), ['pinned1', 'pinned2', 'soon', 'late', 'nodata', 'rolled']);

  const vm = buildViewModel(payload(accounts), { now: NOW, text: ko });
  assert.deepEqual(vm.accounts.map(r => r.rank), [1, 2, null, null, null, null]);
});

test('view model: bars, reset countdown, summary and current account', () => {
  const accounts = [
    account('a@example.com', {
      unified5h: 0.42, unified5hReset: NOW + 2 * H + 13 * 60 * 1000,
      unified7d: 0.91, unified7dReset: NOW + 3 * 24 * H,
    }, { inflight: 2, usage: { totalRequests: 1234, totalInputTokens: 1200, totalOutputTokens: 3_400_000, lastUsed: new Date(NOW - 3 * 60 * 1000).toISOString() } }),
    account('b@example.com', { unified5h: 0.75, unified5hReset: NOW + 40 * 60 * 1000 }, { enabled: false, usable: false }),
    account('c@example.com', { unified5h: 0.1, unified5hReset: NOW + H }, { maxConcurrent: 2 }),
    // A per-minute API-key window resets sooner but is not a session.
    account('key', { tokensLimit: 100, tokensRemaining: 50, resetsAt: new Date(NOW + 60_000).toISOString() }, { type: 'apikey', maxConcurrent: 0 }),
  ];
  const vm = buildViewModel(payload(accounts, {
    currentAccount: 'a@example.com', currentAccountUuid: 'uuid-a@example.com',
  }), { now: NOW, text: ko });

  const a = vm.accounts.find(r => r.label === 'a@example.com');
  assert.equal(a.isCurrent, true);
  assert.equal(a.bars[1].label, '세션');
  assert.equal(a.bars[1].pct, 42);
  assert.equal(a.bars[1].level, 'ok');
  assert.equal(a.bars[1].resetIn, '2시간 13분');
  assert.equal(a.bars[0].label, '주간');
  assert.equal(a.bars[0].level, 'crit');
  assert.equal(a.bars.length, 2, 'Fable bar is dropped in stage 1');
  assert.equal(a.stats.lastUsedAgo, '3분 전');

  const b = vm.accounts.find(r => r.label === 'b@example.com');
  assert.equal(b.status.key, 'disabled');
  assert.equal(b.status.label, '꺼짐');

  assert.equal(vm.summary.usable, 3);
  assert.equal(vm.summary.total, 4);
  assert.equal(vm.summary.inflight, 2);
  assert.equal(vm.summary.capacity, 5, 'disabled account slots are not capacity');
  // b resets sooner but is disabled and `key` is not a session, so c (1h) is next.
  assert.deepEqual(vm.summary.nextReset, { in: '1시간', label: 'c@example.com' });
  assert.deepEqual(vm.host, { cpu: 23, ram: 92.4, cpuLevel: 'ok', ramLevel: 'crit' });

  const html = renderAccountsHtml(vm, ko);
  assert.match(html, /요청 1,234/);
  assert.match(html, /입력 1\.2K/);
  assert.match(html, /출력 3\.4M/);
  assert.match(html, /동시 2\/3/);
  assert.match(html, /2시간 13분 후 리셋/);
  assert.match(html, /class="acct is-off"/);
  assert.match(html, /class="acct is-current"/);
  assert.match(renderSummaryHtml(vm, ko), /1시간/);
});

test('redacted payload labels accounts by config position, never by a guessed name', () => {
  const accounts = [
    account(null, { unified7d: 0.2, unified7dReset: NOW + 5 * 24 * H }),
    account(null, { unified7d: 0.2, unified7dReset: NOW + 1 * 24 * H }),
  ];
  const vm = buildViewModel(payload(accounts), { now: NOW, text: ko });
  assert.equal(vm.identity, false);
  // Display order puts the second config entry first; its label keeps "계정 2".
  assert.deepEqual(vm.accounts.map(r => r.label), ['계정 2', '계정 1']);
  assert.deepEqual(vm.accounts.map(r => r.named), [false, false]);
  assert.equal(vm.accounts.some(r => r.isCurrent), false);
});

test('status badges follow the TUI precedence and expose the error reason', () => {
  const st = a => buildViewModel(payload([a]), { now: NOW, text: ko }).accounts[0].status;
  assert.equal(st(account('x', {}, { status: 'error', errorReason: 'auth-revoked' })).label, '오류');
  assert.match(st(account('x', {}, { status: 'error', errorReason: 'auth-revoked' })).title, /다시 로그인/);
  assert.equal(st(account('x', {}, { status: 'error', errorReason: 'subscription-disabled' })).label, '접근차단');
  assert.equal(st(account('x', {}, { status: 'throttled' })).tone, 'warn');
  assert.equal(st(account('x', {}, { status: 'active', creditBacked: true })).label, '크레딧');
  assert.equal(st(account('x', {}, { status: 'error', enabled: false })).label, '꺼짐');
});

test('API-key accounts show tokens/requests bars', () => {
  const vm = buildViewModel(payload([account('key', {
    tokensLimit: 1000, tokensRemaining: 250, requestsLimit: 100, requestsRemaining: 95,
  }, { type: 'apikey' })]), { now: NOW, text: en });
  const bars = vm.accounts[0].bars;
  assert.deepEqual(bars.map(b => [b.label, b.pct, b.level]), [['Tokens', 75, 'warn'], ['Requests', 5, 'ok']]);
});

test('account names are escaped in HTML', () => {
  const vm = buildViewModel(payload([account('<img src=x onerror=alert(1)>')]), { now: NOW, text: en });
  const html = renderAccountsHtml(vm, en);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(escapeHtml(`"'&`), '&quot;&#39;&amp;');
});

test('activity: diffing snapshots reports switches, thresholds, resets and toggles', () => {
  const before = buildViewModel(payload([
    account('a', { unified5h: 0.65, unified5hReset: NOW + H }),
    account('b', { unified5h: 0.5, unified5hReset: NOW + 2 * H }),
    account('c', { unified5h: 0.95, unified5hReset: NOW + 10 * 60 * 1000 }),
  ], { currentAccount: 'a', currentAccountUuid: 'uuid-a' }), { now: NOW, text: ko });
  const after = buildViewModel(payload([
    account('a', { unified5h: 0.72, unified5hReset: NOW + H }, { status: 'throttled' }),
    account('b', { unified5h: 0.93, unified5hReset: NOW + 2 * H }, { enabled: false }),
    account('c', { unified5h: 0.02, unified5hReset: NOW + 5 * H }),
    account('d'),
  ], { currentAccount: 'c', currentAccountUuid: 'uuid-c' }), { now: NOW, text: ko });

  const texts = diffSnapshots(before, after, ko).map(e => e.text);
  assert.ok(texts.includes('현재 계정: a → c'), texts.join('\n'));
  assert.ok(texts.includes('a: 정상 → 제한중'), texts.join('\n'));
  assert.ok(texts.includes('a 세션 70% 넘음'), texts.join('\n'));
  assert.ok(texts.includes('b 끔'), texts.join('\n'));
  // A jump straight past 90% reports only the 90% crossing.
  assert.ok(texts.includes('b 세션 90% 넘음'), texts.join('\n'));
  assert.ok(!texts.includes('b 세션 70% 넘음'), texts.join('\n'));
  assert.ok(texts.includes('c 세션 한도 리셋됨'), texts.join('\n'));
  assert.ok(texts.includes('계정 추가: d'), texts.join('\n'));

  assert.deepEqual(diffSnapshots(before, before, ko), []);
  assert.deepEqual(diffSnapshots(null, after, ko), []);

  const html = renderActivityHtml([{ at: new Date(2026, 9, 14, 9, 5, 7).getTime(), tone: 'ok', text: 'x' }], ko);
  assert.match(html, /<time>09:05:07<\/time>/);
});
