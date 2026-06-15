// =============================================
// 자사 배송비 API 경로 검증 (Café24 서버에서 실행)
// deliveryInfo.deliveryFee 구조를 실제 응답으로 확인 →
// 현재 코드 경로(di.baseFee)와 올바른 경로(di.deliveryFee.baseFee)를 나란히 비교.
//
// 실행:
//   cd ~/navone-server
//   node verify-delivery.mjs
//   (Supabase env가 .env.local에만 있고 PM2로 안 떠있으면:)
//   export $(grep -v '^#' .env.local | xargs) && node verify-delivery.mjs
//
//   상품 개수 조정: N=10 node verify-delivery.mjs
//   다른 스토어:   LICENSE_KEY=XXX node verify-delivery.mjs
// =============================================
import { commerceRequest } from "./lib/commerce-auth.js";
import { getStoreByLicense, listProducts } from "./lib/product-optimizer.js";

const LICENSE_KEY = process.env.LICENSE_KEY || "NAVONE-TEST-001";
const N = parseInt(process.env.N, 10) || 5;

async function main() {
  const store = await getStoreByLicense(LICENSE_KEY);
  console.log("store:", store.storeName, "\n");

  const products = await listProducts(store, { size: N });
  console.log(`상품 ${products.length}개 조회\n`);

  for (const p of products) {
    let raw;
    try {
      raw = await commerceRequest(
        `/external/v2/products/origin-products/${p.originProductNo}`,
        { clientId: store.clientId, clientSecret: store.clientSecret }
      );
    } catch (e) {
      console.log(`✗ ${p.name}: ${e.status} ${e.message}`);
      continue;
    }

    const op = raw?.originProduct || {};
    const di = op.deliveryInfo;       // 현재 코드가 멈추는 지점
    const df = di?.deliveryFee;       // 한 단계 더 — 진짜 배송비가 있는 곳

    console.log("─".repeat(54));
    console.log("상품   :", p.name, `(${p.originProductNo})`);
    console.log("salePrice:", op.salePrice);
    console.log("deliveryFee 객체 =", JSON.stringify(df, null, 2));
    console.log("");
    console.log("  [현재 코드 경로] di.deliveryFeeType =", di?.deliveryFeeType,
                "| di.baseFee =", di?.baseFee);
    console.log("  [올바른 경로]    df.deliveryFeeType =", df?.deliveryFeeType,
                "| df.baseFee =", df?.baseFee);
  }
  console.log("─".repeat(54));
}

main().catch((e) => {
  console.error("실패:", e.status || "", e.message);
  if (e.detail) console.error("detail:", JSON.stringify(e.detail));
  process.exit(1);
});
