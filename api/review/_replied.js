// =============================================
// NavOne — PATCH /api/review/replied
// 확장(background.js)이 답글 등록(submitReply) 성공 시 호출 → 상태 갱신.
//   Body: { licenseKey(필수), reviewId(필수), replyText }
//   응답: { success: true }
//
// navone_review 단건 upsert (license_key + review_id 충돌 시 갱신).
//   reply_status='replied', reply_text, replied_at=now() 만 갱신 →
//   content/rating 등 기존 내용은 보존(SET 절에 미포함). 답글 단 리뷰는
//   대시보드 "미답글(pending)" 목록에서 자동 제외된다.
// =============================================

import { setCors, handlePreflight, assertEnv, sbUpsert } from "../../lib/supabase.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

export default async function handler(req, res) {
  setCors(res);
  // PATCH 프리플라이트 대응 — 공유 setCors 가 GET/POST 만 광고하므로 보강.
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  if (handlePreflight(req, res, "PATCH")) return;

  try {
    assertEnv();
    const { licenseKey, reviewId, replyText } = req.body || {};
    if (!licenseKey) return fail(res, 400, "MISSING_LICENSE", "licenseKey는 필수입니다.");
    if (reviewId == null || reviewId === "") {
      return fail(res, 400, "INVALID_INPUT", "reviewId는 필수입니다.");
    }

    const now = new Date().toISOString();
    const row = {
      license_key: licenseKey,
      review_id: String(reviewId),
      reply_status: "replied",
      reply_text: replyText != null ? String(replyText) : null,
      replied_at: now,
      updated_at: now,
    };

    await sbUpsert("navone_review", row, "license_key,review_id");

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[review/replied]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "REVIEW_REPLIED_FAILED", err.message || "서버 오류", err.detail);
  }
}
