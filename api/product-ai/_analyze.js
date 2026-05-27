// =============================================
// NavOne — GET /api/product-ai/analyze
// 단일 상품 분석 (상품명 SEO 점수, AiTEMS 노출 점수, 속성 누락, AI 개선 추천)
//   Query: licenseKey(필수), originProductNo(필수)
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import { getStoreByLicense, analyzeProduct } from "../../lib/product-optimizer.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    const { licenseKey, originProductNo } = req.query || {};
    if (!originProductNo) {
      return res.status(400).json({ error: "originProductNo는 필수입니다." });
    }

    const store = await getStoreByLicense(licenseKey);
    const result = await analyzeProduct({ store, originProductNo });

    return res.status(200).json({ success: true, storeName: store.storeName, data: result });
  } catch (err) {
    const status = err.status || 500;
    console.error("[product-ai/analyze]", status, err.message, err.detail);
    return res.status(status).json({ error: err.message, detail: err.detail });
  }
}
