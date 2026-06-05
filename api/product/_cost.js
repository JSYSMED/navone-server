// =============================================
// NavOne — PATCH /api/product/cost
// 개별 원가 인라인 수정.
//   Body: { licenseKey(필수), channelProductNo(필수), cost(필수), productName? }
//   응답: { success: true }
//
// navone_product_cost 단건 upsert (license_key + channel_product_no 충돌 시 갱신).
// =============================================

import { setCors, handlePreflight, assertEnv, sbUpsert } from "../../lib/supabase.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

export default async function handler(req, res) {
  setCors(res);
  // PATCH 프리플라이트 대응 — 공유 setCors 가 GET/POST 만 광고하므로 보강.
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  if (handlePreflight(req, res, "PATCH")) return;

  try {
    assertEnv();
    const { licenseKey, channelProductNo, cost, productName } = req.body || {};
    if (!licenseKey) return fail(res, 400, "MISSING_LICENSE", "licenseKey는 필수입니다.");
    if (channelProductNo == null || channelProductNo === "") {
      return fail(res, 400, "INVALID_INPUT", "channelProductNo는 필수입니다.");
    }
    const costNum = Number(cost);
    if (isNaN(costNum)) return fail(res, 400, "INVALID_INPUT", "cost는 숫자여야 합니다.");

    const row = {
      license_key: licenseKey,
      channel_product_no: String(channelProductNo),
      cost: Math.round(costNum),
      updated_at: new Date().toISOString(),
    };
    if (productName != null) row.product_name = String(productName);

    await sbUpsert("navone_product_cost", row, "license_key,channel_product_no");

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[product/cost]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "COST_PATCH_FAILED", err.message || "서버 오류", err.detail);
  }
}
