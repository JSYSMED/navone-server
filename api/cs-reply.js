// =============================================
// NavOne Vercel API — /api/cs-reply.js
// OpenAI GPT-4o-mini로 CS 문의 답변 생성 (DOM 기반 레거시 경로)
//
// 프롬프트 로직은 lib/cs-prompt.js로 분리되어 /api/inquiry/ai-answer.js와 공유한다.
// 신규 커머스 API 기반 경로는 /api/inquiry/* 사용. 이 엔드포인트는 하위 호환용으로 유지.
// =============================================

import { buildSystemPrompt, buildUserPrompt, generateReply } from "../lib/cs-prompt.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { inquiry, storeContext } = req.body || {};

    if (!inquiry?.content || !storeContext?.storeName) {
      return res.status(400).json({ error: '문의 내용과 스토어명은 필수입니다.' });
    }

    // 레거시 동작 유지: 문의 답변 분량 250자
    const opts = { maxChars: 250 };
    const systemPrompt = buildSystemPrompt(
      storeContext.storeName,
      storeContext.tone || "정중",
      storeContext.customPrompt || "",
      opts,
    );
    const userPrompt = buildUserPrompt(inquiry, opts);

    const out = await generateReply({ systemPrompt, userPrompt, maxTokens: 400, apiKey: OPENAI_API_KEY });
    return res.status(200).json(out);
  } catch (err) {
    const status = err.status || 500;
    console.error('cs-reply error:', status, err.message, err.detail);
    return res.status(status).json({ error: err.message || '서버 오류', detail: err.detail });
  }
}
