// =============================================
// NavOne — POST /api/product/cost-bulk
// 엑셀 일괄 원가 저장. 엑셀 파싱은 프론트(SheetJS) → 서버는 JSON만 받음.
//   Body: { licenseKey(필수), items: [{ channelProductNo(필수), cost(필수), productName? }, ...] }
//   응답: { success: true, saved: <건수> }
//
// navone_product_cost 에 upsert (license_key + channel_product_no 충돌 시 cost/updated_at 갱신).
// =============================================

import { setCors, handlePreflight, assertEnv, sbUpsert } from "../../lib/supabase.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    assertEnv();
    const { licenseKey, items } = req.body || {};
    if (!licenseKey) return fail(res, 400, "MISSING_LICENSE", "licenseKey는 필수입니다.");
    if (!Array.isArray(items) || !items.length) {
      return fail(res, 400, "INVALID_INPUT", "items는 1개 이상의 배열이어야 합니다.");
    }

    const now = new Date().toISOString();
    const rows = [];
    for (const it of items) {
      const channelProductNo = it?.channelProductNo ?? it?.channel_product_no;
      const cost = Number(it?.cost);
      if (channelProductNo == null || channelProductNo === "" || isNaN(cost)) continue;
      const row = {
        license_key: licenseKey,
        channel_product_no: String(channelProductNo),
        cost: Math.round(cost),
        updated_at: now,
      };
      const name = it?.productName ?? it?.product_name;
      if (name != null) row.product_name = String(name);
      rows.push(row);
    }

    if (!rows.length) {
      return fail(res, 400, "INVALID_INPUT", "유효한 항목이 없습니다 (channelProductNo/cost 확인).");
    }

    await sbUpsert("navone_product_cost", rows, "license_key,channel_product_no");

    return res.status(200).json({ success: true, saved: rows.length });
  } catch (err) {
    console.error("[product/cost-bulk]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "COST_BULK_FAILED", err.message || "서버 오류", err.detail);
  }
}
