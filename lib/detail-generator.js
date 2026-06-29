// =============================================
// NavOne — 상세페이지+등록정보 생성 엔진 (lab Python 프로토타입 포팅)
//   lab_source/{analyze,registration,images,templates}.py → ESM 단일 모듈.
//   ★ 프롬프트 한국어 문자열 / 템플릿 인라인 CSS 는 lab_source 그대로 복붙(수정금지).
//   ★ 고시값은 {value, source} 객체 구조 유지(프론트가 출처 표시에 씀).
//   ★ 누끼(rembg/cutout)는 포팅 대상 아님 — 나노바나나(scene)가 배경 처리.
//
//   export: callOpenAIJson, NAME_RULES, TAG_RULES, NOTICE_TYPES, guessNoticeType,
//           noticeFields, blankRegistration, validateRegistration,
//           estimateRegistration, analyze, scene, TEMPLATES, imageBriefs, renderTemplate
// =============================================

// ── 2-1. OpenAI 호출 헬퍼 (lab_source/analyze.py 의 _openai_json 포팅) ──────────
export async function callOpenAIJson(prompt, imageDataUri = null, temperature = 0.4) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY 가 .env 에 없음");

  const content = [{ type: "text", text: prompt }];
  if (imageDataUri) content.push({ type: "image_url", image_url: { url: imageDataUri } });

  const body = {
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [{ role: "user", content }],
    temperature,
    response_format: { type: "json_object" },
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`OpenAI 호출 실패 ${r.status}: ${detail}`);
  }
  const res = await r.json();
  return JSON.parse(res.choices[0].message.content);
}

// ── 2-2. 상품명/태그 SEO 규칙 상수 (lab_source/registration.py NAME_RULES/TAG_RULES 그대로) ──
export const NAME_RULES = `[상품명 규칙 — 네이버 쇼핑 SEO]
- 순서: 브랜드/제조사 → 시리즈 → 모델명 → 상품유형 → 색상 → 소재 → 수량 → 사이즈 → 속성(용량/무게)
- 50자 내외(최대 100자). 조사·수식어 빼고 핵심 정보만
- 금지: 중복단어, 판매처/쇼핑몰명, 이벤트·할인·가격·쿠폰, 전화번호
- 금지 수식어: 최고/인기/특가/최저가/무료배송/정품/공식/베스트/1위/가성비/세일/한정
- 한글 기본, 필요시 영문/아라비아숫자. 그 외 언어·특수문자(()-·[]/&+,~. 외) 금지
- 동의어/유의어 반복 금지 (네이버가 자동 처리)`;

export const TAG_RULES = `[태그 규칙]
- 감성표현 적극 사용(예: 하늘하늘 원피스, 데일리 추천)
- 브랜드/제조사/판매처는 태그에 중복 입력 금지(별도 필드)
- 상품과 무관하거나 타사 상표 태그 금지`;

// ── 2-3. 고시 27종 분기 (lab_source/registration.py 포팅) ─────────────────────
// value = [라벨, [셀러 입력 필수 필드(키, 한글라벨)]] — 구현된 타입만 필드 채움
export const NOTICE_TYPES = {
  COSMETIC: ["화장품", [
    ["capacity", "용량/중량"], ["expirationDate", "사용기한 또는 개봉후 사용기간"],
    ["usage", "사용방법"], ["manufacturer", "화장품제조업자"],
    ["distributor", "화장품책임판매업자"], ["mainIngredient", "주요성분"],
    ["certificationType", "기능성 심사필 유무"], ["caution", "사용시 주의사항"],
    ["customerServicePhoneNumber", "고객센터 전화번호"],
  ]],
  ETC: ["기타 재화", [
    ["itemName", "품명 및 모델명"], ["manufacturer", "제조자(수입자)"],
    ["afterServiceDirector", "A/S 책임자/전화번호"],
    ["customerServicePhoneNumber", "고객센터 전화번호"],
  ]],
  // 아래는 타입만 정의(필드는 본체에서 확장). 지금은 ETC로 폴백.
  WEAR: ["의류", null], SHOES: ["신발", null], BAG: ["가방", null],
  FOOD: ["가공식품", null], GENERAL_FOOD: ["기타식품", null],
  FURNITURE: ["가구", null], HOME_APPLIANCES: ["생활가전", null],
  IMAGE_APPLIANCES: ["영상가전", null], KITCHEN_UTENSILS: ["주방용품", null],
  JEWELLERY: ["귀금속", null], KIDS: ["유아용품", null],
  CELL_PHONE: ["휴대폰", null], BOOKS: ["도서", null],
  // ... 나머지 타입도 키만 추가하면 분기됨
};

// 카테고리 경로 키워드 → 고시 타입 추정 (AI 보조)
export function guessNoticeType(categoryPath) {
  const p = categoryPath || "";
  const table = [
    [["화장품", "스킨", "크림", "세럼", "클렌징", "마스크팩", "선크림"], "COSMETIC"],
    [["치약", "구강", "칫솔"], "COSMETIC"], // 화장품 고시 인접 처리(실제론 의약외품 별도)
    [["의류", "티셔츠", "원피스", "팬츠", "니트"], "WEAR"],
    [["신발", "운동화", "구두"], "SHOES"],
    [["가방", "백팩", "클러치"], "BAG"],
    [["식품", "간식", "음료", "건강식품"], "FOOD"],
    [["가구", "책상", "의자", "침대"], "FURNITURE"],
    [["키보드", "마우스", "가전", "전자"], "ETC"],
  ];
  for (const [keys, t] of table) {
    if (keys.some((k) => p.includes(k))) return t;
  }
  return "ETC";
}

// 해당 고시 타입의 셀러 입력 필수 필드. 미구현 타입은 ETC로 폴백.
export function noticeFields(noticeType) {
  const [, fields] = NOTICE_TYPES[noticeType] || NOTICE_TYPES["ETC"];
  if (fields === null || fields === undefined) return NOTICE_TYPES["ETC"][1];
  return fields;
}

// 등록정보 골격 — AI추정칸 + 셀러입력칸(빈값) 분리.
export function blankRegistration(noticeType) {
  const fields = noticeFields(noticeType);
  const notice = {};
  for (const [k] of fields) notice[k] = null;
  const labels = {};
  for (const [k, lbl] of fields) labels[k] = lbl;
  return {
    ai_estimated: {            // AI가 채움(추정, 셀러 확인 필요)
      name: "", categoryPath: "", leafCategoryId: null,
      salePrice: null, searchTags: [],
    },
    seller_required: {         // 셀러가 반드시 입력(AI 생성 금지)
      noticeType,
      notice,
      afterServicePhone: null, origin: null,
      functional: { "여부": false, "심사필인증번호": null },
      deliveryFee: null, stockQuantity: null,
    },
    _notice_labels: labels,
  };
}

// {value,source} 또는 평값에서 실제 값 추출.
function _val(cell) {
  if (cell && typeof cell === "object" && !Array.isArray(cell)) return cell.value;
  return cell;
}

// 필수 누락 검사 → 누락 리스트. 비면 등록 가능.
export function validateRegistration(reg) {
  const missing = [];
  const ai = reg.ai_estimated || {};
  const sr = reg.seller_required || {};
  const labels = reg._notice_labels || {};

  if (!ai.name) missing.push("상품명");
  if (!ai.leafCategoryId) missing.push("카테고리(leaf) — 확인 필요");
  if (!ai.salePrice) missing.push("판매가");
  if (!_val(sr.stockQuantity)) missing.push("재고수량");

  for (const [k, cell] of Object.entries(sr.notice || {})) {
    const v = _val(cell);
    if (v === null || v === undefined || v === "") missing.push("고시·" + (labels[k] || k));
  }
  if (!_val(sr.afterServicePhone)) missing.push("A/S 전화");
  if (!_val(sr.origin)) missing.push("원산지");
  const dfee = _val(sr.deliveryFee);
  if (dfee === null || dfee === undefined || dfee === "") missing.push("배송비");
  const func = sr.functional || {};
  if (func["여부"] && !func["심사필인증번호"]) missing.push("기능성 심사필 인증번호");
  return missing;
}

// ── 2-4. 등록정보 추정 (lab_source/analyze.py estimate_registration 포팅) ★핵심 ──
export async function estimateRegistration(desc, imageDataUri = null) {
  // 먼저 카테고리/이름 추정용 1차 (고시 타입 알아야 필드 목록이 정해짐)
  const basePrompt = `너는 네이버 스마트스토어 상품 등록 도우미다. 사진/설명을 보고 JSON만 출력.
${NAME_RULES}
${TAG_RULES}
추정 불가 정보는 지어내지 마라.
스키마:
{"name":"SEO 상품명","categoryPath":"대>중>소 추정","leafCategoryId":null,
"salePrice":숫자 또는 null,"searchTags":["태그 5~8개"]}

[셀러 설명]
${desc}`;
  const est = await callOpenAIJson(basePrompt, imageDataUri);
  const ntype = guessNoticeType(est.categoryPath || "");
  const fields = noticeFields(ntype);

  // 고시 추출 2차 — 설명/사진에 '명시된' 값만 읽기 (지어내기 금지)
  const fieldList = fields.map(([k, lbl]) => `  - ${k} (${lbl})`).join("\n");
  const extractPrompt = `아래 셀러 설명(과 사진)에서 '실제로 적혀 있는' 정보만 그대로 추출한다.
적혀 있지 않으면 반드시 null. 절대 추측·생성·과장하지 마라. 효능 문구는 추출 대상이 아니다.
각 항목은 {"value": 값 또는 null, "source": "설명"|"사진"|null} 형식.

추출할 고시 항목:
${fieldList}
추가 항목:
  - afterServicePhone (A/S 또는 소비자상담 전화번호)
  - origin (제조국/원산지)
  - functional_number (기능성화장품 심사필 인증번호)

순수 JSON만:
{"notice":{"<필드키>":{"value":...,"source":...}, ...},
"afterServicePhone":{"value":...,"source":...},
"origin":{"value":...,"source":...},
"functional_number":{"value":...,"source":...}}

[셀러 설명]
${desc}`;
  const ext = await callOpenAIJson(extractPrompt, imageDataUri);

  const reg = blankRegistration(ntype);
  Object.assign(reg.ai_estimated, {
    name: est.name || "", categoryPath: est.categoryPath || "",
    leafCategoryId: est.leafCategoryId ?? null, salePrice: est.salePrice ?? null,
    searchTags: est.searchTags || [],
  });

  // 추출 결과 반영 — value/source 보존
  const sr = reg.seller_required;
  const en = ext.notice || {};
  for (const k of Object.keys(sr.notice)) {
    const cell = en[k] || {};
    sr.notice[k] = { value: cell.value ?? null, source: cell.source ?? null };
  }
  const asp = ext.afterServicePhone || {};
  sr.afterServicePhone = { value: asp.value ?? null, source: asp.source ?? null };
  const org = ext.origin || {};
  sr.origin = { value: org.value ?? null, source: org.source ?? null };
  const fn = ext.functional_number || {};
  sr.functional = { "여부": !!fn.value, "심사필인증번호": fn.value ?? null, source: fn.source ?? null };
  return reg;
}

// ── 2-5. 카피 분석 (lab_source/analyze.py analyze 포팅) ★핵심 ────────────────
const COMMON = `"category":{"path":"카테고리 경로","leafId":"추정ID 또는 미정"},
"name":"검색 잘 되는 상품명","salePrice":32000,"stockQuantity":100,
"functional":{"기능성여부":false,"유형":[],"심사필인증번호":null},
"notice":{"용량또는중량":"","사용기한":"","제조사":null,"제조국":"","주요성분":""},
"delivery":{"기본배송비":3000,"출고지":null},"afterService":{"전화번호":null},
"origin":{"원산지":""},"searchTags":["태그1","태그2"]`;

export async function analyze(desc, templateKey, imageDataUri = null, verifiedFacts = null) {
  const tpl = TEMPLATES[templateKey] || TEMPLATES["point_dark"];

  let factsBlock = "";
  if (verifiedFacts) {
    const lines = Object.entries(verifiedFacts)
      .filter(([, v]) => v)
      .map(([k, v]) => `  - ${k}: ${v}`)
      .join("\n");
    factsBlock = `
[검증된 사실 — 이 목록 안에서만 카피 작성]
${lines}

절대 규칙:
- 위 '검증된 사실'에 없는 효능·성분·기능을 새로 지어내지 마라.
- 금지 표현: 피부장벽 강화, 진정, 미백, 주름개선, 치료, 효과 보장 등 — 사실에 근거(기능성 심사필 등)가 없으면 쓰지 마라.
- "안심하고 사용", "건강한 피부 유지" 같은 근거 없는 효능 단정 금지.
- 제품 유형·용량·성분 등 사실 기반 표현과 감성 표현(촉촉, 산뜻 등 사용감)만 허용.
`;
  }

  const prompt = `너는 커머원 상품 분석기다. 셀러 설명(과 사진이 있으면 사진)을 분석해
스마트스토어 등록 + 상세페이지에 필요한 정보를 순수 JSON으로만 출력한다.
모르는 고시 항목(제조사/인증번호 등)은 지어내지 말고 null.
문자열 값 안에 큰따옴표 금지(강조 <b></b>, 줄바꿈 <br>). 코드펜스/설명 금지.
img_brief 가 있으면: 업로드한 제품을 어떤 배경·연출로 합성할지 한 문장으로 써라
(제품 자체는 그대로 두고 배경만, 글자/텍스트 없이). 슬롯마다 다른 연출로.
각 슬롯에 적힌 글자수 범위를 반드시 지켜라(예: "45~65자" → 그 길이로 꽉 채움).
desc 류는 짧게 한 줄로 끝내지 말고 지정 글자수만큼 2~3문장으로 충실히 작성.
${factsBlock}
스키마:
{${COMMON},
${tpl.schema}}

[셀러 설명]
${desc}`;

  return callOpenAIJson(prompt, imageDataUri, 0.5);
}

// ── 2-6. 나노바나나 연출컷 (lab_source/images.py scene 포팅) ★Node 차이 주의 ──
// Python google-genai 의 interactions API → Node @google/genai 는 models.generateContent.
// SDK 우선 시도, 미설치/미지원 시 REST(generativelanguage) 폴백.
// 프롬프트·"제품 유지/글자 금지" 제약은 동일하게 유지.
function _extractInlineImage(resp) {
  const cands = resp?.candidates || [];
  for (const c of cands) {
    const parts = c?.content?.parts || [];
    for (const p of parts) {
      const inline = p.inlineData || p.inline_data;
      if (inline && inline.data) {
        const mime = inline.mimeType || inline.mime_type || "image/png";
        return `data:${mime};base64,` + inline.data;
      }
    }
  }
  return null;
}

export async function scene(dataUri, prompt) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY 가 .env 에 없음");
  const model = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
  const b64 = dataUri.split(",").pop();

  const fullPrompt =
    "이 제품 이미지의 제품(모양·색·라벨)은 절대 바꾸지 말고 그대로 유지하면서, " +
    "배경만 다음 연출로 합성해줘. 글자/텍스트는 넣지 마. 연출: " + prompt;

  // 1) @google/genai SDK 우선 시도 (Node SDK: ai.models.generateContent)
  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const resp = await ai.models.generateContent({
      model,
      contents: [{
        role: "user",
        parts: [
          { text: fullPrompt },
          { inlineData: { mimeType: "image/png", data: b64 } },
        ],
      }],
    });
    const img = _extractInlineImage(resp);
    if (img) return img;
  } catch {
    // SDK 미설치/미지원 → REST 폴백
  }

  // 2) REST 폴백 (generativelanguage.googleapis.com)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { text: fullPrompt },
          { inline_data: { mime_type: "image/png", data: b64 } },
        ],
      }],
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`나노바나나 호출 실패 ${r.status} (모델명/결제 상태 확인): ${detail}`);
  }
  const data = await r.json();
  const img = _extractInlineImage(data);
  if (img) return img;
  throw new Error("나노바나나 응답에 이미지가 없음 (모델명/결제 상태 확인)");
}

// ── 2-7. 템플릿 렌더러 (lab_source/templates.py 포팅 — 기계적, 인라인 CSS 그대로) ──
const FONT = "'Apple SD Gothic Neo','Pretendard','Noto Sans KR',sans-serif";

function img(imgs, i, h = 320, bg = "#d9d9d9") {
  if (imgs && i < imgs.length && imgs[i]) {
    return `<div style="height:${h}px;overflow:hidden;background:${bg}"><img src="${imgs[i]}" style="width:100%;height:100%;object-fit:cover"></div>`;
  }
  return `<div style="height:${h}px;background:${bg};display:flex;align-items:center;justify-content:center;color:#8a8a8a;font-size:20px">이미지 슬롯 ${i + 1}</div>`;
}

function g(d, k, def = "") {
  const v = d ? (d[k] !== undefined ? d[k] : def) : def;
  return v !== null && v !== undefined && v !== "" ? v : def;
}

function imgRaw(imgs, i, bg = "#e9e9e9") {
  // 이미지 태그만 (래퍼 div는 호출부에서). 없으면 자리표시 텍스트.
  if (imgs && i < imgs.length && imgs[i]) {
    return `<img src="${imgs[i]}" style="width:100%;height:100%;object-fit:cover">`;
  }
  return `<span style="color:#9a9a9a;font-size:18px;letter-spacing:.04em">이미지 슬롯 ${i + 1}</span>`;
}

// ── 1. 제품 리스트 (검정) ────────────────────────────────
function t_product_list(d, imgs) {
  const items = g(d, "items", []) || [];
  let rows = "";
  for (const it of items) {
    rows += `
      <div style="display:flex;gap:18px;align-items:center;background:#fff;border-radius:12px;padding:16px;margin-bottom:14px">
        <div style="width:96px;height:96px;border-radius:8px;background:#e6e6e6;flex:none;overflow:hidden"></div>
        <div style="flex:1">
          <div style="font-size:18px;font-weight:700">${g(it, "name", "제품 이름")}</div>
          <div style="margin-top:8px"><span style="color:#e23b3b;font-weight:800">${g(it, "pct", "55%")}</span>
            <span style="text-decoration:line-through;color:#aaa;margin-left:8px">${g(it, "orig", "390,000")}원</span></div>
          <div style="font-size:20px;font-weight:800">${g(it, "sale", "179,999")}원</div>
        </div>
      </div>`;
  }
  return `<div style="background:#111;padding:46px 40px;font-family:${FONT};color:#fff">
      <div style="font-size:14px;color:#bbb">${g(d, "eyebrow", "여기에 짧은 설명")}</div>
      <div style="font-size:34px;font-weight:800;margin:6px 0 28px">${g(d, "title", "여기에 제품 이름")}</div>
      ${rows}
    </div>`;
}

// ── 2. 핵심 문구 + 스펙 리스트 (그레이) ──────────────────
function t_feature_spec(d, imgs) {
  const bullets = (g(d, "bullets", []) || []).map((b) => `<li style="margin:10px 0;font-size:15px">• ${b}</li>`).join("");
  return `<div style="background:#ececec;padding:46px 40px;font-family:${FONT};color:#1a1a1a">
      <div style="font-size:30px;font-weight:800;line-height:1.3;margin-bottom:24px">${g(d, "head", "여기에 핵심 문구를<br>넣어주세요")}</div>
      <div style="background:#2e2e2e;color:#fff;border-radius:14px;padding:26px">
        <div style="font-size:13px;color:#9a9a9a">지시 제품</div>
        <ul style="list-style:none;padding:0;margin:10px 0 0">${bullets}</ul>
      </div>
    </div>`;
}

// ── 3. 음식 히어로 (검정+스팀) ───────────────────────────
function t_food_hero(d, imgs) {
  return `<div style="background:#0e0e0e;padding:50px 40px;font-family:${FONT};color:#fff;text-align:center">
      <div style="display:inline-block;border:1px solid #c9a24b;color:#c9a24b;border-radius:20px;padding:5px 16px;font-size:13px">${g(d, "badge", "Point 1")}</div>
      <div style="font-size:30px;font-weight:800;line-height:1.4;margin:22px 0">${g(d, "head", "한우의 육즙을 진하게 담은<br>프리미엄 고기 김치찌개")}</div>
      <div style="font-size:14px;color:#cfcfcf;line-height:1.8">${g(d, "body", "엄선한 고기와 전골육수, 부대비 미리 담은<br>깊고 진한 국물맛")}</div>
      ${img(imgs, 0, 360, "#222")}
      <div style="font-size:20px;font-weight:700;margin-top:26px">${g(d, "footer", "국의 깊이와 맛의 풍격은 <b>술이 만듭니다</b>")}</div>
    </div>`;
}

// ── 4. 3단 가격 비교 (다크그린) ──────────────────────────
function t_price_columns(d, imgs) {
  const cols = g(d, "cols", []) || [];
  let cells = "";
  for (const c of cols) {
    cells += `<div style="flex:1;text-align:center">
          <div style="font-size:26px;font-weight:800;color:#cfe3c0">${g(c, "pct", "30%")}</div>
          <div style="font-size:13px;color:#9bbf94;margin:6px 0">${g(c, "label", "옵션")}</div>
          <div style="background:#cfd9c2;height:120px;border-radius:8px;margin:10px 0"></div>
          <div style="font-size:17px;font-weight:800">${g(c, "price", "38,000")}원</div>
        </div>`;
  }
  return `<div style="background:#1f3326;padding:46px 40px;font-family:${FONT};color:#fff">
      <div style="font-size:30px;font-weight:800;line-height:1.3;margin-bottom:28px">${g(d, "title", "여기에 제품<br>이름을 넣어주세요")}</div>
      <div style="display:flex;gap:14px">${cells}</div>
    </div>`;
}

// ── 5. 시카케어 인트로 (라이트그린) ──────────────────────
function t_cica_intro(d, imgs) {
  return `<div style="background:#eef1ea;padding:50px 40px;font-family:${FONT};color:#1a1a1a;text-align:center">
      <div style="display:inline-block;border:1px solid #6b8f5e;color:#4f7042;border-radius:20px;padding:5px 16px;font-size:13px">${g(d, "badge", "Recommatte")}</div>
      <div style="font-size:30px;font-weight:800;margin:20px 0 12px">${g(d, "head", "피부 트러블 걱정?<br>피부과 대신, 시카 케어")}</div>
      <div style="font-size:14px;color:#566;line-height:1.7">${g(d, "body", "손상된 피부 사이로 함께 채워줘요")}</div>
      ${img(imgs, 0, 320, "#dfe6d6")}
    </div>`;
}

// ── 6/7. POINT 내용전개 (검정 / 흰색) — 정제 버전 ─────────
function _point(d, imgs, dark) {
  let bg, ink, sub, body, cap, card;
  if (dark) {
    [bg, ink, sub, body, cap, card] = ["#141414", "#f5f5f5", "#9a9a9a", "#b8b8b8", "#7a7a7a", "#2a2a2a"];
  } else {
    [bg, ink, sub, body, cap, card] = ["#fafafa", "#171717", "#8c8c8c", "#6e6e6e", "#b3b3b3", "#e9e9e9"];
  }
  const units = g(d, "units", []) || [];
  let blocks = "";
  units.forEach((u, i) => {
    const gap = i > 0 ? "108px" : "52px";
    blocks += `
      <p style="font-size:34px;line-height:1.7;letter-spacing:-.01em;color:${body};padding:0 70px;margin-top:${gap}">${g(u, "desc", "여기에다가 설명하는 텍스트를 넣어주세요")}</p>
      <div style="height:540px;background:${card};margin-top:56px;overflow:hidden;display:flex;align-items:center;justify-content:center">${imgRaw(imgs, i, card)}</div>
      <p style="font-size:34px;text-align:center;letter-spacing:.02em;color:${cap};margin-top:34px">${g(u, "caption", "여기에 서브 텍스트")}</p>`;
  });
  return `<div style="background:${bg};font-family:${FONT};color:${ink};padding-bottom:104px">
      <div style="padding:104px 70px 0">
        <div style="font-size:24px;letter-spacing:.34em;font-weight:700;color:${sub}">POINT&nbsp;&nbsp;${g(d, "point_no", "01")}</div>
        <div style="font-size:32px;font-weight:600;letter-spacing:-.01em;color:${sub};margin-top:26px">${g(d, "sub_text", "서브텍스트")}</div>
        <div style="font-size:58px;font-weight:800;line-height:1.3;letter-spacing:-.035em;margin-top:18px">${g(d, "headline", "여기에다 메인 텍스트를<br>넣어주세요")}</div>
      </div>${blocks}
    </div>`;
}

function t_point_dark(d, imgs) { return _point(d, imgs, true); }
function t_point_light(d, imgs) { return _point(d, imgs, false); }

// ── 8. 후기 만족도 바 (검정) ─────────────────────────────
function t_satisfaction(d, imgs) {
  let bars = "";
  for (const b of (g(d, "bars", []) || [])) {
    const pct = g(b, "pct", "100");
    bars += `<div style="display:flex;align-items:center;gap:14px;margin:12px 0">
          <div style="flex:1;font-size:14px">${g(b, "label", "만족도 항목")}</div>
          <div style="width:140px;height:10px;background:#333;border-radius:6px;overflow:hidden"><div style="width:${pct}%;height:100%;background:#e8c14b"></div></div>
          <div style="width:48px;text-align:right;font-weight:800;color:#e8c14b">${pct}%</div>
        </div>`;
  }
  return `<div style="background:#111;padding:46px 40px;font-family:${FONT};color:#fff">
      <div style="font-size:26px;font-weight:800;line-height:1.4;margin-bottom:24px">${g(d, "title", "직접 사용해본 사람들의<br>사용 후기 만족도 100%")}</div>
      ${bars}
    </div>`;
}

// ── 9. 배송 안내 (크림) ──────────────────────────────────
function t_delivery(d, imgs) {
  const rows = (g(d, "rows", []) || []).map((r) => `<tr><td style="padding:8px 10px;color:#888">${g(r, "k", "항목")}</td><td style="padding:8px 10px;font-weight:600">${g(r, "v", "")}</td></tr>`).join("");
  return `<div style="background:#f3ecd9;padding:46px 40px;font-family:${FONT};color:#2a2620">
      <div style="font-size:30px;font-weight:800">Delivery</div>
      <div style="font-size:30px;font-weight:800;margin-bottom:8px">Notice</div>
      <div style="font-size:13px;color:#8a8270;margin-bottom:20px">${g(d, "note", "주문/배송 안내")}</div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;background:#fff;border-radius:10px;overflow:hidden">${rows}</table>
    </div>`;
}

// ── 10. 리얼 후기 카드 (흰색) ────────────────────────────
function t_review_cards(d, imgs) {
  let cards = "";
  (g(d, "cards", []) || []).forEach((c, i) => {
    const thumb = (imgs && i < imgs.length && imgs[i]) ? imgs[i] : null;
    const timg = thumb
      ? `<img src="${thumb}" style="width:84px;height:84px;border-radius:8px;object-fit:cover;flex:none">`
      : '<div style="width:84px;height:84px;border-radius:8px;background:#eee;flex:none"></div>';
    cards += `<div style="display:flex;gap:14px;background:#fff;border:1px solid #eee;border-radius:12px;padding:16px;margin-bottom:12px">
          ${timg}
          <div style="flex:1"><div style="color:#f0a500">★★★★★</div>
          <div style="font-size:14px;line-height:1.6;margin-top:6px">${g(c, "text", "여기에 후기 텍스트")}</div></div>
        </div>`;
  });
  return `<div style="background:#fafafa;padding:46px 40px;font-family:${FONT};color:#1a1a1a">
      <div style="font-size:14px;color:#888">리얼 후기 넣어주세요</div>
      <div style="font-size:30px;font-weight:800;margin:4px 0 24px">${g(d, "title", "소비자의 리얼 후기")}</div>
      ${cards}
    </div>`;
}

export const TEMPLATES = {
  product_list: { label: "① 제품 리스트", render: t_product_list,
    schema: '"detail":{"eyebrow":"짧은 설명","title":"섹션 제목","items":[{"name":"제품명","pct":"55%","orig":"390,000","sale":"179,999"}]}' },
  feature_spec: { label: "② 핵심문구+스펙", render: t_feature_spec,
    schema: '"detail":{"head":"핵심 문구 1~2줄 <br>","bullets":["특징1","특징2","특징3"]}' },
  food_hero: { label: "③ 음식 히어로", render: t_food_hero,
    schema: '"detail":{"badge":"Point 1","head":"메인 카피 2줄 <br>","body":"설명 1~2줄 <br>","footer":"마무리 한줄, 핵심 <b>강조</b>","img_brief":"이 제품을 어떤 배경/연출로 합성할지 한 문장"}' },
  price_columns: { label: "④ 3단 가격비교", render: t_price_columns,
    schema: '"detail":{"title":"제목 <br>","cols":[{"pct":"10%","label":"옵션명","price":"17,000"},{"pct":"30%","label":"옵션명","price":"38,000"},{"pct":"40%","label":"옵션명","price":"42,000"}]}' },
  cica_intro: { label: "⑤ 시카케어 인트로", render: t_cica_intro,
    schema: '"detail":{"badge":"배지","head":"메인 카피 <br>","body":"설명 1줄","img_brief":"이 제품을 어떤 배경/연출로 합성할지 한 문장"}' },
  point_dark: { label: "⑥ POINT(검정)", render: t_point_dark,
    schema: '"detail":{"point_no":"01","sub_text":"서브 한줄 8~16자","headline":"핵심 헤드라인 12~22자(필요시 <br>로 2줄)","units":[{"desc":"베네핏 설명 45~65자, 2~3문장, <br>로 줄바꿈","caption":"이미지 캡션 6~14자","img_brief":"연출컷 배경/연출 한 문장"},{"desc":"두번째 베네핏 45~65자, 2~3문장 <br>","caption":"캡션 6~14자","img_brief":"다른 연출 한 문장"}]}' },
  point_light: { label: "⑦ POINT(흰색)", render: t_point_light,
    schema: '"detail":{"point_no":"01","sub_text":"서브 한줄 8~16자","headline":"핵심 헤드라인 12~22자(필요시 <br>로 2줄)","units":[{"desc":"베네핏 설명 45~65자, 2~3문장, <br>로 줄바꿈","caption":"이미지 캡션 6~14자","img_brief":"연출컷 배경/연출 한 문장"},{"desc":"두번째 베네핏 45~65자, 2~3문장 <br>","caption":"캡션 6~14자","img_brief":"다른 연출 한 문장"}]}' },
  satisfaction: { label: "⑧ 후기 만족도", render: t_satisfaction,
    schema: '"detail":{"title":"제목 <br>","bars":[{"label":"항목","pct":"100"},{"label":"항목","pct":"98"}]}' },
  delivery: { label: "⑨ 배송 안내", render: t_delivery,
    schema: '"detail":{"note":"안내 한줄","rows":[{"k":"배송기간","v":"평일 2~3일"},{"k":"배송비","v":"3,000원"}]}' },
  review_cards: { label: "⑩ 리얼 후기 카드", render: t_review_cards,
    schema: '"detail":{"title":"소비자의 리얼 후기","cards":[{"text":"후기 텍스트","img_brief":"연출컷 설명 한 문장"},{"text":"후기 텍스트","img_brief":"연출컷 설명 한 문장"},{"text":"후기 텍스트","img_brief":"연출컷 설명 한 문장"}]}' },
};

// 슬롯 순서대로 연출컷 명세 리스트. 이미지 슬롯 없는 템플릿은 [].
export function imageBriefs(key, detail) {
  const d = detail || {};
  if (key === "point_dark" || key === "point_light") {
    return (d.units || []).map((u) => (u || {}).img_brief || "");
  }
  if (key === "review_cards") {
    return (d.cards || []).map((c) => (c || {}).img_brief || "");
  }
  if (key === "food_hero" || key === "cica_intro") {
    return [d.img_brief || ""];
  }
  return [];
}

export function renderTemplate(key, detail, imgs) {
  const t = TEMPLATES[key] || TEMPLATES["point_dark"];
  const inner = t.render(detail || {}, imgs || []);
  return `<div style="width:860px;margin:0 auto;background:#fff">${inner}</div>`;
}
