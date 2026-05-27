// =============================================
// NavOne Vercel API — POST /api/qa/auto-process
// 전체 미답변 상품 Q&A 에 AI 답변 일괄 생성 + 등록.
//   Body: { licenseKey(필수), limit(선택, 처리 최대 건수) }
//
// Agent 자동모드 연동: 동일 로직을 run(config) 로도 export.
//   const { run } = await import(".../api/qa/auto-process.js");
//   await run({ licenseKey });  // { success, processed, errors }
// =============================================

import { setCors, handlePreflight, assertEnv, sendError } from "../../lib/supabase.js";
import { getStoreByLicense, autoProcessQa } from "../../lib/qa-reply.js";

async function process({ licenseKey, limit }) {
  assertEnv();
  const store = await getStoreByLicense(licenseKey);
  const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : Infinity;
  return autoProcessQa(store, { limit: lim });
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    const { licenseKey, limit } = req.body || {};
    const out = await process({ licenseKey, limit });
    return res.status(200).json({ success: true, data: out });
  } catch (err) {
    return sendError(res, err);
  }
}

// 자동모드 표준 인터페이스.
// @param {Object} config - { licenseKey, limit? }
// @returns {Promise<{ success, processed, errors }>}
export async function run(config = {}) {
  try {
    const out = await process(config);
    return { success: out.errors === 0, processed: out.processed, errors: out.errors };
  } catch (e) {
    return { success: false, processed: 0, errors: [e.message] };
  }
}
