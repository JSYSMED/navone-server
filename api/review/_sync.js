// =============================================
// NavOne — POST /api/review/sync
// 확장(content_review.js)이 DOM에서 긁은 미답글 리뷰를 저장한다.
//   Body: { licenseKey(필수), reviews: [{ reviewId(필수), channelProductNo, productName,
//                                          rating, content, date }, ...] }
//   응답: { success: true, synced: <건수>, newCount: <신규 건수> }
//
// navone_review 에 upsert (license_key + review_id 충돌 시 내용/별점만 갱신).
//   reply_status / reply_text / replied_at 은 row 에서 제외 → 기존 답글 상태 보존
//   (이미 replied 면 유지, 신규는 컬럼 default 'pending').
// =============================================

import { setCors, handlePreflight, assertEnv, sbSelect, sbUpsert } from "../../lib/supabase.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    assertEnv();
    const { licenseKey, reviews } = req.body || {};
    if (!licenseKey) return fail(res, 400, "MISSING_LICENSE", "licenseKey는 필수입니다.");
    if (!Array.isArray(reviews) || !reviews.length) {
      return fail(res, 400, "INVALID_INPUT", "reviews는 1개 이상의 배열이어야 합니다.");
    }

    const now = new Date().toISOString();
    const rows = [];
    for (const rv of reviews) {
      const reviewId = rv?.reviewId ?? rv?.review_id;
      if (reviewId == null || reviewId === "") continue;

      const ratingRaw = rv?.rating;
      const ratingNum = ratingRaw == null || ratingRaw === "" ? null : Number(ratingRaw);

      const channelProductNo = rv?.channelProductNo ?? rv?.channel_product_no;
      const productName = rv?.productName ?? rv?.product_name;
      const reviewDate = rv?.date ?? rv?.reviewDate ?? rv?.review_date;

      rows.push({
        license_key: licenseKey,
        review_id: String(reviewId),
        channel_product_no: channelProductNo != null ? String(channelProductNo) : null,
        product_name: productName != null ? String(productName) : null,
        rating: ratingNum != null && !isNaN(ratingNum) ? Math.round(ratingNum) : null,
        content: rv?.content != null ? String(rv.content) : null,
        review_date: reviewDate != null ? String(reviewDate) : null,
        updated_at: now,
      });
    }

    if (!rows.length) {
      return fail(res, 400, "INVALID_INPUT", "유효한 리뷰가 없습니다 (reviewId 확인).");
    }

    // 신규 건수 산정: 이번에 들어온 review_id 중 기존에 없던 것.
    const inList = rows
      .map((r) => encodeURIComponent(`"${r.review_id}"`))
      .join(",");
    const existing = await sbSelect(
      "navone_review",
      "license_key=eq." + encodeURIComponent(licenseKey) +
        "&review_id=in.(" + inList + ")&select=review_id&limit=" + rows.length
    );
    const existingSet = new Set((existing || []).map((r) => String(r.review_id)));
    const newCount = rows.filter((r) => !existingSet.has(r.review_id)).length;

    await sbUpsert("navone_review", rows, "license_key,review_id");

    return res.status(200).json({ success: true, synced: rows.length, newCount });
  } catch (err) {
    console.error("[review/sync]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "REVIEW_SYNC_FAILED", err.message || "서버 오류", err.detail);
  }
}
