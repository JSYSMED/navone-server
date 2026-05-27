// =============================================
// NavOne Vercel API — POST /api/inquiry/submit
// 고객문의 답변 등록 (커머스 API POST /external/v1/pay-user/inquiries/{id}/answer)
//
// ★ 규칙: 답변 등록 전 반드시 로그(cs_history) 저장 → 그 다음 커머스 등록.
//
// body: {
//   inquiryId, content,
//   token,                 (또는 헤더 x-naver-token)
//   licenseKey,            (로그 적재용; 없으면 로그 best-effort 스킵)
//   inquiry: { productName, content },  (로그 보강용, 선택)
//   mode: "manual" | "auto"
// }
// =============================================

import {
  setCors, handlePreflight,
  HISTORY_TABLES, buildHistoryRow, getStoreIdByLicense, sbInsert,
} from "../../lib/supabase.js";
import { submitInquiryAnswer } from "../../lib/inquiry.js";

function readToken(req, body) {
  const h = req.headers || {};
  if (h["x-naver-token"]) return h["x-naver-token"];
  const auth = h["authorization"] || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7);
  return body.token || "";
}

// 등록 전 감사 로그 적재. Supabase 미설정/스토어 미등록 시에도 등록을 막지 않도록 best-effort.
async function logBeforeSubmit({ licenseKey, inquiryId, content, inquiry, mode }) {
  try {
    if (!licenseKey || !process.env.SUPABASE_URL) return { logged: false, reason: "licenseKey/Supabase 미설정" };
    const storeId = await getStoreIdByLicense(licenseKey);
    if (!storeId) return { logged: false, reason: "스토어 미등록" };

    const row = buildHistoryRow("cs", {
      product_name: inquiry?.productName || "",
      inquiry_content: inquiry?.content || "",
      generated_reply: content,
      final_reply: content,
      mode: mode || "manual",
    });
    row.store_id = storeId;
    await sbInsert(HISTORY_TABLES.cs, row);
    return { logged: true };
  } catch (e) {
    // 로그 실패가 등록을 막지 않음. 다만 응답에 표시.
    console.error("inquiry/submit 로그 적재 실패(무시):", e.message);
    return { logged: false, reason: e.message };
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    const body = req.body || {};
    const { inquiryId, content, licenseKey, inquiry, mode } = body;
    const token = readToken(req, body);

    if (!token) return res.status(401).json({ error: "커머스 토큰이 필요합니다." });
    if (!inquiryId) return res.status(400).json({ error: "inquiryId는 필수입니다." });
    if (!content || !content.trim()) return res.status(400).json({ error: "답변 내용은 필수입니다." });

    // 1) 등록 전 로그 저장 (규칙)
    const logResult = await logBeforeSubmit({ licenseKey, inquiryId, content, inquiry, mode });

    // 2) 커머스 답변 등록
    await submitInquiryAnswer({ token, inquiryId, content });

    return res.status(200).json({ success: true, logged: logResult.logged });
  } catch (err) {
    const status = err.status || 500;
    console.error("inquiry/submit error:", status, err.message, err.detail);
    return res.status(status).json({ error: err.message, detail: err.detail });
  }
}
