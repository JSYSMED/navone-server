// =============================================
// NavOne Vercel API — /api/settlement/sync
// 수동 정산 데이터 동기화 트리거. 네이버 정산 API → navone_settlements upsert.
//
//   POST /api/settlement/sync
//   body: { licenseKey, start?: YYYY-MM-DD, end?: YYYY-MM-DD }
//   응답: { success: true, data: { upserted, skipped, range } }
//
// 멱등성: (store_id, settlement_date, product_order_id) 유니크 키로 upsert.
//   product_order_id 없는 항목(집계성 정산 등)은 skip 카운트만.
// =============================================

import { setCors, handlePreflight, assertEnv, sbSelect, sbUpsert } from "../../lib/supabase.js";
import { commerceRequest } from "../../lib/commerce-auth.js";
import { extractSettlementItems, normalizeSettlementRow, fail, sendFail } from "../../lib/settlement.js";

function defaultRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    assertEnv();
    const { licenseKey, start: bStart, end: bEnd } = req.body || {};
    if (!licenseKey) return fail(res, 400, "MISSING_LICENSE", "licenseKey는 필수입니다.");

    const def = defaultRange();
    const start = bStart || def.start;
    const end = bEnd || def.end;

    const stores = await sbSelect(
      "stores",
      "license_key=eq." + encodeURIComponent(licenseKey) + "&select=id,client_id,client_secret&limit=1"
    );
    const store = Array.isArray(stores) && stores.length ? stores[0] : null;
    if (!store) return fail(res, 404, "STORE_NOT_FOUND", "등록된 스토어가 없습니다.");
    if (!store.client_id || !store.client_secret) {
      return fail(res, 400, "NO_COMMERCE_CRED", "커머스 API 인증 정보(client_id/secret)가 없습니다.");
    }

    // commerceRequest 내부에 RPS 가드(초당 2회 이하)가 있어 별도 throttle 불필요.
    const raw = await commerceRequest("/external/v1/pay-order/seller/settlements/daily", {
      clientId: store.client_id,
      clientSecret: store.client_secret,
      method: "GET",
      query: { startDate: start, endDate: end },
    });

    const items = extractSettlementItems(raw);
    const rows = items.map((it) => normalizeSettlementRow(it, store.id));

    // 유니크 키 구성요소(settlement_date, product_order_id)가 모두 있는 행만 upsert.
    const upsertable = rows.filter((r) => r.settlement_date && r.product_order_id);
    const skipped = rows.length - upsertable.length;

    let upserted = 0;
    if (upsertable.length) {
      // Supabase REST 는 배열 본문으로 일괄 upsert 가능.
      const result = await sbUpsert("navone_settlements", upsertable, "store_id,settlement_date,product_order_id");
      upserted = Array.isArray(result) ? result.length : upsertable.length;
    }

    return res.status(200).json({
      success: true,
      data: { upserted, skipped, fetched: rows.length, range: { start, end } },
    });
  } catch (err) {
    return sendFail(res, err);
  }
}
