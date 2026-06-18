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

// 일별 정산 집계 행 정규화 — 문서 /external/v1/pay-settle/settle/daily 응답 필드 기준.
// 일별 응답은 상품 단위가 아니라 "날짜별 집계"라 상품명/상품번호가 없다.
// 필드: settleBasisStartDate(기준 시작일), settleAmount(정산 금액),
//   paySettleAmount(결제 정산=정산 기준 금액), commissionSettleAmount(수수료 정산),
//   benefitSettleAmount(혜택), returnCareSettleAmount(반품안심케어),
//   deductionRestoreSettleAmount(공제 환급), normalSettleAmount/quickSettleAmount 등.
export function normalizeDailyRow(item, storeId) {
  const sales = pickNum(item, ["paySettleAmount"]); // 결제 정산 금액 = 정산 기준 금액
  const commission = pickNum(item, ["commissionSettleAmount"]);
  const benefit = pickNum(item, ["benefitSettleAmount"]);
  const settlement = pickNum(item, ["settleAmount"]); // 최종 정산 금액
  return {
    store_id: storeId,
    settlement_date: pickStr(item, ["settleBasisStartDate", "settleBasisEndDate", "settleExpectDate", "settleCompleteDate"]),
    sales_amount: sales,
    commission_fee: commission,
    benefit_amount: benefit,
    return_deduct: pickNum(item, ["returnCareSettleAmount"]),
    deduction_restore: pickNum(item, ["deductionRestoreSettleAmount"]),
    settlement_amount: settlement,
    quick_settle: pickNum(item, ["quickSettleAmount"]),
    normal_settle: pickNum(item, ["normalSettleAmount"]),
    raw: item,
  };
}

// 네이버 정산 항목 1건 → navone_settlements 행. storeId는 호출부에서 주입.
// 수수료/광고비/배송비/반품차감/정산금을 관용적 키 매핑으로 정규화.
export function normalizeSettlementRow(item, storeId) {
  // 건별 정산(/case) 문서 필드명을 우선 후보로 포함:
  //  paySettleAmount(결제 정산=정산 기준 금액), totalPayCommissionAmount(총 Npay 관리 수수료),
  //  sellingInterlockCommissionAmount(매출 연동 수수료), settleExpectAmount(정산 예정 금액),
  //  settleBasisDate(정산 기준일), productId/productName/productOrderId.
  const salesAmount = pickNum(item, [
    "paySettleAmount",
    "saleAmount", "salesAmount", "paymentAmount", "productAmount", "orderAmount", "totalPaymentAmount",
  ]);
  // 수수료 = Npay 관리 수수료 + 매출 연동 수수료 + 무이자할부(있으면 합산).
  //  네이버는 수수료를 음수로 반환하므로 절댓값으로 정규화한다.
  const payCommission = Math.abs(pickNum(item, ["totalPayCommissionAmount"]));
  const interlockCommission = Math.abs(pickNum(item, ["sellingInterlockCommissionAmount"]));
  const freeInstallment = Math.abs(pickNum(item, ["freeInstallmentCommissionAmount"]));
  let commissionFee = payCommission + interlockCommission + freeInstallment;
  if (!commissionFee) {
    commissionFee = Math.abs(pickNum(item, [
      "commissionAmount", "commissionFee", "saleCommission", "payCommission", "commission",
    ]));
  }
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
    "settleExpectAmount", "settlementAmount", "settleAmount", "expectedSettlementAmount", "paySettlementAmount", "settlementExpectAmount",
  ]);
  if (!settlementAmount && salesAmount) {
    settlementAmount = salesAmount - commissionFee - adFee - deliveryFee - returnDeduct;
  }

  return {
    store_id: storeId,
    settlement_date: pickStr(item, ["settleBasisDate", "settlementDate", "settleDate", "decisionDate", "date", "paymentDate", "payDate"]),
    product_order_id: pickStr(item, ["productOrderId", "productOrderID", "orderId", "orderID"]),
    channel_product_no: pickStr(item, ["productId", "channelProductNo", "channelProductNumber", "productNo", "originProductNo"]),
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
      map.set(date, { date, sales: 0, settlement: 0, commission: 0, benefit: 0, ad: 0, delivery: 0, return: 0, count: 0 });
    }
    const d = map.get(date);
    d.sales += Number(r.sales_amount) || 0;
    d.settlement += Number(r.settlement_amount) || 0;
    d.commission += Number(r.commission_fee) || 0;
    d.benefit += Number(r.benefit_amount) || 0;
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

// navone_product_cost 행 배열 → { channel_product_no: { cost } } 맵.
// computeMarginRanking 이 cfg.cost 를 읽으므로 cost 키로 담는다.
// (구) buildCostMap(stores.config) 대신 진짜 입력 원가를 쓰기 위한 경로.
export function buildProductCostMap(rows) {
  const map = {};
  for (const r of rows || []) {
    const key = r.channel_product_no ?? r.channelProductNo;
    if (key == null) continue;
    const cost = Number(r.cost);
    if (isNaN(cost)) continue;
    map[String(key)] = { cost };
  }
  return map;
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

// =============================================
// 수수료 외부유입 ROI 분석 (수수료 개편 대응)
//   commission-details API 응답을 받아 내부유입(PLT) vs 외부유입(PLF) 비중을 역산한다.
//
//   sellingInterlockCommissionType 기준 분류:
//     PLT_SMART_STORE            = 내부 판매 수수료 (~2.73%, 비싼 쪽)
//     PLF_SMART_STORE_MARKETING  = 외부유입 판매자 마케팅 수수료 (~0.91%, 싼 쪽)
//   네이버는 수수료를 음수로 반환 → 절댓값으로 집계.
//
//   "외부유입을 늘리면 절약되는 금액"을 시뮬레이션해 셀러에게 제시한다.
// =============================================
const INTERLOCK_INTERNAL = "PLT_SMART_STORE";          // 내부유입(판매수수료)
const INTERLOCK_EXTERNAL = "PLF_SMART_STORE_MARKETING"; // 외부유입(마케팅수수료)

// commissionType → 셀러가 알아보는 한글 라벨 + 도넛 색상.
// 모르는 타입은 raw 코드 그대로 노출 → 실데이터 보고 라벨 보강 (판매자센터가 ground-truth).
const FEE_TYPE_META = {
  PAY_COMMISSION:                 { label: "Npay 결제 수수료",   color: "#03C75A" },
  SELLING_COMMISSION:             { label: "매출연동 수수료",     color: "#2E7CF6" },
  SELLING_INTERLOCK_COMMISSION:   { label: "매출연동 수수료",     color: "#2E7CF6" },
  KNOWLEDGE_SHOPPING_COMMISSION:  { label: "지식쇼핑 수수료",     color: "#2E7CF6" },
  FREE_INSTALLMENT_COMMISSION:    { label: "무이자할부 수수료",   color: "#7C5CFC" },
  STORE_DISCOUNT_COMMISSION:      { label: "스토어 쿠폰",         color: "#F08A1D" },
  REVIEW_POINT_COMMISSION:        { label: "구매·리뷰 적립",      color: "#EC6699" },
  RETURN_SAFE_COMMISSION:         { label: "반품안심케어",        color: "#94A3B8" },
};
const FEE_FALLBACK_COLORS = ["#03C75A", "#2E7CF6", "#7C5CFC", "#F08A1D", "#EC6699", "#94A3B8", "#22B8CF", "#FAB005"];

export function analyzeInflowRoi(items) {
  let internalBase = 0, internalFee = 0;   // 내부유입 기준액/수수료
  let externalBase = 0, externalFee = 0;   // 외부유입 기준액/수수료
  let otherFee = 0;                        // 그 외(Npay 등 유입과 무관한 수수료)

  const feeByType = new Map();             // commissionType → 수수료 합계 (도넛용)

  for (const it of items) {
    const sit = it.sellingInterlockCommissionType;
    const base = Math.abs(Number(it.commissionBasisAmount) || 0);
    const fee = Math.abs(Number(it.commissionAmount) || 0);

    if (sit === INTERLOCK_INTERNAL) { internalBase += base; internalFee += fee; }
    else if (sit === INTERLOCK_EXTERNAL) { externalBase += base; externalFee += fee; }
    else { otherFee += fee; } // PAY_COMMISSION 등 — 유입 구분 없음

    // 수수료 구성 도넛 — commissionType 기준으로 합산
    const ct = it.commissionType || "ETC";
    feeByType.set(ct, (feeByType.get(ct) || 0) + fee);
  }

  const totalInterlockBase = internalBase + externalBase;
  const totalInterlockFee = internalFee + externalFee;

  // 실효 수수료율(기준액 대비). 데이터 없으면 null.
  const internalRate = internalBase > 0 ? internalFee / internalBase : null;
  const externalRate = externalBase > 0 ? externalFee / externalBase : null;

  // 외부유입 비중(매출 기준액 기준).
  const externalShare = totalInterlockBase > 0 ? externalBase / totalInterlockBase : 0;

  // 시뮬레이션: 내부유입의 일부를 외부유입으로 전환하면 얼마 절약되나.
  //   외부 실효율을 모르면 개편 기준치(0.91%) 사용, 내부도 모르면 2.73% 사용.
  const EXT_REF = externalRate ?? 0.0091;
  const INT_REF = internalRate ?? 0.0273;
  const ratePerWon = Math.max(INT_REF - EXT_REF, 0); // 1원 전환당 절약액

  const sim = (shiftRatio) => {
    const shiftedBase = internalBase * shiftRatio;
    return Math.round(shiftedBase * ratePerWon);
  };

  // ── 외부유입 "신규 매출" 시뮬 ────────────────────────────────
  //   savingsIf 는 "이미 들어오는 매출을 외부 경로로 돌렸을 때 수수료 절약(전환)".
  //   growthIf 는 "외부유입으로 매출을 새로 만들었을 때 순증(증대)" — 별개 레버.
  //
  //   모델: 유입 매출(totalInterlockBase)의 +10/20/30%를 외부유입으로 새로 만들면,
  //     추가매출  = totalBase × tier
  //     추가수수료 = 추가매출 × 외부율(EXT_REF, 0.91%대로 쌈)
  //     순증정산  = 추가매출 − 추가수수료
  //   같은 매출을 내부유입으로 만들었다면 수수료가 더 컸을 것 → feeEdge(외부라서 덜 낸 수수료)도 함께.
  //   ※ 비율(tier)은 예측이 아니라 what-if 시나리오. 셀러가 목표치 보며 의사결정하는 용도.
  const anchorBase = totalInterlockBase; // 유입 귀속 매출 ≈ 스토어 총매출 프록시
  const growth = (tier) => {
    const extraSales = Math.round(anchorBase * tier);
    const extraFee = Math.round(extraSales * EXT_REF);
    const extraNet = extraSales - extraFee;
    const internalEquivFee = Math.round(extraSales * INT_REF);
    return { extraSales, extraFee, extraNet, feeEdge: internalEquivFee - extraFee };
  };

  // ── 수수료 구성 도넛 (commissionType 실데이터) ──────────────
  const feeMixAll = [...feeByType.entries()]
    .map(([type, val]) => {
      const meta = FEE_TYPE_META[type];
      return { type, name: meta?.label || type, val: Math.round(val), color: meta?.color || null };
    })
    .filter((f) => f.val > 0)
    .sort((a, b) => b.val - a.val);
  // 상위 6개 + 나머지는 "기타"로 묶기, 색상 없으면 폴백 팔레트 채우기
  const feeMix = [];
  feeMixAll.slice(0, 6).forEach((f, i) => feeMix.push({ ...f, color: f.color || FEE_FALLBACK_COLORS[i % FEE_FALLBACK_COLORS.length] }));
  const restVal = feeMixAll.slice(6).reduce((s, f) => s + f.val, 0);
  if (restVal > 0) feeMix.push({ type: "ETC_GROUP", name: "기타", val: restVal, color: "#CBD5E1" });
  const feeMixTotal = feeMix.reduce((s, f) => s + f.val, 0);

  return {
    internal: { base: Math.round(internalBase), fee: Math.round(internalFee), rate: internalRate },
    external: { base: Math.round(externalBase), fee: Math.round(externalFee), rate: externalRate },
    otherFee: Math.round(otherFee),
    totalInterlockBase: Math.round(totalInterlockBase),
    totalInterlockFee: Math.round(totalInterlockFee),
    externalSharePct: Number((externalShare * 100).toFixed(1)),
    internalSharePct: Number(((1 - externalShare) * 100).toFixed(1)),
    refRates: { internal: INT_REF, external: EXT_REF },
    // 수수료 구성 도넛 (실데이터). 데이터 없으면 빈 배열 → 프론트가 폴백.
    feeMix,
    feeMixTotal,
    // 내부유입의 25%/50%/100%를 외부로 "전환" 시 수수료 절약액
    savingsIf: { shift25: sim(0.25), shift50: sim(0.5), shift100: sim(1.0) },
    // 외부유입으로 유입매출의 +10/20/30% 신규 매출을 "증대" 시 순증
    growthIf: { plus10: growth(0.1), plus20: growth(0.2), plus30: growth(0.3) },
  };
}
