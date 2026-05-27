// =============================================
// NavOne — 발주/송장 공통 모듈 (Agent C)
// `_` 프리픽스 → Vercel이 엔드포인트로 노출하지 않는 내부 헬퍼.
//
// 의존:
//   ../../lib/commerce-auth.js  (공유, READ ONLY) — 커머스 API 인증/호출
//   ../../lib/supabase.js       (공유, READ ONLY) — 스토어/주문 저장
//   ../../lib/telegram.js       (Agent D, 선택) — 있으면 사용, 없으면 직접 호출
// =============================================

import { commerceRequest } from "../../lib/commerce-auth.js";
import { sbSelect, sbUpsert, getStoreIdByLicense } from "../../lib/supabase.js";

// ---- 커머스 API 경로 ----
export const ORDER_API = {
  lastChanged: "/external/v1/pay-order/seller/product-orders/last-changed-statuses",
  query: "/external/v1/pay-order/seller/product-orders/query",
  confirm: "/external/v1/pay-order/seller/product-orders/confirm",
  dispatch: "/external/v1/pay-order/seller/product-orders/dispatch",
};

// ---- 배송사 코드 (네이버 커머스 표준) ----
// 권위 있는 전체 목록: GET /external/v1/pay-order/seller/delivery-companies
export const DELIVERY_COMPANIES = {
  CJGLS: "CJ대한통운",
  HANJIN: "한진택배",
  LOTTE: "롯데택배",
  EPOST: "우체국택배",
  LOGEN: "로젠택배",
  KDEXP: "경동택배",
  CVSNET: "GS Postbox 편의점택배",
  HYUNDAI: "롯데글로벌(현대)",
  DAESIN: "대신택배",
  ILYANG: "일양로지스",
  GTX: "GTX로지스",
  CHUNIL: "천일택배",
  KGB: "KGB택배",
  DHL: "DHL",
  FEDEX: "FedEx",
  EMS: "우체국 EMS",
};

export function isValidDeliveryCompany(code) {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(DELIVERY_COMPANIES, code);
}

// ---- RPS 가드용 sleep (일괄 처리 시 500ms 딜레이) ----
export const RPS_DELAY_MS = 500;
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 재시도 래퍼 (발주확인 등 실패 시 최대 3회).
 * @param {() => Promise<any>} fn
 * @param {{ max?: number, baseDelayMs?: number, onRetry?: (attempt:number, err:Error)=>void }} opts
 */
export async function withRetry(fn, { max = 3, baseDelayMs = 500, onRetry } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // 4xx 인증/입력 오류는 재시도해도 의미 없음 (429 제외)
      const s = err && err.status;
      if (s && s >= 400 && s < 500 && s !== 429) throw err;
      if (attempt < max) {
        if (onRetry) onRetry(attempt, err);
        await sleep(baseDelayMs * attempt); // 선형 백오프
      }
    }
  }
  throw lastErr;
}

/**
 * license_key → 스토어 자격증명/설정 로드.
 * @returns {Promise<{storeId, storeName, clientId, clientSecret, config}>}
 */
export async function getStoreByLicense(licenseKey) {
  if (!licenseKey) {
    const e = new Error("licenseKey는 필수입니다.");
    e.status = 400;
    throw e;
  }
  const rows = await sbSelect(
    "stores",
    "license_key=eq." + encodeURIComponent(licenseKey) +
      "&select=id,store_name,client_id,client_secret,config&limit=1"
  );
  if (!Array.isArray(rows) || !rows.length) {
    const e = new Error("등록되지 않은 라이선스입니다.");
    e.status = 404;
    throw e;
  }
  const r = rows[0];
  if (!r.client_id || !r.client_secret) {
    const e = new Error("스토어에 커머스 API 키(clientId/clientSecret)가 설정되지 않았습니다.");
    e.status = 400;
    throw e;
  }
  return {
    storeId: r.id,
    storeName: r.store_name,
    clientId: r.client_id,
    clientSecret: r.client_secret,
    config: r.config || {},
  };
}

// ---- 커머스 호출 단축 헬퍼 (store에서 자격증명 주입) ----
export function callCommerce(store, path, { method = "GET", query, body } = {}) {
  return commerceRequest(path, {
    clientId: store.clientId,
    clientSecret: store.clientSecret,
    method,
    query,
    body,
  });
}

/**
 * 미발주(결제완료·발주대기) 주문 조회.
 * 1) last-changed-statuses 로 변경 productOrderId 수집
 * 2) product-orders/query 로 상세 조회
 * @param {object} store
 * @param {{ from?: string, type?: string }} opts  ISO8601 lastChangedFrom, lastChangedType
 * @returns {Promise<Array>} 정규화된 주문 목록
 */
export async function fetchPendingOrders(store, { from, type = "PAY_WAITING" } = {}) {
  // 기본 조회 구간: 최근 24시간
  const lastChangedFrom = from || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const changed = await callCommerce(store, ORDER_API.lastChanged, {
    query: { lastChangedFrom, lastChangedType: type },
  });

  // 응답 구조 방어적 파싱
  const list =
    changed?.data?.lastChangeStatuses ||
    changed?.lastChangeStatuses ||
    changed?.data ||
    [];
  const ids = [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map((c) => c.productOrderId || c.productOrderID)
        .filter(Boolean)
    ),
  ];
  if (!ids.length) return [];

  // 상세 조회 (한 번에 최대 300건 권장 — 청크)
  const details = [];
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const res = await callCommerce(store, ORDER_API.query, {
      method: "POST",
      body: { productOrderIds: chunk },
    });
    const arr = res?.data || res?.productOrders || (Array.isArray(res) ? res : []);
    if (Array.isArray(arr)) details.push(...arr);
    if (i + 300 < ids.length) await sleep(RPS_DELAY_MS);
  }

  return details.map(normalizeOrder);
}

// 커머스 상세 응답 → navone_orders 친화 형태로 정규화
export function normalizeOrder(d) {
  const po = d.productOrder || d;
  const order = d.order || {};
  return {
    productOrderId: po.productOrderId || d.productOrderId,
    orderId: order.orderId || po.orderId,
    productName: po.productName,
    productOrderStatus: po.productOrderStatus,
    claimStatus: po.claimStatus || null,
    buyerName: order.ordererName || po.ordererName || null,
    quantity: po.quantity ?? null,
    totalAmount: po.totalPaymentAmount ?? order.totalPaymentAmount ?? null,
    orderedAt: order.orderDate || po.orderDate || null,
    raw: d,
  };
}

/**
 * 주문 목록을 navone_orders 에 upsert (store_id + product_order_id 충돌 기준).
 */
export async function persistOrders(storeId, orders, patch = {}) {
  if (!Array.isArray(orders) || !orders.length) return [];
  const now = new Date().toISOString();
  const rows = orders.map((o) => ({
    store_id: storeId,
    product_order_id: String(o.productOrderId),
    order_id: o.orderId || null,
    product_name: o.productName || null,
    order_status: o.productOrderStatus || null,
    claim_status: o.claimStatus || null,
    buyer_name: o.buyerName || null,
    quantity: o.quantity ?? null,
    total_amount: o.totalAmount ?? null,
    ordered_at: o.orderedAt || null,
    raw: o.raw || {},
    updated_at: now,
    ...patch,
  }));
  return sbUpsert("navone_orders", rows, "store_id,product_order_id");
}

/**
 * 특정 주문들의 상태 플래그 갱신 (발주확인/송장등록 후).
 */
export async function markOrders(storeId, productOrderIds, patch) {
  if (!Array.isArray(productOrderIds) || !productOrderIds.length) return [];
  const now = new Date().toISOString();
  const rows = productOrderIds.map((id) => ({
    store_id: storeId,
    product_order_id: String(id),
    updated_at: now,
    ...patch,
  }));
  return sbUpsert("navone_orders", rows, "store_id,product_order_id");
}

/**
 * Telegram 알림. 공유 lib/telegram.js(Agent D)가 있으면 사용, 없으면 직접 호출.
 * 실패해도 본 기능 흐름을 막지 않도록 swallow.
 */
export async function notify(text) {
  try {
    const mod = await import("../../lib/telegram.js");
    const fn =
      mod.sendTelegram || mod.send || mod.notify ||
      mod.default?.sendTelegram || mod.default?.send || mod.default;
    if (typeof fn === "function") {
      await fn(text);
      return true;
    }
  } catch {
    // lib/telegram.js 미존재 — 직접 호출로 폴백
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    return true;
  } catch (e) {
    console.error("Telegram 알림 실패:", e.message);
    return false;
  }
}

export { getStoreIdByLicense };
