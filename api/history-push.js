// =============================================
// NavOne Vercel API — /api/history-push.js
// 이력 1건 적재 (type별 테이블에 INSERT)
// =============================================

import {
  setCors, handlePreflight, assertEnv,
  HISTORY_TABLES, buildHistoryRow, getStoreIdByLicense, sbInsert, sendError,
} from "../lib/supabase.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    assertEnv();
    const { licenseKey, type, data } = req.body || {};

    if (!licenseKey) return res.status(400).json({ error: "licenseKey는 필수입니다." });
    const table = HISTORY_TABLES[type];
    if (!table) return res.status(400).json({ error: "type은 price|review|cs 중 하나여야 합니다." });
    if (!data || typeof data !== "object") {
      return res.status(400).json({ error: "data 객체는 필수입니다." });
    }

    const storeId = await getStoreIdByLicense(licenseKey);
    if (!storeId) return res.status(404).json({ error: "등록된 스토어가 없습니다. 먼저 store-register 하세요." });

    // data의 필드를 해당 테이블의 실제 컬럼으로 매핑 (created_at은 DB default에 위임)
    const row = buildHistoryRow(type, data);
    if (Object.keys(row).length === 0) {
      return res.status(400).json({ error: "매핑 가능한 컬럼이 없습니다. data 필드명을 확인하세요." });
    }
    row.store_id = storeId;

    await sbInsert(table, row);

    return res.status(200).json({ success: true });
  } catch (err) {
    return sendError(res, err);
  }
}
