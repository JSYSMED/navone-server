// 그룹상품 AI 추천(suggest) 검증 — 핵심 기능
// 1) 상품 전체 수집(/products/search) 2) 클러스터링(유사도) 3) (AI 끄고) 후보 확인
// 실행: export $(grep -v '^#' .env.local | xargs); node verify-group-suggest.mjs
//   AI까지 보려면 USE_AI=1 (OpenAI 비용 발생)
import { getStoreByLicense, fetchAllProducts, suggestGroups } from "./lib/group-products.js";
const LK = process.env.LICENSE_KEY || "NAVONE-TEST-001";
const USE_AI = process.env.USE_AI === "1";
function line(){ console.log("-".repeat(54)); }

const store = await getStoreByLicense(LK);
console.log("\n그룹상품 추천(suggest) 검증");
line();
console.log("store:", store.storeName);

// 1) 상품 수집만 먼저
console.log("\n1) 상품 전체 수집 (/external/v1/products/search)...");
const products = await fetchAllProducts(store, { size: 100, maxPages: 5 });
console.log("   수집 상품 수:", products.length);
if (products[0]) console.log("   샘플:", products[0].name, "| 번호:", products[0].productNo, "| 가격:", products[0].salePrice);
line();

// 2) 추천 (AI 옵션)
console.log(`2) 그룹 추천 (AI ${USE_AI ? "ON" : "OFF — 클러스터링만"})...`);
const result = await suggestGroups(store, { useAI: USE_AI, maxGroups: 10 });
console.log("   스캔:", result.scanned, "/ 추천 그룹:", result.candidates.length);
result.candidates.slice(0,5).forEach((c,i)=>{
  console.log(`   [${i+1}] ${c.groupName} (${c.products.length}개) - ${c.reason}`);
  c.products.slice(0,3).forEach(p=>console.log(`        · ${p.name}`));
});
line();
console.log(result.candidates.length>0 ? "검증 완료: 상품수집 + 그룹추천 흐름 정상 OK" : "추천 0건 — 묶을 유사상품이 없거나 임계값 높음(정상일 수 있음)");
