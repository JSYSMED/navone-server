// =============================================
// NavOne — Supabase REST 헬퍼 (npm 패키지 없이 fetch 직접 호출)
// /api 밖(lib/)에 둬서 Vercel이 엔드포인트로 노출하지 않음.
//
// 필요한 환경변수: SUPABASE_URL, SUPABASE_SERVICE_KEY (Vercel 등록됨)
//
// 전제 스키마 (Supabase SQL):
//   create table stores (
//     id uuid primary key default gen_random_uuid(),
//     license_key text unique not null,
//     store_name text not null,
//     client_id text, client_secret text,
//     config jsonb default '{}'::jsonb,
//     created_at timestamptz default now(),
//     updated_at timestamptz default now()
//   );
//   create table price_history  ( id uuid primary key default gen_random_uuid(),
//     store_id uuid references stores(id), data jsonb default '{}'::jsonb,
//     created_at timestamptz default now() );
//   create table review_history ( ... 동일 ... );
//   create table cs_history     ( ... 동일 ... );
// =============================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export const HISTORY_TABLES = {
  price: "price_history",
  review: "review_history",
  cs: "cs_history",
};

// 실제 테이블의 개별 컬럼(snake_case). store_id/created_at 같은 인프라 컬럼은 제외.
export const HISTORY_COLUMNS = {
  price: [
    "channel_product_no", "product_name", "old_price", "new_price",
    "rank1_price", "rank2_price", "gap_percent", "action_type",
    "floor_price", "triggered_by",
  ],
  review: [
    "review_id", "product_name", "rating",
    "original_review", "generated_reply", "final_reply", "mode",
  ],
  cs: [
    "product_name", "inquiry_content", "generated_reply", "final_reply", "mode",
  ],
};

// 컬럼명과 다른 입력 키 별칭 (확장 프로그램이 보내는 키 호환)
const COLUMN_ALIASES = {
  floor_price: ["floor"],
  inquiry_content: ["content"],
};

function toCamel(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// body.data → 해당 type 테이블의 실제 컬럼으로 매핑.
// 각 컬럼값을 snake_case → camelCase → 별칭 순으로 찾는다 (둘 다 허용).
export function buildHistoryRow(type, data) {
  const cols = HISTORY_COLUMNS[type] || [];
  const row = {};
  for (const col of cols) {
    let v = data[col];
    if (v === undefined) v = data[toCamel(col)];
    if (v === undefined && COLUMN_ALIASES[col]) {
      for (const a of COLUMN_ALIASES[col]) {
        if (data[a] !== undefined) { v = data[a]; break; }
      }
    }
    if (v !== undefined) row[col] = v;
  }
  return row;
}

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

// 모든 응답에 공통 CORS 헤더
export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// OPTIONS 프리플라이트 + 메서드 체크. 처리됐으면 true 반환(핸들러는 즉시 return).
export function handlePreflight(req, res, allowed) {
  if (req.method === "OPTIONS") { res.status(200).end(); return true; }
  if (req.method !== allowed) { res.status(405).json({ error: "Method not allowed" }); return true; }
  return false;
}

// 환경변수 누락 가드
export function assertEnv() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    const e = new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY 미설정");
    e.status = 500;
    throw e;
  }
}

// 저수준 요청. 실패 시 status/detail 달린 Error throw.
async function sbRequest(path, { method = "GET", body, prefer } = {}) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method,
    headers: sbHeaders(prefer ? { Prefer: prefer } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }

  if (!res.ok) {
    const err = new Error((data && data.message) || ("Supabase 오류 " + res.status));
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return { data, headers: res.headers };
}

export async function sbSelect(table, query = "") {
  const { data } = await sbRequest(table + (query ? "?" + query : ""), { method: "GET" });
  return data || [];
}

export async function sbInsert(table, row) {
  const { data } = await sbRequest(table, {
    method: "POST", body: row, prefer: "return=representation",
  });
  return data;
}

// license_key 등 충돌 컬럼 기준 upsert
export async function sbUpsert(table, row, onConflict) {
  const q = onConflict ? "?on_conflict=" + encodeURIComponent(onConflict) : "";
  const { data } = await sbRequest(table + q, {
    method: "POST", body: row, prefer: "resolution=merge-duplicates,return=representation",
  });
  return data;
}

// SELECT + 전체 건수(Content-Range). { data, total } 반환.
export async function sbSelectWithCount(table, query = "") {
  const { data, headers } = await sbRequest(table + (query ? "?" + query : ""), {
    method: "GET", prefer: "count=exact",
  });
  const cr = headers.get("content-range") || "";
  const total = cr.includes("/") && cr.split("/")[1] !== "*"
    ? parseInt(cr.split("/")[1], 10)
    : (Array.isArray(data) ? data.length : 0);
  return { data: data || [], total };
}

// 조건에 맞는 행 수만 카운트 (store_id는 모든 history 테이블에 존재)
export async function sbCount(table, query = "") {
  const q = (query ? query + "&" : "") + "select=store_id&limit=1";
  const { total } = await sbSelectWithCount(table, q);
  return total;
}

// license_key → store_id (없으면 null)
export async function getStoreIdByLicense(licenseKey) {
  const rows = await sbSelect(
    "stores",
    "license_key=eq." + encodeURIComponent(licenseKey) + "&select=id&limit=1"
  );
  return Array.isArray(rows) && rows.length ? rows[0].id : null;
}

// 공통 에러 응답
export function sendError(res, err) {
  const status = err && err.status ? err.status : 500;
  console.error("API error:", status, err && err.message, err && err.detail);
  res.status(status).json({ error: (err && err.message) || "서버 오류" });
}
