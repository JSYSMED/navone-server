// =============================================
// CommerOne — GET /api/catalog-map/list
// 저장된 catalog 매핑 조회. 커머스 API 안 거치고 순수 DB 조회(빠름).
//   Query: licenseKey(필수)
//   응답: { success, count, items: [{ channelProductNo, catalogId, productName, updatedAt }, ...] }
//
// DB 기반 주기 실행(3번)에서 이 목록을 받아 카탈로그 페이지 순회 없이
// catalog_id로 바로 상세페이지를 열어 파싱한다.
// =============================================

import { setCors, handlePreflight, assertEnv, sbSelect } from "../../lib/supabase.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    assertEnv();
    const { licenseKey } = req.query || {};
    if (!licenseKey) return fail(res, 400, "MISSING_LICENSE", "licenseKey는 필수입니다.");

    const rows = await sbSelect(
      "navone_catalog_map",
      "license_key=eq." + encodeURIComponent(licenseKey) +
        "&select=channel_product_no,catalog_id,product_name,updated_at&limit=50000"
    );

    const items = (rows || []).map((r) => ({
      channelProductNo: String(r.channel_product_no),
      catalogId: String(r.catalog_id),
      productName: r.product_name || null,
      updatedAt: r.updated_at || null,
    }));

    return res.status(200).json({ success: true, count: items.length, items });
  } catch (err) {
    console.error("[catalog-map/list]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "CATALOG_MAP_LIST_FAILED", err.message || "서버 오류", err.detail);
  }
}
