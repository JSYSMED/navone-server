// =============================================
// NavOne Vercel API — /api/review-reply.js
// OpenAI GPT-4o-mini로 리뷰 답글 생성
// =============================================

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ALLOWED_ORIGINS = [
  'chrome-extension://',  // 크롬 확장에서 호출
];

// 별점별 프롬프트 가이드
const RATING_GUIDE = {
  high: `[5점 리뷰 — 감동+재구매 유도]
- 리뷰 내용 중 구체적 포인트(배송, 품질, 착용감 등)를 반드시 1개 이상 언급
- 사진/영상 리뷰면 "예쁘게 찍어주셔서" 또는 "생생한 후기" 감사 표현
- 자연스럽게 재구매 또는 다른 상품 추천 유도
- 밝고 따뜻한 톤, 이모지 1~2개`,

  mid: `[3~4점 리뷰 — 감사+개선 의지]
- 감사 인사로 시작
- 아쉬웠던 부분을 정확히 짚어서 공감 ("말씀하신 부분은...")
- 구체적 개선 계획 또는 팁 제공 (사이즈 안내, 사용법 등)
- 추가 문의는 톡톡 상담 유도
- 차분하고 성의있는 톤`,

  low: `[1~2점 리뷰 — 사과+해결방안]
- 진심어린 사과로 시작 (변명 X)
- 고객이 겪은 불편을 구체적으로 언급
- 교환/환불/재발송 등 명확한 해결방안 제시
- 톡톡 또는 고객센터로 직접 연락 요청
- 정중하고 책임감 있는 톤, 이모지 자제`
};

// 톤 설정별 스타일 가이드
const TONE_GUIDE = {
  "친근": "친구같이 다정하고 따뜻한 말투. '~해요', '~네요' 체. 이모지 자연스럽게 사용. 예: '어머 고객님~ 사진 너무 예쁘게 찍어주셨네요 😍'",
  "정중": "정중하고 프로페셔널한 말투. '~습니다', '~드리겠습니다' 체. 이모지 최소. 예: '소중한 리뷰 남겨주셔서 진심으로 감사드립니다.'",
  "전문적": "브랜드 전문가 느낌. 상품 지식을 활용한 답변. 간결하고 신뢰감 있는 톤. 예: '해당 제품은 ~에 최적화되어 있어 만족하셨을 거예요.'",
};

function buildSystemPrompt(storeName, tone, customPrompt) {
  return `당신은 네이버 스마트스토어 "${storeName}"의 고객 응대 전문가입니다.
고객 리뷰에 대한 답글을 작성합니다.

## 톤
${TONE_GUIDE[tone] || TONE_GUIDE["정중"]}

## 핵심 규칙
1. 한국어로 작성
2. 리뷰 내용에 구체적으로 반응 (복붙 느낌 절대 X)
3. "고객님" 호칭 사용
4. 100~150자 내외 (너무 길면 안 읽힘)
5. 다른 리뷰와 겹치지 않는 자연스러운 표현
6. 스토어찜, 소식받기, 재구매 유도는 자연스럽게 (억지 X)
7. 과장된 감탄사나 반복 표현 금지 ("정말 정말 감사합니다!!" 같은 거 X)
8. "저희 스토어" 또는 "${storeName}" 자연스럽게 언급 가능

${customPrompt ? `## 셀러 추가 지시\n${customPrompt}` : ""}

## 절대 하지 말 것
- 영어 섞어쓰기
- "AI가 작성" 같은 메타 언급
- 고객 닉네임 직접 호명 (개인정보)
- 할인/쿠폰 임의 약속
- 경쟁사 언급`;
}

function buildUserPrompt(review) {
  const ratingGroup = review.rating >= 5 ? "high" : review.rating >= 3 ? "mid" : "low";
  const guide = RATING_GUIDE[ratingGroup];

  return `${guide}

상품명: ${review.productName || "(알 수 없음)"}
별점: ${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)} (${review.rating}점)
${review.photoCount > 0 ? `사진: ${review.photoCount}장` : "사진: 없음"}
리뷰 내용: ${review.content}

위 리뷰에 맞는 답글을 작성하세요. 답글만 출력하세요.`;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { review, storeContext, licenseKey } = req.body;

    // 입력 검증
    if (!review?.content || !storeContext?.storeName) {
      return res.status(400).json({ error: '리뷰 내용과 스토어명은 필수입니다.' });
    }

    // TODO: 라이선스 키 검증 (Supabase 연동 시)
    // if (!await validateLicense(licenseKey)) {
    //   return res.status(403).json({ error: '유효하지 않은 라이선스입니다.' });
    // }

    const systemPrompt = buildSystemPrompt(
      storeContext.storeName,
      storeContext.tone || "정중",
      storeContext.customPrompt || ""
    );
    const userPrompt = buildUserPrompt(review);

    // OpenAI API 호출
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('OpenAI API error:', openaiRes.status, errText);
      return res.status(502).json({ error: 'AI 응답 실패', detail: errText.substring(0, 200) });
    }

    const openaiData = await openaiRes.json();
    const reply = openaiData.choices?.[0]?.message?.content || '';
    const usage = openaiData.usage || {};

    return res.status(200).json({
      reply: reply.trim(),
      model: openaiData.model,
      tokens: {
        input: usage.prompt_tokens || 0,
        output: usage.completion_tokens || 0,
      },
    });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: '서버 오류', detail: err.message });
  }
}
