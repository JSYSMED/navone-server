// 그룹상품 목록 조회 경로 검증 (/external/v2 vs /external/v1)
import { commerceRequest } from "./lib/commerce-auth.js";
import { getStoreByLicense } from "./lib/qa-reply.js";
const LK = process.env.LICENSE_KEY || "NAVONE-TEST-001";
async function tryPath(label, path, store){
  try{
    const raw = await commerceRequest(path, {
      clientId:store.clientId, clientSecret:store.clientSecret, method:"GET",
      query:{ page:1, size:100 },
    });
    const items = raw?.contents || raw?.elements || raw?.groupProducts || (Array.isArray(raw)?raw:[]) || [];
    console.log(`  OK [${label}] ${path} → 200 / ${items.length}건`);
    if(items[0]) console.log("     첫 항목 키:", Object.keys(items[0]).join(", ").slice(0,160));
    return true;
  }catch(e){ console.log(`  X  [${label}] ${path} → ${e.status} ${e.message}`); return false; }
}
const store = await getStoreByLicense(LK);
console.log("store:", store.storeName, "\n경로 탐색:");
let ok = await tryPath("v2+external", "/external/v2/standard-group-products", store);
if(!ok) ok = await tryPath("v1+external", "/external/v1/standard-group-products", store);
if(!ok) ok = await tryPath("v2 no-external", "/v2/standard-group-products", store);
console.log(ok ? "\n→ 위 OK 경로가 정답" : "\n→ 다 실패, 문서 재확인 필요");
