// =============================================
// NavOne — GET /api/product-ai/bulk-analyze
// 전체 상품 일괄 분석 (상위 50개, 휴리스틱 점수 기준 개선 우선순위 정렬)
//   Query: licenseKey(필수), limit(선택, 기본 50, 최대 50)
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import { getStoreByLicense, bulkAnalyze } from "../../lib/product-optimizer.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    const { licenseKey, limit } = req.query || {};
    const n = Math.min(parseInt(limit, 10) || 50, 50);

    const store = await getStoreByLicense(licenseKey);
    const result = await bulkAnalyze({ store, limit: n });

    return res.status(200).json({ success: true, storeName: store.storeName, data: result });
  } catch (err) {
    const status = err.status || 500;
    console.error("[product-ai/bulk-analyze]", status, err.message, err.detail);
    return res.status(status).json({ error: err.message, detail: err.detail });
  }
}
