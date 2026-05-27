# Agent D — 클린페널티 알림봇

네이버 클린 프로그램(2025.06~) 대응: 무거래 상품 / 등록 한도 임박을 매일 자동 스캔하고
Telegram으로 알림한다.

## 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/penalty/risk-scan` | 리스크 스캔 실행 → Supabase 저장 + Telegram 알림 |
| GET | `/api/penalty/history` | 과거 스캔 결과 조회 |

### `GET /api/penalty/risk-scan`
쿼리(선택):
- `licenseKey` — 특정 스토어만 스캔. 없으면 커머스 인증정보가 등록된 **전체 스토어** 스캔(Cron 용).
- `recentSalesAmount` — 직전 3개월 판매액(원). 등록 한도 산정용(아래 참고).

응답: `{ success, data: { processed, errors, scans } }`

### `GET /api/penalty/history`
쿼리: `licenseKey`(선택), `limit`(기본 30, 최대 100). → `{ success, data: [...] }`

## 스캔 로직
1. 커머스 API `POST /external/v1/products/search`로 판매중 상품 전체 조회(페이지네이션, RPS≤2 준수).
2. 무거래 판정: `lastSoldDate`(없으면 등록일 fallback) 기준
   - **13개월+** → 위험, **10개월+** → 주의
3. 등록 한도: 직전 3개월 판매액 `< 500만원` → **1,000개** 한도 적용, 아니면 기본 한도(`DEFAULT_LIMIT`).
   상품 수 대비 사용률(%) 계산. 사용률 ≥80%면 알림.

> ⚠️ **판매액 데이터 한계**: 직전 3개월 판매액은 정산 API(Agent A 영역)에 있어 상품 API만으론
> 알 수 없다. `recentSalesAmount` 쿼리 또는 `stores.config.recentSalesAmount`로 주입한다.
> 주입되지 않으면 미상으로 보고 기본 한도를 적용한다.

> ⚠️ **상품 응답 필드**: `lastSoldDate` 등 필드명은 환경마다 다를 수 있어 방어적으로 추출한다.
> 테스트스토어 실응답으로 `normalizeProduct()` 매핑을 한 번 검증할 것.

## run() 인터페이스
Agent F 자동모드 연결용 표준 인터페이스를 export 한다(AGENTS.md §8):
```js
import { run } from "./api/penalty/risk-scan.js";
await run({ licenseKey, recentSalesAmount, registrationLimit });
// → { success, processed, errors, scans }
```

## Cron (vercel.json)
```json
{ "crons": [{ "path": "/api/penalty/risk-scan", "schedule": "0 9 * * *" }] }
```
> ⚠️ **Vercel Cron은 UTC 기준**이다. `0 9 * * *`는 **UTC 09:00 = KST 18:00**.
> 한국시간 오전 9시에 돌리려면 `0 0 * * *`로 변경할 것.

## 환경변수
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — Telegram 발송(`lib/telegram.js`)
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — 로그 저장(`lib/supabase.js`)

## 의존성 (공유 인프라, import only)
- `lib/telegram.js` — Agent D가 생성한 범용 Telegram 모듈
- `lib/supabase.js` — Supabase REST 헬퍼
- `lib/commerce-auth.js` — **커머스 인증 헤더 `getCommerceHeaders(clientId, clientSecret)`**.
  AGENTS.md §4.1의 공유 헬퍼. 현재 브랜치에 파일이 없으므로 머지/배포 전 존재 확인 필요.

## DB 마이그레이션
`migration.sql` → Supabase SQL Editor에서 실행 (`navone_penalty_alerts` 테이블).
