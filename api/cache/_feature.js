// =============================================
// CommerOne — /api/cache/feature  (GET + POST, app.all)
// 무거운 AI 결과(그룹추천·상품진단 등)를 feature별로 저장/조회하는 범용 캐시.
//   GET  ?licenseKey=&feature=group   → { success, cached: { result, updatedAt } | null }
//   POST { licenseKey, feature, result } → 저장 → { success, updatedAt }
//
// result는 화면이 그대로 쓰는 JSON 한 덩어리(이미지는 URL만 포함, 파일 저장 안 함).
// "다시 스캔/다시 진단"을 누를 때만 POST로 갱신 → content_hash 무효화 불필요(수동 갱신).
//
// 전제 테이블 (Supabase SQL):
//   create table navone_feature_cache (
//     license_key text        not null,
//     feature     text        not null,
//     result      jsonb       not null,
//     updated_at  timestamptz not null default now(),
//     primary key (license_key, feature)
//   );
// =============================================

import { setCors, assertEnv, sbSelect, sbUpsert } from "../../lib/supabase.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

const ALLOWED = ["group", "optimize"];  // 허용 feature (오타·남용 방지)

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    assertEnv();

    if (req.method === "GET") {
      const { licenseKey, feature } = req.query || {};
      if (!licenseKey || !feature) return fail(res, 400, "MISSING_PARAM", "licenseKey와 feature는 필수입니다.");
      if (!ALLOWED.includes(feature)) return fail(res, 400, "BAD_FEATURE", "허용되지 않은 feature입니다.");

      const rows = await sbSelect(
        "navone_feature_cache",
        "license_key=eq." + encodeURIComponent(licenseKey) +
          "&feature=eq." + encodeURIComponent(feature) +
          "&select=result,updated_at&limit=1"
      );
      const r = (rows && rows[0]) || null;
      return res.status(200).json({
        success: true,
        cached: r ? { result: r.result, updatedAt: r.updated_at } : null,
      });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const { licenseKey, feature, result } = body;
      if (!licenseKey || !feature) return fail(res, 400, "MISSING_PARAM", "licenseKey와 feature는 필수입니다.");
      if (!ALLOWED.includes(feature)) return fail(res, 400, "BAD_FEATURE", "허용되지 않은 feature입니다.");
      if (result == null) return fail(res, 400, "MISSING_RESULT", "result는 필수입니다.");

      const now = new Date().toISOString();
      await sbUpsert(
        "navone_feature_cache",
        { license_key: licenseKey, feature, result, updated_at: now },
        "license_key,feature"
      );
      return res.status(200).json({ success: true, updatedAt: now });
    }

    return fail(res, 405, "METHOD_NOT_ALLOWED", "GET 또는 POST만 지원합니다.");
  } catch (err) {
    console.error("[cache/feature]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "CACHE_FEATURE_FAILED", err.message || "서버 오류", err.detail);
  }
}
