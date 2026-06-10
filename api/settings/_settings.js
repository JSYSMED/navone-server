// =============================================
// CommerOne — /api/settings  (GET + POST, app.all)
// 대시보드 일반 설정(스토어명·카테고리·상세페이지·텔레그램 등)을 라이선스별로 저장.
// localStorage 대신 서버 저장 → 어느 기기/브라우저에서도 동일하게 보임.
//   GET  ?licenseKey=          → { success, settings: {...} }   (행 없으면 {})
//   POST { licenseKey, patch } → 부분 병합 저장 → { success, settings }
//
// 라이선스 키 자체는 "내가 누구인지" 기준이라 클라 localStorage 유지(여기 저장 안 함).
// Commerce API client_id/secret은 store-register에 별도 저장(여기 X).
//
// 전제 테이블 (Supabase SQL):
//   create table navone_settings (
//     license_key text        primary key,
//     settings    jsonb       not null default '{}',
//     updated_at  timestamptz not null default now()
//   );
// =============================================

import { setCors, assertEnv, sbSelect, sbUpsert } from "../../lib/supabase.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

async function readSettings(licenseKey) {
  const rows = await sbSelect(
    "navone_settings",
    "license_key=eq." + encodeURIComponent(licenseKey) + "&select=settings&limit=1"
  );
  return (rows && rows[0] && rows[0].settings) || {};
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    assertEnv();

    if (req.method === "GET") {
      const { licenseKey } = req.query || {};
      if (!licenseKey) return fail(res, 400, "MISSING_LICENSE", "licenseKey는 필수입니다.");
      const settings = await readSettings(licenseKey);
      return res.status(200).json({ success: true, settings });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const { licenseKey } = body;
      const patch = body.patch || body.settings || {};
      if (!licenseKey) return fail(res, 400, "MISSING_LICENSE", "licenseKey는 필수입니다.");
      if (typeof patch !== "object" || Array.isArray(patch)) {
        return fail(res, 400, "BAD_PATCH", "patch는 객체여야 합니다.");
      }
      const cur = await readSettings(licenseKey);
      const merged = { ...cur, ...patch };   // 부분 병합 (보낸 필드만 갱신)
      const now = new Date().toISOString();
      await sbUpsert("navone_settings", { license_key: licenseKey, settings: merged, updated_at: now }, "license_key");
      return res.status(200).json({ success: true, settings: merged });
    }

    return fail(res, 405, "METHOD_NOT_ALLOWED", "GET 또는 POST만 지원합니다.");
  } catch (err) {
    console.error("[settings]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "SETTINGS_FAILED", err.message || "서버 오류", err.detail);
  }
}
