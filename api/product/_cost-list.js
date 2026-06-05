// =============================================
// NavOne — GET /api/product/cost-list
// 전체 상품(커머스 API) + 저장된 원가(navone_product_cost) 머지.
//   Query: licenseKey(필수)
//   응답: { success, storeName, count, costConfigured, products: [
//            { channelProductNo, productName, category, salePrice, cost|null }, ... ] }
//
// 상품 조회는 lib/group-products.js 의 fetchAllProducts 재활용(판매중 SALE 기준).
//
// 전제 테이블 (Supabase SQL):
//   create table navone_product_cost (
//     license_key        text        not null,
//     channel_product_no text        not null,
//     product_name       text,
//     cost               integer     not null default 0,
//     updated_at         timestamptz not null default now(),
//     primary key (license_key, channel_product_no)
//   );
//   create index on navone_product_cost (license_key);
// =============================================

import { setCors, handlePreflight, assertEnv, sbSelect } from "../../lib/supabase.js";
import { getStoreByLicense, fetchAllProducts } from "../../lib/group-products.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    assertEnv();
    const { licenseKey } = req.query || {};

    const store = await getStoreByLicense(licenseKey);
    const products = await fetchAllProducts(store);

    // 저장된 원가 전부 조회 → channel_product_no → cost 맵.
    const costRows = await sbSelect(
      "navone_product_cost",
      "license_key=eq." + encodeURIComponent(licenseKey) +
        "&select=channel_product_no,cost&limit=10000"
    );
    const costMap = new Map();
    for (const r of costRows || []) {
      const cost = Number(r.cost);
      if (!isNaN(cost)) costMap.set(String(r.channel_product_no), cost);
    }

    const merged = products.map((p) => {
      const channelProductNo = String(p.productNo);
      const cost = costMap.has(channelProductNo) ? costMap.get(channelProductNo) : null;
      return {
        channelProductNo,
        productName: p.name,
        category: p.category,
        salePrice: p.salePrice,
        cost,
      };
    });

    const costConfigured = merged.filter((p) => p.cost != null).length;

    return res.status(200).json({
      success: true,
      storeName: store.storeName,
      count: merged.length,
      costConfigured,
      products: merged,
    });
  } catch (err) {
    console.error("[product/cost-list]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "COST_LIST_FAILED", err.message || "서버 오류", err.detail);
  }
}
