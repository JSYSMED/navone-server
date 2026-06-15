import { sbSelect, sbInsert, sbUpsert } from "../../lib/supabase.js";
import { consumeState, signSession, genLicenseKey } from "../../lib/auth-util.js";

export default async function handler(req, res) {
  const { code, state } = req.query;
  const fail = (msg) =>
    res.redirect(`${process.env.APP_BASE_URL}/login?error=${encodeURIComponent(msg)}`);

  if (!code || !state) return fail("missing_params");
  if (!consumeState(state)) return fail("invalid_state");

  // 1) code -> 토큰
  const tokenRes = await fetch("https://nid.naver.com/oauth2.0/token?" + new URLSearchParams({
    grant_type: "authorization_code",
    client_id: process.env.NAVER_CLIENT_ID,
    client_secret: process.env.NAVER_CLIENT_SECRET,
    code, state,
  }));
  const tokenJson = await tokenRes.json();
  if (!tokenJson.access_token) return fail("token_failed");

  // 2) 프로필 조회
  const meRes = await fetch("https://openapi.naver.com/v1/nid/me", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  const meJson = await meRes.json();
  const p = meJson.response;
  if (!p?.id) return fail("profile_failed");

  // 3) 유저 조회/생성 (식별키 = naver id)
  const existing = await sbSelect(
    "navone_users",
    "naver_id=eq." + encodeURIComponent(p.id) + "&limit=1"
  );
  let user = Array.isArray(existing) && existing.length ? existing[0] : null;

  if (!user) {
    const ins = await sbInsert("navone_users", {
      naver_id: p.id,
      name: p.name || p.nickname || null,
      email: p.email || null,
      license_key: genLicenseKey(),
      plan: "trial",
      status: "active",
    });
    user = Array.isArray(ins) ? ins[0] : ins;
  } else {
    await sbUpsert("navone_users", {
      id: user.id,
      naver_id: user.naver_id,
      license_key: user.license_key,
      name: p.name || user.name,
      email: p.email || user.email,
      last_login_at: new Date().toISOString(),
    }, "id");
  }
  if (!user) return fail("user_failed");

  // 4) 세션 JWT를 httpOnly 쿠키로
  const token = signSession({
    uid: user.id, licenseKey: user.license_key, plan: user.plan,
  });
  res.setHeader("Set-Cookie", [
    `co_session=${token}; Domain=.commerone.store; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}`,
  ]);
  res.redirect(`${process.env.APP_BASE_URL}/`);
}
