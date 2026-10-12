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
(완료 후 기록)
