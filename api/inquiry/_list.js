// =============================================
// NavOne Vercel API — GET /api/inquiry/list?licenseKey=...
// 미답변 고객문의 목록 (커머스 API GET /external/v1/pay-user/inquiries, answered=false)
//
// 인증: licenseKey → store(client_id/secret) → 서버가 토큰 발급(qa·정산과 통일).
// 쿼리: licenseKey(필수), page, size, from, to (선택)
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import { fetchInquiries, getStoreByLicense } from "../../lib/inquiry.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    const q = req.query || {};
    const store = await getStoreByLicense(q.licenseKey);

    const page = parseInt(q.page, 10) || 1;
    const size = Math.min(parseInt(q.size, 10) || 50, 200);

    const result = await fetchInquiries({
      store, answered: false, page, size, from: q.from, to: q.to,
    });

    return res.status(200).json({ success: true, storeName: store.storeName, ...result });
  } catch (err) {
    const status = err.status || 500;
    console.error("inquiry/list error:", status, err.message, err.detail);
    return res.status(status).json({ error: err.message, detail: err.detail });
  }
}
