# Agent B — 클레임 자동처리 (navone-server)

반품/교환/취소 클레임을 GPT-4o-mini로 분류하고, 셀러 룰에 맞으면 자동 승인한다.

## 엔드포인트

### `GET /api/claim/pending`
미처리(CLAIM_REQUESTED) 클레임 목록.
- Query: `licenseKey`(필수), `days`(기본 1, 최대 31) 또는 `since`(ISO8601)
- 응답: `{ success, data: { storeName, since, count, pending[], claims[] } }`
- 각 클레임: `productOrderId, claimType(RETURN|CANCEL|EXCHANGE), claimStatus, productName, amount, claimReason, processed, decision, decidedBy, category`

### `POST /api/claim/auto-process`
AI 분류 + 룰 엔진 자동처리.
- Body: `{ licenseKey(필수), days?, since?, productOrderIds?[] }`
- 응답: `{ success, data: { processed, approved, held, errors[], results[] } }`
- `run(config)` 도 export → Agent F 자동모드/크론에서 직접 호출 가능 (`{ success, processed, errors }`)

### `POST /api/claim/manual-decide`
셀러 수동 승인/거부.
- Body: `{ licenseKey, productOrderId, claimType(RETURN|CANCEL), decision(approve|reject) }`
- 응답: `{ success, data: { productOrderId, claimType, decision } }`

## 룰 엔진 (`navone_claim_rules` / 기본값 `DEFAULT_RULES`)

| 분류 | 조건 | 처리 |
|------|------|------|
| 단순변심 `simple_return` | 금액 ≤ `simple_return_max_amount` + 신뢰도 ≥ 임계값 | 자동 승인 |
| 상품하자 `defect` | `auto_approve_defect` | 자동 승인 + Telegram 알림 |
| 배송문제 `delivery` / 기타 `other` | — | 보류 + Telegram(셀러 판단) |
| 교환 `EXCHANGE` | — | 항상 보류 (재배송 절차 필요) |
| 신뢰도 < `confidence_threshold` | 모든 분류 | 보류 |
| `enabled=false` | — | 자동처리 비활성 |

- 자동승인 대상 클레임 유형은 **반품(RETURN)·취소(CANCEL)** 뿐.
- 모든 결정은 `navone_claims` 에 감사 로그로 적재(자동승인 포함, `decided_by` = ai/seller).

## 의존성 / 환경변수

- **신규 npm 의존성**: `bcryptjs` — 커머스 API 토큰 서명(`lib/commerce-auth.js`)에 필요. 확장은 벤더링된 bcrypt를 쓰지만 서버는 패키지로 추가.
- **환경변수**: `OPENAI_API_KEY`(분류), `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`(알림, 미설정 시 알림만 생략).
- 커머스 자격증명(`client_id`/`client_secret`)은 `stores` 테이블에서 `licenseKey`로 조회 — 별도 env 불필요.
- `package.json` 에 `"type": "module"` 추가(기존 코드가 전부 ESM이라 명시화). Vercel 동작 변화 없음.

## DB 마이그레이션
`db/migrations/20260527_navone_claims.sql` — `navone_claims`, `navone_claim_rules`. Supabase SQL Editor에서 실행.

## 테스트
`npm run test:claim` — 룰 엔진/정규화 단위 테스트(네트워크 무사용, 11 케이스).

## 공정위 표시광고법 준수
GPT는 **분류 JSON만** 생성하며 고객 노출 텍스트·보상/환불 약속을 만들지 않는다(시스템 프롬프트에서 차단).

## 공유 인프라 메모
`lib/commerce-auth.js` 는 AGENTS.md §4.1 인터페이스(`getCommerceHeaders`)대로 신규 생성. 부재 상태였으며 커머스 API를 쓰는 모든 에이전트가 공용으로 import하는 헬퍼.
