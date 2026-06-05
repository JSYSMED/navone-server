// =============================================
// NavOne 판매 현황 엔드포인트 검증 (SALES_STATUS_SERVER_SPEC.md)
//   - GET /api/order/sales-status  (오늘/어제/이번주)
//
// 핸들러 default export 를 mock req/res 로 직접 호출(서버 기동 불필요).
//
// product-orders 는 커머스 API 의존 → 운영 VPS(허용 IP)에서만 실호출 가능.
//   IP 미허용(GW.IP_NOT_ALLOWED) 이면 SKIP (verify-product-cost 의 cost-list 와 동일 정책).
//
// ★ 핵심 검증(명세 §5): expectedSettlement / commission 가 "주문·결제 시점"부터
//   채워져 오는지를 status 별 분포로 출력한다. PAYED 시점부터 채워지면 기능 살림.
//
// 실행: export $(grep -v '^#' .env.local | xargs); node verify-sales-status.mjs
// =============================================
import salesStatus from "./api/order/_sales-status.js";

const LICENSE_KEY = process.env.LICENSE_KEY || "NAVONE-TEST-001";
const line = () => console.log("-".repeat(60));
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

function mockRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.end = () => r;
  return r;
}

async function call(query = {}) {
  const res = mockRes();
  await salesStatus({ method: "GET", query, headers: {} }, res);
  return res;
}

// 절대 시각 → KST(+09:00) ISO. (핸들러와 동일 포맷)
function toKstIso(date) {
  const k = new Date(date.getTime() + 9 * 3600 * 1000);
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())}` +
    `T${p(k.getUTCHours())}:${p(k.getUTCMinutes())}:${p(k.getUTCSeconds())}.${p(k.getUTCMilliseconds(), 3)}+09:00`;
}
function kstMidnight(daysAgo = 0) {
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  const base = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - 9 * 3600 * 1000;
  return new Date(base - daysAgo * 24 * 3600 * 1000);
}

// 커머스 API IP 미허용 등 환경 제약인지 판정 → 실호출 SKIP 사유.
function isEnvSkip(body) {
  const blob = JSON.stringify(body?.error || {});
  return /IP_NOT_ALLOWED|GW\.|커머스 API/.test(blob) || body?.error?.code === "NO_COMMERCE_CRED";
}

// summary 합계가 orders 합과 일치하는지 검증.
function checkConsistency(ok, body) {
  const orders = body.orders || [];
  const s = body.summary || {};
  const sumSales = orders.reduce((a, o) => a + (Number(o.salesAmount) || 0), 0);
  const sumSettle = orders.reduce((a, o) => a + (Number(o.expectedSettlement) || 0), 0);
  const sumComm = orders.reduce((a, o) => a + (Number(o.commission) || 0), 0);
  const sumStatus = Object.values(s.statusCounts || {}).reduce((a, n) => a + n, 0);

  ok(s.orderCount === orders.length, `orderCount(${s.orderCount}) == orders.length(${orders.length})`);
  ok(s.totalSales === sumSales, `totalSales(${s.totalSales}) == ΣsalesAmount(${sumSales})`);
  ok(s.totalSettlement === sumSettle, `totalSettlement(${s.totalSettlement}) == ΣexpectedSettlement(${sumSettle})`);
  ok(s.totalCommission === sumComm, `totalCommission(${s.totalCommission}) == Σcommission(${sumComm})`);
  ok(sumStatus === orders.length || orders.length === 0, `ΣstatusCounts(${sumStatus}) == orderCount(${orders.length})`);
}

// ★ 명세 §5 핵심 리포트.
function criticalReport(allOrders) {
  line();
  console.log("★ 핵심 검증 (명세 §5): 주문 시점부터 예상 정산액이 채워지는가\n");

  const total = allOrders.length;
  if (!total) {
    console.log("  (수집된 주문 0건 — 실데이터가 있는 기간/스토어에서 재실행 필요)");
    return;
  }

  // 1. expectedSettlement 채워진 건수
  const settleFilled = allOrders.filter((o) => Number(o.expectedSettlement) > 0).length;
  console.log(`1) expectedSettlement 채워진 건: ${settleFilled}/${total} (${pct(settleFilled, total)}%)`);

  // 3. commission 채워진 건수
  const commFilled = allOrders.filter((o) => Number(o.commission) > 0).length;
  console.log(`3) commission(수수료) 채워진 건: ${commFilled}/${total} (${pct(commFilled, total)}%)`);

  // 2. status 별 expectedSettlement/commission 채워짐 분포
  console.log("\n2) status 별 expectedSettlement / commission 채워짐 분포:");
  const byStatus = {};
  for (const o of allOrders) {
    const st = o.status || "(없음)";
    const b = (byStatus[st] ||= { n: 0, settle: 0, comm: 0 });
    b.n++;
    if (Number(o.expectedSettlement) > 0) b.settle++;
    if (Number(o.commission) > 0) b.comm++;
  }
  for (const [st, b] of Object.entries(byStatus)) {
    console.log(
      `   ${st.padEnd(18)} ${String(b.n).padStart(4)}건` +
      `  | 정산예정 ${b.settle}/${b.n} (${pct(b.settle, b.n)}%)` +
      `  | 수수료 ${b.comm}/${b.n} (${pct(b.comm, b.n)}%)`
    );
  }

  // PAYED 판정 — 사업 가치 핵심.
  const payed = byStatus["PAYED"];
  console.log("\n   ▶ 판정:");
  if (payed && payed.settle > 0) {
    console.log(`     ✅ PAYED(결제완료) 시점부터 expectedSettlement 채워짐 (${payed.settle}/${payed.n})`);
    console.log("        → '주문 즉시 예상 정산액 표시' 기능 살림(GO).");
  } else if (payed && payed.settle === 0) {
    const decided = byStatus["PURCHASE_DECIDED"];
    if (decided && decided.settle > 0) {
      console.log("     ⚠️ PAYED 에선 비어오고 PURCHASE_DECIDED(구매확정)에서만 채워짐");
      console.log("        → '구매확정분만 예상정산 표시'로 한정.");
    } else {
      console.log("     ⛔ PAYED/PURCHASE_DECIDED 모두 expectedSettlement 비어옴");
      console.log("        → 정산은 기존 settlement 페이지로, 여기선 판매액·수수료·건수만 표시.");
    }
  } else {
    console.log("     ℹ️ 이 기간에 PAYED 상태 주문이 없어 PAYED 시점 판정 보류(다른 기간 재실행).");
  }

  // 4. inflowPath 샘플 (외부/내부 유입 — 수수료 ROI 연계)
  const paths = [...new Set(allOrders.map((o) => o.inflowPath).filter(Boolean))];
  console.log(`\n4) inflowPath 샘플(고유 ${paths.length}종): ${paths.slice(0, 8).join(", ") || "(전부 비어옴)"}`);
  const inflowFilled = allOrders.filter((o) => o.inflowPath).length;
  console.log(`   inflowPath 채워진 건: ${inflowFilled}/${total} (${pct(inflowFilled, total)}%) — 외부/내부 유입 구분 가능 여부`);
}

async function main() {
  console.log("\nNavOne 판매 현황 엔드포인트 검증");
  line();
  console.log("licenseKey:", LICENSE_KEY);
  line();

  let pass = 0, fail = 0, skip = 0;
  const ok = (cond, msg) => { console.log((cond ? "   OK  " : "   X   ") + msg); cond ? pass++ : fail++; };

  const cases = [
    { name: "오늘",   query: { licenseKey: LICENSE_KEY } }, // from 생략 → 오늘 0시 KST, to → +24h
    { name: "어제",   query: { licenseKey: LICENSE_KEY, from: toKstIso(kstMidnight(1)), to: toKstIso(kstMidnight(0)) } },
    { name: "이번주", query: { licenseKey: LICENSE_KEY, from: toKstIso(kstMidnight(7)), to: toKstIso(kstMidnight(0)) } }, // 7일 → 일자별 분할 합산 경로
  ];

  const collected = [];
  let skippedEnv = false;

  for (const c of cases) {
    line();
    console.log(`▶ ${c.name}  ${c.query.from ? `(${c.query.from} ~ ${c.query.to})` : "(오늘 0시 KST ~ +24h)"}`);
    const r = await call(c.query);

    if (r.statusCode === 200 && r.body?.success) {
      const s = r.body.summary || {};
      ok(true, `200 success — storeName=${r.body.storeName}, orderCount=${s.orderCount}, totalSales=${s.totalSales}, totalSettlement=${s.totalSettlement}`);
      ok(r.body.range?.rangeType === (c.query.rangeType || "PAYED_DATETIME"), `range.rangeType=${r.body.range?.rangeType} (기본 PAYED_DATETIME)`);
      checkConsistency(ok, r.body);
      collected.push(...(r.body.orders || []));
    } else if (isEnvSkip(r.body)) {
      console.log(`   SKIP (status ${r.statusCode}, ${JSON.stringify(r.body?.error?.code || r.body?.error?.detail?.code || "")}) — 커머스 API IP 미허용 등 환경 제약. 코드 경로는 정상.`);
      skip++;
      skippedEnv = true;
    } else {
      ok(false, `예상 못한 실패 status=${r.statusCode} body=${JSON.stringify(r.body).slice(0, 240)}`);
    }
  }

  // ★ 핵심 리포트 (실데이터가 한 건이라도 수집됐을 때만 의미 있음)
  if (collected.length || !skippedEnv) criticalReport(collected);
  else {
    line();
    console.log("★ 핵심 검증: 커머스 API 미호출(IP 제약)로 실데이터 없음 → 운영 VPS에서 재실행 필요.");
  }

  line();
  console.log(`결과: ${pass} PASS / ${fail} FAIL / ${skip} SKIP\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("\n예외:", e.status || "", e.message, e.detail || ""); process.exit(1); });
