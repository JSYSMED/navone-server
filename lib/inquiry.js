// =============================================
// NavOne — 고객문의(Q&A) 도메인 로직 (커머스 API v1.4.0 연동)
// /api/inquiry/{list,ai-answer,submit}.js 가 공유하는 코어.
// /api 밖(lib/)에 둬서 Vercel이 엔드포인트로 노출하지 않음.
//
// 커머스 문의 API:
//   GET  /external/v1/pay-user/inquiries          미답변 문의 목록 (answered=false)
//   POST /external/v1/pay-user/inquiries/{id}/answer  답변 등록
//
// 인증: 커머스 Bearer 토큰은 확장 프로그램(background.js ensureToken, bcrypt 서명)에서
//       발급해 호출 시 전달한다. 서버는 토큰을 보관하지 않고 그대로 커머스에 위임한다.
// =============================================

import { buildSystemPrompt, buildUserPrompt, generateReply } from "./cs-prompt.js";

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
export async function fetchInquiries({ token, answered = false, page = 1, size = 50, from, to } = {}) {
  if (!token) { const e = new Error("커머스 토큰이 필요합니다."); e.status = 401; throw e; }

  const params = new URLSearchParams({
    page: String(page),
    size: String(size),
    answered: String(answered),
  });
  if (from) params.set("startSearchDate", from);
  if (to) params.set("endSearchDate", to);

  const res = await fetch(COMMERCE_BASE + "/external/v1/pay-user/inquiries?" + params.toString(), {
    headers: { "Authorization": "Bearer " + token },
  });

  if (!res.ok) {
    const text = await res.text();
    const e = new Error("문의 목록 조회 실패 (" + res.status + ")");
    e.status = res.status === 401 ? 401 : 502;
    e.detail = text.substring(0, 200);
    throw e;
  }

  const data = await res.json();
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
export async function submitInquiryAnswer({ token, inquiryId, content }) {
  if (!token) { const e = new Error("커머스 토큰이 필요합니다."); e.status = 401; throw e; }
  if (!inquiryId) { const e = new Error("inquiryId가 필요합니다."); e.status = 400; throw e; }
  if (!content || !content.trim()) { const e = new Error("답변 내용이 비어 있습니다."); e.status = 400; throw e; }

  const res = await fetch(
    COMMERCE_BASE + "/external/v1/pay-user/inquiries/" + encodeURIComponent(inquiryId) + "/answer",
    {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ commentContent: content.trim() }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    const e = new Error("답변 등록 실패 (" + res.status + ")");
    e.status = res.status === 401 ? 401 : 502;
    e.detail = text.substring(0, 200);
    throw e;
  }
  // 일부 응답은 본문 없음(204) — 성공만 반환
  return { success: true };
}

// =============================================
// run() — 풀 오케스트레이션 (필수 인터페이스)
// 미답변 문의를 훑어 AI 답변을 생성하고, auto=true면 등록까지 수행한다.
// 등록 직전 onLog 콜백으로 로그를 남기게 하여 "등록 전 로그 저장" 규칙을 만족.
//
// @param {object}  p
// @param {string}  p.token         커머스 Bearer 토큰 (확장에서 발급)
// @param {object}  p.storeContext  { storeName, tone, customPrompt }
// @param {boolean} p.auto          true면 생성 후 자동 등록, false면 초안만 생성
// @param {number}  p.limit         처리 최대 건수 (기본 전체)
// @param {function} p.onLog        async (event) => {}  — 등록 전 호출(감사 로그)
// @returns {Promise<{ processed, submitted, drafted, errors, results }>}
// =============================================
export async function run({ token, storeContext = {}, auto = false, limit = Infinity, onLog } = {}) {
  const { inquiries } = await fetchInquiries({ token, answered: false });
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

      await submitInquiryAnswer({ token, inquiryId: inquiry.inquiryId, content: gen.reply });
      submitted++;
      results.push({ inquiryId: inquiry.inquiryId, status: "SUBMITTED", reply: gen.reply, tokens: gen.tokens });
    } catch (err) {
      errors++;
      results.push({ inquiryId: inquiry.inquiryId, status: "ERROR", error: err.message });
    }
  }

  return { processed: results.length, submitted, drafted, errors, results };
}
