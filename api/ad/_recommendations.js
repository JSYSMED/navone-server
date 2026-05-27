// =============================================
// NavOne Vercel API — /api/ad/recommendations
// 광고비 효율(ROAS) 분류별 상품 리스트 + 추천 액션.
//
//   GET /api/ad/recommendations?licenseKey=...&start=YYYY-MM-DD&end=YYYY-MM-DD
//   응답: { success: true, data: { groups, summary, range } }
//
//   groups: { danger:[], warning:[], good:[], excellent:[] }
//     danger    위험  → 광고 중단 추천 (ROAS < 150%)
//     warning   경고  → 광고비 감액 추천 (150~300%)
//     good      양호  → 현행 유지 (300~500%)
//     excellent 우수  → 광고비 증액 추천 (500%+)
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
    const { groups, summary } = summarizeRecommendations(products);

    return res.status(200).json({
      success: true,
      data: { groups, summary, range: { start, end } },
    });
  } catch (err) {
    return sendFail(res, err);
  }
}
