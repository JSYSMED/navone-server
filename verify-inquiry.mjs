// =============================================
// NavOne 고객문의(inquiry) 인증 검증 — licenseKey 방식 (실제 서버 경로와 동일)
//
// client_id/secret은 .env.local이 아니라 Supabase stores 테이블에 있다.
// 그래서 실제 서버처럼 licenseKey → getStoreByLicense(Supabase 조회) → inquiry 호출.
//
// 실행 (.env.local에 SUPABASE_URL, SUPABASE_SERVICE_KEY 있어야 함):
//   export $(grep -v '^#' .env.local | xargs)
//   LICENSE_KEY=NAVONE-TEST-001 node verify-inquiry.mjs
// =============================================

import { getStoreByLicense, fetchInquiries } from "./lib/inquiry.js";

const LICENSE_KEY = process.env.LICENSE_KEY || "NAVONE-TEST-001";

function line() { console.log("-".repeat(54)); }

async function main() {
  console.log("\nNavOne 고객문의(inquiry) 인증 검증 - licenseKey 방식");
  line();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.log("X Supabase 환경변수 누락. 먼저:");
    console.log("    export $(grep -v '^#' .env.local | xargs)");
    console.log("  그다음 이 스크립트를 실행하세요.\n");
    process.exit(1);
  }

  console.log("licenseKey :", LICENSE_KEY);
  console.log("흐름       : licenseKey -> Supabase store 조회 -> 서버 토큰 발급 -> 커머스 문의 API");
  line();

  let store;
  try {
    console.log("1) getStoreByLicense - Supabase에서 client_id/secret 조회...");
    store = await getStoreByLicense(LICENSE_KEY);
    console.log("   OK store 조회 성공:", store.storeName);
    console.log("   client_id:", store.clientId ? "있음" : "없음", "/ client_secret:", store.clientSecret ? "있음" : "없음");
  } catch (err) {
    console.log("   X store 조회 실패:", err.status || "", err.message);
    console.log("\n  진단:");
    if (err.status === 404) console.log("    licenseKey가 stores에 없음. LICENSE_KEY 환경변수로 올바른 키 지정.");
    else if (err.status === 400) console.log("    store에 client_id/secret 미설정. Supabase stores 테이블 확인.");
    else console.log("    Supabase 연결 확인 (SUPABASE_URL / SUPABASE_SERVICE_KEY).");
    process.exit(1);
  }
  line();

  try {
    console.log("2) 미답변 문의 목록 호출 (store 기반, x-naver-token 아님)...");
    const result = await fetchInquiries({ store, answered: false, page: 1, size: 50 });
    console.log("   OK HTTP 200 - licenseKey 방식 인증 성공\n");

    console.log("3) 결과:");
    console.log("   미답변 문의 수:", result.inquiries.length, "/ total:", result.total);
    if (result.inquiries.length > 0) {
      const q = result.inquiries[0];
      console.log("   첫 문의 -> id:", q.inquiryId, "| 상품:", q.productName || "(없음)");
      console.log("           내용:", (q.content || "").slice(0, 40));
      console.log("   ", q.inquiryId ? "OK 매핑 정상" : "주의 inquiryId 없음 - 필드명 확인");
    } else {
      console.log("   주의: 미답변 문의 0건 - 인증·경로 정상, 그냥 미답변이 없는 것.");
    }
    line();
    console.log("검증 완료: inquiry가 licenseKey(store) 기반으로 정상 동작 OK\n");
  } catch (err) {
    console.log("   X inquiry 호출 실패:", err.status || "", err.message);
    if (err.detail) console.log("   상세:", JSON.stringify(err.detail).slice(0, 300));
    console.log("\n  진단:");
    if (err.status === 401 || err.status === 403) console.log("    인증/권한 또는 로컬 IP 미등록 -> 서버(고정IP)에서 재시도.");
    else if (err.status === 404) console.log("    경로 확인: /external/v1/pay-user/inquiries");
    else if (err.status === 400) console.log("    파라미터(page/size/answered/날짜) 확인.");
    process.exit(1);
  }
}

main().catch(e => { console.error("예외:", e); process.exit(1); });
