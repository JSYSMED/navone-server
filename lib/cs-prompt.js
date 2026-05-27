// =============================================
// NavOne — CS/문의 답변 프롬프트 빌더 (공유 헬퍼)
// /api/cs-reply.js (DOM 기반)와 /api/inquiry/ai-answer.js (커머스 API 기반)가
// 동일 프롬프트 로직을 재사용하도록 lib/로 분리.
// /api 밖에 둬서 Vercel이 엔드포인트로 노출하지 않음.
// =============================================

// 문의 유형별 답변 가이드
export const INQUIRY_TYPE_GUIDE = {
  "상품문의": "상품 스펙, 사용법, 호환성 등에 대한 정확한 정보 제공. 모르는 건 확인 후 안내 약속.",
  "배송문의": "배송 현황, 예상 일자, 택배사 정보 안내. 지연 시 사과 + 구체적 사유.",
  "교환/반품": "교환·반품 절차 안내. 고객 불편 공감 + 빠른 처리 약속. 왕복 배송비 정책 명시.",
  "기타": "문의 내용을 정확히 파악하고 성의 있게 답변.",
};

const TONE_GUIDE = {
  "친근": "친절하고 다정한 말투. '~해요' 체. 이모지는 최소한으로.",
  "정중": "정중하고 프로페셔널한 말투. '~습니다' 체.",
  "전문적": "전문적이고 신뢰감 있는 톤. 상품 지식을 활용해 간결하게.",
};

// 답변 분량 가이드(글자 수)는 호출부가 옵션으로 지정. 기본값은 문의(inquiry) 기준 150자.
export function buildSystemPrompt(storeName, tone, customPrompt, opts = {}) {
  const maxChars = opts.maxChars || 150;
  return `당신은 네이버 스마트스토어 "${storeName}"의 CS(고객문의) 담당자입니다.
고객이 남긴 상품 Q&A(문의)에 대한 답변을 작성합니다.

## 톤
${TONE_GUIDE[tone] || TONE_GUIDE["정중"]}

## 핵심 규칙
1. 한국어로 작성
2. 상품 스펙·정보를 기반으로 정확하게 답변 (질문 빠뜨리지 않기)
3. "고객님" 호칭 사용
4. ${maxChars}자 이내로 간결하게
5. 확실하지 않은 정보는 "확인 후 답변 드리겠습니다"로 처리 (추측 금지)
6. 정중하고 친절한 톤 유지

${customPrompt ? `## 셀러 추가 지시\n${customPrompt}\n` : ""}
## 절대 하지 말 것 (위반 시 법적 문제 발생)
- 보상·환불·할인·쿠폰 등 금전적 약속 (공정거래위원회 표시광고법 위반 소지)
- 경쟁사·타사 제품 언급
- 확인되지 않은 배송일자·재고 단정
- 다른 고객 정보 언급
- 고객에게 책임 전가
- "AI가 작성" 같은 메타 언급`;
}

export function buildUserPrompt(inquiry, opts = {}) {
  const type = inquiry.type || "상품문의";
  const typeGuide = INQUIRY_TYPE_GUIDE[type] || INQUIRY_TYPE_GUIDE["기타"];
  const maxChars = opts.maxChars || 150;

  return `[${type} — ${typeGuide}]

상품명: ${inquiry.productName || "(알 수 없음)"}
문의 유형: ${type}
문의 내용: ${inquiry.content}

위 문의에 대한 답변을 ${maxChars}자 이내로 작성하세요. 답변 본문만 출력하세요.`;
}

// OpenAI Chat Completions 호출 공통 래퍼.
// 성공 시 { reply, model, tokens }, 실패 시 status 달린 Error throw.
export async function generateReply({ systemPrompt, userPrompt, maxTokens = 400, apiKey }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error("AI 응답 실패");
    err.status = 502;
    err.detail = errText.substring(0, 200);
    throw err;
  }

  const data = await res.json();
  const reply = (data.choices?.[0]?.message?.content || "").trim();
  const usage = data.usage || {};
  return {
    reply,
    model: data.model,
    tokens: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 },
  };
}
