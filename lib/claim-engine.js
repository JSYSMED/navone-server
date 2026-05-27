// =============================================
// NavOne — 클레임 자동처리 코어 엔진 (Agent B)
// /api 밖(lib/)에 둬서 Vercel이 엔드포인트로 노출하지 않음.
//
// 책임:
//   1. 커머스 API 클레임 폴링/상세 조회 (정규화)
//   2. GPT-4o-mini 클레임 사유 분류
//   3. 룰 엔진 (단순변심/상품하자/배송/기타 → 승인/보류)
//   4. 커머스 API 반품/취소 승인 호출
//   5. Supabase 감사 로그 + Telegram 알림
//
// ⚠️ 공정위 표시광고법: AI는 분류 JSON만 생성하며 고객 노출 텍스트를
//    만들지 않는다. 보상/환불 약속 표현이 생성될 여지 자체를 차단.
// =============================================

import { commerceRequest } from "./commerce-auth.js";
import { sbSelect, sbInsert, sbUpsert } from "./supabase.js";
import { sendTelegram, escapeHtml } from "./telegram.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// 셀러가 navone_claim_rules 행을 안 만들었을 때의 기본 룰.
export const DEFAULT_RULES = {
  enabled: true,
  auto_approve_simple_return: true,
  simple_return_max_amount: 50000,
  auto_approve_defect: true,
  notify_on_defect: true,
  notify_on_hold: true,
  confidence_threshold: 0.8,
};

const CATEGORY_LABEL = {
  simple_return: "단순변심",
  defect: "상품하자",
  delivery: "배송문제",
  other: "기타",
};

// ── 스토어/룰 조회 ────────────────────────────────────────────

// license_key → 스토어 행(id, 커머스 자격증명 포함). 없으면 null.
export async function getStoreByLicense(licenseKey) {
  const rows = await sbSelect(
    "stores",
    "license_key=eq." + encodeURIComponent(licenseKey) +
      "&select=id,store_name,client_id,client_secret,config&limit=1"
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// store_id → navone_claim_rules 행. 없으면 DEFAULT_RULES.
export async function getClaimRules(storeId) {
  const rows = await sbSelect(
    "navone_claim_rules",
    "store_id=eq." + encodeURIComponent(storeId) + "&limit=1"
  );
  if (Array.isArray(rows) && rows.length) {
    return { ...DEFAULT_RULES, ...rows[0] };
  }
  return { ...DEFAULT_RULES };
}

// ── 커머스 API: 클레임 조회 ───────────────────────────────────

// 미처리(CLAIM_REQUESTED) 클레임 식별자 폴링.
// since: ISO8601 문자열 (기본 24시간 전).
export async function fetchChangedClaims(creds, since) {
  const lastChangedFrom = since || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const data = await commerceRequest(
    "/external/v1/pay-order/seller/product-orders/last-changed-statuses",
    {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      query: { lastChangedFrom, lastChangedType: "CLAIM_REQUESTED" },
    }
  );
  // 응답 형태 방어적 추출: data.lastChangeStatuses 가 표준.
  const list = data?.data?.lastChangeStatuses || data?.lastChangeStatuses || [];
  return Array.isArray(list) ? list : [];
}

// productOrderId 배열 → 상세(상품명/금액/클레임 사유) 조회.
export async function fetchClaimDetails(creds, productOrderIds) {
  if (!productOrderIds.length) return [];
  const data = await commerceRequest(
    "/external/v1/pay-order/seller/product-orders/query",
    {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      method: "POST",
      body: { productOrderIds },
    }
  );
  const list = data?.data || data?.contents || data || [];
  return Array.isArray(list) ? list : [];
}

// 커머스 응답을 내부 표준 클레임 객체로 정규화.
// 응답 필드명은 버전별 편차가 있어 다단계 fallback 으로 추출한다.
export function normalizeClaim(changed, detail) {
  const po = detail?.productOrder || detail || {};
  const claim = detail?.claim || detail?.returnInfo || detail?.cancelInfo || {};
  const productOrderId =
    changed?.productOrderId || po.productOrderId || detail?.productOrderId || null;

  const claimType =
    (changed?.claimType || claim.claimType || po.claimType || "").toUpperCase() || null;

  return {
    productOrderId,
    claimType, // RETURN | CANCEL | EXCHANGE
    claimStatus: changed?.claimStatus || claim.claimStatus || po.claimStatus || null,
    productName: po.productName || detail?.productName || "(상품명 미상)",
    amount: Number(
      po.totalPaymentAmount ?? po.totalPaymentAmt ?? claim.claimAmount ?? po.unitPrice ?? 0
    ),
    claimReason:
      claim.claimRequestDetailContent ||
      claim.claimReason ||
      claim.returnReason ||
      claim.cancelReason ||
      changed?.claimReason ||
      "",
    claimReasonType:
      claim.claimRequestReason || claim.returnReasonCode || claim.claimReasonCode || null,
    lastChangedDate: changed?.lastChangedDate || claim.claimRequestDate || null,
    raw: { changed, detail }, // 감사용 원본 보존
  };
}

// ── GPT-4o-mini 분류 ──────────────────────────────────────────

const SYSTEM_PROMPT =
  "너는 네이버 스마트스토어 클레임 분류기다. 클레임 사유를 분석해 카테고리와 자동처리 가능 여부를 JSON으로 반환해라. " +
  "고객에게 보낼 문장이나 보상·환불 약속은 절대 생성하지 마라. 분류 JSON 외의 텍스트는 출력하지 마라.";

// 단일 클레임 분류. OPENAI 미설정/실패 시 안전하게 other(보류)로 강등.
export async function classifyClaim(claim) {
  if (!OPENAI_API_KEY) {
    return { category: "other", auto_processable: false, confidence: 0, reason: "OPENAI_API_KEY 미설정" };
  }

  const userPrompt =
    `다음 클레임을 분류해라.\n` +
    `클레임유형: ${claim.claimType || "미상"}\n` +
    `상품명: ${claim.productName}\n` +
    `결제금액: ${claim.amount}원\n` +
    `사유코드: ${claim.claimReasonType || "없음"}\n` +
    `고객사유: ${claim.claimReason || "(내용 없음)"}\n\n` +
    `반드시 다음 JSON 형식으로만 답해라:\n` +
    `{ "category": "simple_return"|"defect"|"delivery"|"other", "auto_processable": true|false, "confidence": 0.0~1.0, "reason": "분류 근거(셀러 참고용, 한국어, 보상/환불 약속 금지)" }`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      return { category: "other", auto_processable: false, confidence: 0, reason: "AI 분류 실패: " + detail };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);

    const category = ["simple_return", "defect", "delivery", "other"].includes(parsed.category)
      ? parsed.category
      : "other";
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));

    return {
      category,
      auto_processable: Boolean(parsed.auto_processable),
      confidence,
      reason: String(parsed.reason || "").slice(0, 500),
    };
  } catch (e) {
    return { category: "other", auto_processable: false, confidence: 0, reason: "AI 분류 예외: " + e.message };
  }
}

// ── 룰 엔진 ───────────────────────────────────────────────────

// 분류 + 클레임 + 룰 → 처리 결정.
// 반환: { decision: "approve"|"hold", notify, reason }
export function decide(classification, claim, rules) {
  const { category, confidence, auto_processable } = classification;

  if (!rules.enabled) {
    return { decision: "hold", notify: false, reason: "자동처리 비활성화(셀러 설정)" };
  }
  // 교환은 재배송 절차가 필요해 자동승인 대상에서 제외 → 항상 보류.
  if (claim.claimType === "EXCHANGE") {
    return { decision: "hold", notify: rules.notify_on_hold, reason: "교환 클레임은 셀러 확인 필요" };
  }
  // 자동승인 가능 클레임 유형은 반품/취소뿐.
  if (claim.claimType !== "RETURN" && claim.claimType !== "CANCEL") {
    return { decision: "hold", notify: rules.notify_on_hold, reason: "자동승인 미지원 클레임 유형: " + (claim.claimType || "미상") };
  }
  // 신뢰도 미달 → 보류.
  if (confidence < rules.confidence_threshold) {
    return { decision: "hold", notify: rules.notify_on_hold, reason: `AI 신뢰도 미달(${confidence} < ${rules.confidence_threshold})` };
  }

  if (category === "simple_return") {
    if (rules.auto_approve_simple_return && auto_processable && claim.amount <= rules.simple_return_max_amount) {
      return { decision: "approve", notify: false, reason: `단순변심 자동승인(금액 ${claim.amount} ≤ 기준 ${rules.simple_return_max_amount})` };
    }
    return { decision: "hold", notify: rules.notify_on_hold, reason: `단순변심이나 자동승인 조건 미충족(금액 ${claim.amount})` };
  }

  if (category === "defect") {
    if (rules.auto_approve_defect) {
      return { decision: "approve", notify: rules.notify_on_defect, reason: "상품하자 자동승인" };
    }
    return { decision: "hold", notify: rules.notify_on_hold, reason: "상품하자(셀러 확인 설정)" };
  }

  // delivery / other → 보류 + 셀러 판단 요청.
  return { decision: "hold", notify: rules.notify_on_hold, reason: `${CATEGORY_LABEL[category] || category} — 셀러 판단 필요` };
}

// ── 커머스 API: 승인 처리 ─────────────────────────────────────

// 클레임 유형별 승인 엔드포인트 호출. 성공 시 응답 반환, 실패 시 throw.
export async function approveClaim(creds, productOrderId, claimType) {
  const base = `/external/v1/pay-order/seller/product-orders/${encodeURIComponent(productOrderId)}/claim`;
  const path =
    claimType === "RETURN" ? `${base}/return/approve` :
    claimType === "CANCEL" ? `${base}/cancel/approve` :
    null;
  if (!path) {
    const e = new Error("승인 미지원 클레임 유형: " + claimType);
    e.status = 400;
    throw e;
  }
  return commerceRequest(path, {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    method: "POST",
    body: {},
  });
}

// 거부(보류 해제 후 셀러 거부). 커머스 API는 클레임 거부 엔드포인트가 유형별로 다름.
export async function rejectClaim(creds, productOrderId, claimType) {
  const base = `/external/v1/pay-order/seller/product-orders/${encodeURIComponent(productOrderId)}/claim`;
  const path =
    claimType === "RETURN" ? `${base}/return/reject` :
    claimType === "CANCEL" ? `${base}/cancel/reject` :
    null;
  if (!path) {
    const e = new Error("거부 미지원 클레임 유형: " + claimType);
    e.status = 400;
    throw e;
  }
  return commerceRequest(path, {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    method: "POST",
    body: {},
  });
}

// ── 감사 로그 ─────────────────────────────────────────────────

// navone_claims 에 처리 기록 upsert (store_id+product_order_id 유니크).
// ⚠️ 자동승인은 반드시 이 함수로 로그를 남긴다(감사 추적 필수).
export async function logClaim(row) {
  return sbUpsert("navone_claims", {
    ...row,
    updated_at: new Date().toISOString(),
  }, "store_id,product_order_id");
}

// ── Telegram 포맷 ─────────────────────────────────────────────

export function buildTelegramMessage(claim, classification, result) {
  const cat = CATEGORY_LABEL[classification.category] || classification.category;
  const head =
    result.decision === "approve" ? "✅ 클레임 자동승인" : "⏸ 클레임 보류 (셀러 판단 요청)";
  return (
    `<b>${head}</b>\n\n` +
    `상품: ${escapeHtml(claim.productName)}\n` +
    `유형: ${escapeHtml(claim.claimType || "미상")} / 분류: ${escapeHtml(cat)}\n` +
    `금액: ${claim.amount.toLocaleString()}원\n` +
    `AI 신뢰도: ${classification.confidence}\n` +
    `사유: ${escapeHtml((claim.claimReason || "").slice(0, 120))}\n` +
    `결정: ${escapeHtml(result.reason)}`
  );
}

// ── 단일 클레임 처리 (분류 → 결정 → 승인 → 로그 → 알림) ────────

// 반환: { productOrderId, decision, category, confidence, approved, error }
export async function processOneClaim(claim, { storeId, creds, rules, tgChatId }) {
  const classification = await classifyClaim(claim);
  const result = decide(classification, claim, rules);

  let approved = false;
  let actionResult = null;
  let error = null;

  if (result.decision === "approve") {
    try {
      actionResult = await approveClaim(creds, claim.productOrderId, claim.claimType);
      approved = true;
    } catch (e) {
      error = e.message;
      actionResult = { error: e.message, detail: e.detail || null };
      result.decision = "hold"; // 승인 실패 → 보류로 강등, 셀러 알림
      result.notify = true;
      result.reason = "자동승인 시도 실패 → 보류: " + e.message;
    }
  }

  // 감사 로그 (성공/실패 무관하게 기록)
  try {
    await logClaim({
      store_id: storeId,
      product_order_id: claim.productOrderId,
      claim_type: claim.claimType,
      claim_status: claim.claimStatus,
      product_name: claim.productName,
      claim_reason: claim.claimReason,
      amount: claim.amount,
      category: classification.category,
      ai_confidence: classification.confidence,
      ai_reason: classification.reason,
      decision: result.decision,
      decided_by: "ai",
      action_result: actionResult,
      notified: false,
    });
  } catch (e) {
    error = (error ? error + "; " : "") + "로그 저장 실패: " + e.message;
  }

  // Telegram 알림
  let notified = false;
  if (result.notify) {
    const tg = await sendTelegram(buildTelegramMessage(claim, classification, result), tgChatId);
    notified = !!tg.ok;
    if (notified) {
      try {
        await sbUpsert("navone_claims", {
          store_id: storeId,
          product_order_id: claim.productOrderId,
          notified: true,
          updated_at: new Date().toISOString(),
        }, "store_id,product_order_id");
      } catch { /* 알림 플래그 갱신 실패는 무시 */ }
    }
  }

  return {
    productOrderId: claim.productOrderId,
    decision: result.decision,
    category: classification.category,
    confidence: classification.confidence,
    approved,
    notified,
    error,
  };
}

export { CATEGORY_LABEL };
