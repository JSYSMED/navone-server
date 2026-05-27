// =============================================
// NavOne — AI 상품설명 생성 + AiTEMS 최적화 도메인 로직
// /api/product-ai/{analyze,generate,apply,bulk-analyze}.js 가 공유하는 코어.
// /api 밖(lib/)에 둬서 Vercel이 엔드포인트로 노출하지 않음.
//
// 의존:
//   ./commerce-auth.js  (공유, READ ONLY) — 커머스 API 인증/호출 (commerceRequest)
//   ./supabase.js       (공유, READ ONLY) — licenseKey → 스토어 자격증명 조회
//   OPENAI_API_KEY      (환경변수) — GPT-4o-mini 분석/생성
//
// 커머스 상품 API (v2):
//   GET /external/v2/products/origin-products/{originProductNo}  상품 상세 조회
//   PUT /external/v2/products/origin-products/{originProductNo}  상품 수정
//   GET /external/v1/products  (검색) — 일괄 분석용 상품 목록
//
// AiTEMS = 네이버쇼핑 개인화 추천(AI Item Embedding) 노출 엔진. 상품명 키워드,
// 이미지/속성 완성도, 태그가 노출 점수에 직결되므로 이를 점수화한다.
// =============================================

import { commerceRequest } from "./commerce-auth.js";
import { sbSelect } from "./supabase.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export const PRODUCT_API = {
  detail: (no) => `/external/v2/products/origin-products/${encodeURIComponent(no)}`,
  update: (no) => `/external/v2/products/origin-products/${encodeURIComponent(no)}`,
  search: "/external/v1/products/search",
};

// 상품명 SEO 권장 길이(네이버 쇼핑 가이드: 공백 포함 20~50자 권장, 100자 초과 비추천)
const NAME_MIN = 20;
const NAME_MAX = 50;
const NAME_HARD_MAX = 100;
// AiTEMS 노출에 권장되는 대표/추가 이미지 수
const IMAGE_RECOMMENDED = 4;
// 상세설명 권장 최소 길이(태그 제거 후 텍스트 기준)
const DETAIL_MIN_CHARS = 300;

// =============================================
// licenseKey → 스토어 자격증명/설정 로드
//   getStoreByLicense(licenseKey) → { storeId, storeName, clientId, clientSecret, config }
// (api/order/_lib.js 와 동일 규약 — lib/ 안에서 자족하도록 supabase.js 직접 사용)
// =============================================
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

// =============================================
// 상품 상세 조회 (GET) + 분석/수정에 쓰는 필드 정규화
// =============================================
export async function fetchProduct(store, originProductNo) {
  if (!originProductNo) {
    const e = new Error("originProductNo는 필수입니다.");
    e.status = 400;
    throw e;
  }
  const raw = await callCommerce(store, PRODUCT_API.detail(originProductNo));
  return { raw, info: normalizeProduct(raw, originProductNo) };
}

// 커머스 v2 상품 응답 → 분석 친화 형태로 정규화. 키 위치가 버전별로 다를 수 있어 방어적 추출.
function normalizeProduct(raw, originProductNo) {
  const op = raw?.originProduct || raw || {};
  const detailAttr = op.detailAttribute || {};
  const images = op.images || {};
  const naverInfo = detailAttr.naverShoppingSearchInfo || {};

  const optionalImages = Array.isArray(images.optionalImages) ? images.optionalImages : [];
  const repImage = images.representativeImage?.url || null;

  const productAttributes = Array.isArray(detailAttr.productAttributes)
    ? detailAttr.productAttributes
    : [];
  const sellerTags = Array.isArray(detailAttr.seoInfo?.sellerTags)
    ? detailAttr.seoInfo.sellerTags
    : (Array.isArray(naverInfo.sellerTags) ? naverInfo.sellerTags : []);

  return {
    originProductNo: String(originProductNo),
    name: op.name || "",
    leafCategoryId: op.leafCategoryId || op.categoryId || "",
    detailContent: op.detailContent || "",
    salePrice: op.salePrice ?? null,
    statusType: op.statusType || "",
    representativeImage: repImage,
    imageCount: (repImage ? 1 : 0) + optionalImages.length,
    productAttributeCount: productAttributes.length,
    sellerTags,
    brandName: naverInfo.brandName || "",
    manufacturerName: naverInfo.manufacturerName || "",
    modelName: naverInfo.modelName || "",
    originAreaCode: detailAttr.originAreaInfo?.originAreaCode || "",
  };
}

// 상세설명 HTML에서 텍스트만 대략 추출 (길이 측정용)
function stripHtml(html) {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// =============================================
// 휴리스틱 점수 (결정적, GPT 없이 계산) — bulk-analyze에서도 재사용
//   상품명 SEO / 속성 완성도 / AiTEMS 노출 점수
// =============================================
export function scoreProduct(info) {
  const name = info.name || "";
  const nameLen = name.length;
  const tokens = name.split(/\s+/).filter(Boolean);

  // --- 상품명 SEO (0~100) ---
  const nameDetails = [];
  let nameSeo = 0;
  // 길이 (40점): 권장 20~50자
  if (nameLen >= NAME_MIN && nameLen <= NAME_MAX) {
    nameSeo += 40;
  } else if (nameLen < NAME_MIN) {
    nameSeo += Math.round((nameLen / NAME_MIN) * 40);
    nameDetails.push(`상품명이 짧음(${nameLen}자) — 키워드 보강 권장(${NAME_MIN}~${NAME_MAX}자)`);
  } else {
    nameSeo += nameLen <= NAME_HARD_MAX ? 25 : 10;
    nameDetails.push(`상품명이 김(${nameLen}자) — ${NAME_MAX}자 이내 권장`);
  }
  // 구조: 키워드(토큰) 다양성 (30점): 4~12 토큰 권장
  if (tokens.length >= 4 && tokens.length <= 12) {
    nameSeo += 30;
  } else {
    nameSeo += Math.min(30, tokens.length * 5);
    nameDetails.push(`상품명 키워드 수 ${tokens.length}개 — 4~12개 권장(브랜드+속성+상품명 조합)`);
  }
  // 브랜드/제조사 노출 (15점)
  if (info.brandName || info.manufacturerName) nameSeo += 15;
  else nameDetails.push("상품명/속성에 브랜드·제조사 정보 없음");
  // 중복 토큰 패널티 가드 (15점): 고유 토큰 비율
  const uniqueRatio = tokens.length ? new Set(tokens).size / tokens.length : 0;
  nameSeo += Math.round(uniqueRatio * 15);
  if (uniqueRatio < 0.8 && tokens.length) nameDetails.push("상품명에 중복 단어가 있음(키워드 낭비)");
  nameSeo = Math.min(100, nameSeo);

  // --- 속성 완성도 (0~100) ---
  const missingAttributes = [];
  let attr = 0;
  if (info.productAttributeCount > 0) attr += 30;
  else missingAttributes.push("카테고리 속성(productAttributes) 미입력");
  if (info.brandName) attr += 15; else missingAttributes.push("브랜드명");
  if (info.manufacturerName) attr += 15; else missingAttributes.push("제조사명");
  if (info.modelName) attr += 10; else missingAttributes.push("모델명");
  if (info.originAreaCode) attr += 10; else missingAttributes.push("원산지");
  if (info.sellerTags.length > 0) attr += 20; else missingAttributes.push("판매자 태그(검색 키워드)");
  attr = Math.min(100, attr);

  // --- AiTEMS 노출 점수 (0~100): 키워드 + 이미지 + 속성 완성도 ---
  const aitemsDetails = [];
  let aitems = 0;
  // 이미지 (30점): 대표+추가 4장 이상 권장
  if (info.imageCount >= IMAGE_RECOMMENDED) {
    aitems += 30;
  } else {
    aitems += Math.round((info.imageCount / IMAGE_RECOMMENDED) * 30);
    aitemsDetails.push(`이미지 ${info.imageCount}장 — ${IMAGE_RECOMMENDED}장 이상 권장`);
  }
  // 키워드/태그 (25점): 태그 5개 이상 권장
  const tagScore = Math.min(25, info.sellerTags.length * 5);
  aitems += tagScore;
  if (info.sellerTags.length < 5) aitemsDetails.push(`판매자 태그 ${info.sellerTags.length}개 — 5개 이상 권장`);
  // 속성 완성도 반영 (25점)
  aitems += Math.round((attr / 100) * 25);
  // 상세설명 충실도 (20점)
  const detailLen = stripHtml(info.detailContent).length;
  if (detailLen >= DETAIL_MIN_CHARS) {
    aitems += 20;
  } else {
    aitems += Math.round((detailLen / DETAIL_MIN_CHARS) * 20);
    aitemsDetails.push(`상세설명 텍스트 ${detailLen}자 — ${DETAIL_MIN_CHARS}자 이상 권장`);
  }
  aitems = Math.min(100, aitems);

  return {
    nameSeo: { score: nameSeo, max: 100, details: nameDetails },
    attributeCompleteness: { score: attr, max: 100, missing: missingAttributes },
    aitems: { score: aitems, max: 100, details: aitemsDetails },
    overall: Math.round((nameSeo + attr + aitems) / 3),
  };
}

// =============================================
// OpenAI GPT-4o-mini 호출 헬퍼. json=true 면 JSON object 응답 강제.
// =============================================
async function callGpt({ systemPrompt, userPrompt, maxTokens = 600, json = false }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const e = new Error("OPENAI_API_KEY 미설정");
    e.status = 500;
    throw e;
  }
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error("AI 응답 실패");
    err.status = 502;
    err.detail = errText.substring(0, 200);
    throw err;
  }

  const data = await res.json();
  const content = (data.choices?.[0]?.message?.content || "").trim();
  const usage = data.usage || {};
  return {
    content,
    model: data.model,
    tokens: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 },
  };
}

// =============================================
// 단일 상품 분석: 휴리스틱 점수 + GPT 질적 개선 추천
//   analyzeProduct({ store, originProductNo }) →
//     { originProductNo, productName, leafCategoryId, scores, missingAttributes, ai, tokens }
// =============================================
export async function analyzeProduct({ store, originProductNo }) {
  const { info } = await fetchProduct(store, originProductNo);
  const scores = scoreProduct(info);

  const systemPrompt = `당신은 네이버 스마트스토어 SEO 및 AiTEMS(네이버쇼핑 AI 추천) 노출 최적화 전문가입니다.
주어진 상품 정보를 분석해 검색/추천 노출을 높일 구체적 개선안을 제시합니다.
반드시 아래 JSON 스키마로만 응답하세요(설명 텍스트 금지):
{
  "keywordSuggestions": ["검색 노출에 유리한 키워드", ...],   // 5~10개
  "recommendedName": "개선된 상품명 제안(50자 이내, 브랜드+핵심키워드+속성)",
  "improvements": ["구체적 개선 항목", ...]                  // 3~6개
}`;

  const userPrompt = `상품명: ${info.name || "(없음)"}
카테고리ID: ${info.leafCategoryId || "(없음)"}
브랜드: ${info.brandName || "(없음)"} / 제조사: ${info.manufacturerName || "(없음)"} / 모델: ${info.modelName || "(없음)"}
판매자 태그: ${info.sellerTags.length ? info.sellerTags.join(", ") : "(없음)"}
이미지 수: ${info.imageCount}장 / 속성 수: ${info.productAttributeCount}개
현재 상세설명(요약): ${stripHtml(info.detailContent).substring(0, 500) || "(없음)"}

위 상품의 검색 SEO와 AiTEMS 노출을 높일 개선안을 JSON으로 제시하세요.`;

  let ai = null;
  let tokens = { input: 0, output: 0 };
  try {
    const gpt = await callGpt({ systemPrompt, userPrompt, maxTokens: 700, json: true });
    tokens = gpt.tokens;
    ai = safeJson(gpt.content);
  } catch (err) {
    // GPT 실패해도 휴리스틱 점수는 반환 (분석이 완전히 막히지 않도록)
    ai = { error: err.message };
  }

  return {
    originProductNo: info.originProductNo,
    productName: info.name,
    leafCategoryId: info.leafCategoryId,
    scores,
    missingAttributes: scores.attributeCompleteness.missing,
    ai,
    tokens,
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // 코드펜스 등 군더더기 제거 후 재시도
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* noop */ } }
    return { raw: text };
  }
}

// =============================================
// AI 상품설명 생성 (적용 안 함, 미리보기용)
//   generateDescription({ store, originProductNo }) →
//     { originProductNo, productName, description(HTML), tokens }
// =============================================
export async function generateDescription({ store, originProductNo }) {
  const { info } = await fetchProduct(store, originProductNo);

  const systemPrompt = `당신은 네이버 스마트스토어 상세페이지 카피라이터이자 SEO 전문가입니다.
상품명·카테고리·기존 설명을 바탕으로 검색/AiTEMS 노출에 최적화된 상세 설명을 작성합니다.

## 구성 (각 섹션을 <h3> 제목 + <p> 본문 HTML로)
1. 상품 소개 (한눈에 들어오는 핵심 가치)
2. 주요 특징 (3~5가지, <ul><li>)
3. 사용법 / 활용 팁
4. 구매 안내 (배송/보관 등 일반적 안내)

## 규칙
- 한국어. 자연스러운 문장 안에 핵심 키워드를 억지스럽지 않게 반복 삽입.
- 과장·허위 광고 표현 금지(최고/100%/유일 등 단정 금지).
- 가격·할인·쿠폰 등 금전 약속 금지.
- 경쟁사 언급 금지.
- 순수 HTML 본문만 출력(<h3>, <p>, <ul>, <li>, <strong>만 사용). <html>/<body>/코드펜스 금지.`;

  const userPrompt = `상품명: ${info.name || "(없음)"}
카테고리ID: ${info.leafCategoryId || "(없음)"}
브랜드: ${info.brandName || "(없음)"} / 제조사: ${info.manufacturerName || "(없음)"}
핵심 키워드(태그): ${info.sellerTags.length ? info.sellerTags.join(", ") : "(없음)"}
기존 상세설명(참고): ${stripHtml(info.detailContent).substring(0, 800) || "(없음)"}

위 상품의 SEO 최적화 상세 설명을 HTML로 작성하세요. 본문 HTML만 출력하세요.`;

  const gpt = await callGpt({ systemPrompt, userPrompt, maxTokens: 1500 });
  const description = cleanHtml(gpt.content);

  return {
    originProductNo: info.originProductNo,
    productName: info.name,
    description,
    model: gpt.model,
    tokens: gpt.tokens,
  };
}

// GPT가 가끔 감싸는 ```html ... ``` 코드펜스 제거
function cleanHtml(text) {
  return String(text)
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

// =============================================
// 상품설명 실제 적용 (PUT)
//   현재 상품 전체를 조회해 detailContent만 교체 후 PUT (커머스 v2는 전체 페이로드 요구).
//   applyDescription({ store, originProductNo, newDescription }) → { success, originProductNo }
// =============================================
export async function applyDescription({ store, originProductNo, newDescription }) {
  if (!newDescription || !newDescription.trim()) {
    const e = new Error("newDescription(상세설명)이 비어 있습니다.");
    e.status = 400;
    throw e;
  }
  const { raw } = await fetchProduct(store, originProductNo);

  // 커머스 v2 수정 페이로드: 조회 응답 구조를 그대로 유지한 채 detailContent만 교체.
  const payload = JSON.parse(JSON.stringify(raw));
  if (!payload.originProduct) {
    const e = new Error("상품 응답에 originProduct가 없어 수정할 수 없습니다.");
    e.status = 502;
    e.detail = raw;
    throw e;
  }
  payload.originProduct.detailContent = newDescription.trim();

  await callCommerce(store, PRODUCT_API.update(originProductNo), {
    method: "PUT",
    body: payload,
  });

  return { success: true, originProductNo: String(originProductNo) };
}

// =============================================
// 상품 목록 조회 (일괄 분석용). 커머스 검색 API로 판매중 상품 페이지 조회.
// =============================================
export async function listProducts(store, { size = 50, page = 1 } = {}) {
  const res = await callCommerce(store, PRODUCT_API.search, {
    method: "POST",
    body: {
      productStatusTypes: ["SALE"],
      page,
      size,
      orderType: "NO",
    },
  });
  const list = res?.contents || res?.data || (Array.isArray(res) ? res : []);
  return (Array.isArray(list) ? list : [])
    .map((row) => {
      const op = row.originProduct || row.channelProducts?.[0] || row;
      return {
        originProductNo: String(
          op.originProductNo || row.originProductNo || row.productNo || ""
        ),
        name: op.name || op.productName || row.name || "",
      };
    })
    .filter((p) => p.originProductNo);
}

// =============================================
// 전체 상품 일괄 분석 (상위 N개, 기본 50). 비용/타임아웃 고려해 휴리스틱 점수만 산출.
//   bulkAnalyze({ store, limit }) → { count, products: [{...info, scores}], summary }
// =============================================
export async function bulkAnalyze({ store, limit = 50 }) {
  const products = await listProducts(store, { size: limit });
  const results = [];
  let okCount = 0;

  for (const p of products.slice(0, limit)) {
    try {
      const { info } = await fetchProduct(store, p.originProductNo);
      const scores = scoreProduct(info);
      results.push({
        originProductNo: info.originProductNo,
        productName: info.name,
        leafCategoryId: info.leafCategoryId,
        scores,
        missingAttributes: scores.attributeCompleteness.missing,
      });
      okCount++;
    } catch (err) {
      results.push({
        originProductNo: p.originProductNo,
        productName: p.name,
        error: err.message,
      });
    }
  }

  // 개선 우선순위: overall 낮은 순으로 정렬
  results.sort((a, b) => (a.scores?.overall ?? 999) - (b.scores?.overall ?? 999));

  const scored = results.filter((r) => r.scores);
  const avg = scored.length
    ? Math.round(scored.reduce((s, r) => s + r.scores.overall, 0) / scored.length)
    : 0;

  return {
    count: results.length,
    analyzed: okCount,
    summary: {
      averageOverall: avg,
      needsImprovement: scored.filter((r) => r.scores.overall < 60).length,
    },
    products: results,
  };
}
