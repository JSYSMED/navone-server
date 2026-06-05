# NavOne 원가 관리 — 서버(navone-server) 작업 명세

마진율(`settlement/margin-rank`)을 진짜 원가 기반으로 계산하기 위한 원가 입력 인프라.
상품목록 조회는 이미 구현됨(`lib/group-products.js`의 `fetchAllProducts`) → 재활용.

---

## 1. Supabase 테이블: `navone_product_cost`

```sql
create table navone_product_cost (
  license_key         text        not null,
  channel_product_no  text        not null,
  product_name        text,
  cost                integer     not null default 0,   -- 원 단위
  updated_at          timestamptz not null default now(),
  primary key (license_key, channel_product_no)
);
create index on navone_product_cost (license_key);
```

---

## 2. 엔드포인트 3개 (server.mjs 수동 라우트 등록 필수)

### GET /api/product/cost-list
상품 전체 + 저장된 원가 머지.
- `getStoreByLicense(licenseKey)` → store
- `fetchAllProducts(store)` 호출 (lib/group-products.js, 이미 있음)
  - 반환 필드: `{ productNo, originProductNo, name, category, salePrice, statusType }`
- `navone_product_cost`에서 `license_key` 행 전부 조회 → `channel_product_no → cost` 맵
- 머지해서 반환:

```json
{
  "success": true,
  "storeName": "...",
  "count": 424,
  "costConfigured": 12,
  "products": [
    { "channelProductNo": "...", "productName": "...", "category": "...",
      "salePrice": 24900, "cost": 15000 },
    { "channelProductNo": "...", "productName": "...", "category": "...",
      "salePrice": 38000, "cost": null }
  ]
}
```
- 원가 미입력 상품은 `cost: null`.

### POST /api/product/cost-bulk
엑셀 파싱은 프론트(SheetJS)에서 → 서버는 JSON만 받음.
- body: `{ licenseKey, items: [{ channelProductNo, cost }, ...] }`
- `navone_product_cost`에 upsert (license_key + channel_product_no 충돌 시 cost/updated_at 갱신)
- product_name은 cost-list 때 채워도 되고 여기서 items에 같이 받아 저장해도 됨
- 응답: `{ success: true, saved: <건수> }`

### PATCH /api/product/cost
개별 인라인 수정.
- body: `{ licenseKey, channelProductNo, cost }`
- 단건 upsert
- 응답: `{ success: true }`

---

## 3. margin-rank 수정 (api/settlement/_margin-rank.js + lib/settlement.js)

현재: `buildCostMap`이 `stores.config.product_configs[*].min_sale_price`를 원가 프록시로 사용.
변경: `navone_product_cost` 테이블을 조회해 `channel_product_no → cost` 맵으로 교체.
- 원가 있는 상품만 마진 계산(`profit = settleAmount - cost`, `rate = profit/sales`).
- `costConfigured` = 원가 입력된 상품 수.
- 원가 0건이면 기존처럼 `ranking: []` 반환(프론트가 빈 상태 처리).

---

## 4. 주의
- `fetchAllProducts`는 `productStatusTypes:["SALE"]`만 가져옴 → 판매중 기준. 품절 포함하려면 옵션 추가.
- channelProductNo 기준으로 통일(originProductNo 아님 — 마진/정산도 channel 기준).
- 페이지네이션 size=100, maxPages=20 (최대 2000개) — 대형 셀러는 maxPages 상향.
