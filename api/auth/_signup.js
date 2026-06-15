// =============================================
// CommerOne — POST /api/auth/signup
// email + 비밀번호 회원가입.
//   - 비밀번호는 bcrypt 해싱 후 저장 (평문 저장 안 함)
//   - 라이선스 키 자동 발급 (genLicenseKey)
//   - status='pending' (관리자가 Supabase에서 active로 승인해야 실사용)
//   - 가입 즉시 JWT 세션 쿠키 발급 (로그인 상태로) — 단 기능은 status로 게이트
//   Body: { email, password, name? }
// =============================================

import bcrypt from "bcryptjs";
import { sbSelect, sbInsert } from "../../lib/supabase.js";
import { signSession, genLicenseKey } from "../../lib/auth-util.js";

function fail(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "METHOD", "POST만 지원합니다.");

  try {
    const { email, password, name } = req.body || {};
    const em = String(email || "").trim().toLowerCase();

    if (!EMAIL_RE.test(em)) return fail(res, 400, "BAD_EMAIL", "올바른 이메일을 입력하세요.");
    if (!password || String(password).length < 8) {
      return fail(res, 400, "WEAK_PASSWORD", "비밀번호는 8자 이상이어야 합니다.");
    }

    // 이미 가입된 이메일인지
    const exist = await sbSelect(
      "navone_users",
      "email=eq." + encodeURIComponent(em) + "&select=id&limit=1"
    );
    if (Array.isArray(exist) && exist.length) {
      return fail(res, 409, "EMAIL_TAKEN", "이미 가입된 이메일입니다.");
    }

    const hash = await bcrypt.hash(String(password), 10);
    const licenseKey = genLicenseKey();

    const ins = await sbInsert("navone_users", {
      email: em,
      password: hash,
      name: name ? String(name).trim() : null,
      license_key: licenseKey,
      plan: "trial",
      status: "pending",          // ← 관리자 승인 대기
    });
    const user = Array.isArray(ins) ? ins[0] : ins;
    if (!user) return fail(res, 500, "CREATE_FAILED", "가입 처리에 실패했습니다.");

    // 세션 발급 (가입=로그인). 기능 접근은 status로 별도 게이트.
    const token = signSession({ uid: user.id, licenseKey: user.license_key, plan: user.plan });
    res.setHeader("Set-Cookie", [
      `co_session=${token}; Domain=.commerone.store; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}`,
    ]);

    return res.status(200).json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, license_key: user.license_key, status: user.status, plan: user.plan },
    });
  } catch (err) {
    console.error("[auth/signup]", err.message, err.detail);
    return fail(res, 500, "SIGNUP_FAILED", err.message || "서버 오류");
  }
}
