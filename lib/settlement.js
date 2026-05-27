// =============================================
// NavOne — Agent A: 정산 데이터 정규화 / 마진 집계 순수 함수
// /api 밖(lib/)에 둬서 Vercel이 엔드포인트로 노출하지 않음. (supabase.js / commerce-auth.js 와 동일 패턴)
//
// 네이버 커머스 정산 API 응답은 필드명이 버전/항목별로 달라서, 여러 후보 키를 관용적으로 읽고
// 원본은 raw 컬럼에 보존한다. 금액은 모두 숫자(원)로 정규화.
// =============================================

// 표준 실패 응답: { success: false, error: { code, message } } (AGENTS.md §4.3)
export function fail(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

// 예외 → 표준 실패 응답. commerce-auth/supabase 헬퍼가 던진 err.status/detail 반영.
export function sendFail(res, err) {
  const status = err && err.status ? err.status : 500;
  const code = status === 502 ? "UPSTREAM_ERROR" : status >= 500 ? "SERVER_ERROR" : "REQUEST_ERROR";
  console.error("[settlement] error:", status, err && err.message, err && err.detail);
  return res.status(status).json({
    success: false,
    error: { code, message: (err && err.message) || "서버 오류" },
  });
}

// 여러 후보 키 중 처음으로 값이 있는 것을 숫자로. 없으면 0.
function pickNum(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") {
      const n = Number(v);
      if (!isNaN(n)) return n;
    }
  }
  return 0;
}

function pickStr(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  return null;
}

// 정산 API 응답에서 정산 항목 배열을 관용적으로 추출.
export function extractSettlementItems(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  // 자주 쓰이는 래핑 키들
  const candidates = [
    data.elements, data.contents, data.data, data.settlements,
    data.dailySettlements, data.list, data.result,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  // data.data.elements 같은 2단 래핑
  if (data.data && typeof data.data === "object") {
    const inner = extractSettlementItems(data.data);
    if (inner.length) return inner;
  }
  return [];
}

// 네이버 정산 항목 1건 → navone_settlements 행. storeId는 호출부에서 주입.
// 수수료/광고비/배송비/반품차감/정산금을 관용적 키 매핑으로 정규화.
export function normalizeSettlementRow(item, storeId) {
  const salesAmount = pickNum(item, [
    "saleAmount", "salesAmount", "paymentAmount", "productAmount", "orderAmount", "totalPaymentAmount",
  ]);
  const commissionFee = pickNum(item, [
    "commissionAmount", "commissionFee", "saleCommission", "payCommission", "commission",
  ]);
  const adFee = pickNum(item, [
    "adAmount", "adFee", "advertisementFee", "marketingFee",
  ]);
  const deliveryFee = pickNum(item, [
    "deliveryAmount", "deliveryFee", "shippingFee", "deliveryFeeAmount",
  ]);
  const returnDeduct = pickNum(item, [
    "returnAmount", "returnDeductAmount", "claimAmount", "returnDeduction", "refundAmount",
  ]);

  // 정산금: 응답에 있으면 그대로, 없으면 판매가에서 차감액을 빼서 산출.
  let settlementAmount = pickNum(item, [
    "settlementAmount", "settleAmount", "expectedSettlementAmount", "paySettlementAmount", "settlementExpectAmount",
  ]);
  if (!settlementAmount && salesAmount) {
    settlementAmount = salesAmount - commissionFee - adFee - deliveryFee - returnDeduct;
  }

  return {
    store_id: storeId,
    settlement_date: pickStr(item, ["settlementDate", "settleDate", "decisionDate", "date", "paymentDate"]),
    product_order_id: pickStr(item, ["productOrderId", "productOrderID", "orderId", "orderID"]),
    channel_product_no: pickStr(item, ["channelProductNo", "channelProductNumber", "productId", "productNo", "originProductNo"]),
    product_name: pickStr(item, ["productName", "productTitle", "goodsName", "itemName"]),
    quantity: pickNum(item, ["quantity", "productOrderQuantity", "qty"]) || 1,
    sales_amount: salesAmount,
    commission_fee: commissionFee,
    ad_fee: adFee,
    delivery_fee: deliveryFee,
    return_deduct: returnDeduct,
    settlement_amount: settlementAmount,
    raw: item,
  };
}

// 일자별 합계 집계 (대시보드 차트용). [{ date, sales, settlement, commission, ad, delivery, return, count }]
export function aggregateDaily(rows) {
  const map = new Map();
  for (const r of rows) {
    const date = r.settlement_date || (r.created_at || "").slice(0, 10) || "unknown";
    if (!map.has(date)) {
      map.set(date, { date, sales: 0, settlement: 0, commission: 0, ad: 0, delivery: 0, return: 0, count: 0 });
    }
    const d = map.get(date);
    d.sales += Number(r.sales_amount) || 0;
    d.settlement += Number(r.settlement_amount) || 0;
    d.commission += Number(r.commission_fee) || 0;
    d.ad += Number(r.ad_fee) || 0;
    d.delivery += Number(r.delivery_fee) || 0;
    d.return += Number(r.return_deduct) || 0;
    d.count += 1;
  }
  return [...map.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// 상품별 마진율 랭킹.
//   마진율 = (정산금 - 원가) / 판매가 × 100
//   원가(cost) = costMap[channel_product_no].min_sale_price × 수량 (셀러가 chrome.storage 에 설정한 값)
// costMap 없거나 해당 상품 원가 미설정이면 hasCost=false 로 표시(랭킹엔 포함하되 경고).
export function computeMarginRanking(rows, costMap = {}) {
  const byProduct = new Map();

  for (const r of rows) {
    const key = r.channel_product_no || r.product_name || r.product_order_id || "unknown";
    if (!byProduct.has(key)) {
      byProduct.set(key, {
        channelProductNo: r.channel_product_no || null,
        productName: r.product_name || key,
        sales: 0, settlement: 0, units: 0,
        commission: 0, ad: 0, delivery: 0, return: 0,
      });
    }
    const p = byProduct.get(key);
    p.sales += Number(r.sales_amount) || 0;
    p.settlement += Number(r.settlement_amount) || 0;
    p.units += Number(r.quantity) || 1;
    p.commission += Number(r.commission_fee) || 0;
    p.ad += Number(r.ad_fee) || 0;
    p.delivery += Number(r.delivery_fee) || 0;
    p.return += Number(r.return_deduct) || 0;
  }

  const ranking = [...byProduct.values()].map((p) => {
    const cfg = costMap[p.channelProductNo] || costMap[p.productName] || null;
    const unitCost = cfg ? Number(cfg.min_sale_price ?? cfg.minSalePrice ?? cfg.cost) : null;
    const hasCost = unitCost != null && !isNaN(unitCost) && unitCost > 0;
    const totalCost = hasCost ? unitCost * p.units : 0;

    // 판매가가 0이면 마진율 계산 불가(null).
    const marginRate = hasCost && p.sales > 0
      ? Number((((p.settlement - totalCost) / p.sales) * 100).toFixed(2))
      : null;
    const profit = hasCost ? Math.round(p.settlement - totalCost) : null;

    return {
      ...p,
      sales: Math.round(p.sales),
      settlement: Math.round(p.settlement),
      unitCost: hasCost ? unitCost : null,
      totalCost: Math.round(totalCost),
      profit,
      marginRate,
      hasCost,
      isLoss: hasCost && profit != null && profit < 0,
    };
  });

  // 마진율 내림차순. 원가 미설정(null)은 맨 뒤로.
  ranking.sort((a, b) => {
    if (a.marginRate == null && b.marginRate == null) return b.settlement - a.settlement;
    if (a.marginRate == null) return 1;
    if (b.marginRate == null) return -1;
    return b.marginRate - a.marginRate;
  });

  return ranking.map((r, i) => ({ rank: i + 1, ...r }));
}

// stores.config 에서 상품별 원가 설정 맵 추출. 배열/객체 양쪽 허용.
//   config.product_configs = [{ channelProductNo, min_sale_price }, ...] 또는
//                            { [channelProductNo]: { min_sale_price } }
export function buildCostMap(config) {
  const pc = config?.product_configs ?? config?.productConfigs;
  if (!pc) return {};
  if (Array.isArray(pc)) {
    const map = {};
    for (const c of pc) {
      const key = c.channelProductNo ?? c.channel_product_no ?? c.productNo ?? c.productName;
      if (key != null) map[String(key)] = c;
    }
    return map;
  }
  if (typeof pc === "object") return pc;
  return {};
}
