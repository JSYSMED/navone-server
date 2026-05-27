// =============================================
// NavOne — claim-engine 룰/정규화 단위 테스트 (네트워크 무사용)
//   실행: npm run test:claim  (또는 node test/claim-engine.test.mjs)
// =============================================

import assert from "node:assert/strict";
import { decide, normalizeClaim, DEFAULT_RULES } from "../lib/claim-engine.js";

let pass = 0;
function t(name, fn) {
  try {
    fn();
    console.log("  ✓ " + name);
    pass++;
  } catch (e) {
    console.error("  ✗ " + name + "\n    " + e.message);
    process.exitCode = 1;
  }
}

const rules = { ...DEFAULT_RULES }; // enabled, simple_return_max 50000, defect on, threshold 0.8
const ret = (over = {}) => ({ claimType: "RETURN", amount: 10000, ...over });

console.log("decide() — 룰 엔진");

t("단순변심 + 금액 이하 + 고신뢰 → 자동승인", () => {
  const r = decide({ category: "simple_return", confidence: 0.95, auto_processable: true }, ret({ amount: 10000 }), rules);
  assert.equal(r.decision, "approve");
  assert.equal(r.notify, false);
});

t("단순변심 + 금액 초과 → 보류+알림", () => {
  const r = decide({ category: "simple_return", confidence: 0.95, auto_processable: true }, ret({ amount: 80000 }), rules);
  assert.equal(r.decision, "hold");
  assert.equal(r.notify, true);
});

t("상품하자 → 자동승인 + 알림", () => {
  const r = decide({ category: "defect", confidence: 0.9, auto_processable: true }, ret(), rules);
  assert.equal(r.decision, "approve");
  assert.equal(r.notify, true);
});

t("배송문제 → 보류+알림", () => {
  const r = decide({ category: "delivery", confidence: 0.99, auto_processable: true }, ret(), rules);
  assert.equal(r.decision, "hold");
});

t("기타 → 보류+알림", () => {
  const r = decide({ category: "other", confidence: 0.99, auto_processable: true }, ret(), rules);
  assert.equal(r.decision, "hold");
});

t("신뢰도 미달 → 무조건 보류", () => {
  const r = decide({ category: "simple_return", confidence: 0.5, auto_processable: true }, ret(), rules);
  assert.equal(r.decision, "hold");
});

t("교환 클레임 → 항상 보류", () => {
  const r = decide({ category: "defect", confidence: 0.99, auto_processable: true }, ret({ claimType: "EXCHANGE" }), rules);
  assert.equal(r.decision, "hold");
});

t("자동처리 비활성화 → 보류, 알림 없음", () => {
  const r = decide({ category: "defect", confidence: 0.99, auto_processable: true }, ret(), { ...rules, enabled: false });
  assert.equal(r.decision, "hold");
  assert.equal(r.notify, false);
});

t("취소(CANCEL) 단순변심도 자동승인 경로 동작", () => {
  const r = decide({ category: "simple_return", confidence: 0.9, auto_processable: true }, ret({ claimType: "CANCEL", amount: 5000 }), rules);
  assert.equal(r.decision, "approve");
});

console.log("normalizeClaim() — 정규화");

t("changed + detail 병합 추출", () => {
  const c = normalizeClaim(
    { productOrderId: "PO1", claimType: "return", claimStatus: "RETURN_REQUEST" },
    { productOrder: { productOrderId: "PO1", productName: "테스트상품", totalPaymentAmount: 23000 },
      claim: { claimRequestDetailContent: "사이즈가 안 맞아요" } }
  );
  assert.equal(c.productOrderId, "PO1");
  assert.equal(c.claimType, "RETURN");
  assert.equal(c.productName, "테스트상품");
  assert.equal(c.amount, 23000);
  assert.equal(c.claimReason, "사이즈가 안 맞아요");
});

t("detail 누락 시 안전한 기본값", () => {
  const c = normalizeClaim({ productOrderId: "PO2" }, undefined);
  assert.equal(c.productOrderId, "PO2");
  assert.equal(c.amount, 0);
  assert.equal(c.productName, "(상품명 미상)");
});

console.log(`\n${pass}개 통과` + (process.exitCode ? " (실패 있음)" : " — 전부 성공"));
