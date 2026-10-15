import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildViewModel,
  dashboardText,
  diffSnapshots,
  renderAccountsHtml,
  renderControlsHtml,
  renderSummaryHtml,
} from '../src/dashboard-view.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const ko = dashboardText('ko');
const en = dashboardText('en');

function account(name, extra = {}) {
  return {
    name,
    accountUuid: `uuid-${name}`,
    type: 'oauth',
    status: 'active',
    enabled: true,
    usable: true,
    priority: null,
    quota: {},
    usage: { totalRequests: 3 },
    inflight: 0,
    maxConcurrent: 3,
    ...extra,
  };
}

function status(accounts, dashboard = { identity: true, port: 3499, csrf: 'token-123' }) {
  return {
    currentAccount: accounts[0]?.name,
    currentAccountUuid: accounts[0]?.accountUuid,
    accounts,
    dashboard,
  };
}

/** The buttons of one row as { act: disabled } (plus the raw HTML). */
function buttons(vm, label, text = ko, opts) {
  const row = vm.accounts.find(r => r.label === label);
  const html = renderControlsHtml(row, vm, text, opts);
  const out = {};
  for (const m of html.matchAll(/<button[^>]*data-act="([a-z]+)"[^>]*>/g)) out[m[1]] = /\sdisabled[\s>]/.test(m[0]);
  return { html, map: out };
}

test('controls need a named session with a CSRF token', () => {
  const accounts = [account('a'), account('b')];
  const named = buildViewModel(status(accounts), { now: NOW, text: ko });
  assert.equal(named.controls, true);
  assert.match(renderAccountsHtml(named, ko), /data-act="disable"/);

  const noToken = buildViewModel(status(accounts, { identity: true, port: 3499 }), { now: NOW, text: ko });
  assert.equal(noToken.controls, false);
  assert.doesNotMatch(renderAccountsHtml(noToken, ko), /<button/);

  const strip = a => {
    const copy = { ...a };
    delete copy.name;
    delete copy.accountUuid;
    return copy;
  };
  const redacted = buildViewModel(status(accounts.map(strip),
    { identity: false, port: 3499, csrf: 'token-123' }), { now: NOW, text: ko });
  assert.equal(redacted.controls, false, 'no identity, no buttons — even if a token appeared');
  assert.doesNotMatch(renderAccountsHtml(redacted, ko), /<button/);
});

test('button states follow the rank, the current account, usability and enabled', () => {
  const vm = buildViewModel(status([
    account('cur', { priority: 0 }),
    account('second', { priority: 1 }),
    account('auto'),
    account('tired', { usable: false, status: 'throttled' }),
    account('off', { enabled: false, usable: false }),
  ]), { now: NOW, text: ko });

  assert.deepEqual(buttons(vm, 'cur').map, { up: true, down: false, auto: false, disable: false },
    'current: no switch, #1 cannot go up');
  assert.deepEqual(buttons(vm, 'second').map, { switch: false, up: false, down: false, auto: false, disable: false });
  assert.deepEqual(buttons(vm, 'auto').map, { switch: false, up: false, down: true, disable: false },
    'unranked: cannot go down, no auto button');
  assert.deepEqual(buttons(vm, 'tired').map, { switch: true, up: false, down: true, disable: false },
    'an unusable account cannot become current');
  assert.match(buttons(vm, 'tired').html, new RegExp(`title="${ko.controls.unavailableTitle}"`));
  assert.deepEqual(buttons(vm, 'off').map, { up: false, down: true, enable: false },
    'a disabled account offers enable, never switch');

  const busy = buttons(vm, 'second', ko, { busy: true }).map;
  assert.ok(Object.values(busy).every(Boolean), 'busy disables every button');
});

test('buttons carry an escaped target and the error count shows next to requests', () => {
  const vm = buildViewModel(status([
    account('a"<b>', { usage: { totalRequests: 1200, totalErrors: 0 } }),
    account('flaky', { usage: { totalRequests: 9, totalErrors: 4 } }),
  ]), { now: NOW, text: en });
  const html = renderAccountsHtml(vm, en);
  assert.match(html, /data-name="a&quot;&lt;b&gt;"/);
  assert.match(html, /data-uuid="uuid-a&quot;&lt;b&gt;"/);
  assert.doesNotMatch(html, /<b>"/);
  assert.match(html, /<span>1,200 req<\/span><span>0 errors<\/span>/);
  assert.match(html, /<span class="err">4 errors<\/span>/);
  assert.equal(en.stats.errors('1'), '1 error');
  assert.equal(ko.stats.errors('4'), '오류 4');
});

test('an order change shows up in the activity list', () => {
  const before = buildViewModel(status([account('a'), account('b', { priority: 0 })]), { now: NOW, text: ko });
  const after = buildViewModel(status([account('a', { priority: 0 }), account('b', { priority: 1 })]), { now: NOW, text: ko });
  const texts = diffSnapshots(before, after, ko).map(e => e.text);
  assert.ok(texts.includes('a 순서: 자동 → #1'), texts.join(' | '));
  assert.ok(texts.includes('b 순서: #1 → #2'), texts.join(' | '));
});

test('English and Korean control texts have the same keys', () => {
  assert.deepEqual(Object.keys(en.controls).sort(), Object.keys(ko.controls).sort());
  assert.deepEqual(Object.keys(en.actionErrors).sort(), Object.keys(ko.actionErrors).sort());
});

test('the refresh-usage button sits in the summary only for a page that may act', () => {
  const acting = buildViewModel(status([account('a')]), { now: NOW, text: ko });
  const html = renderSummaryHtml(acting, ko);
  assert.match(html, /<button type="button" class="btn" data-fleet="refresh-usage"/);
  assert.match(html, />사용량 새로고침<\/button>/);
  assert.match(renderSummaryHtml(acting, en), />Refresh usage<\/button>/);

  const busy = renderSummaryHtml(acting, ko, { busy: true });
  assert.match(busy, /data-fleet="refresh-usage"[^>]* disabled>새로고침 중…/);

  const readOnly = buildViewModel(status([account('a')], { identity: true, port: 3499 }), { now: NOW, text: ko });
  assert.doesNotMatch(renderSummaryHtml(readOnly, ko), /data-fleet/);
  const redacted = buildViewModel(status([account('a')], { identity: false, port: 3499 }), { now: NOW, text: ko });
  assert.doesNotMatch(renderSummaryHtml(redacted, ko), /data-fleet/);
});

test('English and Korean usage-refresh texts have the same keys', () => {
  assert.deepEqual(Object.keys(en.usage).sort(), Object.keys(ko.usage).sort());
  assert.match(ko.usage.done(2, 3), /3개 중 2개/);
});
