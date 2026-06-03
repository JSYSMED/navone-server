// =============================================
// NavOne Vercel API — /api/settlement/commission-roi
// 수수료 외부유입 ROI 분석 (수수료 개편 대응).
//
//   GET /api/settlement/commission-roi?licenseKey=...&start=YYYY-MM-DD&end=YYYY-MM-DD
//   응답: { success, data: { range, ...analyzeInflowRoi 결과 } }
//
//   수수료 상세 내역 조회(/external/v1/pay-settle/settle/commission-details) 사용.
//   - 건별과 동일하게 searchDate(단일 일자) 기준 → 기간을 하루씩 돌며 수집.
//   - sellingInterlockCommissionType으로 내부유입(PLT_SMART_STORE) vs
//     외부유입(PLF_SMART_STORE_MARKETING) 비중을 역산.
//   - "외부유입 전환 시 절약액" 시뮬레이션 제공.
// =============================================

import { setCors, handlePreflight, assertEnv, sbSelect } from "../../lib/supabase.js";
import { commerceRequest } from "../../lib/commerce-auth.js";
import { analyzeInflowRoi, fail, sendFail } from "../../lib/settlement.js";

function defaultRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

function extractItems(raw) {
  if (Array.isArray(raw)) return raw;
  return raw?.elements || raw?.contents || raw?.items || raw?.data || [];
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
      return fail(res, 400, "NO_COMMERCE_CRED", "커머스 API 인증 정보가 없습니다.");
    }

    // 기간을 하루씩 돌며 수수료 상세 수집 (commission-details는 searchDate 단위).
    const dayList = [];
    {
      const s = new Date(start + "T00:00:00");
      const e = new Date(end + "T00:00:00");
      for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
        dayList.push(d.toISOString().slice(0, 10));
      }
    }

    const allItems = [];
    for (const day of dayList) {
      const raw = await commerceRequest("/external/v1/pay-settle/settle/commission-details", {
        clientId: store.client_id,
        clientSecret: store.client_secret,
        method: "GET",
        query: {
          periodType: "SETTLE_CASEBYCASE_SETTLE_BASIS_DATE",
          searchDate: day,
          pageNumber: 1,
          pageSize: 1000,
        },
      });
      allItems.push(...extractItems(raw));
    }

    const analysis = analyzeInflowRoi(allItems);

    return res.status(200).json({
      success: true,
      data: {
        range: { start, end },
        sampleCount: allItems.length,
        ...analysis,
      },
    });
  } catch (err) {
    return sendFail(res, err);
  }
}
