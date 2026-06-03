// =============================================
// NavOne Vercel API — /api/settlement/daily
// 네이버 커머스 정산 API 호출 → 일별 정산 내역 반환 (조회 전용, DB 저장 안 함)
//
//   GET /api/settlement/daily?licenseKey=...&start=YYYY-MM-DD&end=YYYY-MM-DD
//   응답: { success: true, data: { rows, daily, range } }
//
// Commerce API: GET /external/v1/pay-settle/settle/daily (startDate, endDate, pageNumber, pageSize)
// =============================================

import { setCors, handlePreflight, assertEnv, sbSelect } from "../../lib/supabase.js";
import { commerceRequest } from "../../lib/commerce-auth.js";
import { extractSettlementItems, normalizeDailyRow, aggregateDaily, fail, sendFail } from "../../lib/settlement.js";

// 기본 조회 범위: 최근 30일.
function defaultRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    assertEnv();
    const { licenseKey } = req.query || {};
    if (!licenseKey) return fail(res, 400, "MISSING_LICENSE", "licenseKey는 필수입니다.");

    const def = defaultRange();
    const start = req.query.start || def.start;
    const end = req.query.end || def.end;

    const stores = await sbSelect(
      "stores",
      "license_key=eq." + encodeURIComponent(licenseKey) + "&select=id,client_id,client_secret&limit=1"
    );
    const store = Array.isArray(stores) && stores.length ? stores[0] : null;
    if (!store) return fail(res, 404, "STORE_NOT_FOUND", "등록된 스토어가 없습니다.");
    if (!store.client_id || !store.client_secret) {
      return fail(res, 400, "NO_COMMERCE_CRED", "커머스 API 인증 정보(client_id/secret)가 없습니다.");
    }

    // 일별 정산 내역 조회: GET /external/v1/pay-settle/settle/daily
    // 필수 파라미터: startDate, endDate, pageNumber, pageSize(1000 이하)
    // 응답: { elements: [...일별 집계...], pagination: { page, size, totalPages, totalElements } }
    const raw = await commerceRequest("/external/v1/pay-settle/settle/daily", {
      clientId: store.client_id,
      clientSecret: store.client_secret,
      method: "GET",
      query: { startDate: start, endDate: end, pageNumber: 1, pageSize: 1000 },
    });

    const items = extractSettlementItems(raw);
    const rows = items.map((it) => normalizeDailyRow(it, store.id));
    const daily = aggregateDaily(rows);

    return res.status(200).json({
      success: true,
      data: { rows, daily, range: { start, end }, count: rows.length },
    });
  } catch (err) {
    return sendFail(res, err);
  }
}
