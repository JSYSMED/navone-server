// =============================================
// NavOne Vercel API — GET /api/qa/list?licenseKey=...
// 미답변 상품 Q&A 목록 조회 (커머스 미답변 문의).
//   Query: licenseKey(필수), from(ISO8601, 선택), to(선택), page(선택), size(선택)
// =============================================

import { setCors, handlePreflight, assertEnv, sendError } from "../../lib/supabase.js";
import { getStoreByLicense, fetchUnansweredQa } from "../../lib/qa-reply.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    assertEnv();
    const { licenseKey, from, to, page, size } = req.query || {};

    const store = await getStoreByLicense(licenseKey);
    const { inquiries, total } = await fetchUnansweredQa(store, {
      from,
      to,
      page: page ? Number(page) : 1,
      size: size ? Number(size) : 50,
    });

    return res.status(200).json({
      success: true,
      data: {
        storeName: store.storeName,
        count: inquiries.length,
        total,
        inquiries,
      },
    });
  } catch (err) {
    return sendError(res, err);
  }
}
