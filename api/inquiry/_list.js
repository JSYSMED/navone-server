// =============================================
// NavOne Vercel API — GET /api/inquiry/list
// 미답변 고객문의 목록 (커머스 API GET /external/v1/pay-user/inquiries, answered=false)
//
// 커머스 Bearer 토큰은 확장(background.js)에서 발급해 헤더로 전달:
//   x-naver-token: <accessToken>   (또는 Authorization: Bearer <accessToken>)
// 쿼리: page, size, from, to (선택)
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import { fetchInquiries } from "../../lib/inquiry.js";

function readToken(req) {
  const h = req.headers || {};
  if (h["x-naver-token"]) return h["x-naver-token"];
  const auth = h["authorization"] || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7);
  return "";
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    const token = readToken(req);
    if (!token) return res.status(401).json({ error: "커머스 토큰이 필요합니다. (x-naver-token 헤더)" });

    const q = req.query || {};
    const page = parseInt(q.page, 10) || 1;
    const size = Math.min(parseInt(q.size, 10) || 50, 200);

    const result = await fetchInquiries({
      token, answered: false, page, size, from: q.from, to: q.to,
    });

    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    const status = err.status || 500;
    console.error("inquiry/list error:", status, err.message, err.detail);
    return res.status(status).json({ error: err.message, detail: err.detail });
  }
}
