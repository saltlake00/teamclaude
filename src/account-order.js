// Explicit account order (priority expressed as a movable rank), shared by the
// TUI order mode (o + ↑/↓, a, c) and the web dashboard's order buttons so both
// follow one rule set.
//
// Ranked accounts get contiguous priorities 0,1,2,… (0 = most preferred, shown
// as "#1"); accounts left unranked keep priority null and are routed by
// use-or-lose. Pure functions over AccountManager account objects: nothing here
// mutates an account or touches the config.

/** Ranked accounts (priority set), in order: priority asc, then array index. */
export function rankedAccounts(accounts) {
  return accounts
    .filter(a => a.priority != null)
    .sort((a, b) => (a.priority - b.priority) || (a.index - b.index));
}

/**
 * The ranked order after moving `account` up (dir < 0, more preferred) or down
 * (dir > 0). Moving an unranked account up ranks it at the bottom of the ranked
 * group; moving the last ranked account down un-ranks it (back to use-or-lose).
 * Returns null when the move is a no-op (already at the top, or unranked and
 * moved down) or the account is not in `accounts`.
 */
export function moveRanking(accounts, account, dir) {
  if (!accounts.includes(account)) return null;
  const ranked = rankedAccounts(accounts);
  const r = ranked.indexOf(account);

  if (dir < 0) {                       // up — more preferred
    if (r === -1) ranked.push(account);                                          // unranked → lowest ranked
    else if (r > 0) { const t = ranked[r - 1]; ranked[r - 1] = ranked[r]; ranked[r] = t; }
    else return null;                                                            // already at the top
  } else {                             // down — less preferred
    if (r === -1) return null;                                                   // unranked: nothing below
    else if (r < ranked.length - 1) { const t = ranked[r + 1]; ranked[r + 1] = ranked[r]; ranked[r] = t; }
    else ranked.splice(r, 1);                                                    // last ranked → un-rank
  }
  return ranked;
}

/**
 * The ranked order with `account` returned to "auto" (unranked). Still returns
 * the list when it was already unranked, so applying it normalizes any
 * legacy/duplicate priorities. Null when the account is not in `accounts`.
 */
export function autoRanking(accounts, account) {
  if (!accounts.includes(account)) return null;
  return rankedAccounts(accounts).filter(a => a !== account);
}

/** [{ account, priority }] for every account whose priority must change to apply `ranked`. */
export function rankingChanges(accounts, ranked) {
  const set = new Set(ranked);
  const out = [];
  for (const a of accounts) {
    const want = set.has(a) ? ranked.indexOf(a) : null;
    if (a.priority !== want) out.push({ account: a, priority: want });
  }
  return out;
}
