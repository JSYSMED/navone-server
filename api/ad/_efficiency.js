// =============================================
// NavOne Vercel API — /api/ad/efficiency
// 저장된 정산 데이터(navone_settlements) 기반 상품별 광고비 효율(ROAS) 집계.
//
//   GET /api/ad/efficiency?licenseKey=...&start=YYYY-MM-DD&end=YYYY-MM-DD
//   응답: { success: true, data: { products, summary, range } }
//
//   products[]: { productName, sales, adFee, roas, profit, level, action, ... }
//   (ROAS 오름차순 — 비효율 상품이 위로)
//
// 주의: 최신 데이터를 보려면 먼저 POST /api/settlement/sync 로 동기화 필요.
// =============================================

import { setCors, handlePreflight, assertEnv, sbSelect } from "../../lib/supabase.js";
import {
  computeAdEfficiency, summarizeRecommendations, buildCostMap, fail, sendFail,
} from "../../lib/ad-efficiency.js";

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

    // 기간 내 광고비 집행 행만 조회 (ad_fee > 0).
    const rows = await sbSelect(
      "navone_settlements",
      "store_id=eq." + encodeURIComponent(store.id) +
        "&settlement_date=gte." + encodeURIComponent(start) +
        "&settlement_date=lte." + encodeURIComponent(end) +
        "&ad_fee=gt.0" +
        "&select=channel_product_no,product_name,product_order_id,quantity,sales_amount,settlement_amount,commission_fee,ad_fee,delivery_fee,return_deduct" +
        "&order=settlement_date.desc&limit=5000"
    );

    const costMap = buildCostMap(store.config);
    const products = computeAdEfficiency(rows || [], costMap);
    const { summary } = summarizeRecommendations(products);

    return res.status(200).json({
      success: true,
      data: { products, summary, range: { start, end } },
    });
  } catch (err) {
    return sendFail(res, err);
  }
}
