// =============================================
// NavOne — POST /api/order/dispatch-bulk
// 송장번호 일괄 등록. 여러 주문을 순차 처리 (RPS 제한: 각 호출 사이 500ms 딜레이).
//   Body: {
//     licenseKey(필수),
//     items: [ { productOrderId, deliveryCompanyCode, trackingNumber, deliveryMethod?, dispatchDate? }, ... ]
//   }
// 각 건 실패해도 나머지 계속 진행 — 건별 성공/실패 리포트 반환.
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import {
  getStoreByLicense, sleep, RPS_DELAY_MS, notify,
  isValidDeliveryCompany, DELIVERY_COMPANIES,
} from "./_lib.js";
import { dispatchOne } from "./dispatch.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    const { licenseKey, items } = req.body || {};

    if (!Array.isArray(items) || !items.length) {
      return fail(res, 400, "INVALID_INPUT", "items 배열이 필요합니다.");
    }

    const store = await getStoreByLicense(licenseKey);

    const succeeded = [];
    const failed = [];

    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const { productOrderId, deliveryCompanyCode, trackingNumber } = it;

      // 건별 입력 검증 (전체 중단 없이 스킵)
      if (!productOrderId || !deliveryCompanyCode || !trackingNumber) {
        failed.push({ productOrderId: productOrderId || null, error: "필수값 누락(productOrderId/deliveryCompanyCode/trackingNumber)" });
      } else if (!isValidDeliveryCompany(deliveryCompanyCode)) {
        failed.push({ productOrderId, error: `알 수 없는 배송사 코드: ${deliveryCompanyCode}` });
      } else {
        try {
          await dispatchOne(store, it);
          succeeded.push({ productOrderId, trackingNumber });
        } catch (err) {
          console.error(`[order/dispatch-bulk] ${productOrderId} 실패:`, err.status, err.message);
          failed.push({ productOrderId, error: err.message, status: err.status || 500 });
        }
      }

      // RPS 제한 준수: 마지막 항목이 아니면 500ms 딜레이
      if (i < items.length - 1) await sleep(RPS_DELAY_MS);
    }

    await notify(
      `📦 <b>송장 일괄 등록 완료</b>\n스토어: ${store.storeName}\n` +
      `성공: ${succeeded.length}건 / 실패: ${failed.length}건`
    );

    // 일부 실패해도 처리 자체는 성공 → 200 + 건별 리포트
    return res.status(200).json({
      success: true,
      data: {
        total: items.length,
        succeededCount: succeeded.length,
        failedCount: failed.length,
        succeeded,
        failed,
      },
    });
  } catch (err) {
    console.error("[order/dispatch-bulk]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "ORDER_DISPATCH_BULK_FAILED", err.message || "서버 오류", err.detail);
  }
}
