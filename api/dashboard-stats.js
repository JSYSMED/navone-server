// =============================================
// NavOne Vercel API — /api/dashboard-stats.js
// 대시보드 집계 (기간별 가격변경/리뷰답글/CS답변 건수)
// =============================================

import {
  setCors, handlePreflight, assertEnv,
  HISTORY_TABLES, getStoreIdByLicense, sbCount, sendError,
} from "../lib/supabase.js";

// period → 시작 시각(ISO). today=오늘 00:00 UTC, week=7일 전, month=30일 전.
function periodSince(period) {
  const now = new Date();
  if (period === "week") return new Date(now.getTime() - 7 * 86400000).toISOString();
  if (period === "month") return new Date(now.getTime() - 30 * 86400000).toISOString();
  // today (기본)
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    assertEnv();
    const { licenseKey } = req.query || {};
    const period = req.query.period || "today";
    if (!licenseKey) return res.status(400).json({ error: "licenseKey는 필수입니다." });

    const storeId = await getStoreIdByLicense(licenseKey);
    if (!storeId) return res.status(404).json({ error: "등록된 스토어가 없습니다." });

    const since = periodSince(period);
    const base =
      "store_id=eq." + encodeURIComponent(storeId) +
      "&created_at=gte." + encodeURIComponent(since);

    // 세 테이블 카운트 병렬 조회
    const [priceChanges, reviewReplies, csReplies] = await Promise.all([
      sbCount(HISTORY_TABLES.price, base),
      sbCount(HISTORY_TABLES.review, base),
      sbCount(HISTORY_TABLES.cs, base),
    ]);

    return res.status(200).json({
      success: true,
      stats: {
        priceChanges,
        reviewReplies,
        csReplies,
        total: priceChanges + reviewReplies + csReplies,
        period,
        since,
      },
    });
  } catch (err) {
    return sendError(res, err);
  }
}
