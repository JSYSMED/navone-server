// =============================================
// NavOne — GET /api/group/suggest
// 그룹화 가능한 상품 후보 리스트 반환 (AI 추천).
// 같은 카테고리 + 유사 상품명 → 묶을 수 있는 그룹 제안.
//   Query: licenseKey(필수), ai("0"이면 AI 검증 생략, 기본 사용)
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import { getStoreByLicense, suggestGroups } from "../../lib/group-products.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    const { licenseKey, ai } = req.query || {};
    const useAI = !(ai === "0" || ai === "false");

    const store = await getStoreByLicense(licenseKey);
    const { scanned, candidates } = await suggestGroups(store, { useAI });

    return res.status(200).json({
      success: true,
      data: {
        storeName: store.storeName,
        scanned,
        count: candidates.length,
        candidates,
      },
    });
  } catch (err) {
    console.error("[group/suggest]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "GROUP_SUGGEST_FAILED", err.message || "서버 오류", err.detail);
  }
}
