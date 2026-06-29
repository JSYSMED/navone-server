// =============================================
// NavOne — POST /api/product-ai/detail-generate
// 상세페이지 생성 (등록정보→검증사실→카피→연출컷→HTML)
//   body: { desc, template(기본 "point_dark"), image(dataURI) }
//   response: { profile, registration, html, genLog }
//   파이프라인은 lab/app.py 의 /api/generate 와 동일 순서.
//   연출컷은 순차 생성(병렬 금지 — Gemini rate limit).
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import {
  estimateRegistration, validateRegistration, analyze,
  imageBriefs, scene, renderTemplate,
} from "../../lib/detail-generator.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST만 허용됩니다." });
  }

  try {
    const { desc, template, image } = req.body || {};
    const tpl = template || "point_dark";
    const productImg = image; // 제품 사진 1장 (data URI)
    const d = desc || "";

    // 1) 등록정보 추출 → 검증
    const reg = await estimateRegistration(d, productImg);
    reg.missing = validateRegistration(reg);

    // 2) verifiedFacts 구성: 상품명/카테고리 + 고시값(있는 것, 한글키) + 원산지
    const vf = {};
    const ai = reg.ai_estimated || {};
    vf["상품명"] = ai.name;
    vf["카테고리"] = ai.categoryPath;
    const labels = reg._notice_labels || {};
    for (const [k, cell] of Object.entries(reg.seller_required?.notice || {})) {
      const val = cell && typeof cell === "object" ? cell.value : cell;
      if (val) vf[labels[k] || k] = val;
    }
    const org = reg.seller_required?.origin;
    if (org && typeof org === "object" && org.value) vf["원산지"] = org.value;

    // 3) 분석 → product_profile (검증된 사실 안에서만 카피)
    const prof = await analyze(d, tpl, productImg, vf);

    // 4) 슬롯별 연출컷 명세
    const briefs = imageBriefs(tpl, prof.detail);

    // 5) 각 brief마다 scene() → imgs[] (순차, 실패 시 원본으로 폴백)
    const imgs = [];
    const genLog = [];
    if (productImg && briefs.length) {
      for (let i = 0; i < briefs.length; i++) {
        const brief = briefs[i];
        try {
          imgs.push(await scene(productImg, brief || "깨끗한 스튜디오 배경에 제품 단독 배치"));
          genLog.push({ slot: i + 1, brief, ok: true });
        } catch (ie) {
          imgs.push(productImg); // 실패 시 원본 제품사진으로 폴백
          genLog.push({ slot: i + 1, brief, ok: false, err: ie.message });
        }
      }
    } else if (productImg) {
      imgs.push(productImg); // 이미지 슬롯 없거나 brief 없으면 원본 1장
    }

    // 6) 렌더
    const html = renderTemplate(tpl, prof.detail, imgs);

    // 7) 응답
    return res.status(200).json({ profile: prof, registration: reg, html, genLog });
  } catch (err) {
    const status = err.status || 500;
    console.error("[product-ai/detail-generate]", status, err.message, err.detail);
    return res.status(status).json({ error: err.message, detail: err.detail });
  }
}
