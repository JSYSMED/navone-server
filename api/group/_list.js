// =============================================
// NavOne — GET /api/group/list
// 현재 등록된 그룹상품 목록 조회.
//   Query: licenseKey(필수), page?(기본 1), size?(기본 100)
// 커머스 API: GET /v2/standard-group-products
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import { getStoreByLicense, listGroupProducts } from "../../lib/group-products.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    const { licenseKey, page, size } = req.query || {};

    const store = await getStoreByLicense(licenseKey);
    const result = await listGroupProducts(store, {
      page: Number(page) || 1,
      size: Number(size) || 100,
    });

    return res.status(200).json({
      success: true,
      data: { storeName: store.storeName, ...result },
    });
  } catch (err) {
    console.error("[group/list]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "GROUP_LIST_FAILED", err.message || "서버 오류", err.detail);
  }
}
