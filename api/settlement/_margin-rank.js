// =============================================
// NavOne Vercel API — /api/settlement/margin-rank
// 저장된 정산 데이터(navone_settlements) 기반 상품별 마진율 계산 + 랭킹.
//
//   GET /api/settlement/margin-rank?licenseKey=...&start=YYYY-MM-DD&end=YYYY-MM-DD
//   응답: { success: true, data: { ranking, lossCount, range, costConfigured } }
//
//   마진율 = (정산금 - 원가) / 판매가 × 100
//   원가 = stores.config.product_configs[*].min_sale_price (셀러가 chrome.storage 에 설정 → 서버 동기화)
//
// 주의: 최신 데이터를 보려면 먼저 POST /api/settlement/sync 로 동기화 필요.
// =============================================

import { setCors, handlePreflight, assertEnv, sbSelect } from "../../lib/supabase.js";
import { computeMarginRanking, buildCostMap, fail, sendFail } from "../../lib/settlement.js";

function defaultRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    assertEnv();
    const { licenseKey } = req.query || {};
    if (!licenseKey) return fail(res, 400, "MISSING_LICENSE", "licenseKey는 필수입니다.");

    const def = defaultRange();
    const start = req.query.start || def.start;
    const end = req.query.end || def.end;

    const stores = await sbSelect(
      "stores",
      "license_key=eq." + encodeURIComponent(licenseKey) + "&select=id,config&limit=1"
    );
    const store = Array.isArray(stores) && stores.length ? stores[0] : null;
    if (!store) return fail(res, 404, "STORE_NOT_FOUND", "등록된 스토어가 없습니다.");

    // 기간 내 정산 행 조회 (settlement_date 범위).
    const rows = await sbSelect(
      "navone_settlements",
      "store_id=eq." + encodeURIComponent(store.id) +
        "&settlement_date=gte." + encodeURIComponent(start) +
        "&settlement_date=lte." + encodeURIComponent(end) +
        "&select=channel_product_no,product_name,product_order_id,quantity,sales_amount,settlement_amount,commission_fee,ad_fee,delivery_fee,return_deduct" +
        "&order=settlement_date.desc&limit=5000"
    );

    const costMap = buildCostMap(store.config);
    const ranking = computeMarginRanking(rows || [], costMap);
    const lossCount = ranking.filter((r) => r.isLoss).length;
    const costConfigured = Object.keys(costMap).length;

    return res.status(200).json({
      success: true,
      data: {
        ranking,
        lossCount,
        costConfigured,
        productCount: ranking.length,
        range: { start, end },
      },
    });
  } catch (err) {
    return sendFail(res, err);
  }
}
