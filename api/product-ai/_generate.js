// =============================================
// NavOne — POST /api/product-ai/generate
// AI 상품설명 생성 (적용은 안 함, 미리보기만)
//   body: { licenseKey(필수), originProductNo(필수) }
//   response: { success, data: { originProductNo, productName, description, tokens } }
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import { getStoreByLicense, generateDescription } from "../../lib/product-optimizer.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    const { licenseKey, originProductNo } = req.body || {};
    if (!originProductNo) {
      return res.status(400).json({ error: "originProductNo는 필수입니다." });
    }

    const store = await getStoreByLicense(licenseKey);
    const result = await generateDescription({ store, originProductNo });

    return res.status(200).json({ success: true, storeName: store.storeName, data: result });
  } catch (err) {
    const status = err.status || 500;
    console.error("[product-ai/generate]", status, err.message, err.detail);
    return res.status(status).json({ error: err.message, detail: err.detail });
  }
}
