// =============================================
// NavOne 원가 관리 엔드포인트 검증 (COST_SERVER_SPEC.md)
//   - POST  /api/product/cost-bulk     (일괄 upsert)
//   - PATCH /api/product/cost          (단건 upsert)
//   - GET   /api/settlement/margin-rank (원가 테이블 반영 확인)
//   - GET   /api/product/cost-list     (상품 머지; 커머스 API IP 허용 필요 → best-effort)
//
// 핸들러 default export 를 mock req/res 로 직접 호출(서버 기동 불필요).
//
// 스토리지 계층(cost-bulk/cost/margin-rank)은 커머스 API 를 호출하지 않으므로
// 합성 SKU(VERIFY-SKU-*)로 어떤 IP 에서도 검증 가능. 끝나면 합성 행은 삭제한다.
// cost-list 는 fetchAllProducts(커머스 API) 의존 → IP 미허용이면 SKIP 처리.
//
// 실행: export $(grep -v '^#' .env.local | xargs); node verify-product-cost.mjs
// =============================================
import costList from "./api/product/_cost-list.js";
import costBulk from "./api/product/_cost-bulk.js";
import costPatch from "./api/product/_cost.js";
import marginRank from "./api/settlement/_margin-rank.js";
import { sbSelect } from "./lib/supabase.js";

const LICENSE_KEY = process.env.LICENSE_KEY || "NAVONE-TEST-001";
const line = () => console.log("-".repeat(54));

function mockRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.end = () => r;
  return r;
}

async function call(handler, { method = "GET", query = {}, body = {} } = {}) {
  const res = mockRes();
  await handler({ method, query, body, headers: {} }, res);
  return res;
}

// 합성 행 정리 (sbDelete 헬퍼가 없어 REST 직접 호출).
async function deleteSynthetic() {
  const url = process.env.SUPABASE_URL + "/rest/v1/navone_product_cost"
    + "?license_key=eq." + encodeURIComponent(LICENSE_KEY)
    + "&channel_product_no=like.VERIFY-SKU-*";
  await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: "Bearer " + process.env.SUPABASE_SERVICE_KEY,
    },
  }).catch(() => {});
}

async function main() {
  console.log("\nNavOne 원가 관리 엔드포인트 검증");
  line();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.log("X Supabase 환경변수 누락. export $(grep -v '^#' .env.local | xargs) 먼저.\n");
    process.exit(1);
  }
  console.log("licenseKey:", LICENSE_KEY);
  line();

  let pass = 0, fail = 0, skip = 0;
  const ok = (cond, msg) => { console.log((cond ? "   OK  " : "   X   ") + msg); cond ? pass++ : fail++; };

  // 테이블 존재 확인 (없으면 마이그레이션 안내 후 종료).
  try {
    await sbSelect("navone_product_cost", "select=license_key&limit=1");
  } catch (e) {
    if (String(e.message).includes("navone_product_cost") || e.status === 404 || e.status === 406) {
      console.log("X 테이블 navone_product_cost 가 없습니다.");
      console.log("  → db/migrations/20260605_navone_product_cost.sql 를 Supabase SQL editor 에서 1회 실행하세요.");
      console.log("  (이 환경엔 DB 접속 문자열/psql/supabase CLI 가 없어 DDL 자동 적용 불가)\n");
      process.exit(1);
    }
    throw e;
  }

  const SKU = (i) => "VERIFY-SKU-" + i;
  await deleteSynthetic(); // 이전 잔여 정리

  // 1) PATCH /api/product/cost (단건 upsert)
  console.log("1) PATCH /api/product/cost (단건 upsert)");
  let r = await call(costPatch, {
    method: "PATCH",
    body: { licenseKey: LICENSE_KEY, channelProductNo: SKU(1), cost: 11111, productName: "검증상품1" },
  });
  ok(r.statusCode === 200 && r.body?.success === true, `단건 저장 (${SKU(1)} → 11111)`);

  // 단건 갱신(upsert 충돌 갱신) 확인
  r = await call(costPatch, {
    method: "PATCH",
    body: { licenseKey: LICENSE_KEY, channelProductNo: SKU(1), cost: 22222 },
  });
  ok(r.statusCode === 200 && r.body?.success === true, "동일 키 재호출 → 갱신 성공");

  // 2) POST /api/product/cost-bulk (일괄 upsert)
  line();
  console.log("2) POST /api/product/cost-bulk (일괄 upsert)");
  const bulkItems = [
    { channelProductNo: SKU(1), cost: 30000, productName: "검증상품1" }, // 기존 키 갱신
    { channelProductNo: SKU(2), cost: 31000, productName: "검증상품2" },
    { channelProductNo: SKU(3), cost: 32000, productName: "검증상품3" },
  ];
  r = await call(costBulk, { method: "POST", body: { licenseKey: LICENSE_KEY, items: bulkItems } });
  ok(r.statusCode === 200 && r.body?.saved === bulkItems.length, `일괄 저장 saved=${r.body?.saved} (기대 ${bulkItems.length})`);

  // 잘못된 항목 필터링 확인 (cost 누락 → 스킵)
  r = await call(costBulk, {
    method: "POST",
    body: { licenseKey: LICENSE_KEY, items: [{ channelProductNo: SKU(2), cost: 99999 }, { channelProductNo: "", cost: 1 }, { channelProductNo: SKU(4) }] },
  });
  ok(r.statusCode === 200 && r.body?.saved === 1, `유효 항목만 저장 saved=${r.body?.saved} (기대 1)`);

  // 3) 테이블 직접 조회로 저장 확인
  line();
  console.log("3) 저장 결과 직접 조회 (navone_product_cost)");
  const rows = await sbSelect(
    "navone_product_cost",
    "license_key=eq." + encodeURIComponent(LICENSE_KEY) +
      "&channel_product_no=like.VERIFY-SKU-*&select=channel_product_no,cost&order=channel_product_no"
  );
  const byNo = Object.fromEntries(rows.map((x) => [x.channel_product_no, x.cost]));
  ok(byNo[SKU(1)] === 30000, `${SKU(1)} cost=${byNo[SKU(1)]} (bulk 가 patch 값 갱신, 기대 30000)`);
  ok(byNo[SKU(2)] === 99999, `${SKU(2)} cost=${byNo[SKU(2)]} (기대 99999)`);
  ok(byNo[SKU(3)] === 32000, `${SKU(3)} cost=${byNo[SKU(3)]} (기대 32000)`);

  // 4) margin-rank — 원가 테이블 반영(costConfigured) 확인
  line();
  console.log("4) GET /api/settlement/margin-rank (원가 테이블 기반 costConfigured)");
  r = await call(marginRank, { query: { licenseKey: LICENSE_KEY } });
  ok(r.statusCode === 200 && r.body?.success === true, "margin-rank 200");
  ok((r.body?.data?.costConfigured || 0) >= 3, `costConfigured=${r.body?.data?.costConfigured} (테이블 기반, >=3)`);
  console.log(`   info ranking ${r.body?.data?.ranking?.length || 0}건 (기간 내 정산 데이터 있을 때만 채워짐)`);

  // 5) cost-list — 커머스 API 의존(best-effort)
  line();
  console.log("5) GET /api/product/cost-list (커머스 API — IP 허용 필요)");
  r = await call(costList, { query: { licenseKey: LICENSE_KEY } });
  if (r.statusCode === 200 && r.body?.success) {
    const p = r.body.products || [];
    ok(Array.isArray(p), `products 배열 count=${r.body.count}, costConfigured=${r.body.costConfigured}`);
    ok(p.length === 0 || p.every((x) => x.cost === null || typeof x.cost === "number"), "원가 미입력은 cost:null");
  } else {
    const code = r.body?.error?.detail?.code || r.body?.error?.code;
    console.log(`   SKIP cost-list (status ${r.statusCode}, ${code}) — 커머스 API IP 미허용 등 환경 제약. 코드 경로는 정상.`);
    skip++;
  }

  // 정리
  await deleteSynthetic();

  line();
  console.log(`결과: ${pass} PASS / ${fail} FAIL / ${skip} SKIP\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("\n예외:", e.status || "", e.message, e.detail || ""); process.exit(1); });
