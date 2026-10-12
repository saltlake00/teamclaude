// Codex credits: the paid balance a ChatGPT account draws from once its plan's
// included usage is spent (OpenAI: "Your plan's included usage is used first.
// After you hit plan limits, usage draws from your credit balance.").
//
// The balance rides on the same wham/usage payload the proxy already polls:
//   credits: { has_credits, unlimited, overage_limit_reached, balance: "62500", ... }
// `balance` is a decimal STRING upstream. No proxy state lives here — pure
// parse/predicate/format helpers shared by the account manager, CLI and TUI.

// Credit-backed accounts are ordered by balance in buckets of this size, so a
// few requests' worth of drift between two near-equal balances does not flip
// the order on every re-evaluation (which would bounce traffic between
// accounts and cost prompt-cache locality).
export const CODEX_CREDIT_BALANCE_BUCKET = 1000;

// After a genuine limit 429 on an account the proxy routed on credits, keep
// it off the credit tier for this long. The backend refused to draw credits
// for that request, and the next wham/usage poll would just report the same
// balance again — without a hold the account would come back every throttle
// window and burn one more refused request each time.
export const DEFAULT_CODEX_CREDIT_REFUSAL_MS = 30 * 60 * 1000;

// Explicit "this account is out of usage/credits" signals in the 429 body.
// Anything else — including an unknown class — is not evidence, so the long
// credit hold never fires on a concurrency/transient 429. The
// `x-codex-rate-limit-reached-type` header is deliberately NOT a signal: it
// means "included quota reached" (account-manager folds it into quota
// rejection), which is the premise of every credit-backed dispatch.
// Body `error.code` / `error.type` classes for usage/quota/credit exhaustion
// (`usage_limit_reached` is what the Codex CLI renders natively; see the
// codex-native 429 body built in server.js).
export const CODEX_CREDIT_REFUSAL_ERROR_CLASSES = new Set([
  'usage_limit_reached', 'usage_not_included', 'insufficient_quota',
]);
// `error.message` wording that directly says the CREDIT balance is exhausted.
// Usage-limit wording is deliberately absent (it also appears in transient
// messages like "...check your usage limits"); usage limits count only via the
// explicit error.code/error.type classes above. Not a bare "credit" match
// either: reset-credit or balance METADATA must not count.
const CREDIT_REFUSAL_MESSAGE = /\bout of credits\b|insufficient credits|credit balance (?:is )?(?:exhausted|empty|depleted|insufficient)/i;

function errorObjectOf(bodyText) {
  if (typeof bodyText !== 'string' || bodyText.trim() === '') return null;
  try {
    const parsed = JSON.parse(bodyText.slice(0, 65536));
    const error = parsed && typeof parsed === 'object' ? parsed.error : null;
    return error && typeof error === 'object' && !Array.isArray(error) ? error : null;
  } catch {
    return null; // non-JSON (or truncated/compressed) body: no evidence
  }
}

/**
 * Did a 429 on a credit-backed dispatch carry explicit evidence that the
 * backend refused to draw credits? Only then is the long credit hold
 * (DEFAULT_CODEX_CREDIT_REFUSAL_MS) justified; a plain transient 429 takes the
 * ordinary bounded Retry-After throttle. Evidence = an allowlisted `error.code`/`error.type`
 * class / credits-exhausted wording in `error.message` of the JSON body. (A later
 * wham/usage poll that reports the balance unusable drops the account from the
 * credit tier on its own via codexCreditsUsable.)
 */
// A `reachedType` argument is accepted but intentionally ignored (see above).
export function codexCreditRefusalEvidence({ bodyText = '' } = {}) {
  const error = errorObjectOf(bodyText);
  if (!error) return false;
  for (const key of ['code', 'type']) {
    if (typeof error[key] === 'string'
        && CODEX_CREDIT_REFUSAL_ERROR_CLASSES.has(error[key].trim().toLowerCase())) {
      return true;
    }
  }
  return typeof error.message === 'string' && CREDIT_REFUSAL_MESSAGE.test(error.message);
}

function parseBalance(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Normalize a credits object (wham/usage snake_case or the stored camelCase
 * shape) into { balance, hasCredits, unlimited, overageLimitReached }.
 * Flags are strict booleans; an unparseable balance is null (unknown), never 0.
 * Returns null when there is no credits object at all.
 */
export function normalizeCodexCredits(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pick = (snake, camel) => (raw[snake] !== undefined ? raw[snake] : raw[camel]);
  return {
    balance: parseBalance(raw.balance),
    hasCredits: pick('has_credits', 'hasCredits') === true,
    unlimited: pick('unlimited', 'unlimited') === true,
    overageLimitReached: pick('overage_limit_reached', 'overageLimitReached') === true,
  };
}

/** Parse `credits` out of a wham/usage payload (null when absent/malformed). */
export function parseCodexCredits(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return normalizeCodexCredits(payload.credits);
}

/**
 * Can this account still be served on credits? Requires a known positive
 * balance (or an unlimited grant) and no overage stop. Unknown → false
 * (fail closed: routing on a guessed balance would only produce refused 429s).
 */
export function codexCreditsUsable(credits) {
  if (!credits || credits.overageLimitReached === true) return false;
  if (credits.unlimited === true) return true;
  return credits.hasCredits === true && Number.isFinite(credits.balance) && credits.balance > 0;
}

/** Full balance for CLI output: "61,962.87", "unlimited", or null when unknown. */
export function formatCodexCreditBalance(credits) {
  if (!credits) return null;
  if (credits.unlimited === true) return 'unlimited';
  if (!Number.isFinite(credits.balance)) return null;
  return credits.balance.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * One-line description for `teamcodex status`, or null when the server
 * reported no credits object (older server / Anthropic account).
 */
export function codexCreditsStatusLine(credits, creditBacked = false) {
  if (!credits) return null;
  const balance = formatCodexCreditBalance(credits);
  const amount = balance == null ? 'unknown' : `${balance} balance`;
  if (credits.overageLimitReached) return `${amount} (overage limit reached — not usable)`;
  if (!codexCreditsUsable(credits)) return `${amount} (not usable)`;
  if (creditBacked) return `${amount} — serving on credits (included quota spent)`;
  return amount;
}

/** Compact balance for the TUI column: "62.5k", "1.23M", "950", "-". */
export function formatCodexCreditsCompact(credits) {
  if (!credits) return '-';
  if (credits.unlimited === true) return 'inf';
  const b = credits.balance;
  if (!Number.isFinite(b)) return '-';
  if (b >= 1_000_000) return `${(b / 1_000_000).toFixed(2)}M`;
  if (b >= 1000) return `${(b / 1000).toFixed(1)}k`;
  return String(Math.floor(b));
}
