// =============================================
// NavOne — POST /api/order/dispatch
// 송장번호 등록 (단건)
//   Body: { licenseKey(필수), productOrderId(필수),
//           deliveryCompanyCode(필수), trackingNumber(필수),
//           deliveryMethod?("DELIVERY" 기본), dispatchDate?(ISO8601) }
// 커머스 API: POST /external/v1/pay-order/seller/product-orders/dispatch
// 실패 시 최대 3회 재시도.
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import {
  getStoreByLicense, callCommerce, withRetry, markOrders,
  ORDER_API, isValidDeliveryCompany, DELIVERY_COMPANIES,
} from "./_lib.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

// 단건 송장 등록 — bulk에서도 재사용.
export async function dispatchOne(store, { productOrderId, deliveryCompanyCode, trackingNumber, deliveryMethod = "DELIVERY", dispatchDate }) {
  const body = {
    productOrderId: String(productOrderId),
    deliveryMethod,
    deliveryCompanyCode,
    trackingNumber: String(trackingNumber),
    dispatchDate: dispatchDate || new Date().toISOString(),
  };
  const result = await withRetry(
    () => callCommerce(store, ORDER_API.dispatch, { method: "POST", body }),
    { max: 3, onRetry: (n, e) => console.warn(`[order/dispatch] ${productOrderId} 재시도 ${n}/3:`, e.message) }
  );
  await markOrders(store.storeId, [productOrderId], {
    dispatched: true,
    delivery_company_code: deliveryCompanyCode,
    tracking_number: String(trackingNumber),
    order_status: "DELIVERING",
  });
  return result;
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    const { licenseKey, productOrderId, deliveryCompanyCode, trackingNumber, deliveryMethod, dispatchDate } = req.body || {};

    if (!productOrderId || !deliveryCompanyCode || !trackingNumber) {
      return fail(res, 400, "INVALID_INPUT", "productOrderId, deliveryCompanyCode, trackingNumber는 필수입니다.");
    }
    if (!isValidDeliveryCompany(deliveryCompanyCode)) {
      return fail(res, 400, "INVALID_DELIVERY_COMPANY",
        `알 수 없는 배송사 코드: ${deliveryCompanyCode}`, { supported: Object.keys(DELIVERY_COMPANIES) });
    }

    const store = await getStoreByLicense(licenseKey);
    const result = await dispatchOne(store, { productOrderId, deliveryCompanyCode, trackingNumber, deliveryMethod, dispatchDate });

    return res.status(200).json({
      success: true,
      data: { productOrderId, deliveryCompanyCode, trackingNumber, result },
    });
  } catch (err) {
    console.error("[order/dispatch]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "ORDER_DISPATCH_FAILED", err.message || "서버 오류", err.detail);
  }
}
