// =============================================
// NavOne Vercel API — GET /api/claim/pending
// 미처리(CLAIM_REQUESTED) 클레임 목록 조회 (상태 변경 폴링)
//   Query: licenseKey(필수), since(ISO, optional), days(optional, 기본 1)
// =============================================

import { setCors, handlePreflight, assertEnv, sbSelect, sendError } from "../../lib/supabase.js";
import {
  getStoreByLicense, fetchChangedClaims, fetchClaimDetails, normalizeClaim,
} from "../../lib/claim-engine.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    assertEnv();
    const { licenseKey, since } = req.query || {};
    const days = Math.min(Math.max(parseInt(req.query?.days || "1", 10) || 1, 1), 31);
    if (!licenseKey) return res.status(400).json({ error: "licenseKey는 필수입니다." });

    const store = await getStoreByLicense(licenseKey);
    if (!store) return res.status(404).json({ error: "등록된 스토어가 없습니다." });
    if (!store.client_id || !store.client_secret) {
      return res.status(400).json({ error: "스토어에 커머스 API 자격증명이 없습니다. store-register 하세요." });
    }

    const creds = { clientId: store.client_id, clientSecret: store.client_secret };
    const from = since || new Date(Date.now() - days * 86400000).toISOString();

    // 1) 변경 상태 폴링 → productOrderId 수집
    const changed = await fetchChangedClaims(creds, from);
    const ids = [...new Set(changed.map((c) => c.productOrderId).filter(Boolean))];

    // 2) 상세 조회 + 정규화
    let claims = [];
    if (ids.length) {
      const details = await fetchClaimDetails(creds, ids);
      const detailById = new Map(
        details.map((d) => [d?.productOrder?.productOrderId || d?.productOrderId, d])
      );
      claims = changed
        .filter((c) => c.productOrderId)
        .map((c) => normalizeClaim(c, detailById.get(c.productOrderId)));
    }

    // 3) 이미 처리된 클레임(navone_claims) 병합 → 상태 표시
    let processedMap = new Map();
    if (ids.length) {
      const inList = ids.map((id) => encodeURIComponent(id)).join(",");
      const rows = await sbSelect(
        "navone_claims",
        "store_id=eq." + encodeURIComponent(store.id) +
          "&product_order_id=in.(" + inList + ")" +
          "&select=product_order_id,decision,decided_by,category,notified"
      );
      processedMap = new Map((rows || []).map((r) => [r.product_order_id, r]));
    }

    const result = claims.map((c) => {
      const p = processedMap.get(c.productOrderId);
      return {
        productOrderId: c.productOrderId,
        claimType: c.claimType,
        claimStatus: c.claimStatus,
        productName: c.productName,
        amount: c.amount,
        claimReason: c.claimReason,
        lastChangedDate: c.lastChangedDate,
        processed: !!p,
        decision: p?.decision || null,
        decidedBy: p?.decided_by || null,
        category: p?.category || null,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        storeName: store.store_name,
        since: from,
        count: result.length,
        pending: result.filter((c) => !c.processed),
        claims: result,
      },
    });
  } catch (err) {
    return sendError(res, err);
  }
}
