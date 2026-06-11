// =============================================
// CommerOne — POST /api/auth/verify-password
// 로그인된 사용자의 비밀번호 재확인 (설정 진입 등 민감 작업 게이트용).
//   - JWT 쿠키(co_session)로 누구인지 확인
//   - 입력 비번을 그 계정의 bcrypt 해시와 비교
//   Body: { password }
//   응답: { success, ok: true|false }
// (네이버로만 가입해 password가 없는 계정은 ok:false + 안내)
// =============================================

import bcrypt from "bcryptjs";
import { sbSelect } from "../../lib/supabase.js";
import { verifySession } from "../../lib/auth-util.js";

function fail(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "METHOD", "POST만 지원합니다.");

  try {
    const token = req.cookies?.co_session;
    const sess = token && verifySession(token);
    if (!sess) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");

    const { password } = req.body || {};
    if (!password) return fail(res, 400, "MISSING", "비밀번호를 입력하세요.");

    const rows = await sbSelect(
      "navone_users",
      "id=eq." + encodeURIComponent(sess.uid) + "&select=password&limit=1"
    );
    const user = Array.isArray(rows) && rows.length ? rows[0] : null;

    if (!user || !user.password) {
      // 네이버로만 가입(비번 없음) → 재확인 불가. 통과 막음.
      return res.status(200).json({ success: true, ok: false, code: "NO_PASSWORD" });
    }

    const ok = await bcrypt.compare(String(password), user.password);
    return res.status(200).json({ success: true, ok });
  } catch (err) {
    console.error("[auth/verify-password]", err.message, err.detail);
    return fail(res, 500, "VERIFY_FAILED", err.message || "서버 오류");
  }
}
