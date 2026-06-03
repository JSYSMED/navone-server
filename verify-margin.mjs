// =============================================
// NavOne 마진율 랭킹 전체 흐름 검증
// 건별 정산(/case) 여러 날 수집 → normalizeSettlementRow → computeMarginRanking
// 실행: export $(grep -v '^#' .env.local | xargs); node verify-margin.mjs
//   (선택) DAYS=7 로 수집 일수 조정 (기본 7일, RPS 때문에 너무 크게 X)
// =============================================
import { commerceRequest } from "./lib/commerce-auth.js";
import { getStoreByLicense } from "./lib/qa-reply.js";
import { extractSettlementItems, normalizeSettlementRow, computeMarginRanking } from "./lib/settlement.js";

const LICENSE_KEY = process.env.LICENSE_KEY || "NAVONE-TEST-001";
const DAYS = parseInt(process.env.DAYS,10) || 7;
const iso = d => d.toISOString().slice(0,10);
function line(){ console.log("-".repeat(54)); }

async function main(){
  console.log(`\nNavOne 마진율 랭킹 검증 (최근 ${DAYS}일, 건별 정산)`);
  line();
  const store = await getStoreByLicense(LICENSE_KEY);
  console.log("store:", store.storeName);

  const now = new Date();
  const allItems = [];
  let okDays=0;
  for (let back=1; back<=DAYS; back++){
    const day = iso(new Date(now.getTime()-back*86400000));
    try {
      const raw = await commerceRequest("/external/v1/pay-settle/settle/case", {
        clientId: store.clientId, clientSecret: store.clientSecret, method:"GET",
        query:{ periodType:"SETTLE_CASEBYCASE_SETTLE_BASIS_DATE", searchDate:day, pageNumber:1, pageSize:1000 },
      });
      const items = extractSettlementItems(raw);
      for(const it of items){ if(!it.settleBasisDate) it.settleBasisDate=day; }
      allItems.push(...items);
      if(items.length) okDays++;
    } catch(e){ console.log(`  ${day}: ${e.status} ${e.message}`); }
  }
  console.log(`수집: ${allItems.length}건 (데이터 있는 날 ${okDays}일)`);
  line();

  // 정규화 (PROD_ORDER만 마진 대상; 배송비/적립 등은 참고로 분리)
  const rows = allItems.map(it=>normalizeSettlementRow(it,"verify"));
  const prodRows = allItems.filter(it=>it.productOrderType==="PROD_ORDER").map(it=>normalizeSettlementRow(it,"verify"));
  console.log(`정규화: 전체 ${rows.length} / 상품주문(PROD_ORDER) ${prodRows.length}`);

  // 매핑 샘플
  const sample = prodRows.find(r=>r.sales_amount>0) || prodRows[0];
  if(sample){
    console.log("\n샘플 상품:");
    console.log("  ", sample.product_name);
    console.log("   판매가:", sample.sales_amount?.toLocaleString(), "/ 수수료:", sample.commission_fee?.toLocaleString(), "/ 정산금:", sample.settlement_amount?.toLocaleString());
    const okMap = sample.sales_amount>0 && sample.settlement_amount>0 && sample.commission_fee>=0;
    console.log("  ", okMap ? "OK 금액 매핑 정상 (수수료 절댓값)" : "주의 금액 확인 필요");
  }
  line();

  // 마진 랭킹 (원가 없이 — 정산율 기준)
  const ranking = computeMarginRanking(prodRows, {});
  console.log(`마진 랭킹: ${ranking.length}개 상품 집계`);
  ranking.slice(0,5).forEach((r,i)=>{
    const rate = r.sales>0 ? ((r.settlement/r.sales)*100).toFixed(1) : "-";
    console.log(`  ${i+1}. ${(r.productName||"").slice(0,28)} | 판매 ${r.sales?.toLocaleString()} 정산 ${r.settlement?.toLocaleString()} 정산율 ${rate}%`);
  });
  line();
  console.log(ranking.length>0 ? "검증 완료: 건별 정산 → 마진 랭킹 흐름 정상 OK\n" : "주의: 집계 0 — 기간 늘리거나 데이터 확인\n");
}
main().catch(e=>{console.error("예외:",e);process.exit(1);});
