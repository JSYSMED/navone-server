// =============================================
// NavOne Vercel API — POST /api/claim/auto-process
// AI 분류 + 룰 엔진 자동처리 (반품/취소 자동승인, 보류는 Telegram 알림)
//   Body: { licenseKey(필수), since(ISO, optional), days(optional),
//           productOrderIds(optional, 특정 건만 처리) }
//
// Agent F 자동모드 연동: 동일 로직을 run(config) 로도 export.
//   const { run } = await import(".../api/claim/auto-process.js");
//   await run({ licenseKey, since });  // { success, processed, errors }
// =============================================

import { setCors, handlePreflight, assertEnv, sendError } from "../../lib/supabase.js";
import {
  getStoreByLicense, getClaimRules, fetchChangedClaims, fetchClaimDetails,
  normalizeClaim, processOneClaim,
} from "../../lib/claim-engine.js";

// 자동처리 코어. 라우트 핸들러와 run()이 공유.
// 반환: { success, processed, approved, held, errors, results, storeName }
async function autoProcess({ licenseKey, since, days = 1, productOrderIds, tgChatId }) {
  assertEnv();
  if (!licenseKey) {
    const e = new Error("licenseKey는 필수입니다.");
    e.status = 400;
    throw e;
  }

  const store = await getStoreByLicense(licenseKey);
  if (!store) {
    const e = new Error("등록된 스토어가 없습니다.");
    e.status = 404;
    throw e;
  }
  if (!store.client_id || !store.client_secret) {
    const e = new Error("스토어에 커머스 API 자격증명이 없습니다.");
    e.status = 400;
    throw e;
  }

  const creds = { clientId: store.client_id, clientSecret: store.client_secret };
  const rules = await getClaimRules(store.id);

  if (!rules.enabled) {
    return { success: true, processed: 0, approved: 0, held: 0, errors: [], results: [], storeName: store.store_name, note: "자동처리 비활성화" };
  }

  const from = since || new Date(Date.now() - Math.min(Math.max(days, 1), 31) * 86400000).toISOString();

  // 처리 대상 productOrderId 결정
  let ids = Array.isArray(productOrderIds) ? productOrderIds.filter(Boolean) : null;
  let changedById = new Map();
  if (!ids) {
    const changed = await fetchChangedClaims(creds, from);
    changed.forEach((c) => c.productOrderId && changedById.set(c.productOrderId, c));
    ids = [...changedById.keys()];
  }
  if (!ids.length) {
    return { success: true, processed: 0, approved: 0, held: 0, errors: [], results: [], storeName: store.store_name };
  }

  const details = await fetchClaimDetails(creds, ids);
  const detailById = new Map(
    details.map((d) => [d?.productOrder?.productOrderId || d?.productOrderId, d])
  );

  const results = [];
  const errors = [];
  // 순차 처리 (커머스 RPS 가드는 commerce-auth 내부에서 적용됨)
  for (const id of ids) {
    const claim = normalizeClaim(changedById.get(id) || { productOrderId: id }, detailById.get(id));
    if (!claim.productOrderId) continue;
    try {
      const r = await processOneClaim(claim, { storeId: store.id, creds, rules, tgChatId });
      results.push(r);
      if (r.error) errors.push(`${id}: ${r.error}`);
    } catch (e) {
      errors.push(`${id}: ${e.message}`);
      results.push({ productOrderId: id, decision: "error", error: e.message });
    }
  }

  return {
    success: errors.length === 0,
    processed: results.length,
    approved: results.filter((r) => r.approved).length,
    held: results.filter((r) => r.decision === "hold").length,
    errors,
    results,
    storeName: store.store_name,
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    const { licenseKey, since, days, productOrderIds } = req.body || {};
    const out = await autoProcess({ licenseKey, since, days, productOrderIds });
    return res.status(200).json({ success: true, data: out });
  } catch (err) {
    return sendError(res, err);
  }
}

// Agent F 자동모드 표준 인터페이스.
// @param {Object} config - { licenseKey, since?, days?, productOrderIds?, tgChatId? }
// @returns {Promise<{ success, processed, errors }>}
export async function run(config = {}) {
  try {
    const out = await autoProcess(config);
    return { success: out.success, processed: out.processed, errors: out.errors };
  } catch (e) {
    return { success: false, processed: 0, errors: [e.message] };
  }
}
