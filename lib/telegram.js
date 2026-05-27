// =============================================
// NavOne — Telegram 봇 발송 헬퍼 (범용 모듈)
// npm 패키지 없이 fetch로 Telegram Bot API 직접 호출.
// /api 밖(lib/)에 둬서 Vercel이 엔드포인트로 노출하지 않음.
//
// 다른 에이전트(B 클레임, C 발주 등)도 이 모듈을 import 해서 사용.
//   import { sendTelegram } from "../lib/telegram.js";
//   await sendTelegram("<b>알림</b> 내용");
//
// 필요한 환경변수: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//
// 설계 원칙: 알림 실패가 메인 플로우를 깨뜨리면 안 되므로
//   throw 하지 않고 { ok } 결과 객체를 반환한다(soft-fail).
// =============================================

const TELEGRAM_API = "https://api.telegram.org";
const MAX_MESSAGE_LEN = 4096; // Telegram 단일 메시지 길이 제한

// HTML parse_mode에서 안전하도록 본문 텍스트 이스케이프.
// (상품명 등 동적 값에 사용 — 태그를 직접 쓰는 포맷 문자열엔 쓰지 말 것)
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 4096자 초과 메시지를 줄 단위로 분할.
function splitMessage(message, max = MAX_MESSAGE_LEN) {
  if (message.length <= max) return [message];
  const chunks = [];
  let rest = message;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) cut = max; // 줄바꿈이 없으면 강제로 자름
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Telegram 메시지 발송.
 * @param {string} message - HTML 포맷 메시지 본문
 * @param {string} [chatId] - 수신 chat id (기본: TELEGRAM_CHAT_ID)
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string, results?: any[] }>}
 */
export async function sendTelegram(message, chatId = process.env.TELEGRAM_CHAT_ID) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 발송 생략");
    return { ok: false, skipped: true, error: "missing_credentials" };
  }

  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const chunks = splitMessage(String(message));
  const results = [];

  for (const chunk of chunks) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        console.error("[telegram] 발송 실패:", res.status, data && data.description);
        results.push({ ok: false, status: res.status, error: data && data.description });
      } else {
        results.push({ ok: true, messageId: data.result && data.result.message_id });
      }
    } catch (err) {
      console.error("[telegram] 네트워크 오류:", err.message);
      results.push({ ok: false, error: err.message });
    }
  }

  return { ok: results.every((r) => r.ok), results };
}

export default { sendTelegram, escapeHtml };
