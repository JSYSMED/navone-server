// =============================================
// NavOne — GET /api/review/list
// 대시보드(Customer.jsx 리뷰 탭)가 호출. 저장된 리뷰를 상태별로 조회.
//   Query: licenseKey(필수), status(pending|replied|all, 기본 pending), limit(기본 50)
//   응답: { success, count, reviews: [
//            { reviewId, productName, rating, content, reviewDate, replyStatus, replyText }, ... ] }
//
// navone_review 에서 license_key(+reply_status) 필터, review_date DESC.
// =============================================

import { setCors, handlePreflight, assertEnv, sbSelect } from "../../lib/supabase.js";

const ALLOWED_STATUS = new Set(["pending", "replied", "all"]);

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    assertEnv();
    const q = req.query || {};
    const licenseKey = q.licenseKey;
    if (!licenseKey) return fail(res, 400, "MISSING_LICENSE", "licenseKey는 필수입니다.");

    const status = ALLOWED_STATUS.has(q.status) ? q.status : "pending";
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 500);

    let query = "license_key=eq." + encodeURIComponent(licenseKey);
    if (status !== "all") query += "&reply_status=eq." + status;
    query +=
      "&select=review_id,product_name,rating,content,review_date,reply_status,reply_text" +
      "&order=review_date.desc&limit=" + limit;

    const rows = await sbSelect("navone_review", query);

    const reviews = (rows || []).map((r) => ({
      reviewId: r.review_id,
      productName: r.product_name,
      rating: r.rating,
      content: r.content,
      reviewDate: r.review_date,
      replyStatus: r.reply_status,
      replyText: r.reply_text,
    }));

    return res.status(200).json({ success: true, count: reviews.length, reviews });
  } catch (err) {
    console.error("[review/list]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "REVIEW_LIST_FAILED", err.message || "서버 오류", err.detail);
  }
}
