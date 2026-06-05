// =============================================
// NavOne — GET /api/order/sales-status
// 판매 현황(주문 시점 기준): 날짜 범위 내 무엇이 몇 개 얼마에 팔렸고,
// 단계(productOrderStatus)별 몇 건인지, 정산예정액 합계가 얼마인지.
//   정산(settlement) 페이지와 별개 — 이건 "주문 시점" 스냅샷(정산 전 포함).
//
//   Query:
//     licenseKey (필수)
//     from       (ISO8601, 선택)  생략 시 오늘 0시(KST)
//     to         (ISO8601, 선택)  생략 시 from + 24h
//     rangeType  (선택, 기본 PAYED_DATETIME)
//                PAYED/ORDERED/DISPATCHED/PURCHASE_DECIDED/CLAIM_REQUESTED_DATETIME
//
// 네이버 커머스: GET /external/v1/pay-order/seller/product-orders
//   (조건형 상품 주문 상세 내역 조회) — claim-engine과 동일한 commerceRequest 인증 재사용.
//   네이버 제약상 1회 조회 범위 24h 권장 → 긴 범위는 일자별로 쪼개 호출 후 합산.
// =============================================

import { setCors, handlePreflight } from "../../lib/supabase.js";
import { getStoreByLicense, callCommerce, sleep, RPS_DELAY_MS } from "./_lib.js";

const PRODUCT_ORDERS_PATH = "/external/v1/pay-order/seller/product-orders";
const PAGE_SIZE = 300;
const MAX_PAGES = 10;          // 페이지 안전장치(범위당 최대 ~3000건)
const CHUNK_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const VALID_RANGE_TYPES = new Set([
  "PAYED_DATETIME",
  "ORDERED_DATETIME",
  "DISPATCHED_DATETIME",
  "PURCHASE_DECIDED_DATETIME",
  "CLAIM_REQUESTED_DATETIME",
]);

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

// 절대 시각(Date) → KST(+09:00) ISO 문자열. 커머스 API가 요구하는 형식.
function toKstIso(date) {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return (
    `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())}` +
    `T${p(k.getUTCHours())}:${p(k.getUTCMinutes())}:${p(k.getUTCSeconds())}` +
    `.${p(k.getUTCMilliseconds(), 3)}+09:00`
  );
}

// 오늘 0시(KST)의 절대 시각.
function todayKstMidnight() {
  const k = new Date(Date.now() + KST_OFFSET_MS);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - KST_OFFSET_MS);
}

// [fromDate, toDate)를 최대 24h 청크로 분할(네이버 범위 제약 대응).
function dayChunks(fromDate, toDate) {
  const chunks = [];
  let s = fromDate.getTime();
  const e = toDate.getTime();
  while (s < e) {
    const cend = Math.min(s + CHUNK_MS, e);
    chunks.push({ from: toKstIso(new Date(s)), to: toKstIso(new Date(cend)) });
    s = cend;
  }
  return chunks;
}

// 응답에서 contents 배열 방어적 추출.
function extractContents(raw) {
  return raw?.data?.contents || raw?.contents || raw?.data || [];
}

// pagination.hasNext 방어적 추출.
function hasNext(raw) {
  const pg = raw?.data?.pagination || raw?.pagination;
  return !!(pg && (pg.hasNext === true || pg.hasNext === "true"));
}

// content.{productOrder, order} → 정규화 객체(명세 §처리 3).
function normalize(item) {
  const content = item?.content || item || {};
  const po = content.productOrder || {};
  const o = content.order || {};
  return {
    productOrderId: po.productOrderId || item?.productOrderId || null,
    productName: po.productName || "",
    option: po.productOption || "",
    quantity: po.quantity ?? null,
    salesAmount: po.totalPaymentAmount ?? 0,
    commission: Math.abs(po.paymentCommission || 0) + Math.abs(po.saleCommission || 0),
    expectedSettlement: po.expectedSettlementAmount ?? null, // 정산 예정액(네이버 떼고 줄 돈)
    status: po.productOrderStatus || null,
    inflowPath: po.inflowPath || "",
    ordererName: o.ordererName || null,
    paymentDate: o.paymentDate || null,
    orderDate: o.orderDate || null,
  };
}

// 한 청크(≤24h) 전체 페이지 수집.
async function fetchChunk(store, from, to, rangeType) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const raw = await callCommerce(store, PRODUCT_ORDERS_PATH, {
      query: { from, to, rangeType, page, pageSize: PAGE_SIZE },
    });
    const contents = extractContents(raw);
    if (Array.isArray(contents)) out.push(...contents);
    if (!hasNext(raw) || !Array.isArray(contents) || !contents.length) break;
    await sleep(RPS_DELAY_MS); // 다음 페이지 전 RPS 가드
  }
  return out;
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    const { licenseKey } = req.query || {};
    const rangeType = req.query?.rangeType || "PAYED_DATETIME";
    if (!VALID_RANGE_TYPES.has(rangeType)) {
      return fail(res, 400, "INVALID_RANGE_TYPE", "지원하지 않는 rangeType: " + rangeType);
    }

    // 범위 결정: from 생략 시 오늘 0시(KST), to 생략 시 from + 24h.
    const fromDate = req.query?.from ? new Date(req.query.from) : todayKstMidnight();
    if (isNaN(fromDate.getTime())) return fail(res, 400, "INVALID_FROM", "from 파싱 실패: " + req.query.from);
    const toDate = req.query?.to ? new Date(req.query.to) : new Date(fromDate.getTime() + CHUNK_MS);
    if (isNaN(toDate.getTime())) return fail(res, 400, "INVALID_TO", "to 파싱 실패: " + req.query.to);
    if (toDate <= fromDate) return fail(res, 400, "INVALID_RANGE", "to는 from보다 이후여야 합니다.");

    const store = await getStoreByLicense(licenseKey);

    // 24h 청크로 분할 → 청크별 페이지 수집 → 합산.
    const chunks = dayChunks(fromDate, toDate);
    const seen = new Set();
    const orders = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const items = await fetchChunk(store, c.from, c.to, rangeType);
      for (const it of items) {
        const norm = normalize(it);
        const key = norm.productOrderId;
        // 청크 경계 중복 방어(productOrderId 기준 dedup).
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        orders.push(norm);
      }
      if (i + 1 < chunks.length) await sleep(RPS_DELAY_MS);
    }

    // 집계.
    const statusCounts = {};
    let totalSales = 0, totalSettlement = 0, totalCommission = 0;
    for (const o of orders) {
      if (o.status) statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
      totalSales += Number(o.salesAmount) || 0;
      totalSettlement += Number(o.expectedSettlement) || 0;
      totalCommission += Number(o.commission) || 0;
    }

    return res.status(200).json({
      success: true,
      storeName: store.storeName,
      range: { from: toKstIso(fromDate), to: toKstIso(toDate), rangeType },
      summary: {
        orderCount: orders.length,
        totalSales,
        totalSettlement,
        totalCommission,
        statusCounts,
      },
      orders,
    });
  } catch (err) {
    console.error("[order/sales-status]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "SALES_STATUS_FAILED", err.message || "서버 오류", err.detail);
  }
}
