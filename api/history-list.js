// =============================================
// NavOne Vercel API — /api/history-list.js
// 이력 목록 조회 (type별 테이블, created_at DESC, 페이지네이션)
// =============================================

import {
  setCors, handlePreflight, assertEnv,
  HISTORY_TABLES, HISTORY_COLUMNS, getStoreIdByLicense, sbSelectWithCount, sendError,
} from "../lib/supabase.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    assertEnv();
    const { licenseKey, type } = req.query || {};
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    if (!licenseKey) return res.status(400).json({ error: "licenseKey는 필수입니다." });
    const table = HISTORY_TABLES[type];
    if (!table) return res.status(400).json({ error: "type은 price|review|cs 중 하나여야 합니다." });

    const storeId = await getStoreIdByLicense(licenseKey);
    if (!storeId) return res.status(404).json({ error: "등록된 스토어가 없습니다." });

    // 개별 컬럼만 명시적으로 select (store_id/created_at 포함)
    const selectCols = ["store_id", ...HISTORY_COLUMNS[type], "created_at"].join(",");
    const query =
      "store_id=eq." + encodeURIComponent(storeId) +
      "&select=" + selectCols +
      "&order=created_at.desc" +
      "&limit=" + limit +
      "&offset=" + offset;

    const { data, total } = await sbSelectWithCount(table, query);

    return res.status(200).json({ success: true, data, total, limit, offset });
  } catch (err) {
    return sendError(res, err);
  }
}
