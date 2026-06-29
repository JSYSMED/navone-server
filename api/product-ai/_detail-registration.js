// =============================================
// NavOne — POST /api/product-ai/detail-registration
// 등록정보 추정 (AI추정칸 + 셀러입력 필수칸 + 검증)
//   body: { desc, image(dataURI, optional) }   // licenseKey는 쿠키→자동주입
//   response: { ...reg, missing:[...] }
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import { estimateRegistration, validateRegistration } from "../../lib/detail-generator.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST만 허용됩니다." });
  }

  try {
    const { desc, image } = req.body || {};
    const reg = await estimateRegistration(desc || "", image);
    reg.missing = validateRegistration(reg);
    return res.status(200).json(reg);
  } catch (err) {
    const status = err.status || 500;
    console.error("[product-ai/detail-registration]", status, err.message, err.detail);
    return res.status(status).json({ error: err.message, detail: err.detail });
  }
}
