// Web dashboard served by the supervisor: read-only status (stage 1) plus
// account controls (stage 2).
//
// Routes (all local-only, all under DASHBOARD_PATH):
//   GET  /teamclaude/dashboard              the page; ?code=<one-time code> is
//                                           exchanged for a session cookie, then
//                                           redirected to the clean URL
//   GET  /teamclaude/dashboard/view.js      display logic (dashboard-view.js)
//   GET  /teamclaude/dashboard/client.js    browser bootstrap (dashboard-client.js)
//   GET  /teamclaude/dashboard/status       worker status snapshot; account names
//                                           (and the session's CSRF token) only
//                                           with a valid session cookie
//   POST /teamclaude/dashboard/session      mint a one-time code (proxy API key +
//                                           live lifecycle id, like account reload)
//   POST /teamclaude/dashboard/action       one account control (enable, disable,
//                                           up, down, auto, switch), relayed to
//                                           the worker
//
// The proxy API key never reaches the browser: `teamclaude dashboard` reads it
// from the config file, mints a 60 s single-use code, and opens the page with
// it. The page trades the code for an HttpOnly SameSite=Strict cookie, and the
// supervisor adds the key itself when it asks the worker for the named status.
// Every route also checks the Host header (DNS-rebinding guard) and refuses
// cross-site fetch metadata, so another web page cannot read the snapshot.
// Nothing here spends upstream quota: the status snapshot is in-memory state.
//
// The action route is the only write path, and it requires ALL of: a valid
// session cookie, that session's CSRF token echoed in a custom header (the
// page reads it from the named status response, which another origin cannot
// read), `Sec-Fetch-Site: same-origin`, an allowed `Origin`, a JSON content
// type, and a small body. A redacted page (no session) gets no token, so it
// renders no buttons.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dashboardText, escapeHtml } from './dashboard-view.js';

export const DASHBOARD_PATH = '/teamclaude/dashboard';
export const DASHBOARD_SESSION_PATH = `${DASHBOARD_PATH}/session`;
export const DASHBOARD_STATUS_PATH = `${DASHBOARD_PATH}/status`;
export const DASHBOARD_ACTION_PATH = `${DASHBOARD_PATH}/action`;
export const DASHBOARD_CSRF_HEADER = 'x-teamclaude-csrf';
export const DASHBOARD_ACTIONS = Object.freeze(['enable', 'disable', 'up', 'down', 'auto', 'switch']);
const MAX_ACTION_BODY_BYTES = 1024;
export const DASHBOARD_CODE_TTL_MS = 60_000;
export const DASHBOARD_SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
const MAX_CODES = 16;
const MAX_SESSIONS = 32;

const ASSETS = {
  [`${DASHBOARD_PATH}/view.js`]: readFileSync(new URL('./dashboard-view.js', import.meta.url)),
  [`${DASHBOARD_PATH}/client.js`]: readFileSync(new URL('./dashboard-client.js', import.meta.url)),
};

const COMMON_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function dashboardCookieName(port) {
  return `tc_dash_${port}`;
}

function parseCookies(header) {
  const out = new Map();
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, { ...COMMON_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, statusCode, payload, extra = {}) {
  send(res, statusCode, { 'content-type': 'application/json; charset=utf-8', ...extra }, JSON.stringify(payload));
}

function rejectWithBody(req, res, statusCode, message, extra = {}) {
  // A request we refuse may still carry a body; never read it.
  req.resume();
  sendJson(res, statusCode, { error: { type: 'permission_error', message } }, { connection: 'close', ...extra });
}

const FAVICON = 'data:image/svg+xml,'
  + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    + '<rect width="32" height="32" rx="8" fill="#c96442"/>'
    + '<path d="M16 6v20M6 16h20M9 9l14 14M23 9L9 23" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>');

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f5f4ef; --card: #ffffff; --border: #e6e3d9; --text: #1f1e1d; --muted: #6f6d66;
  --accent: #c96442; --track: #ebe8df;
  --ok: #4f9a68; --warn: #d39b2a; --crit: #c94f3d; --info: #4b7fc4;
  --ok-bg: #e5f2e8; --warn-bg: #faefd6; --crit-bg: #f8e1dc; --info-bg: #e2ebf7; --muted-bg: #ecebe6;
  --shadow: 0 1px 2px rgba(31, 30, 29, 0.06);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #1f1e1d; --card: #2a2927; --border: #3a3936; --text: #efede6; --muted: #a29f97;
    --accent: #d97757; --track: #3a3936;
    --ok: #6dbb86; --warn: #e3b04b; --crit: #e2735f; --info: #7aa6e0;
    --ok-bg: #233629; --warn-bg: #3b3220; --crit-bg: #3d2420; --info-bg: #222f40; --muted-bg: #34332f;
    --shadow: none;
  }
}
:root[data-theme="dark"] {
  --bg: #1f1e1d; --card: #2a2927; --border: #3a3936; --text: #efede6; --muted: #a29f97;
  --accent: #d97757; --track: #3a3936;
  --ok: #6dbb86; --warn: #e3b04b; --crit: #e2735f; --info: #7aa6e0;
  --ok-bg: #233629; --warn-bg: #3b3220; --crit-bg: #3d2420; --info-bg: #222f40; --muted-bg: #34332f;
  --shadow: none;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--bg); color: var(--text);
  font: 14px/1.5 "Segoe UI Variable Text", "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 1040px; margin: 0 auto; padding: 20px 24px 32px; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.brand { display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
.brand-mark { width: 26px; height: 26px; border-radius: 7px; background: var(--accent); display: grid; place-items: center; color: #fff; font-size: 16px; }
.meta { display: flex; align-items: center; gap: 14px; color: var(--muted); font-size: 13px; flex-wrap: wrap; }
.meta .sep { margin: 0 6px; opacity: .6; }
.conn::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); margin-right: 6px; vertical-align: 1px; }
.conn.ok::before { background: var(--ok); }
.conn.bad { color: var(--crit); }
.conn.bad::before { background: var(--crit); }
.lvl-text-warn { color: var(--warn); }
.lvl-text-crit { color: var(--crit); }
.notice { background: var(--info-bg); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; }
.notice code { font-family: "Cascadia Code", Consolas, ui-monospace, monospace; font-size: 12.5px; background: var(--card); padding: 1px 6px; border-radius: 5px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); }
.summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
.stat { padding: 14px 16px; }
.stat-label { color: var(--muted); font-size: 12.5px; }
.stat-value { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; margin: 2px 0; font-variant-numeric: tabular-nums; }
.stat-of { font-size: 16px; color: var(--muted); font-weight: 500; }
.stat-sub { color: var(--muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat.tone-crit .stat-value { color: var(--crit); }
.stat.tone-warn .stat-value { color: var(--warn); }
h2 { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin: 0 0 8px 2px; }
h2 .count { font-weight: 500; margin-left: 4px; }
.panel { margin-bottom: 20px; }
ul, ol { list-style: none; margin: 0; padding: 0; }
.accounts { display: grid; gap: 10px; }
.acct { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 12px 16px 12px; box-shadow: var(--shadow); position: relative; }
.acct.is-current { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent), var(--shadow); }
.acct.is-off > :not(.actions) { opacity: .55; filter: grayscale(1); }
.who { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.name { font-weight: 600; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.name.redacted { color: var(--muted); }
.pill, .badge, .kind { font-size: 11.5px; line-height: 18px; padding: 0 8px; border-radius: 999px; white-space: nowrap; }
.pill.current { background: var(--accent); color: #fff; }
.pill.rank { background: var(--muted-bg); color: var(--text); font-variant-numeric: tabular-nums; }
.kind { color: var(--muted); border: 1px solid var(--border); margin-left: auto; }
.reason { color: var(--crit); font-size: 12px; }
.badge { font-weight: 600; }
.badge.tone-ok { background: var(--ok-bg); color: var(--ok); }
.badge.tone-warn { background: var(--warn-bg); color: var(--warn); }
.badge.tone-crit { background: var(--crit-bg); color: var(--crit); }
.badge.tone-info { background: var(--info-bg); color: var(--info); }
.badge.tone-muted, .badge.tone-neutral { background: var(--muted-bg); color: var(--muted); }
.bars { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 20px; margin: 10px 0 8px; }
.bar-head { display: flex; justify-content: space-between; gap: 8px; font-size: 12.5px; margin-bottom: 4px; }
.bar-label { color: var(--muted); }
.bar-val { font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.muted { color: var(--muted); }
.track { height: 8px; background: var(--track); border-radius: 999px; overflow: hidden; }
.fill { height: 100%; border-radius: 999px; transition: width .4s ease; }
.fill.lvl-ok { background: var(--ok); }
.fill.lvl-warn { background: var(--warn); }
.fill.lvl-crit { background: var(--crit); }
.stats { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.activity { background: var(--card); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); max-height: 280px; overflow: auto; }
.ev { display: flex; gap: 12px; padding: 8px 16px; border-top: 1px solid var(--border); font-size: 13px; }
.ev:first-child { border-top: 0; }
.ev time { color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
.ev::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; margin-top: 7px; background: var(--muted); }
.ev.tone-ok::before { background: var(--ok); }
.ev.tone-warn::before { background: var(--warn); }
.ev.tone-crit::before { background: var(--crit); }
.ev.tone-info::before { background: var(--info); }
.empty { color: var(--muted); padding: 14px 16px; font-size: 13px; }
.accounts .empty { background: var(--card); border: 1px dashed var(--border); border-radius: 12px; }
.stats .err { color: var(--crit); font-weight: 600; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
.btn-group { display: inline-flex; }
.btn-group .btn:first-child { border-radius: 7px 0 0 7px; }
.btn-group .btn:last-child { border-radius: 0 7px 7px 0; margin-left: -1px; }
.btn {
  font: inherit; font-size: 12.5px; line-height: 18px; padding: 4px 11px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--border); background: var(--card); color: var(--text); white-space: nowrap;
}
.btn:hover:not(:disabled) { background: var(--muted-bg); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; position: relative; }
.btn:disabled { opacity: .45; cursor: default; }
.btn.primary { border-color: var(--accent); color: var(--accent); }
.btn.primary:hover:not(:disabled) { background: var(--accent); color: #fff; }
.btn.danger { margin-left: auto; color: var(--crit); }
.btn.danger:hover:not(:disabled) { background: var(--crit-bg); }
.btn.solid-danger { background: var(--crit); border-color: var(--crit); color: #fff; }
.btn.solid-danger:hover:not(:disabled) { background: var(--crit); filter: brightness(1.08); }
dialog {
  border: 1px solid var(--border); border-radius: 14px; background: var(--card); color: var(--text);
  padding: 20px 22px 16px; width: min(420px, calc(100vw - 32px)); box-shadow: 0 12px 40px rgba(0, 0, 0, .25);
}
dialog::backdrop { background: rgba(20, 20, 19, .45); }
dialog h3 { margin: 0 0 8px; font-size: 16px; }
dialog p { margin: 0 0 18px; color: var(--muted); font-size: 13.5px; }
dialog .row { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 720px) {
  main { padding: 16px; }
  .summary { grid-template-columns: 1fr; }
  .bars { grid-template-columns: 1fr; }
  .kind { margin-left: 0; }
  .btn.danger { margin-left: 0; }
}
`;

export function dashboardHtml(lang) {
  const text = dashboardText(lang);
  return `<!doctype html>
<html lang="${escapeHtml(text.lang)}" data-lang="${escapeHtml(text.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(text.title)}</title>
<link rel="icon" href="${FAVICON}">
<style>${STYLE}</style>
<script type="module" src="${DASHBOARD_PATH}/client.js"></script>
</head>
<body>
<main>
  <header class="top">
    <div class="brand"><span class="brand-mark" aria-hidden="true">✳</span>${escapeHtml(text.title)}</div>
    <div class="meta"><span id="host"></span><span id="conn" class="conn">${escapeHtml(text.connecting)}</span></div>
  </header>
  <div id="notice" class="notice" hidden></div>
  <section id="summary" class="summary" aria-live="polite"></section>
  <section class="panel">
    <h2>${escapeHtml(text.accounts)}<span id="account-count" class="count"></span></h2>
    <ul id="accounts" class="accounts"></ul>
  </section>
  <section class="panel">
    <h2>${escapeHtml(text.activity)}</h2>
    <ol id="activity" class="activity"></ol>
  </section>
</main>
<dialog id="confirm" aria-labelledby="confirm-title">
  <h3 id="confirm-title"></h3>
  <p>${escapeHtml(text.controls.confirmBody)}</p>
  <div class="row">
    <button type="button" class="btn" data-dialog="cancel">${escapeHtml(text.controls.cancel)}</button>
    <button type="button" class="btn solid-danger" data-dialog="ok">${escapeHtml(text.controls.confirmOk)}</button>
  </div>
</dialog>
</body>
</html>
`;
}

/**
 * @param {object} opts
 * @param {number} opts.port           the public port (Host header check)
 * @param {string} opts.proxyApiKey    required to mint a code
 * @param {string} opts.lifecycleId    required to mint a code
 * @param {string} opts.lifecycleHeader header name carrying the lifecycle id
 * @param {'en'|'ko'} [opts.language]  default page language (?lang= overrides)
 * @param {(identity: boolean) => Promise<object>} opts.fetchStatus worker status
 * @param {(request: { action: string, accountUuid: string|null, name: string|null })
 *   => Promise<{ statusCode: number, body: object }>} [opts.controlAccount]
 *   runs one account control in the worker; without it the action route is 404
 * @param {() => number} [opts.now]
 */
export function createDashboard({
  port,
  proxyApiKey,
  lifecycleId,
  lifecycleHeader,
  language = 'en',
  fetchStatus,
  controlAccount = null,
  now = Date.now,
}) {
  const codes = new Map(); // code -> expiresAt
  const sessions = new Map(); // token -> { seen, csrf }
  const cookieName = dashboardCookieName(port);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map(h => `http://${h}`));

  function prune() {
    const t = now();
    for (const [code, expiresAt] of codes) if (expiresAt <= t) codes.delete(code);
    for (const [token, session] of sessions) if (t - session.seen > DASHBOARD_SESSION_IDLE_MS) sessions.delete(token);
  }

  function mintCode() {
    prune();
    while (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value);
    const code = randomBytes(24).toString('base64url');
    codes.set(code, now() + DASHBOARD_CODE_TTL_MS);
    return code;
  }

  function consumeCode(code) {
    prune();
    if (typeof code !== 'string' || !codes.has(code)) return null;
    codes.delete(code);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { seen: now(), csrf: randomBytes(32).toString('base64url') });
    return token;
  }

  /** The live session named by the request's cookie (refreshing its idle clock), or null. */
  function sessionOf(req) {
    prune();
    const token = parseCookies(req.headers.cookie).get(cookieName);
    const session = token ? sessions.get(token) : null;
    if (!session) return null;
    session.seen = now();
    return session;
  }

  function hostAllowed(req) {
    return allowedHosts.has(String(req.headers.host || '').toLowerCase());
  }

  function crossSite(req) {
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') return true;
    const origin = req.headers.origin;
    return origin != null && !allowedOrigins.has(String(origin).toLowerCase());
  }

  /** Stricter than crossSite: a write must PROVE it came from this origin's page. */
  function sameOriginWrite(req) {
    return req.headers['sec-fetch-site'] === 'same-origin'
      && typeof req.headers.origin === 'string'
      && allowedOrigins.has(req.headers.origin.toLowerCase());
  }

  function readSmallBody(req, limit) {
    return new Promise((resolve, reject) => {
      const tooLarge = () => Object.assign(new Error('too large'), { tooLarge: true });
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) {
        reject(tooLarge());
        return;
      }
      const chunks = [];
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > limit) {
          req.removeAllListeners('data');
          reject(tooLarge());
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function handleAction(req, res) {
    if (req.method !== 'POST') {
      rejectWithBody(req, res, 405, 'Dashboard actions are POST requests.', { allow: 'POST' });
      return;
    }
    if (!controlAccount) {
      rejectWithBody(req, res, 404, 'Account controls are not available.');
      return;
    }
    if (!sameOriginWrite(req)) {
      rejectWithBody(req, res, 403, 'Dashboard actions must come from the dashboard page itself.');
      return;
    }
    const session = sessionOf(req);
    if (!session) {
      rejectWithBody(req, res, 403, 'No dashboard session. Open the window again with `teamclaude dashboard`.',
        { 'x-teamclaude-reason': 'session' });
      return;
    }
    if (!safeEqual(req.headers[DASHBOARD_CSRF_HEADER], session.csrf)) {
      rejectWithBody(req, res, 403, 'Missing or wrong dashboard CSRF token.');
      return;
    }
    const type = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (type !== 'application/json') {
      rejectWithBody(req, res, 415, 'Dashboard actions are JSON.');
      return;
    }
    readSmallBody(req, MAX_ACTION_BODY_BYTES).then(raw => {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      const action = parsed?.action;
      const accountUuid = typeof parsed?.accountUuid === 'string' && parsed.accountUuid ? parsed.accountUuid : null;
      const name = typeof parsed?.name === 'string' && parsed.name ? parsed.name : null;
      if (!DASHBOARD_ACTIONS.includes(action) || (!accountUuid && !name)) {
        sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'Expected { action, accountUuid | name }.' } });
        return null;
      }
      return controlAccount({ action, accountUuid, name }).then(answer => {
        if (res.destroyed) return;
        const code = Number.isInteger(answer?.statusCode) && answer.statusCode >= 200 && answer.statusCode <= 599
          ? answer.statusCode
          : 502;
        sendJson(res, code, answer?.body ?? {});
      });
    }).catch(err => {
      if (res.destroyed || res.headersSent) return;
      if (err?.tooLarge) {
        rejectWithBody(req, res, 413, 'Dashboard action body is too large.');
        return;
      }
      sendJson(res, 503, {
        error: { type: 'overloaded_error', message: err?.message || 'Proxy worker unavailable' },
      }, { 'retry-after': '1' });
    });
  }

  /** Handle a request when it targets the dashboard; returns false otherwise. */
  function handle(req, res, isLocal) {
    // Runs on EVERY public request: a cheap string test first, and never let a
    // malformed request-target (absolute-form, bad IPv6 literal…) throw here.
    const raw = typeof req.url === 'string' ? req.url : '';
    if (!raw.startsWith(DASHBOARD_PATH)) return false;
    let url;
    try {
      url = new URL(raw, 'http://localhost');
    } catch {
      return false;
    }
    const path = url.pathname;
    if (path !== DASHBOARD_PATH && !path.startsWith(`${DASHBOARD_PATH}/`)) return false;

    if (!isLocal) {
      rejectWithBody(req, res, 403, 'The dashboard is local-only.');
      return true;
    }
    if (!hostAllowed(req)) {
      rejectWithBody(req, res, 403, 'Unexpected Host header for the dashboard.');
      return true;
    }

    if (path === DASHBOARD_SESSION_PATH) {
      const bodyFree = (req.headers['content-length'] == null || req.headers['content-length'] === '0')
        && req.headers['transfer-encoding'] == null;
      if (req.method !== 'POST' || !bodyFree) {
        rejectWithBody(req, res, 405, 'Dashboard sessions are minted by an empty POST.', { allow: 'POST' });
        return true;
      }
      if (crossSite(req)
          || !safeEqual(req.headers['x-api-key'], proxyApiKey)
          || !safeEqual(req.headers[lifecycleHeader], lifecycleId)) {
        rejectWithBody(req, res, 403, 'Minting a dashboard code requires the proxy key and the live lifecycle id.');
        return true;
      }
      sendJson(res, 200, { code: mintCode(), expiresInMs: DASHBOARD_CODE_TTL_MS });
      return true;
    }

    if (path === DASHBOARD_ACTION_PATH) {
      handleAction(req, res);
      return true;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      rejectWithBody(req, res, 405, 'The dashboard is read-only.', { allow: 'GET, HEAD' });
      return true;
    }

    if (path === DASHBOARD_PATH || path === `${DASHBOARD_PATH}/`) {
      const code = url.searchParams.get('code');
      if (code != null) {
        // A code only ever arrives by the CLI opening this URL directly.
        const token = crossSite(req) ? null : consumeCode(code);
        url.searchParams.delete('code');
        const headers = { location: `${DASHBOARD_PATH}${url.search}` };
        if (token) {
          headers['set-cookie'] = `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=${DASHBOARD_PATH}`;
        }
        send(res, 303, headers, '');
        return true;
      }
      const requested = url.searchParams.get('lang');
      const lang = requested === 'ko' || requested === 'en' ? requested : language;
      send(res, 200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': PAGE_CSP,
      }, req.method === 'HEAD' ? '' : dashboardHtml(lang));
      return true;
    }

    if (ASSETS[path]) {
      send(res, 200, { 'content-type': 'text/javascript; charset=utf-8' }, req.method === 'HEAD' ? '' : ASSETS[path]);
      return true;
    }

    if (path === DASHBOARD_STATUS_PATH) {
      if (crossSite(req)) {
        rejectWithBody(req, res, 403, 'Cross-site dashboard reads are refused.');
        return true;
      }
      const session = sessionOf(req);
      const identity = session != null;
      fetchStatus(identity).then(status => {
        const dashboard = { identity, port };
        // Only a named page can act, and it proves that with this token.
        if (session && controlAccount) dashboard.csrf = session.csrf;
        const body = { ...status, dashboard };
        // The lifecycle id fences deployment/reload control; the page never needs it.
        delete body.lifecycleId;
        if (!res.destroyed) sendJson(res, 200, body);
      }, err => {
        if (!res.destroyed && !res.headersSent) {
          sendJson(res, 503, {
            error: { type: 'overloaded_error', message: err?.message || 'Proxy worker unavailable' },
          }, { 'retry-after': '1' });
        }
      });
      return true;
    }

    send(res, 404, { 'content-type': 'application/json; charset=utf-8' },
      JSON.stringify({ error: { type: 'not_found_error', message: 'Unknown dashboard path.' } }));
    return true;
  }

  return { handle, mintCode, cookieName };
}
