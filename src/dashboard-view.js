// Web dashboard view logic (status display + account control buttons).
//
// This file is served VERBATIM to the browser as an ES module
// (GET /teamclaude/dashboard/view.js) and is also imported by the Node tests,
// so it must stay pure: no imports, no Node or DOM globals at load time.
// Everything here turns one /teamclaude/status payload into display data and
// HTML strings; the browser bootstrap (dashboard-client.js) only fetches,
// diffs and assigns innerHTML.

const EN = {
  lang: 'en',
  locale: 'en-US',
  title: 'TeamClaude',
  port: 'Port',
  summary: {
    usable: 'Usable accounts',
    usableSub: 'can take requests now',
    inflight: 'Requests in flight',
    inflightSub: n => `of ${n} concurrent slots`,
    nextReset: 'Next session reset',
    nextResetNone: 'no measured session yet',
  },
  accounts: 'Accounts',
  activity: 'Activity',
  noActivity: 'Nothing has changed since this window opened.',
  noAccounts: 'No accounts configured.',
  account: n => `Account ${n}`,
  current: 'current',
  bar: { session: 'Session', weekly: 'Weekly', tokens: 'Tokens', requests: 'Requests' },
  notMeasured: 'not measured',
  resetsIn: s => `resets in ${s}`,
  stats: {
    requests: n => `${n} req`,
    tokensIn: s => `in ${s}`,
    tokensOut: s => `out ${s}`,
    inflight: (i, m) => `${i}/${m} in flight`,
    lastUsed: s => `last used ${s}`,
    credits: s => `credits ${s}`,
    errors: n => (n === '1' ? '1 error' : `${n} errors`),
  },
  controls: {
    switch: 'Switch now',
    switchTitle: 'Make this the current account until the next automatic re-evaluation',
    unavailableTitle: 'This account cannot take requests right now',
    up: 'Move up',
    down: 'Move down',
    auto: 'Auto order',
    autoTitle: 'Drop the explicit rank and return to automatic ordering',
    enable: 'Enable',
    disable: 'Disable',
    confirmTitle: n => `Disable ${n}?`,
    confirmBody: 'It leaves the rotation. Requests already in flight still finish, and you can enable it again at any time.',
    confirmOk: 'Disable',
    cancel: 'Cancel',
  },
  usage: {
    refresh: 'Refresh usage',
    refreshTitle: 'Ask Anthropic for the current 5-hour and weekly usage of each account (spends no tokens)',
    refreshing: 'Refreshing…',
    done: (updated, targets) => `Usage refreshed for ${updated} of ${targets} account(s)`,
    skipped: 'No account could be polled right now (in use, disabled, API key, or token about to expire)',
    failed: msg => `Usage refresh failed — ${msg}`,
  },
  actionFailed: (n, msg) => `${n}: action failed — ${msg}`,
  actionErrors: {
    session: 'the dashboard session ended — reopen it with `teamclaude dashboard`',
    'not-found': 'the account is no longer in the running proxy',
    unavailable: 'the account cannot take requests right now',
    network: 'the proxy did not answer',
  },
  // Same words as the TUI status column (src/tui-i18n.js); a test keeps them equal.
  status: {
    disabled: 'disabled',
    subEnded: 'sub ended',
    access: 'access',
    reauth: 'reauth',
    error: 'error',
    subDue: 'sub due',
    canceling: 'canceling',
    credits: 'credits',
    active: 'active',
    throttled: 'throttled',
    exhausted: 'exhausted',
    ready: 'ready',
  },
  errorReason: {
    'subscription-disabled': 'organization blocked Claude Code access',
    'subscription-ended': 'subscription ended',
    'auth-revoked': 'credentials revoked — log in again',
    'refresh-failed': 'token refresh failed',
    'auth-rejected': 'credentials rejected',
    'send-failed': 'send failed (cooling down)',
  },
  dur: {
    m: n => `${n}m`,
    hm: (h, m) => (m > 0 ? `${h}h ${m}m` : `${h}h`),
    dh: (d, h) => (h > 0 ? `${d}d ${h}h` : `${d}d`),
  },
  ago: {
    s: n => `${n}s ago`,
    m: n => `${n}m ago`,
    h: n => `${n}h ago`,
    d: n => `${n}d ago`,
  },
  updated: s => `updated ${s}`,
  connecting: 'connecting…',
  unreachable: 'Proxy unreachable — retrying',
  identityHint: 'Account names and controls are hidden. Open this window with `teamclaude dashboard` to show them.',
  events: {
    current: (a, b) => `Active account: ${a} → ${b}`,
    rank: (n, a, b) => `${n} order: ${a} → ${b}`,
    autoRank: 'auto',
    status: (n, a, b) => `${n}: ${a} → ${b}`,
    enabled: n => `${n} enabled`,
    disabled: n => `${n} disabled`,
    crossed: (n, bar, pct) => `${n} ${bar} passed ${pct}%`,
    reset: (n, bar) => `${n} ${bar} window reset`,
    added: n => `Account added: ${n}`,
    removed: n => `Account removed: ${n}`,
    disconnected: 'Lost connection to the proxy',
    reconnected: 'Reconnected to the proxy',
  },
  autostart: {
    heading: 'Startup',
    title: 'Start when I log in to Windows',
    onSub: name => `Task Scheduler task "${name}" starts the proxy without a window. Its log is next to the config file.`,
    offSub: 'The proxy runs only when you start it yourself.',
    dashboard: 'Also open this dashboard window',
    loading: 'Checking Task Scheduler…',
    disabledInScheduler: 'The task exists but is disabled in Task Scheduler. Turning this on enables it again.',
    stale: 'The task starts a different Node, program or config than this proxy. Turn it off and on again to update it.',
    failed: msg => `Task Scheduler: ${msg}`,
    turnedOn: 'Start at login turned on',
    turnedOff: 'Start at login turned off',
    dashboardOn: 'The dashboard will open at login',
    dashboardOff: 'The dashboard will not open at login',
  },
};

const KO = {
  lang: 'ko',
  locale: 'ko-KR',
  title: 'TeamClaude',
  port: '포트',
  summary: {
    usable: '쓸 수 있는 계정',
    usableSub: '지금 요청을 받을 수 있음',
    inflight: '진행 중 요청',
    inflightSub: n => `동시 한도 ${n}개 중`,
    nextReset: '가장 빠른 세션 리셋',
    nextResetNone: '측정된 세션 없음',
  },
  accounts: '계정',
  activity: '최근 활동',
  noActivity: '창을 연 뒤로 바뀐 것이 없습니다.',
  noAccounts: '등록된 계정이 없습니다.',
  account: n => `계정 ${n}`,
  current: '현재',
  bar: { session: '세션', weekly: '주간', tokens: '토큰', requests: '요청' },
  notMeasured: '측정 전',
  resetsIn: s => `${s} 후 리셋`,
  stats: {
    requests: n => `요청 ${n}`,
    tokensIn: s => `입력 ${s}`,
    tokensOut: s => `출력 ${s}`,
    inflight: (i, m) => `동시 ${i}/${m}`,
    lastUsed: s => `마지막 사용 ${s}`,
    credits: s => `잔액 ${s}`,
    errors: n => `오류 ${n}`,
  },
  controls: {
    switch: '지금 전환',
    switchTitle: '다음 자동 재평가 전까지 이 계정을 현재 계정으로 씁니다',
    unavailableTitle: '이 계정은 지금 요청을 받을 수 없습니다',
    up: '순위 올리기',
    down: '순위 내리기',
    auto: '자동 순서',
    autoTitle: '지정한 순위를 지우고 자동 순서로 되돌립니다',
    enable: '켜기',
    disable: '끄기',
    confirmTitle: n => `${n} 계정을 끌까요?`,
    confirmBody: '회전에서 빠집니다. 이미 진행 중인 요청은 끝까지 처리되고, 언제든 다시 켤 수 있습니다.',
    confirmOk: '끄기',
    cancel: '취소',
  },
  usage: {
    refresh: '사용량 새로고침',
    refreshTitle: '계정마다 현재 5시간·주간 사용량을 Anthropic에 직접 물어봅니다 (토큰을 쓰지 않습니다)',
    refreshing: '새로고침 중…',
    done: (updated, targets) => `계정 ${targets}개 중 ${updated}개의 사용량을 새로 읽었습니다`,
    skipped: '지금 조회할 수 있는 계정이 없습니다 (사용 중·꺼짐·API 키 계정·토큰 만료 직전)',
    failed: msg => `사용량 새로고침 실패 — ${msg}`,
  },
  actionFailed: (n, msg) => `${n}: 조작 실패 — ${msg}`,
  actionErrors: {
    session: '대시보드 세션이 끝났습니다. `teamclaude dashboard`로 다시 여세요',
    'not-found': '실행 중인 프록시에 그 계정이 없습니다',
    unavailable: '그 계정은 지금 요청을 받을 수 없습니다',
    network: '프록시가 응답하지 않습니다',
  },
  status: {
    disabled: '꺼짐',
    subEnded: '구독종료',
    access: '접근차단',
    reauth: '재인증',
    error: '오류',
    subDue: '종료도달',
    canceling: '해지예정',
    credits: '크레딧',
    active: '정상',
    throttled: '제한중',
    exhausted: '소진',
    ready: '대기',
  },
  errorReason: {
    'subscription-disabled': '조직의 Claude Code 접근 차단',
    'subscription-ended': '구독 종료',
    'auth-revoked': '인증 무효 — 다시 로그인 필요',
    'refresh-failed': '토큰 갱신 실패',
    'auth-rejected': '인증 거부',
    'send-failed': '송신 실패 (잠시 대기)',
  },
  dur: {
    m: n => `${n}분`,
    hm: (h, m) => (m > 0 ? `${h}시간 ${m}분` : `${h}시간`),
    dh: (d, h) => (h > 0 ? `${d}일 ${h}시간` : `${d}일`),
  },
  ago: {
    s: n => `${n}초 전`,
    m: n => `${n}분 전`,
    h: n => `${n}시간 전`,
    d: n => `${n}일 전`,
  },
  updated: s => `${s} 갱신`,
  connecting: '연결 중…',
  unreachable: '프록시에 연결할 수 없음 — 다시 시도 중',
  identityHint: '계정 이름과 조작 버튼이 가려져 있습니다. `teamclaude dashboard` 명령으로 이 창을 열면 보입니다.',
  events: {
    current: (a, b) => `현재 계정: ${a} → ${b}`,
    rank: (n, a, b) => `${n} 순서: ${a} → ${b}`,
    autoRank: '자동',
    status: (n, a, b) => `${n}: ${a} → ${b}`,
    enabled: n => `${n} 켬`,
    disabled: n => `${n} 끔`,
    crossed: (n, bar, pct) => `${n} ${bar} ${pct}% 넘음`,
    reset: (n, bar) => `${n} ${bar} 한도 리셋됨`,
    added: n => `계정 추가: ${n}`,
    removed: n => `계정 제거: ${n}`,
    disconnected: '프록시 연결 끊김',
    reconnected: '프록시 다시 연결됨',
  },
  autostart: {
    heading: '시작 설정',
    title: 'Windows에 로그인하면 자동으로 시작',
    onSub: name => `작업 스케줄러의 "${name}" 작업이 창 없이 프록시를 띄웁니다. 로그는 설정 파일 옆에 남습니다.`,
    offSub: '직접 실행할 때만 프록시가 켜집니다.',
    dashboard: '대시보드 창도 같이 열기',
    loading: '작업 스케줄러 확인 중…',
    disabledInScheduler: '작업은 있지만 작업 스케줄러에서 꺼져 있습니다. 여기서 켜면 다시 켜집니다.',
    stale: '작업이 지금 프록시와 다른 Node·프로그램·설정을 띄웁니다. 껐다가 다시 켜면 갱신됩니다.',
    failed: msg => `작업 스케줄러 오류: ${msg}`,
    turnedOn: '로그인 때 자동 시작을 켰습니다',
    turnedOff: '로그인 때 자동 시작을 껐습니다',
    dashboardOn: '로그인 때 대시보드 창도 엽니다',
    dashboardOff: '로그인 때 대시보드 창은 열지 않습니다',
  },
};

const TEXTS = { en: EN, ko: KO };

export function dashboardText(lang = 'en') {
  return TEXTS[lang] || EN;
}

/** Same thresholds as the TUI bars and host header: green < 70% ≤ amber < 90% ≤ red. */
export function levelOf(ratio) {
  if (ratio == null || Number.isNaN(ratio)) return 'none';
  if (ratio < 0.7) return 'ok';
  if (ratio < 0.9) return 'warn';
  return 'crit';
}

const LEVEL_RANK = { none: 0, ok: 1, warn: 2, crit: 3 };

export function formatRemaining(ms, text) {
  if (!(ms > 0)) return null;
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return text.dur.m(mins);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return text.dur.hm(hrs, mins % 60);
  return text.dur.dh(Math.floor(hrs / 24), hrs % 24);
}

export function formatAgo(ms, text) {
  if (!(ms >= 0)) return null;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return text.ago.s(secs);
  const mins = Math.floor(secs / 60);
  if (mins < 60) return text.ago.m(mins);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return text.ago.h(hrs);
  return text.ago.d(Math.floor(hrs / 24));
}

export function formatCompact(n) {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  const trim = v => v.toFixed(1).replace(/\.0$/, '');
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1e6) return `${trim(n / 1e3)}K`;
  if (abs < 1e9) return `${trim(n / 1e6)}M`;
  return `${trim(n / 1e9)}B`;
}

function toMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// ── ordering (mirrors the TUI list: ranked first, then the auto drain order) ──

function weeklyResetTime(a, now) {
  const q = a.quota || {};
  const r = (q.unified7d != null && q.unified7dReset) ? q.unified7dReset : Infinity;
  return r > now ? r : Infinity;
}

function sessionResetTime(a, now) {
  const q = a.quota || {};
  const r = q.unified5hReset || toMs(q.resetsAt) || Infinity;
  return r > now ? r : Infinity;
}

function sessionUtilization(a) {
  const q = a.quota || {};
  if (q.unified5h != null) return q.unified5h;
  if (q.tokensLimit != null && q.tokensRemaining != null) return 1 - q.tokensRemaining / q.tokensLimit;
  if (q.requestsLimit != null && q.requestsRemaining != null) return 1 - q.requestsRemaining / q.requestsLimit;
  return 0;
}

/** Same comparator as AccountManager.autoCompare, on status-payload accounts. */
function autoCompare(a, b, now) {
  const wa = weeklyResetTime(a, now);
  const wb = weeklyResetTime(b, now);
  if (wa !== wb) return wa < wb ? -1 : 1;
  const ra = sessionResetTime(a, now);
  const rb = sessionResetTime(b, now);
  if (ra !== rb) return ra < rb ? -1 : 1;
  return sessionUtilization(a) - sessionUtilization(b);
}

/**
 * Display order as index list: accounts with a priority first (lower first,
 * array order on ties), then the rest in the automatic use-or-lose order.
 */
export function displayOrder(accounts, now = Date.now()) {
  const idx = accounts.map((_, i) => i);
  const ranked = idx.filter(i => accounts[i].priority != null)
    .sort((x, y) => (accounts[x].priority - accounts[y].priority) || (x - y));
  const auto = idx.filter(i => accounts[i].priority == null)
    .sort((x, y) => autoCompare(accounts[x], accounts[y], now) || (x - y));
  return { ranked, order: [...ranked, ...auto] };
}

// ── per-account view ──

/** Status badge, same precedence as the TUI status column. */
export function statusOf(a, text) {
  const st = text.status;
  const reason = a.errorReason ? (text.errorReason[a.errorReason] || a.errorReason) : null;
  if (a.enabled === false) return { key: 'disabled', tone: 'muted', label: st.disabled, title: null };
  const sub = a.subscription?.state;
  if (sub === 'ended') return { key: 'subEnded', tone: 'crit', label: st.subEnded, title: reason };
  if (a.status === 'error') {
    return a.errorReason === 'subscription-disabled'
      ? { key: 'access', tone: 'crit', label: st.access, title: reason }
      : { key: 'error', tone: 'crit', label: st.error, title: reason };
  }
  if (sub === 'end-date-reached') return { key: 'subDue', tone: 'warn', label: st.subDue, title: null };
  if (sub === 'cancellation-scheduled') return { key: 'canceling', tone: 'warn', label: st.canceling, title: null };
  if (a.status === 'active' && a.creditBacked === true) return { key: 'credits', tone: 'info', label: st.credits, title: null };
  switch (a.status) {
    case 'active': return { key: 'active', tone: 'ok', label: st.active, title: null };
    case 'throttled': return { key: 'throttled', tone: 'warn', label: st.throttled, title: null };
    case 'exhausted': return { key: 'exhausted', tone: 'crit', label: st.exhausted, title: null };
    default: return { key: 'ready', tone: 'neutral', label: a.status || st.ready, title: null };
  }
}

function barView(label, ratio, resetAt, now, text) {
  const r = ratio == null || Number.isNaN(ratio) ? null : clamp01(ratio);
  const reset = resetAt != null && resetAt > now ? resetAt : null;
  return {
    label,
    ratio: r,
    pct: r == null ? null : Math.round(r * 100),
    level: levelOf(r),
    resetAt: reset,
    resetIn: reset == null ? null : formatRemaining(reset - now, text),
  };
}

/** Session/weekly for OAuth accounts, tokens/requests for API-key accounts (TUI rule: keyed on TYPE). */
export function barsOf(a, now, text) {
  const q = a.quota || {};
  if (a.type === 'oauth') {
    return [
      barView(text.bar.session, q.unified5h, q.unified5hReset ?? null, now, text),
      barView(text.bar.weekly, q.unified7d, q.unified7dReset ?? null, now, text),
    ];
  }
  const tokens = (q.tokensLimit != null && q.tokensRemaining != null) ? 1 - q.tokensRemaining / q.tokensLimit : null;
  const requests = (q.requestsLimit != null && q.requestsRemaining != null) ? 1 - q.requestsRemaining / q.requestsLimit : null;
  const reset = toMs(q.resetsAt);
  return [
    barView(text.bar.tokens, tokens, reset, now, text),
    barView(text.bar.requests, requests, reset, now, text),
  ];
}

function isCurrent(status, a) {
  if (a.name == null) return false;
  if (status.currentAccountUuid && a.accountUuid) return status.currentAccountUuid === a.accountUuid;
  return status.currentAccount != null && status.currentAccount === a.name;
}

/**
 * Turn one status payload into everything the page draws. `status.dashboard`
 * is added by the supervisor ({ identity, port }); without identity the payload
 * carries no names, so accounts are labelled by their stable config position.
 */
export function buildViewModel(status, { now = Date.now(), text = EN } = {}) {
  const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
  const { ranked, order } = displayOrder(accounts, now);
  const rankOf = new Map(ranked.map((i, pos) => [i, pos + 1]));

  const rows = order.map(i => {
    const a = accounts[i];
    const named = typeof a.name === 'string' && a.name.length > 0;
    const usage = a.usage || {};
    const lastUsed = toMs(usage.lastUsed);
    const credits = a.provider === 'codex' && a.quota?.codexCredits
      ? (a.quota.codexCredits.unlimited ? '∞' : a.quota.codexCredits.balance ?? null)
      : null;
    return {
      key: named ? `id:${a.accountUuid || a.name}` : `idx:${i}`,
      index: i,
      label: named ? a.name : text.account(i + 1),
      named,
      // What an action names the account by (the worker matches UUID first).
      target: named ? { accountUuid: a.accountUuid || null, name: a.name } : null,
      rank: rankOf.get(i) ?? null,
      isCurrent: isCurrent(status, a),
      type: a.type || null,
      provider: a.provider || null,
      enabled: a.enabled !== false,
      usable: a.usable === true,
      status: statusOf(a, text),
      bars: barsOf(a, now, text),
      stats: {
        requests: Number(usage.totalRequests) || 0,
        errors: Number(usage.totalErrors) || 0,
        tokensIn: Number(usage.totalInputTokens) || 0,
        tokensOut: Number(usage.totalOutputTokens) || 0,
        inflight: Number(a.inflight) || 0,
        maxConcurrent: Number(a.maxConcurrent) || 0,
        lastUsedAgo: lastUsed == null ? null : formatAgo(Math.max(0, now - lastUsed), text),
        credits: credits == null ? null : String(credits),
      },
    };
  });

  // Only OAuth accounts have a 5-hour session window; an API-key account's
  // per-minute rate-limit reset is not a "session" and would always win.
  let next = null;
  for (const row of rows) {
    if (!row.enabled || row.type !== 'oauth') continue;
    const at = row.bars[0].resetAt;
    if (at != null && (next == null || at < next.at)) next = { at, label: row.label };
  }

  const host = status?.host;
  const hostView = host && (host.cpu || host.memory)
    ? {
        cpu: host.cpu?.usedPct ?? null,
        ram: host.memory?.usedPct ?? null,
        cpuLevel: levelOf(host.cpu?.usedPct == null ? null : host.cpu.usedPct / 100),
        ramLevel: levelOf(host.memory?.usedPct == null ? null : host.memory.usedPct / 100),
      }
    : null;

  const identity = status?.dashboard?.identity === true;
  return {
    identity,
    // Buttons need a named session AND the supervisor's CSRF token for it.
    controls: identity && typeof status?.dashboard?.csrf === 'string' && status.dashboard.csrf.length > 0,
    port: status?.dashboard?.port ?? null,
    summary: {
      usable: Number.isFinite(status?.usableCount) ? status.usableCount : rows.filter(r => r.usable).length,
      total: Number.isFinite(status?.totalCount) ? status.totalCount : rows.length,
      inflight: rows.reduce((s, r) => s + r.stats.inflight, 0),
      capacity: rows.reduce((s, r) => s + (r.enabled ? r.stats.maxConcurrent : 0), 0),
      nextReset: next ? { in: formatRemaining(next.at - now, text), label: next.label } : null,
    },
    host: hostView,
    accounts: rows,
  };
}

// ── activity: events derived by comparing two consecutive view models ──

const THRESHOLDS = [{ level: 'warn', pct: 70 }, { level: 'crit', pct: 90 }];

/** What changed between two snapshots, oldest-first. Returns [{ tone, text }]. */
export function diffSnapshots(prev, next, text) {
  if (!prev || !next) return [];
  const ev = text.events;
  const out = [];
  const before = new Map(prev.accounts.map(r => [r.key, r]));
  const after = new Map(next.accounts.map(r => [r.key, r]));

  // Identity flipped (redacted ⇄ named): keys are not comparable, report nothing.
  if (prev.identity !== next.identity) return out;

  const prevCur = prev.accounts.find(r => r.isCurrent);
  const nextCur = next.accounts.find(r => r.isCurrent);
  if (prevCur && nextCur && prevCur.key !== nextCur.key) {
    out.push({ tone: 'info', text: ev.current(prevCur.label, nextCur.label) });
  }

  for (const [key, r] of after) {
    const p = before.get(key);
    if (!p) {
      out.push({ tone: 'info', text: ev.added(r.label) });
      continue;
    }
    if (p.enabled !== r.enabled) {
      out.push({ tone: r.enabled ? 'ok' : 'muted', text: r.enabled ? ev.enabled(r.label) : ev.disabled(r.label) });
    } else if (p.status.key !== r.status.key) {
      out.push({ tone: r.status.tone, text: ev.status(r.label, p.status.label, r.status.label) });
    }
    if (p.rank !== r.rank) {
      const show = rank => (rank == null ? ev.autoRank : `#${rank}`);
      out.push({ tone: 'info', text: ev.rank(r.label, show(p.rank), show(r.rank)) });
    }
    r.bars.forEach((b, i) => {
      const pb = p.bars[i];
      if (!pb || pb.label !== b.label) return;
      if (pb.ratio != null && pb.resetAt != null && pb.resetAt !== b.resetAt
          && (b.ratio == null || b.ratio < pb.ratio - 0.01)) {
        out.push({ tone: 'ok', text: ev.reset(r.label, b.label) });
        return;
      }
      for (const t of THRESHOLDS) {
        if (LEVEL_RANK[pb.level] < LEVEL_RANK[t.level] && LEVEL_RANK[b.level] >= LEVEL_RANK[t.level]
            && (t.level === 'crit' || LEVEL_RANK[b.level] < LEVEL_RANK.crit)) {
          out.push({ tone: t.level, text: ev.crossed(r.label, b.label, t.pct) });
        }
      }
    });
  }
  for (const [key, p] of before) {
    if (!after.has(key)) out.push({ tone: 'muted', text: ev.removed(p.label) });
  }
  return out;
}

// ── HTML ──

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function group(n, text) {
  return Math.round(n).toLocaleString(text.locale);
}

export function renderSummaryHtml(vm, text, { busy = false } = {}) {
  const s = vm.summary;
  const usableTone = s.total > 0 && s.usable === 0 ? 'crit' : s.usable < s.total ? 'warn' : 'ok';
  const reset = s.nextReset;
  return [
    `<div class="card stat tone-${usableTone}"><div class="stat-label">${escapeHtml(text.summary.usable)}</div>`
      + `<div class="stat-value">${s.usable}<span class="stat-of"> / ${s.total}</span></div>`
      + `<div class="stat-sub">${escapeHtml(text.summary.usableSub)}</div></div>`,
    `<div class="card stat"><div class="stat-label">${escapeHtml(text.summary.inflight)}</div>`
      + `<div class="stat-value">${s.inflight}</div>`
      + `<div class="stat-sub">${escapeHtml(text.summary.inflightSub(s.capacity))}</div></div>`,
    `<div class="card stat"><div class="stat-label">${escapeHtml(text.summary.nextReset)}</div>`
      + `<div class="stat-value">${reset ? escapeHtml(reset.in) : '—'}</div>`
      + `<div class="stat-sub">${escapeHtml(reset ? reset.label : text.summary.nextResetNone)}</div></div>`,
    // Fleet-wide write: same gate as the row buttons (named session + CSRF).
    vm.controls
      ? '<div class="summary-actions">'
        + `<button type="button" class="btn" data-fleet="refresh-usage"${attr('title', text.usage.refreshTitle)}${busy ? ' disabled' : ''}>`
        + `${escapeHtml(busy ? text.usage.refreshing : text.usage.refresh)}</button></div>`
      : '',
  ].join('');
}

function renderBar(b, text) {
  const head = b.ratio == null
    ? `<span class="bar-val muted">${escapeHtml(text.notMeasured)}</span>`
    : `<span class="bar-val"><b>${b.pct}%</b>${b.resetIn ? ` <span class="muted">· ${escapeHtml(text.resetsIn(b.resetIn))}</span>` : ''}</span>`;
  const width = b.ratio == null ? 0 : Math.max(b.pct, b.pct > 0 ? 2 : 0);
  return `<div class="bar"><div class="bar-head"><span class="bar-label">${escapeHtml(b.label)}</span>${head}</div>`
    + `<div class="track"><div class="fill lvl-${b.level}" style="width:${width}%"></div></div></div>`;
}

function attr(name, value) {
  return value == null ? '' : ` ${name}="${escapeHtml(value)}"`;
}

/**
 * The control buttons for one row, or '' when this page may not act (no named
 * session / no CSRF token) or the row is redacted. `busy` disables every button
 * while an action is in flight. Data attributes carry the action and target;
 * the browser bootstrap reads them with one delegated click handler.
 */
export function renderControlsHtml(r, vm, text, { busy = false } = {}) {
  if (!vm.controls || !r.named || !r.target) return '';
  const c = text.controls;
  const target = attr('data-uuid', r.target.accountUuid) + attr('data-name', r.target.name);
  const button = (act, label, { cls = '', disabled = false, title = null } = {}) =>
    `<button type="button" class="btn${cls ? ` ${cls}` : ''}" data-act="${act}"${target}`
      + `${attr('title', title)}${disabled || busy ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
  const parts = [];
  if (!r.isCurrent && r.enabled) {
    parts.push(button('switch', c.switch, {
      cls: 'primary',
      disabled: !r.usable,
      title: r.usable ? c.switchTitle : c.unavailableTitle,
    }));
  }
  parts.push('<span class="btn-group">'
    + button('up', `▲ ${c.up}`, { disabled: r.rank === 1 })
    + button('down', `▼ ${c.down}`, { disabled: r.rank == null })
    + '</span>');
  if (r.rank != null) parts.push(button('auto', c.auto, { title: c.autoTitle }));
  parts.push(r.enabled
    ? button('disable', c.disable, { cls: 'danger' })
    : button('enable', c.enable, { cls: 'primary' }));
  return `<div class="actions">${parts.join('')}</div>`;
}

export function renderAccountsHtml(vm, text, opts = {}) {
  if (vm.accounts.length === 0) return `<li class="empty">${escapeHtml(text.noAccounts)}</li>`;
  return vm.accounts.map(r => {
    const cls = ['acct'];
    if (!r.enabled) cls.push('is-off');
    if (r.isCurrent) cls.push('is-current');
    const st = r.stats;
    const stats = [
      text.stats.requests(group(st.requests, text)),
      text.stats.tokensIn(formatCompact(st.tokensIn)),
      text.stats.tokensOut(formatCompact(st.tokensOut)),
      text.stats.inflight(st.inflight, st.maxConcurrent),
    ];
    if (st.credits != null) stats.push(text.stats.credits(st.credits));
    if (st.lastUsedAgo) stats.push(text.stats.lastUsed(st.lastUsedAgo));
    const errors = `<span${st.errors > 0 ? ' class="err"' : ''}>${escapeHtml(text.stats.errors(group(st.errors, text)))}</span>`;
    const title = r.status.title ? ` title="${escapeHtml(r.status.title)}"` : '';
    return `<li class="${cls.join(' ')}">`
      + '<div class="who">'
      + `<span class="name${r.named ? '' : ' redacted'}">${escapeHtml(r.label)}</span>`
      + (r.isCurrent ? `<span class="pill current">${escapeHtml(text.current)}</span>` : '')
      + (r.rank != null ? `<span class="pill rank">#${r.rank}</span>` : '')
      + `<span class="badge tone-${r.status.tone}"${title}>${escapeHtml(r.status.label)}</span>`
      + (r.status.title ? `<span class="reason">${escapeHtml(r.status.title)}</span>` : '')
      + (r.type ? `<span class="kind">${escapeHtml(r.provider === 'codex' ? 'codex' : r.type)}</span>` : '')
      + '</div>'
      + `<div class="bars">${r.bars.map(b => renderBar(b, text)).join('')}</div>`
      + `<div class="stats">${stats.slice(0, 1).map(s => `<span>${escapeHtml(s)}</span>`).join('')}${errors}`
      + `${stats.slice(1).map(s => `<span>${escapeHtml(s)}</span>`).join('')}</div>`
      + renderControlsHtml(r, vm, text, opts)
      + '</li>';
  }).join('');
}

/** events: newest-first [{ at, tone, text }]. */
export function renderActivityHtml(events, text) {
  if (!events.length) return `<li class="empty">${escapeHtml(text.noActivity)}</li>`;
  return events.map(e => {
    const d = new Date(e.at);
    const time = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
    return `<li class="ev tone-${e.tone}"><time>${escapeHtml(time)}</time><span>${escapeHtml(e.text)}</span></li>`;
  }).join('');
}

export function renderHostHtml(vm, text) {
  const parts = [];
  if (vm.host) {
    const fmt = v => (v == null ? '–' : `${Math.round(v)}%`);
    parts.push(`<span class="lvl-text-${vm.host.cpuLevel}">CPU ${fmt(vm.host.cpu)}</span>`);
    parts.push(`<span class="lvl-text-${vm.host.ramLevel}">RAM ${fmt(vm.host.ram)}</span>`);
  }
  if (vm.port != null) parts.push(`<span>${escapeHtml(text.port)} ${escapeHtml(vm.port)}</span>`);
  return parts.join('<span class="sep">·</span>');
}

/**
 * The startup settings card. `state` is the GET /teamclaude/dashboard/autostart
 * answer (null while loading); `busy` disables both switches while a change is
 * in flight; `error` is the last failure message to show under them.
 */
export function renderAutostartHtml(state, text, { busy = false, error = null } = {}) {
  const t = text.autostart;
  if (!state) {
    return `<div class="setting"><div class="setting-text"><span class="setting-sub">${escapeHtml(error ? t.failed(error) : t.loading)}</span></div></div>`;
  }
  if (!state.supported) return '';
  const on = state.registered && state.enabled;
  const notes = [];
  if (state.registered && !state.enabled) notes.push(`<span class="setting-sub warn">${escapeHtml(t.disabledInScheduler)}</span>`);
  if (state.stale) notes.push(`<span class="setting-sub warn">${escapeHtml(t.stale)}</span>`);
  if (error) notes.push(`<span class="setting-sub err">${escapeHtml(t.failed(error))}</span>`);
  const sw = (key, checked, label, disabled) => `<input type="checkbox" role="switch" class="switch" data-autostart="${key}"`
    + ` aria-label="${escapeHtml(label)}"${checked ? ' checked' : ''}${disabled || busy ? ' disabled' : ''}>`;
  return '<div class="setting">'
    + sw('enabled', on, t.title, false)
    + '<div class="setting-text">'
    + `<span class="setting-title">${escapeHtml(t.title)}</span>`
    + `<span class="setting-sub">${escapeHtml(on ? t.onSub(state.taskName) : t.offSub)}</span>`
    + notes.join('')
    + '</div></div>'
    + '<div class="setting child">'
    + sw('dashboard', on && state.dashboard, t.dashboard, !on)
    + `<div class="setting-text"><span class="setting-title">${escapeHtml(t.dashboard)}</span></div>`
    + '</div>';
}
