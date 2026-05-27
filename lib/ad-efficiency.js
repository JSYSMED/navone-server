// =============================================
// NavOne — 광고비 효율 점검 순수 로직
// /api 밖(lib/)에 둬서 Vercel이 엔드포인트로 노출하지 않음. (settlement.js / supabase.js 와 동일 패턴)
//
// navone_settlements 의 광고비(ad_fee) > 0 인 상품을 집계해 상품별 ROAS(광고수익률)와 손익을 계산하고,
// ROAS 구간으로 비효율 상품을 분류해 추천 액션을 매긴다.
//
//   ROAS = (판매액 / 광고비) × 100  (%)
//   손익 = 정산금 - 원가추정(없으면 0)
//
// 원가는 settlement.js 의 costMap 규약을 그대로 따른다(stores.config.product_configs).
// =============================================

// 표준 실패 응답: { success: false, error: { code, message } } (settlement.js 와 동일 규약)
export function fail(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

// 예외 → 표준 실패 응답. supabase 헬퍼가 던진 err.status/detail 반영.
export function sendFail(res, err) {
  const status = err && err.status ? err.status : 500;
  const code = status === 502 ? "UPSTREAM_ERROR" : status >= 500 ? "SERVER_ERROR" : "REQUEST_ERROR";
  console.error("[ad-efficiency] error:", status, err && err.message, err && err.detail);
  return res.status(status).json({
    success: false,
    error: { code, message: (err && err.message) || "서버 오류" },
  });
}

// ROAS 구간 분류. 경계값은 하한 포함(>=).
//   < 150%      → 위험(중단 추천)
//   150~300%    → 경고(감액 추천)
//   300~500%    → 양호(유지)
//   500%+       → 우수(증액 추천)
export const ROAS_BANDS = {
  danger:    { level: "danger",    label: "위험", action: "중단", actionLabel: "광고 중단 추천", min: 0,   max: 150 },
  warning:   { level: "warning",   label: "경고", action: "감액", actionLabel: "광고비 감액 추천", min: 150, max: 300 },
  good:      { level: "good",      label: "양호", action: "유지", actionLabel: "현행 유지", min: 300, max: 500 },
  excellent: { level: "excellent", label: "우수", action: "증액", actionLabel: "광고비 증액 추천", min: 500, max: Infinity },
};

export function classifyRoas(roas) {
  if (roas == null || isNaN(roas)) return ROAS_BANDS.danger;
  if (roas < 150) return ROAS_BANDS.danger;
  if (roas < 300) return ROAS_BANDS.warning;
  if (roas < 500) return ROAS_BANDS.good;
  return ROAS_BANDS.excellent;
}

// settlement.js 와 동일한 원가 맵 추출 규약 (배열/객체 양쪽 허용).
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

/**
 * 상품별 광고비 효율 계산.
 *   - ad_fee > 0 인 행만 집계 대상 (광고 집행한 상품).
 *   - 상품별로 판매액/광고비/정산금/수량 합산 → ROAS, 손익, 분류, 추천 액션.
 *
 * @param {Array} rows     navone_settlements 행 배열
 * @param {Object} costMap buildCostMap 결과 (없으면 원가 0 처리)
 * @returns {Array} 상품별 효율 객체 배열 (ROAS 오름차순 — 비효율 상품이 위로)
 */
export function computeAdEfficiency(rows, costMap = {}) {
  const byProduct = new Map();

  for (const r of rows) {
    const adFee = Number(r.ad_fee) || 0;
    if (adFee <= 0) continue; // 광고비 0 상품은 효율 점검 대상 아님

    const key = r.channel_product_no || r.product_name || r.product_order_id || "unknown";
    if (!byProduct.has(key)) {
      byProduct.set(key, {
        channelProductNo: r.channel_product_no || null,
        productName: r.product_name || key,
        sales: 0, settlement: 0, adFee: 0, units: 0,
        commission: 0, delivery: 0, return: 0,
      });
    }
    const p = byProduct.get(key);
    p.sales += Number(r.sales_amount) || 0;
    p.settlement += Number(r.settlement_amount) || 0;
    p.adFee += adFee;
    p.units += Number(r.quantity) || 1;
    p.commission += Number(r.commission_fee) || 0;
    p.delivery += Number(r.delivery_fee) || 0;
    p.return += Number(r.return_deduct) || 0;
  }

  const list = [...byProduct.values()].map((p) => {
    // ROAS = (판매액 / 광고비) × 100. 광고비 0은 위에서 걸러져 항상 양수.
    const roas = p.adFee > 0 ? Number(((p.sales / p.adFee) * 100).toFixed(1)) : 0;

    // 원가 추정 (settlement.js 규약). 미설정이면 0 처리.
    const cfg = costMap[p.channelProductNo] || costMap[p.productName] || null;
    const unitCost = cfg ? Number(cfg.min_sale_price ?? cfg.minSalePrice ?? cfg.cost) : null;
    const hasCost = unitCost != null && !isNaN(unitCost) && unitCost > 0;
    const totalCost = hasCost ? unitCost * p.units : 0;

    // 손익 = 정산금 - 원가추정(없으면 0)
    const profit = Math.round(p.settlement - totalCost);

    const band = classifyRoas(roas);

    return {
      channelProductNo: p.channelProductNo,
      productName: p.productName,
      units: p.units,
      sales: Math.round(p.sales),
      adFee: Math.round(p.adFee),
      settlement: Math.round(p.settlement),
      commission: Math.round(p.commission),
      delivery: Math.round(p.delivery),
      return: Math.round(p.return),
      roas,
      unitCost: hasCost ? unitCost : null,
      totalCost: Math.round(totalCost),
      hasCost,
      profit,
      isLoss: profit < 0,
      level: band.level,
      levelLabel: band.label,
      action: band.action,
      actionLabel: band.actionLabel,
    };
  });

  // ROAS 오름차순 — 비효율(위험) 상품이 위로.
  list.sort((a, b) => a.roas - b.roas);
  return list;
}

/**
 * 분류별 그룹핑 + 요약. computeAdEfficiency 결과를 위험/경고/양호/우수로 묶는다.
 * @param {Array} efficiency computeAdEfficiency 결과
 * @returns {{ groups: Object, summary: Object }}
 */
export function summarizeRecommendations(efficiency) {
  const groups = { danger: [], warning: [], good: [], excellent: [] };
  for (const e of efficiency) {
    (groups[e.level] || groups.danger).push(e);
  }

  const totalAdFee = efficiency.reduce((s, e) => s + e.adFee, 0);
  const totalSales = efficiency.reduce((s, e) => s + e.sales, 0);
  const avgRoas = totalAdFee > 0 ? Number(((totalSales / totalAdFee) * 100).toFixed(1)) : 0;

  const summary = {
    productCount: efficiency.length,
    totalAdFee,
    totalSales,
    avgRoas,
    dangerCount: groups.danger.length,
    warningCount: groups.warning.length,
    goodCount: groups.good.length,
    excellentCount: groups.excellent.length,
    lossCount: efficiency.filter((e) => e.isLoss).length,
  };

  return { groups, summary };
}
