// =============================================
// NavOne 수수료 외부유입 ROI 검증
// commission-details 여러 날 수집 → analyzeInflowRoi → 내부/외부 비중 + 절약 시뮬
// 실행: export $(grep -v '^#' .env.local | xargs); node verify-commission.mjs
//   (선택) DAYS=14
// =============================================
import { commerceRequest } from "./lib/commerce-auth.js";
import { getStoreByLicense } from "./lib/qa-reply.js";
import { analyzeInflowRoi } from "./lib/settlement.js";

const LICENSE_KEY = process.env.LICENSE_KEY || "NAVONE-TEST-001";
const DAYS = parseInt(process.env.DAYS,10) || 14;
const iso = d => d.toISOString().slice(0,10);
const won = v => (v??0).toLocaleString();
function line(){ console.log("-".repeat(54)); }

async function main(){
  console.log(`\nNavOne 수수료 외부유입 ROI 검증 (최근 ${DAYS}일)`);
  line();
  const store = await getStoreByLicense(LICENSE_KEY);
  console.log("store:", store.storeName);

  const now = new Date();
  const allItems = [];
  let okDays = 0;
  for (let back=1; back<=DAYS; back++){
    const day = iso(new Date(now.getTime()-back*86400000));
    try {
      const raw = await commerceRequest("/external/v1/pay-settle/settle/commission-details", {
        clientId: store.clientId, clientSecret: store.clientSecret, method:"GET",
        query:{ periodType:"SETTLE_CASEBYCASE_SETTLE_BASIS_DATE", searchDate:day, pageNumber:1, pageSize:1000 },
      });
      const items = raw?.elements || raw?.contents || (Array.isArray(raw)?raw:[]) || [];
      allItems.push(...items);
      if(items.length) okDays++;
    } catch(e){ /* skip */ }
  }
  console.log(`수집: ${allItems.length}건 (데이터 ${okDays}일)`);
  line();

  const a = analyzeInflowRoi(allItems);
  console.log("내부유입 (PLT_SMART_STORE, 판매수수료):");
  console.log(`   기준액 ${won(a.internal.base)} / 수수료 ${won(a.internal.fee)} / 실효율 ${a.internal.rate!=null?(a.internal.rate*100).toFixed(2)+"%":"-"}`);
  console.log("외부유입 (PLF_SMART_STORE_MARKETING, 마케팅수수료):");
  console.log(`   기준액 ${won(a.external.base)} / 수수료 ${won(a.external.fee)} / 실효율 ${a.external.rate!=null?(a.external.rate*100).toFixed(2)+"%":"-"}`);
  console.log(`기타 수수료(Npay 등): ${won(a.otherFee)}`);
  line();
  console.log(`외부유입 비중: ${a.externalSharePct}%`);
  console.log(`적용 기준율: 내부 ${(a.refRates.internal*100).toFixed(2)}% / 외부 ${(a.refRates.external*100).toFixed(2)}%`);
  console.log("\n내부유입을 외부로 전환 시 절약액(기간 기준):");
  console.log(`   25% 전환 → ${won(a.savingsIf.shift25)}원`);
  console.log(`   50% 전환 → ${won(a.savingsIf.shift50)}원`);
  console.log(`   100% 전환 → ${won(a.savingsIf.shift100)}원`);
  line();
  if (a.totalInterlockBase>0) {
    console.log("검증 완료: 내부/외부 유입 역산 + 절약 시뮬 정상 OK");
    if (a.external.base===0) console.log("(이 스토어는 외부유입 0 — 100% 내부유입. NavOne이 절약 여지를 제시할 대상)");
  } else {
    console.log("주의: 판매수수료(interlock) 데이터 없음 — 기간/스토어 확인");
  }
  console.log();
}
main().catch(e=>{console.error("예외:",e);process.exit(1);});
