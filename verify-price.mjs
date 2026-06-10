// =============================================
// 실제 판매가(즉시할인 적용) 검증 (Café24 서버에서 실행)
// salePrice(정가) vs channelProducts.discountedPrice(할인적용가) vs
// customerBenefit.immediateDiscountPolicy(할인정책)를 나란히 비교.
//
// 실행:
//   cd ~/navone-server
//   node verify-price.mjs
//   (env 필요시) export $(grep -v '^#' .env.local | xargs) && node verify-price.mjs
//   상품 개수: N=10 node verify-price.mjs
// =============================================
import { commerceRequest } from "./lib/commerce-auth.js";
import { getStoreByLicense } from "./lib/product-optimizer.js";

const LICENSE_KEY = process.env.LICENSE_KEY || "NAVONE-TEST-001";
const N = parseInt(process.env.N, 10) || 5;

async function main() {
  const store = await getStoreByLicense(LICENSE_KEY);
  const cred = { clientId: store.clientId, clientSecret: store.clientSecret };
  console.log("store:", store.storeName, "\n");

  // 1) 목록 조회 raw — channelProducts.discountedPrice 가 채워져 오는지 본다
  const searchRaw = await commerceRequest("/external/v1/products/search", {
    ...cred,
    method: "POST",
    body: { productStatusTypes: ["SALE"], page: 1, size: N, orderType: "NO" },
  });
  const list = searchRaw?.contents || searchRaw?.data || [];
  console.log(`상품 ${list.length}개\n`);

  for (const row of list) {
    const cp = row.channelProducts?.[0] || {};
    const originNo = String(row.originProductNo || cp.originProductNo || "");
    if (!originNo) continue;

    // 2) 상세 조회 — 즉시할인 정책(discountMethod) 위치 확인
    let disc = null, opSalePrice = null;
    try {
      const raw = await commerceRequest(
        `/external/v2/products/origin-products/${originNo}`, cred
      );
      const op = raw?.originProduct || {};
      opSalePrice = op.salePrice;
      disc = op.customerBenefit?.immediateDiscountPolicy || null;
    } catch (e) {
      console.log(`  (상세조회 실패: ${e.status} ${e.message})`);
    }

    console.log("─".repeat(54));
    console.log("상품:", cp.name || row.name);
    console.log("  salePrice(정가)            :", opSalePrice ?? cp.salePrice);
    console.log("  channelProducts.discountedPrice :", cp.discountedPrice, "  ← 채워져 오면 이걸 현재가로");
    console.log("  immediateDiscountPolicy   :", JSON.stringify(disc));
  }
  console.log("─".repeat(54));
  console.log("\n해석:");
  console.log("  · discountedPrice 에 39,800 같은 값이 오면 → 그대로 현재가로 사용");
  console.log("  · 비어있고 immediateDiscountPolicy.discountMethod 에 value/unitType 만 오면");
  console.log("    → 정액(WON): 현재가 = salePrice - value");
  console.log("    → 정률(PERCENT): 현재가 = salePrice * (1 - value/100)");
}

main().catch((e) => {
  console.error("실패:", e.status || "", e.message);
  if (e.detail) console.error("detail:", JSON.stringify(e.detail));
  process.exit(1);
});
