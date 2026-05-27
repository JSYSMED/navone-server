// =============================================
// NavOne Vercel API — POST /api/qa/ai-answer
// 단건 상품 Q&A AI 답변 생성 + 커머스 등록.
//   Body: { licenseKey(필수), inquiryId(필수) }
// =============================================

import { setCors, handlePreflight, assertEnv, sendError } from "../../lib/supabase.js";
import { getStoreByLicense, answerOneQa } from "../../lib/qa-reply.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    assertEnv();
    const { licenseKey, inquiryId } = req.body || {};
    if (!inquiryId) {
      return res.status(400).json({ success: false, error: "inquiryId는 필수입니다." });
    }

    const store = await getStoreByLicense(licenseKey);
    const out = await answerOneQa(store, inquiryId);

    return res.status(200).json({ success: true, data: { storeName: store.storeName, ...out } });
  } catch (err) {
    return sendError(res, err);
  }
}
