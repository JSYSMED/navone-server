// =============================================
// NavOne — POST /api/group/create
// 선택한 상품들로 그룹상품 등록.
//   Body: { licenseKey(필수), productNos: string[](필수, 2개 이상), groupName?(선택) }
// 커머스 API: POST /v2/standard-group-products
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import { getStoreByLicense, registerGroupProduct } from "../../lib/group-products.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    const { licenseKey, productNos, groupName } = req.body || {};

    if (!Array.isArray(productNos) || productNos.length < 2) {
      return fail(res, 400, "INVALID_INPUT", "productNos는 2개 이상의 배열이어야 합니다.");
    }

    const store = await getStoreByLicense(licenseKey);
    const result = await registerGroupProduct(store, { groupName, productNos });

    return res.status(200).json({
      success: true,
      data: { storeName: store.storeName, ...result },
    });
  } catch (err) {
    console.error("[group/create]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "GROUP_CREATE_FAILED", err.message || "서버 오류", err.detail);
  }
}
