# Spec: Codex 라우팅 기능 복구 (fleet-final 계보 위 이식)

Intent: docs/intents/2026-10-12-restore-codex-routing-features.md
Grade: L (운영 프록시 핵심 라우팅, 서비스 횡단)

## 범위 (기준 구현 = 커밋 e15f4ff..c072da5, 참조 아티팩트 d306219c)
1. 계정 쿼터 예약 `quotaReserve` (a9db13a)
2. 상류 실패 회피 `upstreamFailureAvoidMs` / `noteUpstreamFailure` / `_isAvoided` (1279277, 173d7b0)
3. B1 JSON 503/529 capacity 재시도 `TEAMCODEX_OVERLOAD_HOLD_MS` (243159d, f7d5196, cd66c95)
4. B2 출력 전 SSE 실패 재생 `codexPrestreamEncodingOf`, `CODEX_PRESTREAM_STAGE_MAX_MS` (6a80562~4dab95f)
5. 크레딧 라우팅 `codexUseCredits`, `codexCreditRefusalMs`, `src/codex-credits.js` (b23c448~c072da5)
6. 같은 구간의 기타 동작 커밋(4efffd6, 5cec560, c197cae, b3ea17c, f66e77a)은 fleet-final에 동등 동작이 없을 때만 이식한다.

## Non-goals
- fleet-final의 cmux/Claude recovery 동작 변경 금지.
- 메뉴바, 문서 대개편, 무관 리팩터 금지.

## Acceptance
- 위 식별자가 후보 런타임에 존재하고 각 기능의 원 테스트(포팅본)가 통과.
- fleet-final 기존 테스트의 실패 집합이 기준(8379189) 대비 늘지 않음.
- 배포 후 `/teamclaude/status`에 codexCredits가 갱신되고, 로그에 `pre-output stream failure` 또는 회피 로그 발동 확인.

## Rollback
manual-rollout 자동 롤백 + rollback_hash 454a80aa.

## Verification
2026-10-12, 이식 브랜치 로컬 검증(배포 전). 기준 = 5e47d84(8379189 + docs).

### 기능별 RED → GREEN
기준 src에 포팅 테스트를 붙여 실패를 확인한 뒤, 이식 후 같은 파일을 통과시켰다.

| 기능 | 테스트 | 기준 src | 이식 후 |
|---|---|---|---|
| quotaReserve | test/quota-reserve.test.js | 로드 실패(`normalizeQuotaReserve` export 없음) | 17/17 |
| 상류 실패 회피 | test/account-manager-avoid.test.js, test/server-upstream-failure-avoid.test.js | 12건 중 10건 실패 | 12/12 |
| B1 | test/server-codex-503-replay.test.js | 로드 실패(`codexCapacityReplayEligible` export 없음) | 통과 |
| B2 | test/server-codex-prestream-replay.test.js | 로드 실패(`classifyCodexSseFrame` export 없음) | 28/28 |
| 크레딧 라우팅 | test/codex-credits.test.js | 로드 실패(`src/codex-credits.js` 없음) | 48/48 |

### 전체 스위트(`node --test`, qgate heavy)
- 기준: tests 1040, pass 990, fail 50 (실패 이름 42종, 서브테스트 포함 50건. 머신 환경 의존 실패: claude-wrapper·run-recovery·model-recovery-gate 계열).
- 이식 후: tests 1159, pass 1109, fail 50.
  - 새로 실패 1건: `Codex missing MIME forwards the first frame before the upstream finishes`.
    원인은 B2가 response.created 엔벨로프를 첫 출력 이벤트까지 스테이징하는 의도된 동작이다. 4f67930 선례대로
    B1/B2 공용 킬스위치(`TEAMCODEX_OVERLOAD_HOLD_MS=0`) 아래 고정했고 단독 실행 12/12 통과.
  - 기준에서 실패하고 이식 후 통과 1건: `SSE request logging is capped without truncating the client stream`(flaky로 판단).
  - 결론: 고정 후 실패 집합은 기준의 부분집합이다(늘지 않음).
- 같은 방식으로 고정한 현재 계보 테스트 1건: `Codex SSE recovery requires response.completed rather than any terminal marker`
  (B2 켜짐에서도 계정 상태·구독 판정은 같고 클라이언트 상태 코드만 200→401로 달라짐).
- `npx eslint src test`: exit 0.
- 해시 핀: `test/test_model_recovery_gate.py` ACCOUNT_MANAGER_SHA256과 증거 문서를 새 해시로 갱신, 핀 테스트 OK.
- 식별자 존재 확인(src): codexUseCredits, _isAvoided, noteUpstreamFailure, _isReserveExceeded, quotaReserve,
  codexOverloadHeldSince, TEAMCODEX_OVERLOAD_HOLD_MS, codexPrestreamEncodingOf, CODEX_PRESTREAM_STAGE_MAX_MS,
  markSendFailure, clearSendFailure, usageLimitGrace, sessionReserveUntil, claimSessionLease·releaseSessionLease·
  claimSessionOnce·resolveCmuxSessionId.
- fleet-final 파일 불변: claude-recovery.js, cmux-session-guards.js, cmux-session-rescue.js, cmux-process-guard.js,
  claude-wrapper.js, codex-reset-credits.js, reauth.js, config.js (5e47d84 대비 diff 없음).
- CLI 스모크: 임시 설정·미사용 포트로 `node src/index.js codex status` 정상 출력.
- 미확인(배포 후 항목): `/teamclaude/status`의 codexCredits 갱신, 라이브 로그의 회피·pre-output 재생 발동.

### 적대 리뷰 1차(REQUEST_CHANGES) 수정 후 재검증
- I2: 요청의 리셋권 1회 패스가 소진되면(`resetCreditAttempts >= 1`) creditScope가 그 사실을 싣고
  creditDeferral이 false가 된다. getActiveAccount 무제외 경로도 scope를 넘긴다.
  회귀 테스트 `a charged reset-credit pass unlocks paid credits even while another account still holds a reset credit`:
  수정 전 429(`All 2 accounts exhausted`), 수정 후 200, consume 1회.
- M1: addAccount에 `_reserveHeld: false` 초기화. 테스트 1건(수정 전 실패).
- M2: 보조 예산 예약 실패를 `aux-budget` 사유로 분리, 크레딧 거절 판정 생략 시 로그 1줄. 테스트 2건(수정 전 실패).
- M3: readOnly(status) 경로는 send-failed 쿨다운을 해제하지도, 해제된 것으로 보지도 않는다.
  `status:'error'` + `creditBacked:true` 행이 나오지 않는다. 테스트 1건(수정 전 실패). 해시 핀·증거 발췌 재갱신.
- 전체 스위트(qgate): 기준 tests 1040 / fail 50(이름 42종) → 수정 후 tests 1164 / fail 50(이름 42종),
  실패 이름 집합 완전 일치(신규 0, 해소 0). 이번 실행에서는 첫 프레임 테스트 고정분과 flaky 1건 모두 기준과 같았다.
- fleet-final 보존 지정 실행 10개 파일(send-failure-cooldown, server-send-failed-recovery, server-401,
  server-supervisor, subscription-supervisor, supervisor-midstream, claude-recovery, cmux-session-lease,
  cmux-session-rescue, run-recovery): 284건 중 21건 실패. 전부 run-recovery·claude-recovery의 실프로세스 계열이고,
  기준에도 없던 이름 3건은 같은 시각 기준(5e47d84)에서도 같은 11건이 실패해 환경(고부하) 의존으로 판단했다.
- `python3 -m pytest test/test_model_recovery_gate.py`: HEAD·기준 모두 3 failed / 2 passed. 해시 핀 테스트는 통과.
  게이트 내부 node 실패 이름은 HEAD가 기준의 부분집합. watchdog 운영 사본 불일치는 기준도 같다.
- `npm run lint`: 워크트리에 node_modules가 없어 `eslint: command not found`. `npx --no-install eslint .`는 exit 0.
- 이식 기능 9개 파일(quota-reserve, account-manager-avoid, server-upstream-failure-avoid, server-codex-503-replay,
  server-codex-prestream-replay, codex-credits, server-codex, server-usage-tracking, sse): 164/164 통과.
- 출력 원문: 세션 scratchpad `evidence-r2.txt`(로컬, 저장소 밖).

### 배포 (2026-10-12 15:19 KST)
- 적대 검증: 1라운드 REQUEST_CHANGES(I2·M1~M3) → 수정 → 2라운드 APPROVE(critical 0, important 0, minor 3). Codex 레인이 용량 초과로 판정 불가라 엔진 `--fallback-run` Claude 레인 판정 — 교차 벤더 아님.
- 2라운드 m1(Claude 복구 보존 미실증) 해소: 저부하 워커에서 claude-recovery·run-recovery·cmux-session-*·supervisor 7파일을 BASE(5e47d84)·HEAD 각각 실행, 250/250 양쪽 통과.
- `teamcodex-manual-rollout.py` 카나리 3/3 PASS, 라이브 아티팩트 `b3b7d146…`(롤백 대상 454a80aa). 배포 직후 status usable 6/6, 전 계정 `codexCreditsAt` 15:19로 갱신(이전 값은 10/11 스냅샷 고정), 라이브 아티팩트에 codexUseCredits·_isAvoided·TEAMCODEX_OVERLOAD_HOLD_MS·codexPrestreamEncodingOf·quotaReserve·markSendFailure 전부 존재.
- 기준 브랜치(qjc/resilient-routing, cmux 계열만 변경) 병합 후 이식 기능 테스트 134/134, eslint 0.
