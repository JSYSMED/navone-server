// =============================================
// NavOne — POST /api/order/auto-confirm
// 자동 발주확인. 설정(config.autoConfirmOrders) ON일 때만 자동 실행.
//   Body: { licenseKey(필수), productOrderIds?(생략 시 미발주 전체), notifyOnNew?(bool) }
//   - productOrderIds 명시 → 수동 트리거(즉시 확인)
//   - 생략 → 자동 모드: 설정 OFF면 skip, ON이면 PAY_WAITING 전체 확인
// 커머스 API: POST /external/v1/pay-order/seller/product-orders/confirm
// 실패 시 최대 3회 재시도.
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import {
  getStoreByLicense, fetchPendingOrders, persistOrders, markOrders,
  callCommerce, withRetry, ORDER_API, notify,
} from "./_lib.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    const { licenseKey, productOrderIds, notifyOnNew = true } = req.body || {};
    const store = await getStoreByLicense(licenseKey);

    let ids = Array.isArray(productOrderIds) ? productOrderIds.map(String).filter(Boolean) : null;
    const autoMode = !ids; // ids 미지정 → 자동 모드

    if (autoMode) {
      // 자동 모드는 설정 ON일 때만 동작
      const enabled = store.config?.autoConfirmOrders === true;
      const pending = await fetchPendingOrders(store, { type: "PAY_WAITING" });

      // 신규 주문 감지 알림 (확인 여부와 무관하게)
      if (pending.length && notifyOnNew) {
        await notify(
          `🆕 <b>NavOne 신규 주문</b>\n` +
          `스토어: ${store.storeName}\n` +
          `미발주(발주대기): ${pending.length}건\n` +
          (enabled ? `→ 자동 발주확인 실행` : `→ 자동확인 OFF (수동 확인 필요)`)
        );
      }

      // 들어온 주문은 일단 DB에 기록
      if (pending.length) await persistOrders(store.storeId, pending, { confirmed: false });

      if (!enabled) {
        return res.status(200).json({
          success: true,
          data: { skipped: true, reason: "자동 발주확인 설정 OFF", pendingCount: pending.length },
        });
      }
      ids = pending.map((o) => String(o.productOrderId)).filter(Boolean);
    }

    if (!ids.length) {
      return res.status(200).json({
        success: true,
        data: { confirmed: 0, productOrderIds: [], message: "확인할 미발주 주문이 없습니다." },
      });
    }

    // 발주확인 (최대 3회 재시도)
    const result = await withRetry(
      () => callCommerce(store, ORDER_API.confirm, {
        method: "POST",
        body: { productOrderIds: ids },
      }),
      { max: 3, onRetry: (n, e) => console.warn(`[order/auto-confirm] 재시도 ${n}/3:`, e.message) }
    );

    // 성공/실패 분리 (응답 구조 방어적 파싱)
    const successIds =
      result?.data?.successProductOrderIds ||
      result?.successProductOrderIds || ids;
    const failInfos =
      result?.data?.failProductOrderInfos ||
      result?.failProductOrderInfos || [];

    // DB 플래그 갱신
    await markOrders(store.storeId, successIds, { confirmed: true, order_status: "DELIVERING" });

    if (successIds.length) {
      await notify(
        `✅ <b>발주확인 완료</b>\n스토어: ${store.storeName}\n확인: ${successIds.length}건` +
        (failInfos.length ? `\n⚠️ 실패: ${failInfos.length}건` : "")
      );
    }

    return res.status(200).json({
      success: true,
      data: {
        confirmed: successIds.length,
        failed: failInfos.length,
        productOrderIds: successIds,
        failInfos,
        autoMode,
      },
    });
  } catch (err) {
    console.error("[order/auto-confirm]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "ORDER_CONFIRM_FAILED", err.message || "서버 오류", err.detail);
  }
}
