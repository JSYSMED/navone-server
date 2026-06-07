// =============================================
// NavOne 리뷰 수집 엔드포인트 검증 (REVIEW_SYNC_SERVER_SPEC.md)
//   - POST  /api/review/sync     (샘플 리뷰 upsert + newCount)
//   - GET   /api/review/list     (status=pending|replied 필터)
//   - PATCH /api/review/replied  (답글 상태 갱신)
//
// 핸들러 default export 를 mock req/res 로 직접 호출(서버 기동 불필요).
// navone_review 는 커머스 API 를 호출하지 않으므로 합성 리뷰(VERIFY-REV-*)로
// 어떤 IP 에서도 검증 가능 (cost-bulk 와 동일). 끝나면 합성 행은 삭제한다.
//
// 실행: export $(grep -v '^#' .env.local | xargs); node verify-review.mjs
// =============================================
import reviewSync from "./api/review/_sync.js";
import reviewList from "./api/review/_list.js";
import reviewReplied from "./api/review/_replied.js";
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
  const url = process.env.SUPABASE_URL + "/rest/v1/navone_review"
    + "?license_key=eq." + encodeURIComponent(LICENSE_KEY)
    + "&review_id=like.VERIFY-REV-*";
  await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: "Bearer " + process.env.SUPABASE_SERVICE_KEY,
    },
  }).catch(() => {});
}

async function main() {
  console.log("\nNavOne 리뷰 수집 엔드포인트 검증");
  line();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.log("X Supabase 환경변수 누락. export $(grep -v '^#' .env.local | xargs) 먼저.\n");
    process.exit(1);
  }
  console.log("licenseKey:", LICENSE_KEY);
  line();

  let pass = 0, fail = 0;
  const ok = (cond, msg) => { console.log((cond ? "   OK  " : "   X   ") + msg); cond ? pass++ : fail++; };

  // 테이블 존재 확인 (없으면 마이그레이션 안내 후 종료).
  try {
    await sbSelect("navone_review", "select=license_key&limit=1");
  } catch (e) {
    if (String(e.message).includes("navone_review") || e.status === 404 || e.status === 406) {
      console.log("X 테이블 navone_review 가 없습니다.");
      console.log("  → db/migrations/20260607_navone_review.sql 를 Supabase SQL editor 에서 1회 실행하세요.");
      console.log("  (이 환경엔 DB 접속 문자열/psql/supabase CLI 가 없어 DDL 자동 적용 불가)\n");
      process.exit(1);
    }
    throw e;
  }

  const REV = (i) => "VERIFY-REV-" + i;
  await deleteSynthetic(); // 이전 잔여 정리

  // 1) POST /api/review/sync (샘플 2건 upsert)
  console.log("1) POST /api/review/sync (샘플 2건 upsert)");
  const reviews = [
    { reviewId: REV(1), channelProductNo: "CP-1", productName: "검증상품1", rating: 5, content: "좋아요", date: "2026-06-05" },
    { reviewId: REV(2), channelProductNo: "CP-2", productName: "검증상품2", rating: 2, content: "별로예요", date: "2026-06-06" },
  ];
  let r = await call(reviewSync, { method: "POST", body: { licenseKey: LICENSE_KEY, reviews } });
  ok(r.statusCode === 200 && r.body?.success === true, "sync 200 success");
  ok(r.body?.synced === 2, `synced=${r.body?.synced} (기대 2)`);
  ok(r.body?.newCount === 2, `newCount=${r.body?.newCount} (신규 2)`);

  // 재호출 → 디듀프(newCount 0), 내용 갱신
  r = await call(reviewSync, {
    method: "POST",
    body: { licenseKey: LICENSE_KEY, reviews: [{ reviewId: REV(1), rating: 4, content: "수정됨", date: "2026-06-05" }] },
  });
  ok(r.body?.synced === 1 && r.body?.newCount === 0, `재수집 디듀프 newCount=${r.body?.newCount} (기대 0)`);

  // 2) GET /api/review/list (status=pending, 기본)
  line();
  console.log("2) GET /api/review/list (pending 기본)");
  r = await call(reviewList, { query: { licenseKey: LICENSE_KEY, status: "pending" } });
  ok(r.statusCode === 200 && r.body?.success === true, "list 200 success");
  let ids = new Set((r.body?.reviews || []).map((x) => x.reviewId));
  ok(ids.has(REV(1)) && ids.has(REV(2)), `pending 에 2건 포함 (count=${r.body?.count})`);
  const rev1 = (r.body?.reviews || []).find((x) => x.reviewId === REV(1));
  ok(rev1?.replyStatus === "pending", `${REV(1)} replyStatus=${rev1?.replyStatus} (기대 pending)`);

  // 3) PATCH /api/review/replied (1건 답글 처리)
  line();
  console.log("3) PATCH /api/review/replied (1건 답글)");
  r = await call(reviewReplied, {
    method: "PATCH",
    body: { licenseKey: LICENSE_KEY, reviewId: REV(1), replyText: "답글 감사합니다" },
  });
  ok(r.statusCode === 200 && r.body?.success === true, `${REV(1)} replied 처리`);

  // 4) list(replied) 확인 + pending 에서 제외 확인
  line();
  console.log("4) GET /api/review/list (replied / pending 재확인)");
  r = await call(reviewList, { query: { licenseKey: LICENSE_KEY, status: "replied" } });
  ids = new Set((r.body?.reviews || []).map((x) => x.reviewId));
  const repliedRow = (r.body?.reviews || []).find((x) => x.reviewId === REV(1));
  ok(ids.has(REV(1)), `replied 목록에 ${REV(1)} 포함`);
  ok(repliedRow?.replyText === "답글 감사합니다", `reply_text 저장됨 ("${repliedRow?.replyText}")`);
  // 답글 처리해도 기존 content 보존(SET 절 미포함)
  ok(repliedRow?.content === "수정됨", `replied 후 content 보존 ("${repliedRow?.content}")`);

  r = await call(reviewList, { query: { licenseKey: LICENSE_KEY, status: "pending" } });
  ids = new Set((r.body?.reviews || []).map((x) => x.reviewId));
  ok(!ids.has(REV(1)) && ids.has(REV(2)), `pending 에서 ${REV(1)} 제외, ${REV(2)} 유지`);

  // 정리
  await deleteSynthetic();

  line();
  console.log(`결과: ${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("\n예외:", e.status || "", e.message, e.detail || ""); process.exit(1); });
