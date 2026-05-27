// =============================================
// NavOne — 상품 Q&A AI 자동답글 도메인 로직
// /api/qa/{list,ai-answer,auto-process}.js 가 공유하는 코어.
// /api 밖(lib/)에 둬서 Vercel이 엔드포인트로 노출하지 않음.
//
// 커머스 문의(Q&A) API:
//   GET  /external/v1/pay-user/inquiries               미답변 문의 목록 (answered=false)
//   POST /external/v1/pay-user/inquiries/{id}/answer   답변 등록
//
// 자격증명: stores 테이블(license_key)에서 client_id/client_secret 조회 →
//           lib/commerce-auth.js commerceRequest 가 bcrypt 서명/토큰 발급까지 위임.
// AI: GPT-4o-mini (process.env.OPENAI_API_KEY). 프롬프트 빌더는 lib/cs-prompt.js 재사용.
// =============================================

import { commerceRequest } from "./commerce-auth.js";
import { generateReply } from "./cs-prompt.js";
import { sbSelect } from "./supabase.js";

const QA_API = {
  list: "/external/v1/pay-user/inquiries",
  answer: (id) => "/external/v1/pay-user/inquiries/" + encodeURIComponent(id) + "/answer",
};

const QA_MAX_CHARS = 150; // 답변 기본 분량 제한
const RPS_DELAY_MS = 500; // 일괄 처리 시 커머스 RPS 가드

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =============================================
// license_key → 스토어 자격증명/설정 로드
// (api/order/_lib.js getStoreByLicense 와 동일 패턴)
// @returns {Promise<{storeId, storeName, clientId, clientSecret, config}>}
// =============================================
export async function getStoreByLicense(licenseKey) {
  if (!licenseKey) {
    const e = new Error("licenseKey는 필수입니다.");
    e.status = 400;
    throw e;
  }
  const rows = await sbSelect(
    "stores",
    "license_key=eq." + encodeURIComponent(licenseKey) +
      "&select=id,store_name,client_id,client_secret,config&limit=1"
  );
  if (!Array.isArray(rows) || !rows.length) {
    const e = new Error("등록되지 않은 라이선스입니다.");
    e.status = 404;
    throw e;
  }
  const r = rows[0];
  if (!r.client_id || !r.client_secret) {
    const e = new Error("스토어에 커머스 API 키(clientId/clientSecret)가 설정되지 않았습니다.");
    e.status = 400;
    throw e;
  }
  return {
    storeId: r.id,
    storeName: r.store_name,
    clientId: r.client_id,
    clientSecret: r.client_secret,
    config: r.config || {},
  };
}

// --- 응답 필드 정규화 (커머스 응답 키가 버전/문서에 따라 다를 수 있어 폭넓게 매핑) ---
function pick(obj, keys, dflt = "") {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return dflt;
}

function normalizeQa(raw) {
  return {
    inquiryId: String(pick(raw, ["inquiryNo", "inquiryId", "id", "questionId"], "")),
    productName: pick(raw, ["productName", "productNm"], ""),
    productNo: String(pick(raw, ["channelProductNo", "productNo", "productId", "originProductNo"], "")),
    category: pick(raw, ["category", "inquiryCategory", "categoryName"], ""),
    title: pick(raw, ["title", "inquiryTitle"], ""),
    content: pick(raw, ["inquiryContent", "content", "question", "contents"], ""),
    writerId: pick(raw, ["writerId", "customerId", "memberId", "writerName"], ""),
    date: pick(raw, ["inquiryRegistrationDateTime", "registrationDateTime", "createDate", "createdAt"], ""),
    answered:
      pick(raw, ["answered", "answerYn"], false) === true ||
      pick(raw, ["answerYn"], "") === "Y",
    raw,
  };
}

// =============================================
// 미답변 Q&A 목록 조회 (commerceRequest 로 자격증명 주입)
// =============================================
export async function fetchUnansweredQa(store, { page = 1, size = 50, from, to } = {}) {
  const query = { page: String(page), size: String(size), answered: "false" };
  if (from) query.startSearchDate = from;
  if (to) query.endSearchDate = to;

  const data = await commerceRequest(QA_API.list, {
    clientId: store.clientId,
    clientSecret: store.clientSecret,
    method: "GET",
    query,
  });

  // 커머스 페이지 응답: contents | items | data 배열 중 하나
  const list = Array.isArray(data)
    ? data
    : data?.contents || data?.items || data?.data || [];
  const inquiries = (Array.isArray(list) ? list : [])
    .map(normalizeQa)
    // answered=false 요청해도 방어적으로 한 번 더 필터
    .filter((q) => !q.answered && q.inquiryId);

  return {
    inquiries,
    total: pick(data || {}, ["totalElements", "totalCount", "total"], inquiries.length),
    page,
    size,
  };
}

// =============================================
// 상품 Q&A 전문 답변 시스템 프롬프트
// 보상/환불·금전적 약속, 타사 언급, 확인 불가 정보 단정을 절대 금지.
// =============================================
function buildQaSystemPrompt(storeName) {
  return `당신은 네이버 스마트스토어 "${storeName || "스토어"}"의 상품 Q&A 전문 답변 담당자입니다.
구매 전 고객이 남긴 상품 문의(Q&A)에 정확하고 신뢰감 있게 답변합니다.

## 톤
정중하고 프로페셔널한 말투. '~습니다' 체. "고객님" 호칭 사용.

## 핵심 규칙
1. 한국어로 작성
2. 상품 스펙·정보를 기반으로 정확하게 답변 (질문을 빠뜨리지 않기)
3. ${QA_MAX_CHARS}자 이내로 간결하게
4. 답변 본문만 출력 (인사말 외 불필요한 사족 금지)

## 절대 하지 말 것 (위반 시 법적·정책적 문제 발생)
- 보상·환불·교환·할인·쿠폰 등 금전적 약속 절대 금지
- 어떠한 금전적·금전 환산 가능한 약속도 금지
- 경쟁사·타사 제품 언급 금지
- 확인되지 않은 정보(재고·배송일자·스펙 등) 단정 금지
  → 확실하지 않으면 "확인 후 답변 드리겠습니다"로 안내 (추측 금지)
- 다른 고객 정보 언급 금지
- "AI가 작성" 같은 메타 언급 금지`;
}

function buildQaUserPrompt(qa) {
  return `상품명: ${qa.productName || "(알 수 없음)"}
문의 제목: ${qa.title || "(없음)"}
문의 내용: ${qa.content}

위 상품 Q&A에 대한 답변을 ${QA_MAX_CHARS}자 이내로 작성하세요. 답변 본문만 출력하세요.`;
}

// =============================================
// AI 답변 생성 (등록 안 함) — GPT-4o-mini
// =============================================
export async function generateQaReply({ qa, storeName } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const e = new Error("OPENAI_API_KEY 미설정");
    e.status = 500;
    throw e;
  }
  if (!qa || !qa.content) {
    const e = new Error("문의 내용이 필요합니다.");
    e.status = 400;
    throw e;
  }

  return generateReply({
    systemPrompt: buildQaSystemPrompt(storeName),
    userPrompt: buildQaUserPrompt(qa),
    maxTokens: 400,
    apiKey,
  });
}

// =============================================
// 답변 등록 (커머스 API POST)
// =============================================
export async function submitQaReply(store, inquiryId, content) {
  if (!inquiryId) {
    const e = new Error("inquiryId가 필요합니다.");
    e.status = 400;
    throw e;
  }
  if (!content || !content.trim()) {
    const e = new Error("답변 내용이 비어 있습니다.");
    e.status = 400;
    throw e;
  }

  await commerceRequest(QA_API.answer(inquiryId), {
    clientId: store.clientId,
    clientSecret: store.clientSecret,
    method: "POST",
    body: { commentContent: content.trim() },
  });
  return { success: true };
}

// =============================================
// 단건 처리: AI 답변 생성 + 등록
// =============================================
export async function answerOneQa(store, inquiryId) {
  const { inquiries } = await fetchUnansweredQa(store);
  const qa = inquiries.find((q) => q.inquiryId === String(inquiryId));
  if (!qa) {
    const e = new Error("미답변 문의에서 해당 inquiryId를 찾을 수 없습니다.");
    e.status = 404;
    throw e;
  }

  const gen = await generateQaReply({ qa, storeName: store.storeName });
  console.log("[qa] generated reply", { inquiryId: qa.inquiryId, productName: qa.productName, tokens: gen.tokens });

  await submitQaReply(store, qa.inquiryId, gen.reply);
  console.log("[qa] submitted reply", { inquiryId: qa.inquiryId });

  return { inquiryId: qa.inquiryId, productName: qa.productName, reply: gen.reply, tokens: gen.tokens };
}

// =============================================
// 일괄 처리: 전체 미답변 문의에 AI 답변 생성 + 등록
// @returns {Promise<{processed, submitted, errors, results, storeName}>}
// =============================================
export async function autoProcessQa(store, { limit = Infinity } = {}) {
  const { inquiries } = await fetchUnansweredQa(store);
  console.log("[qa] auto-process start", { storeName: store.storeName, unanswered: inquiries.length });

  const results = [];
  let submitted = 0;
  let errors = 0;

  const targets = inquiries.slice(0, limit);
  for (let i = 0; i < targets.length; i++) {
    const qa = targets[i];
    try {
      const gen = await generateQaReply({ qa, storeName: store.storeName });
      // 등록 직전 로그 저장
      console.log("[qa] generated reply", { inquiryId: qa.inquiryId, productName: qa.productName, tokens: gen.tokens });

      await submitQaReply(store, qa.inquiryId, gen.reply);
      submitted++;
      console.log("[qa] submitted reply", { inquiryId: qa.inquiryId });
      results.push({ inquiryId: qa.inquiryId, status: "SUBMITTED", reply: gen.reply, tokens: gen.tokens });
    } catch (err) {
      errors++;
      console.error("[qa] error", { inquiryId: qa.inquiryId, error: err.message });
      results.push({ inquiryId: qa.inquiryId, status: "ERROR", error: err.message });
    }
    // 커머스 RPS 가드
    if (i + 1 < targets.length) await sleep(RPS_DELAY_MS);
  }

  console.log("[qa] auto-process done", { storeName: store.storeName, processed: results.length, submitted, errors });
  return { processed: results.length, submitted, errors, results, storeName: store.storeName };
}
