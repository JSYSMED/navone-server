// =============================================
// NavOne — 그룹상품 자동 묶음 도메인 로직 (커머스 API v2.45.0 연동)
// /api/group/{suggest,create,list}.js 가 공유하는 코어.
// /api 밖(lib/)에 둬서 Vercel이 엔드포인트로 노출하지 않음.
//
// 그룹상품(standard-group-products) API:
//   POST /v2/standard-group-products   그룹상품 등록
//   GET  /v2/standard-group-products   그룹상품 목록 조회
//
// 상품 조회:
//   POST /external/v1/products/search  전체 상품 목록 (페이지네이션)
//
// 인증: lib/commerce-auth.js 의 commerceRequest 로 위임 (licenseKey → 자격증명은
//       lib/supabase.js stores 테이블에서 조회). 서버는 토큰을 보관하지 않는다.
// =============================================

import { commerceRequest } from "./commerce-auth.js";
import { sbSelect } from "./supabase.js";
import { generateReply } from "./cs-prompt.js";

// ---- 커머스 API 경로 ----
export const GROUP_API = {
  productSearch: "/external/v1/products/search",
  groupProducts: "/v2/standard-group-products",
};

// 같은 그룹 후보로 묶으려면 상품명 유사도가 이 값 이상이어야 한다.
const SIMILARITY_THRESHOLD = 0.55;
// 한 그룹 후보의 최소/최대 상품 수 (네이버 그룹상품 정책상 2개 이상).
const MIN_GROUP_SIZE = 2;

// ---------------------------------------------
// license_key → 스토어 자격증명/설정 로드 (order/_lib.js 와 동일 규약)
// @returns {Promise<{storeId, storeName, clientId, clientSecret, config}>}
// ---------------------------------------------
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

// 커머스 호출 단축 헬퍼 (store에서 자격증명 주입)
function callCommerce(store, path, { method = "GET", query, body } = {}) {
  return commerceRequest(path, {
    clientId: store.clientId,
    clientSecret: store.clientSecret,
    method,
    query,
    body,
  });
}

// ---------------------------------------------
// 응답 필드 정규화 (커머스 응답 키가 버전/문서에 따라 다를 수 있어 폭넓게 매핑)
// ---------------------------------------------
function pick(obj, keys, dflt = "") {
  if (!obj) return dflt;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return dflt;
}

// products/search 응답 1건 → 평탄화된 상품. 채널상품(channelProducts) 우선 매핑.
function normalizeProduct(raw) {
  const ch = Array.isArray(raw.channelProducts) && raw.channelProducts.length
    ? raw.channelProducts[0]
    : raw;
  return {
    productNo: String(pick(ch, ["channelProductNo", "originProductNo"], pick(raw, ["originProductNo", "productNo"], ""))),
    originProductNo: String(pick(raw, ["originProductNo", "productNo"], pick(ch, ["originProductNo"], ""))),
    name: pick(ch, ["name", "productName", "channelProductName"], pick(raw, ["name", "productName"], "")),
    category: pick(ch, ["wholeCategoryName", "categoryName", "categoryId"], pick(raw, ["wholeCategoryName", "categoryId"], "")),
    categoryId: String(pick(ch, ["categoryId", "leafCategoryId"], pick(raw, ["categoryId"], ""))),
    salePrice: Number(pick(ch, ["salePrice", "discountedPrice"], pick(raw, ["salePrice"], 0))) || 0,
    statusType: pick(ch, ["statusType", "channelProductDisplayStatusType"], ""),
    raw,
  };
}

// ---------------------------------------------
// 전체 상품 목록 조회 (페이지네이션, 최대 maxPages)
// @returns {Promise<Array>} 정규화된 상품 목록
// ---------------------------------------------
export async function fetchAllProducts(store, { size = 100, maxPages = 20 } = {}) {
  const products = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await callCommerce(store, GROUP_API.productSearch, {
      method: "POST",
      body: {
        page,
        size,
        productStatusTypes: ["SALE"]
      },
    });
    const list = res?.contents || res?.data?.contents || res?.data || (Array.isArray(res) ? res : []);
    if (!Array.isArray(list) || !list.length) break;
    products.push(...list.map(normalizeProduct));

    const total = Number(pick(res, ["totalElements", "totalCount", "total"], 0));
    if (total && products.length >= total) break;
    if (list.length < size) break;
  }
  return products;
}

// ---------------------------------------------
// 상품명 정규화 + 유사도
// 용량/수량/옵션·괄호 토큰을 제거해 "같은 제품"의 핵심 명칭만 남긴 뒤 비교.
// ---------------------------------------------
export function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")        // [대괄호] (소괄호) 내용 제거
    .replace(/\d+\s?(ml|l|g|kg|mg|개|매|팩|세트|박스|구|호|p|ea|pcs?)\b/g, " ") // 용량/수량
    .replace(/[^0-9a-z가-힣]+/g, " ")              // 특수문자 → 공백
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(name) {
  return normalizeName(name).split(" ").filter((t) => t.length >= 2);
}

// 토큰 기반 Dice 계수 (0~1). 핵심 명칭이 겹칠수록 1에 가까움.
export function nameSimilarity(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// ---------------------------------------------
// 같은 카테고리 + 상품명 유사도로 그룹화 후보 클러스터 탐지.
// 단순 union-find 없이, 카테고리 버킷 안에서 대표명 기준 그리디 클러스터링.
// @returns {Array<{category, products: [...]}>} 2개 이상 묶인 후보만
// ---------------------------------------------
export function groupCandidates(products) {
  const byCategory = new Map();
  for (const p of products) {
    if (!p.productNo) continue;
    const key = p.categoryId || p.category || "_";
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(p);
  }

  const candidates = [];
  for (const [, items] of byCategory) {
    const remaining = [...items];
    while (remaining.length) {
      const seed = remaining.shift();
      const cluster = [seed];
      for (let i = remaining.length - 1; i >= 0; i--) {
        if (nameSimilarity(seed.name, remaining[i].name) >= SIMILARITY_THRESHOLD) {
          cluster.push(remaining[i]);
          remaining.splice(i, 1);
        }
      }
      if (cluster.length >= MIN_GROUP_SIZE) {
        candidates.push({ category: seed.category, products: cluster });
      }
    }
  }
  return candidates;
}

// ---------------------------------------------
// GPT-4o-mini 로 클러스터가 "같은 제품의 옵션/용량 차이"인지 판단.
// 휴리스틱(유사도)이 모은 후보를 한 번 더 검증해 오묶음을 거른다.
// @returns {Promise<{ same: boolean, groupName: string, reason: string }>}
// ---------------------------------------------
export async function judgeGroupWithAI(cluster) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { const e = new Error("OPENAI_API_KEY 미설정"); e.status = 500; throw e; }

  const names = cluster.products.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
  const systemPrompt =
    `당신은 네이버 스마트스토어 상품 카탈로그 정리 전문가입니다.
주어진 상품 목록이 "같은 제품의 옵션/용량/색상/수량 차이"인지(=하나의 그룹상품으로 묶어야 하는지) 판단합니다.
서로 다른 제품(브랜드·모델·종류가 다름)은 묶으면 안 됩니다.

반드시 아래 JSON 형식 하나만 출력하세요. 설명 문장 금지.
{"same": true 또는 false, "groupName": "묶을 경우 대표 상품명(옵션 표현 제거)", "reason": "판단 근거 한 문장"}`;
  const userPrompt =
    `카테고리: ${cluster.category || "(미상)"}
상품 목록:
${names}

이 상품들을 하나의 그룹상품으로 묶어야 합니까?`;

  const { reply } = await generateReply({ systemPrompt, userPrompt, maxTokens: 200, apiKey });

  // 모델이 코드펜스/잡텍스트를 섞어도 첫 JSON 객체만 파싱
  let parsed = null;
  try {
    const m = reply.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch { parsed = null; }

  return {
    same: parsed?.same === true,
    groupName: (parsed?.groupName || cluster.products[0]?.name || "").trim(),
    reason: parsed?.reason || (parsed ? "" : "AI 응답 파싱 실패"),
  };
}

// ---------------------------------------------
// suggestGroups — 그룹화 가능한 상품 후보 리스트(AI 추천) 반환.
// 전체 상품 조회 → 카테고리+유사도 클러스터링 → AI 검증 → same=true 만 반환.
// @returns {Promise<{ scanned, candidates: [...] }>}
// ---------------------------------------------
export async function suggestGroups(store, { useAI = true, maxGroups = 20 } = {}) {
  const products = await fetchAllProducts(store);
  const clusters = groupCandidates(products);

  const suggestions = [];
  for (const cluster of clusters.slice(0, maxGroups)) {
    let groupName = cluster.products[0]?.name || "";
    let reason = "같은 카테고리 + 상품명 유사";
    if (useAI) {
      const verdict = await judgeGroupWithAI(cluster);
      if (!verdict.same) continue; // AI가 서로 다른 제품으로 판단 → 제외
      groupName = verdict.groupName || groupName;
      reason = verdict.reason || reason;
    }
    suggestions.push({
      groupName,
      category: cluster.category,
      reason,
      productNos: cluster.products.map((p) => p.productNo),
      products: cluster.products.map((p) => ({
        productNo: p.productNo,
        name: p.name,
        salePrice: p.salePrice,
      })),
    });
  }

  return { scanned: products.length, candidates: suggestions };
}

// ---------------------------------------------
// registerGroupProduct — 선택한 상품들로 그룹상품 등록.
// POST /v2/standard-group-products
// @param {object} store
// @param {{ groupName?: string, productNos: string[] }} p
// ---------------------------------------------
export async function registerGroupProduct(store, { groupName, productNos } = {}) {
  if (!Array.isArray(productNos) || productNos.length < MIN_GROUP_SIZE) {
    const e = new Error(`그룹상품은 최소 ${MIN_GROUP_SIZE}개 상품이 필요합니다.`);
    e.status = 400;
    throw e;
  }
  const channelProductNos = [...new Set(productNos.map(String))];
  const body = {
    groupProductName: (groupName || "").trim() || undefined,
    channelProductNos,
  };

  const result = await callCommerce(store, GROUP_API.groupProducts, {
    method: "POST",
    body,
  });

  return {
    groupName: body.groupProductName || null,
    productNos: channelProductNos,
    groupProductNo: pick(result, ["groupProductNo", "standardGroupProductNo", "id"], null) || null,
    result,
  };
}

// ---------------------------------------------
// listGroupProducts — 현재 등록된 그룹상품 목록 조회.
// GET /v2/standard-group-products
// ---------------------------------------------
export async function listGroupProducts(store, { page = 1, size = 100 } = {}) {
  const res = await callCommerce(store, GROUP_API.groupProducts, {
    method: "GET",
    query: { page, size },
  });
  const list = res?.contents || res?.data?.contents || res?.data || (Array.isArray(res) ? res : []);
  const groups = (Array.isArray(list) ? list : []).map((g) => ({
    groupProductNo: String(pick(g, ["groupProductNo", "standardGroupProductNo", "id"], "")),
    groupName: pick(g, ["groupProductName", "groupName", "name"], ""),
    productCount: Array.isArray(g.channelProductNos) ? g.channelProductNos.length
      : Number(pick(g, ["productCount", "channelProductCount"], 0)) || 0,
    raw: g,
  }));
  return {
    count: groups.length,
    total: Number(pick(res, ["totalElements", "totalCount", "total"], groups.length)),
    groups,
  };
}
