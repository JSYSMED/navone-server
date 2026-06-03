// =============================================
// NavOne 정산 API 로컬 검증 스크립트
//
// 고친 정산 경로(/external/v1/pay-settle/settle/daily)가 실제로 200을 주는지,
// 응답 구조가 normalizeDailyRow 매핑과 맞는지 직접 호출해서 확인한다.
//
// 인증정보는 코드에 박지 말고 환경변수로 전달:
//   CLIENT_ID=xxx CLIENT_SECRET='$2a$...' node verify-settlement.mjs
//   (선택) START=2026-05-01 END=2026-05-28
//
// commerceRequest는 실제 서버와 동일한 인증/호출 경로라 검증 신뢰도가 높다.
// =============================================

import { commerceRequest } from "./lib/commerce-auth.js";
import { extractSettlementItems, normalizeDailyRow, aggregateDaily } from "./lib/settlement.js";

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
const START = process.env.START || isoDaysAgo(30);
const END = process.env.END || isoDaysAgo(0);

function line() { console.log("─".repeat(54)); }

async function main() {
  console.log("\nNavOne 정산 API 검증");
  line();

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.log("✗ 환경변수 누락. 아래처럼 실행하세요:\n");
    console.log("  CLIENT_ID='애플리케이션ID' \\");
    console.log("  CLIENT_SECRET='\\$2a\\$로 시작하는 시크릿' \\");
    console.log("  node verify-settlement.mjs\n");
    process.exit(1);
  }

  console.log("조회 기간:", START, "~", END);
  console.log("경로     : /external/v1/pay-settle/settle/daily");
  line();

  // 1) 토큰 발급 (commerceRequest 내부에서 자동 처리)
  let raw;
  try {
    console.log("① API 호출 중...");
    raw = await commerceRequest("/external/v1/pay-settle/settle/daily", {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      method: "GET",
      query: { startDate: START, endDate: END, pageNumber: 1, pageSize: 1000 },
    });
    console.log("   ✓ HTTP 200 — 호출 성공\n");
  } catch (err) {
    console.log("   ✗ 호출 실패:", err.status || "", err.message);
    if (err.detail) console.log("   상세:", JSON.stringify(err.detail).slice(0, 300));
    console.log("\n  ↳ 진단:");
    if (err.status === 401 || err.status === 403) {
      console.log("    인증/권한 문제. client_id/secret 확인, 또는 이 IP가 네이버에 등록 안 됨(로컬 IP 화이트리스트).");
      console.log("    → 서버(카페24 고정IP)에서 재시도 권장.");
    } else if (err.status === 404) {
      console.log("    경로가 틀렸을 수 있음. 문서의 정확한 path 재확인 필요.");
    } else if (err.status === 400) {
      console.log("    파라미터 문제. startDate/endDate/pageNumber/pageSize 형식 확인.");
    } else {
      console.log("    네트워크 또는 기타. 메시지 확인.");
    }
    process.exit(1);
  }

  // 2) 응답 구조 확인
  console.log("② 응답 구조 확인:");
  console.log("   최상위 키:", Object.keys(raw || {}).join(", ") || "(없음)");
  const items = extractSettlementItems(raw);
  console.log("   추출된 정산 항목 수:", items.length);
  if (items.length === 0) {
    console.log("   ⚠ 항목 0건 — 해당 기간에 정산 내역이 없거나, 응답 래핑 구조가 예상과 다름.");
    console.log("   원본 응답(앞부분):", JSON.stringify(raw).slice(0, 400));
  }
  line();

  // 3) 필드 매핑 검증 (첫 항목)
  if (items.length > 0) {
    console.log("③ 첫 항목 원본 키:", Object.keys(items[0]).join(", "));
    const row = normalizeDailyRow(items[0], "verify");
    console.log("\n   정규화 결과:");
    console.log("   - 날짜      :", row.settlement_date);
    console.log("   - 판매금액  :", row.sales_amount?.toLocaleString());
    console.log("   - 수수료    :", row.commission_fee?.toLocaleString());
    console.log("   - 혜택      :", row.benefit_amount?.toLocaleString());
    console.log("   - 정산금    :", row.settlement_amount?.toLocaleString());

    // 매핑 성공 여부: 주요 필드가 0이 아니면 매핑 OK일 가능성 높음
    const mapped = [row.settlement_date, row.sales_amount, row.settlement_amount].filter(Boolean).length;
    console.log("\n   매핑된 핵심 필드:", mapped, "/ 3", mapped >= 2 ? "✓ 매핑 정상" : "⚠ 필드명 불일치 가능 — 원본 키 확인");
    if (mapped < 2) {
      console.log("   원본 첫 항목 전체:", JSON.stringify(items[0], null, 2));
    }
    line();

    const daily = aggregateDaily(items.map(it => normalizeDailyRow(it, "verify")));
    console.log("④ 일별 집계:", daily.length, "일치 데이터");
    daily.slice(0, 3).forEach(d => console.log(`   ${d.date}: 정산 ${d.settlement?.toLocaleString()}원`));
  }

  line();
  console.log("검증 완료. 위 결과로 경로·파라미터·필드명이 실제와 맞는지 확인하세요.\n");
}

main().catch(e => { console.error("예외:", e); process.exit(1); });
