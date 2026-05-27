// =============================================
// NavOne — GET /api/order/pending
// 미발주(결제완료·발주대기, PAY_WAITING) 주문 목록 조회
//   Query: licenseKey(필수), from(ISO8601, 선택), persist(선택: "1"이면 DB 저장)
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import { getStoreByLicense, fetchPendingOrders, persistOrders } from "./_lib.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    const { licenseKey, from, persist } = req.query || {};

    const store = await getStoreByLicense(licenseKey);
    const orders = await fetchPendingOrders(store, { from, type: "PAY_WAITING" });

    if (persist === "1" || persist === "true") {
      await persistOrders(store.storeId, orders, { confirmed: false });
    }

    return res.status(200).json({
      success: true,
      data: {
        storeName: store.storeName,
        count: orders.length,
        orders,
      },
    });
  } catch (err) {
    console.error("[order/pending]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "ORDER_PENDING_FAILED", err.message || "서버 오류", err.detail);
  }
}
