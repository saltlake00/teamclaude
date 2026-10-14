// Browser bootstrap for the web dashboard (served as
// GET /teamclaude/dashboard/client.js). It fetches the supervisor's dashboard
// status route, keeps a short client-side activity list built by diffing
// consecutive snapshots, and assigns the HTML that dashboard-view.js renders.
// A named session also gets account controls: one delegated click handler
// POSTs the action with the session's CSRF token (from the status response),
// and "disable" asks for confirmation first. Nothing here spends upstream quota.

import {
  buildViewModel,
  dashboardText,
  diffSnapshots,
  formatAgo,
  renderAccountsHtml,
  renderActivityHtml,
  renderHostHtml,
  renderSummaryHtml,
  escapeHtml,
} from './view.js';

const POLL_MS = 5000;
const MAX_EVENTS = 50;

const root = document.documentElement;
const text = dashboardText(root.dataset.lang);
const params = new URLSearchParams(location.search);
const theme = params.get('theme');
if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;

const $ = id => document.getElementById(id);
const els = {
  host: $('host'),
  conn: $('conn'),
  notice: $('notice'),
  summary: $('summary'),
  accounts: $('accounts'),
  accountCount: $('account-count'),
  activity: $('activity'),
  confirm: $('confirm'),
  confirmTitle: $('confirm-title'),
};

let lastStatus = null;
let lastVm = null;
let lastOkAt = null;
let connected = null; // null = never tried yet
let timer = null;
let busy = false;
const events = [];

function pushEvents(list) {
  const at = Date.now();
  for (const e of list) events.unshift({ ...e, at });
  events.length = Math.min(events.length, MAX_EVENTS);
}

function renderConn() {
  if (connected === false) {
    els.conn.className = 'conn bad';
    els.conn.textContent = text.unreachable;
  } else if (lastOkAt == null) {
    els.conn.className = 'conn';
    els.conn.textContent = text.connecting;
  } else {
    els.conn.className = 'conn ok';
    els.conn.textContent = text.updated(formatAgo(Date.now() - lastOkAt, text));
  }
}

function renderNotice(vm) {
  if (vm && !vm.identity) {
    const parts = text.identityHint.split('`');
    els.notice.innerHTML = parts.map((p, i) => (i % 2 ? `<code>${escapeHtml(p)}</code>` : escapeHtml(p))).join('');
    els.notice.hidden = false;
  } else {
    els.notice.hidden = true;
  }
}

function render() {
  if (lastStatus) {
    // Rebuild against the current clock so countdowns stay live between polls.
    const vm = buildViewModel(lastStatus, { now: Date.now(), text });
    els.host.innerHTML = renderHostHtml(vm, text);
    els.summary.innerHTML = renderSummaryHtml(vm, text);
    els.accounts.innerHTML = renderAccountsHtml(vm, text, { busy });
    els.accountCount.textContent = String(vm.accounts.length);
    renderNotice(vm);
  }
  els.activity.innerHTML = renderActivityHtml(events, text);
  renderConn();
}

async function poll() {
  try {
    const res = await fetch('/teamclaude/dashboard/status', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const status = await res.json();
    const vm = buildViewModel(status, { now: Date.now(), text });
    if (connected === false) pushEvents([{ tone: 'ok', text: text.events.reconnected }]);
    pushEvents(diffSnapshots(lastVm, vm, text));
    lastStatus = status;
    lastVm = vm;
    lastOkAt = Date.now();
    connected = true;
  } catch {
    if (connected === true) pushEvents([{ tone: 'crit', text: text.events.disconnected }]);
    connected = false;
  }
  render();
}

// ── account controls ──

/** Resolves true when the operator confirms disabling `label`. */
function confirmDisable(label) {
  const dialog = els.confirm;
  if (!dialog || typeof dialog.showModal !== 'function') return Promise.resolve(false);
  els.confirmTitle.textContent = text.controls.confirmTitle(label);
  return new Promise(resolve => {
    let answer = false;
    const onClick = e => {
      const which = e.target.closest('[data-dialog]')?.dataset.dialog;
      if (!which) return;
      answer = which === 'ok';
      dialog.close();
    };
    dialog.addEventListener('click', onClick);
    // Esc closes the dialog too and leaves answer = false.
    dialog.addEventListener('close', () => {
      dialog.removeEventListener('click', onClick);
      resolve(answer);
    }, { once: true });
    dialog.showModal();
    dialog.querySelector('[data-dialog="cancel"]')?.focus();
  });
}

async function failureMessage(res) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (res.headers.get('x-teamclaude-reason') === 'session') return text.actionErrors.session;
  const reason = body?.error?.reason;
  if (reason && text.actionErrors[reason]) return text.actionErrors[reason];
  return body?.error?.message || `HTTP ${res.status}`;
}

async function runAction(button) {
  const action = button.dataset.act;
  const name = button.dataset.name || '';
  const accountUuid = button.dataset.uuid || null;
  const csrf = lastStatus?.dashboard?.csrf;
  if (!action || !name || !csrf || busy) return;
  if (action === 'disable' && !(await confirmDisable(name))) return;
  busy = true;
  render();
  try {
    const res = await fetch('/teamclaude/dashboard/action', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-teamclaude-csrf': csrf },
      body: JSON.stringify({ action, accountUuid, name }),
    });
    if (!res.ok) pushEvents([{ tone: 'crit', text: text.actionFailed(name, await failureMessage(res)) }]);
  } catch {
    pushEvents([{ tone: 'crit', text: text.actionFailed(name, text.actionErrors.network) }]);
  } finally {
    busy = false;
  }
  // Show the result at once; the diff against the previous snapshot reports it.
  await poll();
  schedule();
}

els.accounts.addEventListener('click', e => {
  const button = e.target.closest('button[data-act]');
  if (button && !button.disabled) runAction(button);
});

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (!document.hidden) await poll();
    schedule();
  }, POLL_MS);
}

// A hidden (minimized) window stops polling; coming back refreshes at once.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    poll();
    schedule();
  }
});
setInterval(() => { if (!document.hidden) renderConn(); }, 1000);

poll();
schedule();
