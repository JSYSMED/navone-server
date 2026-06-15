// =============================================
// CommerOne — POST /api/auth/email-login
// email + 비밀번호 로그인.
//   - bcrypt 비밀번호 검증
//   - status가 'suspended'면 차단. 'pending'이면 로그인은 되되 승인대기 안내(클라에서 처리)
//   - 성공 시 JWT 세션 쿠키 발급
//   Body: { email, password }
// (네이버 로그인 _callback.js 와 동일한 co_session 쿠키 틀을 공유 → _me.js가 양쪽 다 처리)
// =============================================

import bcrypt from "bcryptjs";
import { sbSelect, sbUpsert } from "../../lib/supabase.js";
import { signSession } from "../../lib/auth-util.js";

function fail(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "METHOD", "POST만 지원합니다.");

  try {
    const { email, password } = req.body || {};
    const em = String(email || "").trim().toLowerCase();
    if (!em || !password) return fail(res, 400, "MISSING", "이메일과 비밀번호를 입력하세요.");

    const rows = await sbSelect(
      "navone_users",
      "email=eq." + encodeURIComponent(em) +
        "&select=id,email,name,password,license_key,plan,status&limit=1"
    );
    const user = Array.isArray(rows) && rows.length ? rows[0] : null;

    // 이메일 없거나, 비번 미설정(네이버로만 가입한 계정) → 동일 메시지(계정 노출 방지)
    if (!user || !user.password) {
      return fail(res, 401, "INVALID_CREDENTIALS", "이메일 또는 비밀번호가 올바르지 않습니다.");
    }

    const ok = await bcrypt.compare(String(password), user.password);
    if (!ok) return fail(res, 401, "INVALID_CREDENTIALS", "이메일 또는 비밀번호가 올바르지 않습니다.");

    if (user.status === "suspended") {
      return fail(res, 403, "SUSPENDED", "이용이 정지된 계정입니다. 관리자에게 문의하세요.");
    }


    const token = signSession({ uid: user.id, licenseKey: user.license_key, plan: user.plan });
    res.setHeader("Set-Cookie", [
      `co_session=${token}; Domain=.commerone.store; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}`,
    ]);

    return res.status(200).json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, license_key: user.license_key, status: user.status, plan: user.plan },
    });
  } catch (err) {
    console.error("[auth/email-login]", err.message, err.detail);
    return fail(res, 500, "LOGIN_FAILED", err.message || "서버 오류");
  }
}
