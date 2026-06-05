// =============================================
// NavOne 건별 정산(/case) 검증 — 마진율 랭킹용
// 파라미터 구조(searchDate vs startDate/endDate)를 실호출로 확인.
// 실행: export $(grep -v '^#' .env.local | xargs); node verify-case.mjs
// =============================================
import { commerceRequest } from "./lib/commerce-auth.js";
import { getStoreByLicense } from "./lib/qa-reply.js";
import { extractSettlementItems, normalizeSettlementRow } from "./lib/settlement.js";

const LICENSE_KEY = process.env.LICENSE_KEY || "NAVONE-TEST-001";
function line(){ console.log("-".repeat(54)); }
const iso = d => d.toISOString().slice(0,10);

async function tryCall(label, query, store) {
  try {
    const raw = await commerceRequest("/external/v1/pay-settle/settle/case", {
      clientId: store.clientId, clientSecret: store.clientSecret, method: "GET", query,
    });
    const items = extractSettlementItems(raw);
    console.log(`   OK [${label}] 200 / 항목 ${items.length}건`);
    return { ok:true, items, raw };
  } catch (e) {
    console.log(`   X  [${label}] ${e.status||""} ${e.message}`);
    if (e.detail) console.log("       상세:", JSON.stringify(e.detail).slice(0,180));
    return { ok:false };
  }
}

async function main(){
  console.log("\nNavOne 건별 정산(/case) 검증 - 마진율 랭킹용");
  line();
  if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_KEY){
    console.log("X Supabase 환경변수 누락. export $(grep -v '^#' .env.local | xargs) 먼저.\n"); process.exit(1);
  }
  const store = await getStoreByLicense(LICENSE_KEY);
  console.log("store:", store.storeName);
  line();

  const now=new Date(), monthAgo=new Date(now.getTime()-30*86400000);
  console.log("파라미터 구조 탐색 (어떤 게 200을 주는지):");

  // A) startDate/endDate 방식 (일별과 동일 가정)
  let r = await tryCall("startDate+endDate", {
    periodType:"SETTLE_CASEBYCASE_SETTLE_BASIS_DATE",
    startDate:iso(monthAgo), endDate:iso(now), pageNumber:1, pageSize:1000,
  }, store);

  // B) searchDate 단일 방식 (문서 표기)
  if(!r.ok || r.items.length===0){
    r = await tryCall("searchDate(단일일자)", {
      periodType:"SETTLE_CASEBYCASE_SETTLE_BASIS_DATE",
      searchDate:iso(now), pageNumber:1, pageSize:1000,
    }, store);
  }
  // C) 결제일 기준 며칠 전(데이터 있을 법한 날)
  if(!r.ok || r.items.length===0){
    const wk=new Date(now.getTime()-7*86400000);
    r = await tryCall("searchDate 7일전+PAY_DATE", {
      periodType:"SETTLE_CASEBYCASE_PAY_DATE",
      searchDate:iso(wk), pageNumber:1, pageSize:1000,
    }, store);
  }
  line();

  if(r.ok && r.items.length>0){
    console.log("매핑 검증 (첫 상품):");
    const row = normalizeSettlementRow(r.items[0], "verify");
    console.log("   원본 키:", Object.keys(r.items[0]).join(", ").slice(0,200));
    console.log("   - 상품명  :", row.product_name||"(없음)");
    console.log("   - 상품번호:", row.channel_product_no||"(없음)");
    console.log("   - 주문ID  :", row.product_order_id||"(없음)");
    console.log("   - 판매가  :", row.sales_amount?.toLocaleString());
    console.log("   - 수수료  :", row.commission_fee?.toLocaleString());
    console.log("   - 정산금  :", row.settlement_amount?.toLocaleString());
    const hasProduct = row.product_name || row.channel_product_no;
    console.log("\n   ", hasProduct ? "OK 상품 단위 데이터 확인 - 마진율 랭킹 가능" : "주의 상품정보 없음 - 필드 재확인");
    line();
    console.log("결론: 위 라벨의 파라미터 구조가 정답. _sync.js를 거기에 맞추면 됨.\n");
  } else {
    console.log("주의: 200인데 0건이면 해당 기간/일자에 정산이 없는 것.");
    console.log("      LICENSE_KEY 또는 날짜를 바꿔 재시도 가능.\n");
  }
}
main().catch(e=>{console.error("예외:",e);process.exit(1);});
