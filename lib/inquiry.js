// =============================================
// NavOne — 고객문의(Q&A) 도메인 로직 (커머스 API v1.4.0 연동)
// /api/inquiry/{list,ai-answer,submit}.js 가 공유하는 코어.
// /api 밖(lib/)에 둬서 Vercel이 엔드포인트로 노출하지 않음.
//
// 커머스 문의 API:
//   GET  /external/v1/pay-user/inquiries          미답변 문의 목록 (answered=false)
//   POST /external/v1/pay-user/inquiries/{id}/answer  답변 등록
//
// 인증: licenseKey → store(client_id/secret) → commerceRequest가 토큰 발급/캐시.
//       서버 중심 인증이라 대시보드/모바일에서도 호출 가능(리모트컨트롤 일관성).
// =============================================

// 인증: qa·정산과 동일하게 licenseKey 기반(서버가 store의 client_id/secret로 토큰 발급).
//       commerceRequest가 토큰 발급/캐시를 처리하므로 확장이 토큰을 들고 있을 필요가 없다.
//       (구버전은 확장이 x-naver-token으로 토큰을 직접 전달했으나, 리모트컨트롤·대시보드
//        호출을 위해 store 기반으로 통일.)
// =============================================

import { buildSystemPrompt, buildUserPrompt, generateReply } from "./cs-prompt.js";
import { commerceRequest } from "./commerce-auth.js";
export { getStoreByLicense } from "./qa-reply.js";

const COMMERCE_BASE = "https://api.commerce.naver.com";
const INQUIRY_MAX_CHARS = 150; // 문의 답변 기본 분량 제한

// --- 응답 필드 정규화 (커머스 응답 키가 버전/문서에 따라 다를 수 있어 폭넓게 매핑) ---
function pick(obj, keys, dflt = "") {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return dflt;
}

function normalizeInquiry(raw) {
  return {
    inquiryId: String(pick(raw, ["inquiryNo", "inquiryId", "id", "questionId"], "")),
    productName: pick(raw, ["productName", "productNm"], ""),
    productNo: String(pick(raw, ["channelProductNo", "productNo", "productId", "originProductNo"], "")),
    category: pick(raw, ["category", "inquiryCategory", "categoryName"], ""),
    title: pick(raw, ["title", "inquiryTitle"], ""),
    content: pick(raw, ["inquiryContent", "content", "question", "contents"], ""),
    writerId: pick(raw, ["writerId", "customerId", "memberId", "writerName"], ""),
    date: pick(raw, ["inquiryRegistrationDateTime", "registrationDateTime", "createDate", "createdAt"], ""),
    answered: pick(raw, ["answered", "answerYn"], false) === true ||
      pick(raw, ["answerYn"], "") === "Y",
    raw,
  };
}

// =============================================
// 미답변 문의 목록 조회
// =============================================
export async function fetchInquiries({ store, answered = false, page = 1, size = 50, from, to } = {}) {
  if (!store || !store.clientId || !store.clientSecret) {
    const e = new Error("store 인증 정보가 필요합니다."); e.status = 401; throw e;
  }

  // 커머스 고객문의 API는 startSearchDate/endSearchDate가 필수.
  // 미지정 시 최근 7일로 기본 설정(qa-reply와 동일 정책).
  const fmt = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const query = {
    page: String(page),
    size: String(size),
    answered: String(answered),
    startSearchDate: from || fmt(weekAgo),
    endSearchDate: to || fmt(now),
  };

  const data = await commerceRequest("/external/v1/pay-user/inquiries", {
    clientId: store.clientId,
    clientSecret: store.clientSecret,
    method: "GET",
    query,
  });

  // 커머스 페이지 응답: contents | items | data 배열 중 하나
  const list = Array.isArray(data) ? data
    : (data.contents || data.items || data.data || []);
  const inquiries = list.map(normalizeInquiry)
    // answered=false 요청해도 방어적으로 한 번 더 필터
    .filter(q => answered ? true : !q.answered);

  return {
    inquiries,
    total: pick(data, ["totalElements", "totalCount", "total"], inquiries.length),
    page,
    size,
  };
}

// =============================================
// AI 답변 생성 (등록 안 함)
// =============================================
export async function generateInquiryAnswer({ inquiry, storeContext = {} }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { const e = new Error("OPENAI_API_KEY 미설정"); e.status = 500; throw e; }
  if (!inquiry || !inquiry.content) { const e = new Error("문의 내용이 필요합니다."); e.status = 400; throw e; }

  const storeName = storeContext.storeName || "스토어";
  const tone = storeContext.tone || "정중";
  const opts = { maxChars: INQUIRY_MAX_CHARS };

  const systemPrompt = buildSystemPrompt(storeName, tone, storeContext.customPrompt || "", opts);
  const userPrompt = buildUserPrompt(inquiry, opts);

  return generateReply({ systemPrompt, userPrompt, maxTokens: 400, apiKey });
}

// =============================================
// 답변 등록 (커머스 API POST)
// =============================================
export async function submitInquiryAnswer({ store, inquiryId, content }) {
  if (!store || !store.clientId || !store.clientSecret) { const e = new Error("store 인증 정보가 필요합니다."); e.status = 401; throw e; }
  if (!inquiryId) { const e = new Error("inquiryId가 필요합니다."); e.status = 400; throw e; }
  if (!content || !content.trim()) { const e = new Error("답변 내용이 비어 있습니다."); e.status = 400; throw e; }

  await commerceRequest(
    "/external/v1/pay-user/inquiries/" + encodeURIComponent(inquiryId) + "/answer",
    {
      clientId: store.clientId,
      clientSecret: store.clientSecret,
      method: "POST",
      body: { commentContent: content.trim() },
    }
  );
  // 일부 응답은 본문 없음(204) — 성공만 반환
  return { success: true };
}

// =============================================
// run() — 풀 오케스트레이션 (필수 인터페이스)
// 미답변 문의를 훑어 AI 답변을 생성하고, auto=true면 등록까지 수행한다.
// 등록 직전 onLog 콜백으로 로그를 남기게 하여 "등록 전 로그 저장" 규칙을 만족.
//
// @param {object}  p
// @param {object}  p.store         { clientId, clientSecret, storeName } (licenseKey로 조회)
// @param {object}  p.storeContext  { storeName, tone, customPrompt }
// @param {boolean} p.auto          true면 생성 후 자동 등록, false면 초안만 생성
// @param {number}  p.limit         처리 최대 건수 (기본 전체)
// @param {function} p.onLog        async (event) => {}  — 등록 전 호출(감사 로그)
// @returns {Promise<{ processed, submitted, drafted, errors, results }>}
// =============================================
export async function run({ store, storeContext = {}, auto = false, limit = Infinity, onLog } = {}) {
  const { inquiries } = await fetchInquiries({ store, answered: false });
  const results = [];
  let submitted = 0, drafted = 0, errors = 0;

  for (const inquiry of inquiries.slice(0, limit)) {
    try {
      const gen = await generateInquiryAnswer({ inquiry, storeContext });

      if (!auto) {
        drafted++;
        results.push({ inquiryId: inquiry.inquiryId, status: "DRAFT", reply: gen.reply, tokens: gen.tokens });
        continue;
      }

      // 자동 등록 모드 — 등록 직전 반드시 로그 저장
      if (typeof onLog === "function") {
        await onLog({
          inquiryId: inquiry.inquiryId,
          productName: inquiry.productName,
          inquiryContent: inquiry.content,
          generatedReply: gen.reply,
          finalReply: gen.reply,
          mode: "auto",
        });
      }

      await submitInquiryAnswer({ store, inquiryId: inquiry.inquiryId, content: gen.reply });
      submitted++;
      results.push({ inquiryId: inquiry.inquiryId, status: "SUBMITTED", reply: gen.reply, tokens: gen.tokens });
    } catch (err) {
      errors++;
      results.push({ inquiryId: inquiry.inquiryId, status: "ERROR", error: err.message });
    }
  }

  return { processed: results.length, submitted, drafted, errors, results };
}
