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

    // 마진율 랭킹은 "상품 단위" 데이터가 필요 → 건별 정산 내역 조회(/case) 사용.
    //  (일별 /daily은 날짜별 집계라 상품정보·product_order_id가 없어 마진 계산 불가)
    //  건별은 searchDate(단일 일자) 기준이라, 기간을 하루씩 돌며 수집한다.
    //  필수 파라미터: searchDate, pageNumber, pageSize(1000 이하).
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
      // commerceRequest 내부 RPS 가드(초당 2회 이하)가 있어 순차 호출로 충분.
      const raw = await commerceRequest("/external/v1/pay-settle/settle/case", {
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
      const dayItems = extractSettlementItems(raw);
      // 정산일이 응답에 없을 수 있으니 조회한 날짜를 주입(집계 키 보존).
      for (const it of dayItems) {
        if (!it.settleBasisDate) it.settleBasisDate = day;
      }
      allItems.push(...dayItems);
    }

    const items = allItems;
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
