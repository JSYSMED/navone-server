# NavOne 판매 현황 — 서버(navone-server) 작업 명세

스마트스토어센터 "판매 관리" 위젯에 해당. 날짜별로 "뭐가 몇 개 얼마에 팔렸고, 단계별 몇 건이고, 정산예정액이 얼마인지" 보여준다.
정산(settlement)은 이미 있음 — 이건 **주문 시점** 기준 판매 현황(아직 정산 전 포함).

핵심: 네이버 커머스 API `GET /external/v1/pay-order/seller/product-orders`(조건형 상품 주문 상세 내역 조회) 활용.
claim-engine이 이미 commerceRequest로 pay-order API를 쓰고 있으니 인증/요청 패턴 그대로 재사용.

---

## 1. 엔드포인트: GET /api/order/sales-status

### 입력 (query)
- licenseKey (필수)
- from (ISO date-time, 예: 2026-06-06T00:00:00.000+09:00). 생략 시 오늘 0시(KST)
- to   (ISO date-time). 생략 시 from + 24h
- rangeType (기본 PAYED_DATETIME): PAYED_DATETIME/ORDERED_DATETIME/DISPATCHED_DATETIME/PURCHASE_DECIDED_DATETIME/CLAIM_REQUESTED_DATETIME

### 처리
1. getStoreByLicense(licenseKey) → store, creds
2. GET /external/v1/pay-order/seller/product-orders  query={ from, to, rangeType, pageSize:300 }
   - 응답 data.contents[] 각 항목 { productOrderId, content:{ order, productOrder, delivery } }
   - data.pagination.hasNext면 page 증가 반복(최대 ~10페이지 안전장치)
3. content.productOrder(po) + content.order(o) 정규화:
   {
     productOrderId: po.productOrderId,
     productName:    po.productName,
     option:         po.productOption || "",
     quantity:       po.quantity,
     salesAmount:    po.totalPaymentAmount,
     commission:     Math.abs(po.paymentCommission||0)+Math.abs(po.saleCommission||0),
     expectedSettlement: po.expectedSettlementAmount,   // 정산 예정액(네이버 떼고 줄 돈)
     status:         po.productOrderStatus,
     inflowPath:     po.inflowPath || "",
     ordererName:    o.ordererName,
     paymentDate:    o.paymentDate,
     orderDate:      o.orderDate,
   }

### 응답
{
  "success": true,
  "storeName": "...",
  "range": { "from","to","rangeType" },
  "summary": {
    "orderCount": 12,
    "totalSales": 358000,
    "totalSettlement": 327000,
    "totalCommission": 31000,
    "statusCounts": { "PAYED":3,"DELIVERING":4,"DELIVERED":2,"PURCHASE_DECIDED":3 }
  },
  "orders": [ /* 정규화 객체 배열 */ ]
}
- statusCounts는 서버에서 productOrderStatus별 집계해서 제공(프론트 편의).
- productOrderStatus 값: PAYMENT_WAITING/PAYED/DELIVERING/DELIVERED/PURCHASE_DECIDED/EXCHANGED/CANCELED/RETURNED 등. 한글 라벨은 프론트.

---

## 2. server.mjs 라우트 등록 (필수)
/api/order/sales-status  →  api/order/_sales-status.js
기존 order 라우트 패턴/ setCors/handlePreflight 동일.

## 3. verify-sales-status.mjs
- NAVONE-TEST-001로 오늘/어제/이번주 호출, summary 합계 == orders 합 검증
- IP 제약(GW.IP_NOT_ALLOWED)이면 SKIP(원가 cost-list와 동일, 운영 VPS에서만 실호출)

## 4. 주의
- from/to는 KST(+09:00) ISO. 범위 최대 24h 권장(네이버 제약). 이번주 등 긴 범위는 일자별 분할 호출 후 합산.
- 금액 정수(원). 수수료 음수 가능 → Math.abs.
- 취소/반품 건도 섞여옴 → status로 구분(1차는 전부 표시, 라벨로 구분).

---

## 5. ★ 핵심 검증 포인트 (반드시 리포트)

이 기능의 사업적 가치는 "주문 시점부터 예상 정산액을 보여줄 수 있는가"에 달려있다.
스마트스토어센터는 구매확정 후에야 정산액을 보여주지만, product-orders API의
expectedSettlementAmount가 **주문/결제 시점부터 채워져 오면** 큰 차별점이 된다.

verify-sales-status.mjs는 실제 응답을 까서 아래를 명확히 출력할 것:
1. orders 중 expectedSettlement 가 0/null 이 아닌 건수 / 전체 건수
   예: "expectedSettlement 채워진 건: 8/12 (66%)"
2. status별로 expectedSettlement 채워짐 여부 분포
   - PAYED(결제완료) 상태에서도 expectedSettlement가 오는가? ← 가장 중요
   - PURCHASE_DECIDED(구매확정)에서만 오는가?
3. paymentCommission/saleCommission 도 같은 방식으로 채워짐 여부 리포트
4. inflowPath 값 샘플 출력 (외부/내부 유입 구분 가능한지 — 수수료 ROI 연계)

→ 이 리포트로 "주문 즉시 예상 정산액 표시" 기능이 가능한지 판정한다.
   PAYED 시점부터 채워지면 기능 살림 / PURCHASE_DECIDED에서만 오면 "구매확정분만 예상정산 표시".
   전부 비어오면 → 판매액·수수료·건수만 표시하고 정산은 기존 settlement 페이지로.
