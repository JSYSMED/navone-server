# Settlement API (Agent A)

네이버 커머스 정산 API 연동 + 상품별 마진 분석.

## 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET  | `/api/settlement/daily?licenseKey=&start=&end=` | 네이버 정산 API 실시간 조회 (DB 저장 안 함). `start`/`end` 생략 시 최근 30일. |
| GET  | `/api/settlement/margin-rank?licenseKey=&start=&end=` | `navone_settlements` 기반 상품별 마진율 랭킹 + 적자 상품 카운트. |
| POST | `/api/settlement/sync` | body `{ licenseKey, start?, end? }`. 정산 API → `navone_settlements` upsert (멱등). |

응답 형식: 성공 `{ success: true, data: {...} }` / 실패 `{ success: false, error: { code, message } }`.

## 마진율 계산

```
마진율 = (정산금 - 원가) / 판매가 × 100
원가   = stores.config.product_configs[*].min_sale_price × 수량
```

원가(min_sale_price)는 셀러가 chrome.storage 에 설정한 뒤 `stores.config` 로 동기화된 값을 사용한다.
원가 미설정 상품은 랭킹 맨 뒤로 밀리며 마진율은 `null` 로 표시된다.

## 의존성 / 인프라

- **의존성**: `bcryptjs` — 공유 모듈 `lib/commerce-auth.js` 의 커머스 토큰 서명에 사용 (package.json 등록됨).
- **환경변수**: 신규 없음. 기존 `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` 재사용. 커머스 인증정보(client_id/secret)는 `stores` 테이블에서 조회.
- **DB**: `db/migrations/20260527_navone_settlements.sql` 을 Supabase SQL Editor 에서 실행.
- **RPS**: 커머스 호출은 `lib/commerce-auth.js` 의 RPS 가드(초당 2회 이하)를 통과한다.
