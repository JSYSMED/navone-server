# NavOne 서버 — 검증 현황 (STATUS)

> 최종 업데이트: 2026-06-04
> 테스트 스토어: 볼빨간오빠 (`licenseKey = NAVONE-TEST-001`)
> 배포: 카페24 VPS `pjhbless0831.cafe24.com` (PM2 프로세스 `navone`, 포트 3000)

이 문서는 **실제 호출로 검증된** API의 정확한 사용법과 현황을 정리한다.
"코드에 있다"가 아니라 "실제로 200을 주고 데이터가 맞는다"가 확인된 것만 ✅ 로 표시한다.

---

## 1. 검증 현황 요약 (11개 라이브 확인)

| # | 기능 | 경로 | 메서드 | 상태 |
|---|------|------|--------|------|
| 1 | 정산 현황(일별) | `/api/settlement/daily` | GET | ✅ |
| 2 | 마진율 랭킹(건별) | `/api/settlement/sync` → `/margin-rank` | POST/GET | ✅ |
| 3 | 수수료 외부유입 ROI | `/api/settlement/commission-roi` | GET | ✅ (신규) |
| 4 | 고객문의(inquiry) | `/api/inquiry/list`, `/submit` | GET/POST | ✅ (인증 통일) |
| 5 | 페널티 | `/api/penalty/history`, `/risk-scan` | GET | ✅ (컬럼 수정) |
| 6 | 그룹 추천(AI) | `/api/group/suggest` | GET | ✅ |
| 7 | 가격 이력 | `/api/history-list` | GET | ✅ |
| 8 | 클레임 | `/api/claim/pending` | GET | ✅ |
| 9 | 발주 | `/api/order/pending` | GET | ✅ |
| 10 | 상품 최적화(AI) | `/api/product-ai/bulk-analyze`, `/analyze` | GET | ✅ |
| 11 | 리뷰 답글(AI) | `/api/review-reply` | POST | ✅ |

공통 응답: 성공 `{ success: true, data: {...} }` / 실패 `{ success: false, error: { code, message } }`
(일부 라우트는 `{ reply, ... }` 등 자체 형식 — 아래 개별 표기)

---

## 2. 정확한 호출법 (검증 시 알아낸 함정 포함)

### 1) 정산 현황 — 일별
```
GET /api/settlement/daily?licenseKey=NAVONE-TEST-001&start=2026-05-20&end=2026-05-28
```
- 네이버 경로: `/external/v1/pay-settle/settle/daily` (startDate/endDate/**pageNumber/pageSize 필수**)
- 일별은 **날짜별 집계** — 상품 단위 아님. `normalizeDailyRow` 사용.
- 수수료는 **음수**로 옴 → 표시 시 절댓값.

### 2) 마진율 랭킹 — 건별
```
POST /api/settlement/sync   body: { licenseKey, start?, end? }   # navone_settlements 채우기
GET  /api/settlement/margin-rank?licenseKey=...&start=...&end=...
```
- 네이버 경로: `/external/v1/pay-settle/settle/case`
- ⚠️ 건별은 `searchDate`(**단일 일자**) 기준 → `_sync.js`가 기간을 **하루씩 루프**로 수집.
- `PROD_ORDER` 타입만 마진 대상(DELIVERY·적립 제외). 정산금 = `settleExpectAmount`.
- 원가 미설정 시 정산율 동일(≈94.4%, 기본 수수료율). 원가 입력 시 상품별 갈림.

### 3) 수수료 외부유입 ROI (신규)
```
GET /api/settlement/commission-roi?licenseKey=...&start=...&end=...
```
- 네이버 경로: `/external/v1/pay-settle/settle/commission-details` (searchDate 단일 → 하루씩 루프)
- `sellingInterlockCommissionType` 으로 분류:
  - `PLT_SMART_STORE` = 내부유입(판매수수료, ≈3%)
  - `PLF_SMART_STORE_MARKETING` = 외부유입(마케팅수수료, ≈0.91%)
  - `PAY_COMMISSION`(Npay) = 유입무관 → otherFee 분리
- 응답: 내부/외부 base·fee·rate + `externalSharePct` + `savingsIf`(25/50/100% 외부전환 절약액)
- 검증: 볼빨간오빠 = 내부 100%(외부 0). 50% 전환 시 14일 ≈4만원(월 17만 ≈ 구독료).

### 4) 고객문의 (인증 통일됨)
```
GET  /api/inquiry/list?licenseKey=...
POST /api/inquiry/submit   body: { licenseKey, inquiryId, content, mode? }
```
- ⚠️ 인증: `x-naver-token`(구) → **`licenseKey`**(qa·정산과 통일). 서버가 토큰 발급.
- ⚠️ 네이버 문의 API는 `startSearchDate`/`endSearchDate` **필수** → 미지정 시 최근 7일 기본값.

### 5) 페널티
```
GET /api/penalty/history?licenseKey=...
GET /api/penalty/risk-scan?licenseKey=...   # 스캔 실행 + Telegram 알림
```
- ⚠️ history 정렬 컬럼: `scanned_at`(없음) → **`created_at`** 으로 수정.

### 6) 그룹 추천 (AI)
```
GET /api/group/suggest?licenseKey=...
```
- 상품 검색(`/external/v1/products/search`) + 클러스터링 + GPT-4o-mini 판단.
- 검증: 426상품 → 6그룹. 용량/매수 달라도 동일 제품군 판단 정확.
- ⚠️ `group/list`(목록 조회)는 **네이버에 API 없음** (단건 `/external/v2/standard-group-products/:no` 만).
  → 목록은 DB 기반으로 재설계 필요.

### 7) 가격 이력
```
GET /api/history-list?licenseKey=...&type=price   # type = price|review|cs (필수)
```

### 8) 클레임 / 9) 발주
```
GET /api/claim/pending?licenseKey=...
GET /api/order/pending?licenseKey=...
```
- 둘 다 그대로 작동. 발주확인/송장은 POST(`auto-confirm`, `dispatch`).

### 10) 상품 최적화 (AI)
```
GET /api/product-ai/bulk-analyze?licenseKey=...&limit=N   # 여러 상품 SEO 점수
GET /api/product-ai/analyze?licenseKey=...&originProductNo=13497856745   # 단건
```
- ⚠️ `analyze`는 `originProductNo`(**원상품번호**) 필요 — channelProductNo(채널상품번호) 아님!
- 점수: nameSeo / attributeCompleteness / aitems (종합 점수). bulk-analyze로 원상품번호 확인 가능.

### 11) 리뷰 답글 (AI)
```
POST /api/review-reply
body: {
  licenseKey,
  review: { content, rating },          # ⚠️ 중첩 구조
  storeContext: { storeName, tone }
}
```
- ⚠️ 파라미터 **중첩**: `review.content`, `storeContext.storeName` (평평하게 보내면 400).
- 응답: `{ reply, model, tokens }` (GPT-4o-mini).

---

## 3. 인프라 / 운영 메모

- **server.mjs는 라우트를 수동 등록**한다 (`await load("/api/...", "./api/....js")`).
  Vercel의 `[action].js` 동적 라우터와 별개 — **신규 라우트는 server.mjs에도 반드시 등록**.
- **커머스 인증정보(client_id/secret)는 `.env`가 아니라 Supabase `stores` 테이블**에 있음.
  서버/로컬은 `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`만 있으면 됨.
- 모든 커머스 API는 `/external/...` prefix. RPS 가드(초당 2회) 통과.
- **OpenAI 크레딧 소진 시 모든 AI 기능이 quota 에러** → platform.openai.com Billing 확인.
- 로컬 IP도 네이버 통과됨 (IP 화이트리스트 이슈 없음 — 로컬 검증 가능).

### 로컬 검증 방법
```bash
cd navone-server
export $(grep -v '^#' .env.local | xargs)
node verify-settlement.mjs     # 정산 일별
node verify-margin.mjs         # 마진율(건별)
node verify-commission.mjs     # 수수료 ROI
node verify-inquiry.mjs        # 고객문의
node verify-group-suggest.mjs  # 그룹 추천 (USE_AI=1 로 AI까지)
```

---

## 4. 다음 작업

1. **대시보드 이관** — 클로드 디자인 시안(A 히어로 + B 할 일 센터 + 아낀 시간 카드)을
   실제 Vite+React 대시보드(navone-dashboard)로 옮기고 **검증된 11개 API 연결**. ← 가장 큰 작업
   - 메인화면: "오늘 N건 처리" 히어로 + 할 일 센터(긴급순) + 우측 예정 타임라인 + "이번 달 아낀 시간" 다크 카드
   - 사이드바: 6대분류 (가격관리 / 정산·광고분석 / 주문·발주 / 리스크관리 / 상품최적화 / 고객응대AI)
2. **그룹 create 비동기 검증** — 등록 요청 → 요청결과조회 패턴 (테스트스토어에 실제 그룹 생성 주의).
3. **group/list DB 재설계** — create 시 groupProductNo를 Supabase 저장 → list는 DB에서.
4. **리모트컨트롤** — 대시보드 → 서버 명령큐(navone_remote_commands) → 확장 폴링.
5. **크롬확장 전용 작업탭 리팩토링** — 현재 활성탭 의존 → 백그라운드 작업탭 + 큐.
6. **CJ CNPLUS** — 발주확인 + 수동 송장등록까지 1.0 (송장 발급 자동화는 2.0/굿스플로).
