// =============================================
// NavOne Vercel API — /api/cs-reply.js
// OpenAI GPT-4o-mini로 CS 문의 답변 생성
// =============================================

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const INQUIRY_TYPE_GUIDE = {
  "상품문의": "상품 스펙, 사용법, 호환성 등에 대한 정확한 정보 제공. 모르는 건 확인 후 안내 약속.",
  "배송문의": "배송 현황, 예상 일자, 택배사 정보 안내. 지연 시 사과 + 구체적 사유.",
  "교환/반품": "교환·반품 절차 안내. 고객 불편 공감 + 빠른 처리 약속. 왕복 배송비 정책 명시.",
  "기타": "문의 내용을 정확히 파악하고 성의 있게 답변.",
};

function buildSystemPrompt(storeName, tone, customPrompt) {
  return `당신은 네이버 스마트스토어 "${storeName}"의 CS 담당자입니다.
고객 문의에 대한 답변을 작성합니다.

## 톤
${tone === "친근" ? "친절하고 다정한 말투. '~해요' 체." : tone === "전문적" ? "전문적이고 신뢰감 있는 톤." : "정중하고 프로페셔널한 말투. '~습니다' 체."}

## 핵심 규칙
1. 한국어로 작성
2. 문의 내용에 정확히 답변 (질문 안 빠뜨리기)
3. "고객님" 호칭
4. 150~250자 내외
5. 확실하지 않은 정보는 "확인 후 안내드리겠습니다" 처리
6. 톡톡 상담 또는 고객센터 연락처 유도 가능
7. 이모지 최소 (CS는 리뷰보다 진지)

${customPrompt ? `## 셀러 추가 지시\n${customPrompt}` : ""}

## 절대 하지 말 것
- 확인 안 된 배송일자 단정
- 환불/보상 금액 임의 약속
- 다른 고객 정보 언급
- 고객 탓 돌리기`;
}

function buildUserPrompt(inquiry) {
  const typeGuide = INQUIRY_TYPE_GUIDE[inquiry.type] || INQUIRY_TYPE_GUIDE["기타"];

  return `[${inquiry.type || "일반"} 문의 — ${typeGuide}]

상품명: ${inquiry.productName || "(알 수 없음)"}
문의 유형: ${inquiry.type || "일반"}
문의 내용: ${inquiry.content}

위 문의에 대한 답변을 작성하세요. 답변만 출력하세요.`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { inquiry, storeContext, licenseKey } = req.body;

    if (!inquiry?.content || !storeContext?.storeName) {
      return res.status(400).json({ error: '문의 내용과 스토어명은 필수입니다.' });
    }

    const systemPrompt = buildSystemPrompt(
      storeContext.storeName,
      storeContext.tone || "정중",
      storeContext.customPrompt || ""
    );
    const userPrompt = buildUserPrompt(inquiry);

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 400,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      return res.status(502).json({ error: 'AI 응답 실패', detail: errText.substring(0, 200) });
    }

    const openaiData = await openaiRes.json();
    const reply = openaiData.choices?.[0]?.message?.content || '';
    const usage = openaiData.usage || {};

    return res.status(200).json({
      reply: reply.trim(),
      model: openaiData.model,
      tokens: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 },
    });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: '서버 오류', detail: err.message });
  }
}
