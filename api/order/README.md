# Agent C — 발주확인 자동화 + 송장 일괄 등록

신규 주문 자동 발주확인 + 송장번호 등록(단건/일괄). 발주확인 누락은 판매관리 페널티에
직결되므로, 폴링 → 자동 발주확인 → Telegram 알림 → 송장 등록 흐름을 제공한다.

## 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET  | `/api/order/pending`        | 미발주(발주대기, `PAY_WAITING`) 주문 목록 |
| POST | `/api/order/auto-confirm`   | 자동 발주확인 (설정 ON 또는 ids 명시) |
| POST | `/api/order/dispatch`       | 송장 등록 (단건) |
| POST | `/api/order/dispatch-bulk`  | 송장 일괄 등록 (순차, RPS 500ms 딜레이) |

모든 응답은 표준 형식: 성공 `{ success: true, data }`, 실패 `{ success: false, error: { code, message, detail } }`.

### `GET /api/order/pending`
쿼리: `licenseKey`(필수), `from`(ISO8601, 선택 — 기본 최근 24h), `persist`(`"1"`이면 navone_orders 저장).
→ `{ success, data: { storeName, count, orders } }`

### `POST /api/order/auto-confirm`
바디: `{ licenseKey(필수), productOrderIds?, notifyOnNew? }`
- `productOrderIds` 명시 → 해당 주문 즉시 발주확인 (수동 트리거)
- 생략 → **자동 모드**: `stores.config.autoConfirmOrders === true`일 때만 실행. OFF면 신규주문 알림만 보내고 skip.
- 발주확인 실패 시 **최대 3회 재시도**(4xx 비-429는 즉시 중단).
→ `{ success, data: { confirmed, failed, productOrderIds, failInfos, autoMode } }`

### `POST /api/order/dispatch`
바디: `{ licenseKey, productOrderId, deliveryCompanyCode, trackingNumber, deliveryMethod?, dispatchDate? }`
→ `{ success, data: { productOrderId, deliveryCompanyCode, trackingNumber, result } }`

### `POST /api/order/dispatch-bulk`
바디: `{ licenseKey, items: [{ productOrderId, deliveryCompanyCode, trackingNumber, ... }] }`
- 순차 처리, 각 호출 사이 **500ms 딜레이**(RPS≤2 준수). 건별 실패해도 나머지 진행.
→ `{ success, data: { total, succeededCount, failedCount, succeeded, failed } }`

## 커머스 API
- `GET  /external/v1/pay-order/seller/product-orders/last-changed-statuses` (`lastChangedType=PAY_WAITING`)
- `POST /external/v1/pay-order/seller/product-orders/query` (productOrderIds → 상세)
- `POST /external/v1/pay-order/seller/product-orders/confirm` (`{ productOrderIds }`)
- `POST /external/v1/pay-order/seller/product-orders/dispatch`

> ⚠️ **응답 필드**: 커머스 응답 구조는 환경/버전마다 차이가 있어 `_lib.js`에서 방어적으로 파싱한다
> (`lastChangeStatuses`/`data` 등). 테스트스토어(볼빨간오빠) 실응답으로 `normalizeOrder()` 1회 검증 권장.

> ⚠️ **dispatch 바디**: 본 구현은 과제 명세대로 단건 `{ productOrderId, deliveryCompanyCode, trackingNumber }`
> 형태를 보낸다. 커머스가 배열 래퍼(`dispatchProductOrders: [...]`)를 요구하면 `_lib.js`/`dispatch.js`에서 1줄 변경.

## 배송사 코드 (`deliveryCompanyCode`)
`CJGLS`(CJ대한통운), `HANJIN`(한진), `LOTTE`(롯데), `EPOST`(우체국), `LOGEN`(로젠),
`KDEXP`(경동), `CVSNET`(GS편의점) 등 — 전체 맵은 `_lib.js`의 `DELIVERY_COMPANIES`.
권위 있는 전체 목록은 커머스 `GET /external/v1/pay-order/seller/delivery-companies`.

## run() 인터페이스 (Agent F 자동모드)
서버는 무상태 엔드포인트, 자동 실행 트리거는 두 경로:
1. **Extension**: `navone-extension/src/order/order-engine.js` → 전역 `orderConfirm.run(config)`
   (AGENTS.md §8 스케줄러 핸들러 `order_confirm: 'orderConfirm.run'`). 반환 `{ success, processed, errors }`.
   - `background.js`에 `importScripts("lib/bcrypt.js"); importScripts("src/order/order-engine.js");` 선행 필요(Agent F 연결).
2. **서버 자동확인**: `POST /api/order/auto-confirm`(ids 생략) — Cron/스케줄러에서 호출 가능.

## 환경변수
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — 스토어 자격증명/주문 저장(`lib/supabase.js`)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — 신규주문/발주확인 알림(fallback). `lib/telegram.js`(Agent D)가 있으면 우선 사용.
- 스토어별 커머스 키는 `stores.client_id` / `stores.client_secret` (store-register로 등록).

## 의존성
- **신규 npm**: `bcryptjs`(^2.4.3) — 커머스 전자서명(`lib/commerce-auth.js`). package.json에 추가됨.
- 공유 인프라(import only): `lib/commerce-auth.js`(커머스 인증), `lib/supabase.js`(REST), `lib/telegram.js`(선택, Agent D).

## DB 마이그레이션
`db/migrations/20260527_navone_orders.sql` → Supabase SQL Editor 실행 (`navone_orders` 테이블).
자동확인 토글은 `stores.config.autoConfirmOrders`(jsonb boolean)에 보관 — 별도 테이블 없음.

## 충돌 메모 (머지 시)
- `lib/commerce-auth.js`, `package.json`(bcryptjs), `vercel.json`(functions) 은 여러 에이전트 공통 변경 영역.
- Extension `sidepanel.html` 은 `<script>` 3줄만 추가(마크업 무수정), nav/page는 `order-panel.js`가 런타임 주입.
