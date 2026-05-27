// =============================================
// NavOne Vercel API — POST /api/inquiry/ai-answer
// 고객문의 AI 답변 초안 생성 (등록 안 함). GPT-4o-mini.
//
// body: {
//   inquiry: { content, productName, type },
//   storeContext: { storeName, tone, customPrompt },
//   licenseKey
// }
// response: { reply, model, tokens: { input, output } }
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import { generateInquiryAnswer } from "../../lib/inquiry.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    const { inquiry, storeContext } = req.body || {};
    if (!inquiry?.content || !storeContext?.storeName) {
      return res.status(400).json({ error: "문의 내용과 스토어명은 필수입니다." });
    }

    const out = await generateInquiryAnswer({ inquiry, storeContext });
    return res.status(200).json(out);
  } catch (err) {
    const status = err.status || 500;
    console.error("inquiry/ai-answer error:", status, err.message, err.detail);
    return res.status(status).json({ error: err.message, detail: err.detail });
  }
}
