// =============================================
// CommerOne — /api/automation/config  (GET + POST, app.all)
//
// GET  — 확장이 1분마다 폴링해서 자동화 설정을 읽음. 실행 시간 판정은 확장이 함.
//   Query: licenseKey(필수)
//   응답: { success, config: { enabled, intervalMinutes, testMode, runNow, lastRunAt } }
//
// POST — 두 호출자:
//   1) 대시보드: 설정 저장. Body: { licenseKey, enabled?, intervalMinutes?, testMode?, runNow? }
//   2) 확장: 실행 직후 보고. Body: { licenseKey, markRun: true } → last_run_at=now, run_now=false
//   응답: { success, config: {...} }
//
// 부분 업데이트(보낸 필드만). license_key 기준 upsert. 행 없으면 기본값(비활성).
//
// 전제 테이블 (Supabase SQL):
//   create table navone_automation_config (
//     license_key      text        primary key,
//     enabled          boolean     not null default false,
//     interval_minutes integer     not null default 60,
//     test_mode        boolean     not null default true,
//     run_now          boolean     not null default false,
//     last_run_at      timestamptz,
//     updated_at       timestamptz not null default now()
//   );
// =============================================

import { setCors, assertEnv, sbSelect, sbUpsert } from "../../lib/supabase.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

function toConfig(r) {
  if (!r) return { enabled: false, intervalMinutes: 60, testMode: true, runNow: false, lastRunAt: null };
  return {
    enabled: !!r.enabled,
    intervalMinutes: Number(r.interval_minutes) || 60,
    testMode: !!r.test_mode,
    runNow: !!r.run_now,
    lastRunAt: r.last_run_at || null,
  };
}

async function readRow(licenseKey) {
  const rows = await sbSelect(
    "navone_automation_config",
    "license_key=eq." + encodeURIComponent(licenseKey) +
      "&select=enabled,interval_minutes,test_mode,run_now,last_run_at&limit=1"
  );
  return (rows && rows[0]) || null;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    assertEnv();

    if (req.method === "GET") {
      const { licenseKey } = req.query || {};
      if (!licenseKey) return fail(res, 400, "MISSING_LICENSE", "licenseKey는 필수입니다.");
      const r = await readRow(licenseKey);
      return res.status(200).json({ success: true, config: toConfig(r) });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const { licenseKey } = body;
      if (!licenseKey) return fail(res, 400, "MISSING_LICENSE", "licenseKey는 필수입니다.");

      const cur = (await readRow(licenseKey)) || {
        enabled: false, interval_minutes: 60, test_mode: true, run_now: false, last_run_at: null,
      };
      const now = new Date().toISOString();
      const row = {
        license_key: licenseKey,
        enabled: cur.enabled,
        interval_minutes: cur.interval_minutes,
        test_mode: cur.test_mode,
        run_now: cur.run_now,
        last_run_at: cur.last_run_at,
        updated_at: now,
      };

      if (body.markRun === true) {
        row.last_run_at = now;
        row.run_now = false;
      } else {
        if (typeof body.enabled === "boolean") row.enabled = body.enabled;
        if (body.intervalMinutes != null && !isNaN(Number(body.intervalMinutes))) {
          row.interval_minutes = Math.max(1, Math.round(Number(body.intervalMinutes)));
        }
        if (typeof body.testMode === "boolean") row.test_mode = body.testMode;
        if (typeof body.runNow === "boolean") row.run_now = body.runNow;
      }

      await sbUpsert("navone_automation_config", row, "license_key");
      return res.status(200).json({ success: true, config: toConfig(row) });
    }

    return fail(res, 405, "METHOD_NOT_ALLOWED", "GET 또는 POST만 지원합니다.");
  } catch (err) {
    console.error("[automation/config]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "AUTOMATION_CONFIG_FAILED", err.message || "서버 오류", err.detail);
  }
}
