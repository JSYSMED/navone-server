// =============================================
// NavOne — 네이버 커머스 API 인증 공유 헬퍼 (shared)
// AGENTS.md §4.1 에 명시된 인터페이스: getCommerceHeaders(clientId, clientSecret)
//
// /api 밖(lib/)에 둬서 Vercel이 엔드포인트로 노출하지 않음.
// 모든 에이전트(A/B/C/D/E)가 import 해서 사용. ⚠️ 수정 시 전체 영향 — 신중히.
//
// 인증 방식 (확장 background.js ensureToken()와 동일):
//   sign = base64( bcrypt.hashSync(`${clientId}_${timestamp}`, clientSecret) )
//   POST /external/v1/oauth2/token (grant_type=client_credentials, type=SELF)
//
// 필요한 npm 의존성: bcryptjs (package.json + README 명시)
// =============================================

import bcrypt from "bcryptjs";

const COMMERCE_BASE = "https://api.commerce.naver.com";

// clientId → { token, expiresAt(ms) }. 서버리스 인스턴스 재사용 중에만 유효.
const tokenCache = new Map();

// 커머스 API RPS 제한(초당 2회 이하) 준수용 최소 간격 가드.
let lastCallAt = 0;
const MIN_INTERVAL_MS = 500;

async function rpsGuard() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

// client_secret_sign 생성. clientSecret은 bcrypt salt 형식($2a$...).
function signature(clientId, timestamp, clientSecret) {
  const hashed = bcrypt.hashSync(`${clientId}_${timestamp}`, clientSecret);
  return Buffer.from(hashed).toString("base64");
}

// 액세스 토큰 발급/캐시. 만료 5분 전이면 갱신.
export async function getCommerceToken(clientId, clientSecret) {
  if (!clientId || !clientSecret) {
    const e = new Error("clientId/clientSecret 누락");
    e.status = 400;
    throw e;
  }

  const cached = tokenCache.get(clientId);
  if (cached && Date.now() < cached.expiresAt - 300000) return cached.token;

  const ts = Date.now();
  await rpsGuard();
  const res = await fetch(COMMERCE_BASE + "/external/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      timestamp: ts.toString(),
      client_secret_sign: signature(clientId, ts, clientSecret),
      grant_type: "client_credentials",
      type: "SELF",
    }),
  });

  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }

  if (!res.ok || !data?.access_token) {
    const err = new Error((data && data.message) || "커머스 토큰 발급 실패 (" + res.status + ")");
    err.status = res.status === 200 ? 502 : res.status;
    err.detail = data;
    throw err;
  }

  tokenCache.set(clientId, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 10800) * 1000,
  });
  return data.access_token;
}

// AGENTS.md §4.1 표준 인터페이스: 인증 헤더 반환.
export async function getCommerceHeaders(clientId, clientSecret) {
  const token = await getCommerceToken(clientId, clientSecret);
  return {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
}

// 커머스 API 범용 호출. 실패 시 status/detail 달린 Error throw.
//   commerceRequest("/external/v1/...", { clientId, clientSecret, method, query, body })
export async function commerceRequest(path, opts = {}) {
  const { clientId, clientSecret, method = "GET", query, body } = opts;
  const headers = await getCommerceHeaders(clientId, clientSecret);

  let url = COMMERCE_BASE + path;
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) qs.append(k, v);
    }
    url += "?" + qs.toString();
  }

  await rpsGuard();
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }

  if (!res.ok) {
    const err = new Error((data && (data.message || data.error?.message)) || "커머스 API 오류 " + res.status);
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

export { COMMERCE_BASE };
