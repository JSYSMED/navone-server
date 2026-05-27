// =============================================
// NavOne Vercel API — /api/penalty/risk-scan.js
// 클린페널티 리스크 스캔: 무거래 상품 + 등록 한도 → Telegram 알림 + Supabase 로그
//
// 호출 방식
//   - HTTP : GET /api/penalty/risk-scan[?licenseKey=...&recentSalesAmount=...]
//   - Cron : vercel.json crons → 매일 GET (파라미터 없음 → 전체 스토어 스캔)
//   - 프로그램: import { run } from ".../risk-scan.js"; await run(config)
//
// 표준 인터페이스: run(config) → { success, processed, errors, scans }
//   (AGENTS.md §8 자동화 모듈 공통 인터페이스. Agent F penaltyScan.run 연결용)
//
// 의존 (공유 인프라, import only)
//   - lib/supabase.js     : Supabase REST 헬퍼
//   - lib/commerce-auth.js : 커머스 API 인증 헤더 (getCommerceHeaders)
//   - lib/telegram.js     : Telegram 발송 (Agent D 생성)
// =============================================

import {
  setCors, handlePreflight, assertEnv, sbSelect, sbInsert, sendError,
} from "../../lib/supabase.js";
import { getCommerceHeaders } from "../../lib/commerce-auth.js";
import { sendTelegram, escapeHtml } from "../../lib/telegram.js";

const COMMERCE_BASE = "https://api.commerce.naver.com";
const PRODUCT_SEARCH_PATH = "/external/v1/products/search";

// 무거래 기준 (개월)
const MONTHS_DANGER = 13;   // 13개월+ = 위험 (네이버 14개월 무거래 정리 대비)
const MONTHS_WARNING = 10;  // 10개월+ = 주의

// 등록 한도: 직전 3개월 판매액 < 500만원 → 1,000개로 축소
const LOW_VOLUME_THRESHOLD = 5_000_000;
const REDUCED_LIMIT = 1000;
const DEFAULT_LIMIT = 10000; // 일반 셀러 한도 추정치 (config로 override 가능)

const PAGE_SIZE = 500;
const MAX_PAGES = 50;        // 안전 상한 (최대 25,000건)
const RPS_DELAY_MS = 500;    // 커머스 API RPS 제한 준수 (초당 2회 이하)
const NOTIFY_USAGE_PERCENT = 80; // 한도 사용률이 이 이상이면 알림

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 상품 데이터 정규화 ----------

// 검색 응답은 contents[].channelProducts[] 중첩 구조일 수 있어 평탄화한다.
function flattenProducts(list) {
  const out = [];
  for (const item of list || []) {
    if (Array.isArray(item.channelProducts) && item.channelProducts.length) {
      for (const cp of item.channelProducts) out.push({ ...item, ...cp });
    } else {
      out.push(item);
    }
  }
  return out;
}

// 응답 필드명이 케이스마다 달라 방어적으로 추출.
function normalizeProduct(item) {
  return {
    no: item.channelProductNo || item.originProductNo || item.productNo || null,
    name: item.name || item.productName || "(이름 없음)",
    // 마지막 판매일(없으면 등록일로 fallback)
    lastSold: item.lastSoldDate || item.lastOrderDate || item.recentSaleDate || null,
    saleStart: item.saleStartDate || item.regDate || item.registrationDate || null,
  };
}

// 기준일로부터 지난 개월 수 (정수). 파싱 실패 시 null.
function monthsSince(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
}

function fmtDate(dateStr) {
  if (!dateStr) return "정보 없음";
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? "정보 없음" : d.toISOString().slice(0, 10);
}

// ---------- 커머스 상품 전체 조회 (페이지네이션) ----------

async function fetchAllProducts(headers) {
  const products = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(COMMERCE_BASE + PRODUCT_SEARCH_PATH, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ page, size: PAGE_SIZE, productStatusTypes: ["SALE"] }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`커머스 상품조회 실패 ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    const list = data.contents || data.elements || [];
    products.push(...list);

    const totalPages = data.totalPages
      ?? Math.ceil((data.totalElements ?? list.length) / PAGE_SIZE);
    if (page >= totalPages || list.length === 0) break;
    await sleep(RPS_DELAY_MS);
  }
  return products;
}

// ---------- 단일 스토어 스캔 ----------

async function scanStore(store, config = {}) {
  const headers = await getCommerceHeaders(store.client_id, store.client_secret);
  const raw = await fetchAllProducts(headers);
  const products = flattenProducts(raw).map(normalizeProduct);
  const now = new Date();

  const danger = [];
  const warning = [];
  for (const p of products) {
    const months = monthsSince(p.lastSold || p.saleStart, now);
    if (months == null) continue;
    if (months >= MONTHS_DANGER) danger.push({ ...p, months });
    else if (months >= MONTHS_WARNING) warning.push({ ...p, months });
  }

  // 등록 한도 산정. 직전 3개월 판매액은 정산 데이터(Agent A 영역)라
  // 상품 API만으론 알 수 없으므로 config/store.config 로 주입받는다(없으면 미상).
  const storeConfig = store.config || {};
  const recentSalesAmount =
    config.recentSalesAmount ?? storeConfig.recentSalesAmount ?? null;
  const isLowVolume =
    recentSalesAmount != null && recentSalesAmount < LOW_VOLUME_THRESHOLD;
  const limit = isLowVolume
    ? REDUCED_LIMIT
    : (config.registrationLimit ?? storeConfig.registrationLimit ?? DEFAULT_LIMIT);

  const total = products.length;
  const usagePercent = limit > 0 ? Math.round((total / limit) * 1000) / 10 : null;

  return {
    store, total, danger, warning,
    limit, usagePercent, isLowVolume, recentSalesAmount,
  };
}

// ---------- Telegram 메시지 포맷 ----------

const LIST_MAX = 10; // 메시지에 나열할 상품 최대 건수

function listLines(items) {
  const shown = items.slice(0, LIST_MAX)
    .map((p) => `• ${escapeHtml(p.name)} (마지막 판매: ${fmtDate(p.lastSold || p.saleStart)})`);
  if (items.length > LIST_MAX) shown.push(`… 외 ${items.length - LIST_MAX}건`);
  return shown.join("\n");
}

function formatMessage(scan) {
  const { store, danger, warning, total, limit, usagePercent } = scan;
  const parts = [];
  parts.push(`<b>🚨 NavOne 클린페널티 알림</b>`);
  parts.push(escapeHtml(store.store_name || ""));
  parts.push("");

  if (danger.length) {
    parts.push(`<b>⚠️ 무거래 위험 상품 (13개월+): ${danger.length}건</b>`);
    parts.push(listLines(danger));
    parts.push("");
  }
  if (warning.length) {
    parts.push(`<b>🔸 무거래 주의 상품 (10개월+): ${warning.length}건</b>`);
    parts.push(listLines(warning));
    parts.push("");
  }

  const pct = usagePercent == null ? "?" : usagePercent;
  parts.push(`<b>📊 등록 한도: ${total} / ${limit} (${pct}%)</b>`);
  if (danger.length || warning.length) {
    parts.push(`💡 권장: 무거래 상품 정리로 한도 확보`);
  }
  return parts.join("\n").trim();
}

// 알림을 보낼 가치가 있는지 (스팸 방지)
function shouldNotify(scan) {
  return (
    scan.danger.length > 0 ||
    scan.warning.length > 0 ||
    (scan.usagePercent != null && scan.usagePercent >= NOTIFY_USAGE_PERCENT)
  );
}

// ---------- 표준 run() 인터페이스 ----------

/**
 * @param {Object} [config]
 * @param {string} [config.licenseKey]        특정 스토어만 스캔 (없으면 인증정보 있는 전체)
 * @param {number} [config.recentSalesAmount] 직전 3개월 판매액(원) — 한도 산정용
 * @param {number} [config.registrationLimit] 일반 등록 한도 override
 * @returns {Promise<{ success: boolean, processed: number, errors: string[], scans: object[] }>}
 */
export async function run(config = {}) {
  assertEnv();
  const errors = [];
  const scans = [];
  let processed = 0;

  const select = "select=id,store_name,client_id,client_secret,config";
  const stores = config.licenseKey
    ? await sbSelect("stores", `license_key=eq.${encodeURIComponent(config.licenseKey)}&${select}&limit=1`)
    : await sbSelect("stores", `client_id=not.is.null&client_secret=not.is.null&${select}`);

  for (const store of stores) {
    if (!store.client_id || !store.client_secret) {
      errors.push(`${store.store_name}: 커머스 인증정보 없음`);
      continue;
    }
    try {
      const scan = await scanStore(store, config);

      let notified = false;
      if (shouldNotify(scan)) {
        const tg = await sendTelegram(formatMessage(scan));
        notified = !!tg.ok;
      }

      await sbInsert("navone_penalty_alerts", {
        store_id: store.id,
        total_products: scan.total,
        registration_limit: scan.limit,
        limit_usage_percent: scan.usagePercent,
        no_sale_danger_count: scan.danger.length,
        no_sale_warning_count: scan.warning.length,
        result: {
          danger: scan.danger,
          warning: scan.warning,
          is_low_volume: scan.isLowVolume,
          recent_sales_amount: scan.recentSalesAmount,
        },
        notified,
      });

      processed++;
      scans.push({
        storeName: store.store_name,
        total: scan.total,
        danger: scan.danger.length,
        warning: scan.warning.length,
        limit: scan.limit,
        usagePercent: scan.usagePercent,
        notified,
      });
    } catch (err) {
      console.error("penalty scan error:", store.store_name, err.message);
      errors.push(`${store.store_name}: ${err.message}`);
    }
  }

  return { success: errors.length === 0, processed, errors, scans };
}

// ---------- HTTP 핸들러 ----------

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "GET")) return;

  try {
    const q = req.query || {};
    const config = {
      licenseKey: q.licenseKey || undefined,
      recentSalesAmount: q.recentSalesAmount != null ? Number(q.recentSalesAmount) : undefined,
    };
    const result = await run(config);
    return res.status(200).json({ success: result.success, data: result });
  } catch (err) {
    return sendError(res, err);
  }
}
