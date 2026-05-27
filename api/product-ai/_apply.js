// =============================================
// NavOne — POST /api/product-ai/apply
// 커머스 API로 상품설명 실제 적용 (detailContent 교체 후 PUT)
//   body: { licenseKey(필수), originProductNo(필수), newDescription(필수) }
//   response: { success, data: { originProductNo } }
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import { getStoreByLicense, applyDescription } from "../../lib/product-optimizer.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    const { licenseKey, originProductNo, newDescription } = req.body || {};
    if (!originProductNo) {
      return res.status(400).json({ error: "originProductNo는 필수입니다." });
    }
    if (!newDescription || !newDescription.trim()) {
      return res.status(400).json({ error: "newDescription(상세설명)은 필수입니다." });
    }

    const store = await getStoreByLicense(licenseKey);
    const result = await applyDescription({ store, originProductNo, newDescription });

    return res.status(200).json({ success: true, storeName: store.storeName, data: result });
  } catch (err) {
    const status = err.status || 500;
    console.error("[product-ai/apply]", status, err.message, err.detail);
    return res.status(status).json({ error: err.message, detail: err.detail });
  }
}
