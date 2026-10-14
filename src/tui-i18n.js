// TUI display language. English is the default and matches the upstream text
// byte-for-byte; Korean is opt-in via TEAMCLAUDE_LANG=ko or config "language": "ko".
// Only the dashboard's own text lives here — server log lines ([TeamClaude] ...)
// mirrored into the activity pane stay as the server wrote them.

const EN = {
  lang: 'en',
  // Quota-bar label column width. Korean labels are two wide glyphs (4 columns).
  labelWidth: 3,
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
  bar: { ses: 'Ses', wk: 'Wk', fbl: 'Fbl', tok: 'Tok', req: 'Req', cr: 'Cr' },
  auto: 'auto',
  port: 'Port',
  tooSmall: 'Terminal too small (need 40x8+)',
  noAccounts: 'No accounts configured. Press [a] to add one.',
  activity: 'Activity',
  activeCount: n => `${n} active`,
  apiKeyPrompt: 'API key',
  footer: {
    normal: (k, dim, reauth) => ` ${dim('↑↓')} select  ${k('s')}witch  ${k('e')}toggle  ${k('o')}rder  ${k('d')}elete${reauth}  ${k('a')}dd  ${k('R')}eload  ${k('q')}uit`,
    reauth: (k, red) => `  ${red('재인증 필요')} [${k('r')}]`,
    select: (k, dim) => ` ${dim('↑↓')} select  ${k('Enter')} delete  ${k('Esc')} cancel`,
    order: (k, dim) => ` ${dim('↑↓')} move (up = preferred)  ${k('a')}uto-all (reset order, weekly-reset)  ${k('c')}lear rank  ${k('Enter')}/${k('Esc')} done`,
    addCodex: k => ` ${k('i')}mport Codex login  ${k('Esc')} cancel`,
    addClaude: k => ` ${k('i')}mport Claude Code  ${k('k')} API key  ${k('Esc')} cancel`,
  },
  msg: {
    switched: n => `Switched to "${n}"`,
    orderReset: 'Order reset: all accounts on auto (weekly-reset order)',
    synced: n => `Synced ${n} new account(s) from config`,
    reloaded: 'Config reloaded, credentials refreshed',
    syncFailed: e => `Sync failed: ${e}`,
    remeasuring: 'Re-measuring quota for all accounts...',
    remeasureSkipped: 'Quota refresh skipped — no request has flowed through the proxy yet',
    remeasuredAll: n => `Quota re-measured for all ${n} account(s)`,
    remeasuredPartial: (m, t) => `Quota re-measured for ${m}/${t} account(s) — the rest failed or were skipped`,
    remeasureFailed: e => `Quota refresh failed: ${e}`,
    importing: 'Importing credentials...',
    profileWarning: e => `Warning: could not fetch profile — ${e}`,
    detected: (tier, n) => `Detected Claude ${tier}: ${n}`,
    updated: n => `Updated account "${n}"`,
    imported: n => `Imported account "${n}"`,
    importFailed: e => `Import failed: ${e}`,
    importingCodex: 'Importing Codex credentials...',
    updatedCodex: n => `Updated Codex account "${n}"`,
    importedCodex: n => `Imported Codex account "${n}"`,
    codexImportFailed: e => `Codex import failed: ${e}`,
    addedApiKey: n => `Added API key account "${n}"`,
    deleted: n => `Deleted account "${n}"`,
    enabled: n => `Enabled "${n}"`,
    disabled: n => `Disabled "${n}"`,
    saveFailed: e => `Save failed: ${e}`,
    reauthStart: n => `Re-authentication required for "${n}" — opening login...`,
    reauthDone: n => `Re-authenticated "${n}" successfully`,
    reauthFailed: (n, e) => `Re-authentication failed for "${n}": ${e}`,
  },
};

const KO = {
  lang: 'ko',
  labelWidth: 4,
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
  bar: { ses: '세션', wk: '주간', fbl: 'Fbl', tok: '토큰', req: '요청', cr: '잔액' },
  auto: '자동',
  port: '포트',
  tooSmall: '터미널이 너무 작습니다 (40x8 이상 필요)',
  noAccounts: '계정이 없습니다. [a]를 눌러 추가하세요.',
  activity: '활동',
  activeCount: n => `${n}건 진행 중`,
  apiKeyPrompt: 'API 키',
  // Kept within 80 columns even with the reauth hint (Korean glyphs are 2 wide).
  footer: {
    normal: (k, dim, reauth) => ` ${dim('↑↓')} 선택  ${k('s')} 전환  ${k('e')} 켬/끔  ${k('o')} 순서  ${k('d')} 삭제${reauth}  ${k('a')} 추가  ${k('R')} 갱신  ${k('q')} 종료`,
    reauth: (k, red) => `  ${k('r')} ${red('재인증 필요')}`,
    select: (k, dim) => ` ${dim('↑↓')} 선택  ${k('Enter')} 삭제  ${k('Esc')} 취소`,
    order: (k, dim) => ` ${dim('↑↓')} 이동(위=우선)  ${k('a')} 모두 자동(주간 리셋순)  ${k('c')} 순위 해제  ${k('Enter')}/${k('Esc')} 완료`,
    addCodex: k => ` ${k('i')} Codex 로그인 가져오기  ${k('Esc')} 취소`,
    addClaude: k => ` ${k('i')} Claude Code 가져오기  ${k('k')} API 키  ${k('Esc')} 취소`,
  },
  msg: {
    switched: n => `"${n}" 계정으로 전환`,
    orderReset: '순서 초기화: 모든 계정 자동 (주간 리셋이 빠른 순)',
    synced: n => `설정에서 새 계정 ${n}개 동기화`,
    reloaded: '설정을 다시 읽고 인증 정보를 갱신함',
    syncFailed: e => `동기화 실패: ${e}`,
    remeasuring: '전체 계정 한도 다시 측정 중...',
    remeasureSkipped: '한도 측정 건너뜀 — 아직 프록시를 거친 요청이 없음',
    remeasuredAll: n => `계정 ${n}개 한도 다시 측정 완료`,
    remeasuredPartial: (m, t) => `계정 ${m}/${t}개 한도 다시 측정 — 나머지는 실패하거나 건너뜀`,
    remeasureFailed: e => `한도 측정 실패: ${e}`,
    importing: '인증 정보 가져오는 중...',
    profileWarning: e => `경고: 프로필을 가져오지 못함 — ${e}`,
    detected: (tier, n) => `Claude ${tier} 확인: ${n}`,
    updated: n => `계정 "${n}" 갱신`,
    imported: n => `계정 "${n}" 가져옴`,
    importFailed: e => `가져오기 실패: ${e}`,
    importingCodex: 'Codex 인증 정보 가져오는 중...',
    updatedCodex: n => `Codex 계정 "${n}" 갱신`,
    importedCodex: n => `Codex 계정 "${n}" 가져옴`,
    codexImportFailed: e => `Codex 가져오기 실패: ${e}`,
    addedApiKey: n => `API 키 계정 "${n}" 추가`,
    deleted: n => `계정 "${n}" 삭제`,
    enabled: n => `"${n}" 켬`,
    disabled: n => `"${n}" 끔`,
    saveFailed: e => `저장 실패: ${e}`,
    reauthStart: n => `"${n}" 재인증 필요 — 로그인을 엽니다...`,
    reauthDone: n => `"${n}" 재인증 완료`,
    reauthFailed: (n, e) => `"${n}" 재인증 실패: ${e}`,
  },
};

const TEXTS = { en: EN, ko: KO };

/**
 * Pick the dashboard language: TEAMCLAUDE_LANG wins over config.language, and
 * anything that is not Korean (unset, empty, "en", unknown) falls back to English.
 */
export function resolveTuiLanguage(config, env = process.env) {
  const raw = env.TEAMCLAUDE_LANG || config?.language || '';
  return String(raw).trim().toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export function tuiText(lang = 'en') {
  return TEXTS[lang] || EN;
}
