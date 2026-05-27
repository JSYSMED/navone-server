// =============================================
// NavOne Vercel API — POST /api/claim/manual-decide
// 셀러 수동 승인/거부 (보류된 클레임에 대한 사람 판단)
//   Body: { licenseKey, productOrderId, claimType(RETURN|CANCEL), decision(approve|reject) }
// =============================================

import { setCors, handlePreflight, assertEnv, sbUpsert, sendError } from "../../lib/supabase.js";
import {
  getStoreByLicense, approveClaim, rejectClaim,
} from "../../lib/claim-engine.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    assertEnv();
    const { licenseKey, productOrderId, claimType, decision } = req.body || {};

    if (!licenseKey || !productOrderId || !claimType || !decision) {
      return res.status(400).json({ error: "licenseKey, productOrderId, claimType, decision은 필수입니다." });
    }
    const type = String(claimType).toUpperCase();
    if (type !== "RETURN" && type !== "CANCEL") {
      return res.status(400).json({ error: "claimType은 RETURN 또는 CANCEL이어야 합니다." });
    }
    if (decision !== "approve" && decision !== "reject") {
      return res.status(400).json({ error: "decision은 approve 또는 reject여야 합니다." });
    }

    const store = await getStoreByLicense(licenseKey);
    if (!store) return res.status(404).json({ error: "등록된 스토어가 없습니다." });
    if (!store.client_id || !store.client_secret) {
      return res.status(400).json({ error: "스토어에 커머스 API 자격증명이 없습니다." });
    }

    const creds = { clientId: store.client_id, clientSecret: store.client_secret };

    let actionResult = null;
    try {
      actionResult = decision === "approve"
        ? await approveClaim(creds, productOrderId, type)
        : await rejectClaim(creds, productOrderId, type);
    } catch (e) {
      // 커머스 호출 실패도 감사 로그에 남긴 뒤 에러 반환
      await sbUpsert("navone_claims", {
        store_id: store.id,
        product_order_id: productOrderId,
        claim_type: type,
        decision: decision === "approve" ? "approve_failed" : "reject_failed",
        decided_by: "seller",
        action_result: { error: e.message, detail: e.detail || null },
        updated_at: new Date().toISOString(),
      }, "store_id,product_order_id").catch(() => {});
      e.status = e.status || 502;
      throw e;
    }

    // 감사 로그 (수동 결정)
    await sbUpsert("navone_claims", {
      store_id: store.id,
      product_order_id: productOrderId,
      claim_type: type,
      decision: decision === "approve" ? "approved" : "rejected",
      decided_by: "seller",
      action_result: actionResult,
      updated_at: new Date().toISOString(),
    }, "store_id,product_order_id");

    return res.status(200).json({
      success: true,
      data: { productOrderId, claimType: type, decision },
    });
  } catch (err) {
    return sendError(res, err);
  }
}
