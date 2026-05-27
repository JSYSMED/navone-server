// =============================================
// NavOne Vercel API — /api/penalty/history.js
// 과거 리스크 스캔 결과 조회
//   GET /api/penalty/history[?licenseKey=...&limit=30]
// =============================================

import {
  setCors, handlePreflight, assertEnv,
  sbSelect, getStoreIdByLicense, sendError,
} from "../../lib/supabase.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    assertEnv();
    const { licenseKey, limit } = req.query || {};
    const lim = Math.min(parseInt(limit, 10) || 30, 100);

    let query = `select=*&order=scanned_at.desc&limit=${lim}`;
    if (licenseKey) {
      const storeId = await getStoreIdByLicense(licenseKey);
      if (!storeId) {
        return res.status(404).json({
          success: false,
          error: { code: "STORE_NOT_FOUND", message: "등록된 스토어가 없습니다." },
        });
      }
      query += `&store_id=eq.${storeId}`;
    }

    const data = await sbSelect("navone_penalty_alerts", query);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendError(res, err);
  }
}
