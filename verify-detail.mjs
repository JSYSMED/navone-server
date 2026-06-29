// =============================================
// NavOne 상세페이지+등록정보 엔진 검증 (DETAIL_GENERATOR_SPEC.md §5)
//   1) registration 단위 — 토리든 세럼 픽스처로 estimateRegistration 검증
//      (SEO 금지어 없음 / guessNoticeType=COSMETIC / 명시값은 {value,source} / 미명시는 null)
//   2) 환각 차단 — analyze(...,verifiedFacts) 결과 detail 텍스트에 금지어 미포함
//   3) 렌더 — renderTemplate 가 <div style="width:860px... 로 시작, 슬롯 비어도 안 깨짐
//   4) 연출컷 — scene() 이 data URI 반환 (GEMINI_API_KEY 있을 때만, 없으면 skip)
//
//   키는 env에서만 읽는다(하드코딩 금지).
//   실행: set -a; . ./.env.local; set +a; node verify-detail.mjs
// =============================================
import "dotenv/config";
import {
  estimateRegistration, guessNoticeType, analyze, renderTemplate, scene,
} from "./lib/detail-generator.js";

const line = () => console.log("-".repeat(54));

// 토리든 설명 픽스처 (lab 테스트에서 쓰던 것)
const DESC = `토리든 다이브인 저분자 히알루론산 세럼, 50ml, 1개 / 용량 50ml / 모든 피부용 /
화장품제조업자: 주식회사 정코스 / 화장품책임판매업자: (주)토리든 / 제조국: 대한민국 /
사용방법: 본 세럼의 적당량을 덜어 피부에 골고루 바른 후 두드려 흡수 / A/S 1600-3584`;

// 상품명 SEO 금지 수식어 (registration.py NAME_RULES 기준)
const NAME_BANNED = ["최고", "인기", "특가", "최저가", "무료배송", "정품", "공식", "베스트", "1위", "가성비", "세일", "한정"];
// 환각 금지어 (SPEC §5-2)
const HALLUCINATION_BANNED = ["피부장벽 강화", "미백", "치료", "효과 보장", "안심하고 사용"];

// detail 객체의 모든 문자열을 평탄화 수집
function collectStrings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectStrings(x, out));
  return out;
}

async function main() {
  console.log("\nNavOne 상세페이지+등록정보 엔진 검증");
  line();
  if (!process.env.OPENAI_API_KEY) {
    console.log("X OPENAI_API_KEY 누락. set -a; . ./.env.local; set +a 먼저.\n");
    process.exit(1);
  }
  console.log("OPENAI_MODEL:", process.env.OPENAI_MODEL || "gpt-4o-mini");
  console.log("GEMINI:", process.env.GEMINI_API_KEY ? "있음" : "없음(연출컷 skip)");
  line();

  let pass = 0, fail = 0;
  const ok = (cond, msg) => { console.log((cond ? "   OK  " : "   X   ") + msg); cond ? pass++ : fail++; };

  // ── 1) registration 단위 ─────────────────────────────
  console.log("1) estimateRegistration (토리든 세럼)");
  const reg = await estimateRegistration(DESC, null);
  const name = reg.ai_estimated?.name || "";
  console.log("   상품명:", name);
  ok(!NAME_BANNED.some((w) => name.includes(w)), `상품명 SEO 금지 수식어 없음`);
  ok(guessNoticeType(reg.ai_estimated?.categoryPath || "") === "COSMETIC",
    `guessNoticeType=COSMETIC (categoryPath="${reg.ai_estimated?.categoryPath}")`);

  const notice = reg.seller_required?.notice || {};
  const cap = notice.capacity, mfr = notice.manufacturer, org = reg.seller_required?.origin;
  ok(cap?.value && cap?.source === "설명", `용량 {value:"${cap?.value}", source:"${cap?.source}"}`);
  ok(mfr?.value && mfr?.source === "설명", `제조사 {value:"${mfr?.value}", source:"${mfr?.source}"}`);
  ok(org?.value && org?.source === "설명", `제조국 {value:"${org?.value}", source:"${org?.source}"}`);
  // 설명에 없는 기능성 심사필 인증번호는 null
  ok(reg.seller_required?.functional?.["심사필인증번호"] == null,
    `미명시 인증번호 null (=${reg.seller_required?.functional?.["심사필인증번호"]})`);

  // ── 2) 환각 차단 ─────────────────────────────────────
  line();
  console.log("2) analyze 환각 차단 (point_light, verifiedFacts 주입)");
  const vf = {};
  vf["상품명"] = reg.ai_estimated?.name;
  vf["카테고리"] = reg.ai_estimated?.categoryPath;
  for (const [k, cell] of Object.entries(notice)) {
    const val = cell && typeof cell === "object" ? cell.value : cell;
    if (val) vf[reg._notice_labels?.[k] || k] = val;
  }
  if (org?.value) vf["원산지"] = org.value;

  const prof = await analyze(DESC, "point_light", null, vf);
  const texts = collectStrings(prof.detail || {});
  const joined = texts.join(" ");
  const hit = HALLUCINATION_BANNED.filter((w) => joined.includes(w));
  ok(hit.length === 0, hit.length ? `금지어 발견: ${hit.join(", ")}` : "금지어 미포함 (피부장벽강화/미백/치료/효과보장/안심하고 사용)");

  // ── 3) 렌더 ──────────────────────────────────────────
  line();
  console.log("3) renderTemplate (point_light)");
  const htmlFull = renderTemplate("point_light", prof.detail, []);
  ok(htmlFull.startsWith('<div style="width:860px'), `<div style="width:860px 로 시작`);
  // 슬롯 비어도 안 깨짐: detail 비고 imgs 비어도 문자열 반환
  const htmlEmpty = renderTemplate("point_light", {}, []);
  ok(typeof htmlEmpty === "string" && htmlEmpty.startsWith('<div style="width:860px') && htmlEmpty.length > 100,
    `빈 detail/슬롯에도 HTML 정상 반환 (len ${htmlEmpty.length})`);

  // ── 4) 연출컷 (키 있을 때만) ─────────────────────────
  line();
  console.log("4) scene 연출컷");
  if (process.env.GEMINI_API_KEY) {
    // 1x1 투명 PNG data URI
    const testDataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==";
    try {
      const out = await scene(testDataUri, "숲속 배경");
      ok(typeof out === "string" && out.startsWith("data:"), `scene → data URI (len ${out.length})`);
    } catch (e) {
      ok(false, `scene 실패: ${e.message}`);
    }
  } else {
    console.log("   --  GEMINI_API_KEY 없음 → 연출컷 검증 skip");
  }

  line();
  console.log(`결과: ${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("\n예외:", e.status || "", e.message, e.detail || ""); process.exit(1); });
