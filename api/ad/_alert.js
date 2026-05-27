// =============================================
// NavOne Vercel API — /api/ad/alert
// ROAS < 300% (위험+경고) 광고 비효율 상품을 Telegram 으로 알림 발송.
//
//   POST /api/ad/alert  { licenseKey, start?, end? }
//   응답: { success: true, data: { notified, candidates, summary, range } }
//
// 의존: lib/telegram.js (sendTelegram), lib/ad-efficiency.js
// 알림 실패는 메인 플로우를 깨지 않음(soft-fail) — telegram.js 규약.
// =============================================

import { setCors, handlePreflight, assertEnv, sbSelect } from "../../lib/supabase.js";
import { sendTelegram, escapeHtml } from "../../lib/telegram.js";
import {
  computeAdEfficiency, summarizeRecommendations, buildCostMap, fail, sendFail,
} from "../../lib/ad-efficiency.js";

const ALERT_ROAS_THRESHOLD = 300; // 이 미만(위험+경고) 상품을 알림 대상으로
const LIST_MAX = 15;              // 메시지에 나열할 상품 최대 건수

function defaultRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

const won = (n) => Number(n || 0).toLocaleString("ko-KR");

function formatMessage(storeName, candidates, summary, range) {
  const parts = [];
  parts.push(`<b>📉 NavOne 광고비 효율 경고</b>`);
  parts.push(escapeHtml(storeName || ""));
  parts.push(`기간: ${range.start} ~ ${range.end}`);
  parts.push("");
  parts.push(`<b>ROAS ${ALERT_ROAS_THRESHOLD}% 미만 ${candidates.length}건</b> (평균 ROAS ${summary.avgRoas}%)`);
  parts.push("");

  const shown = candidates.slice(0, LIST_MAX).map((p) => {
    const emoji = p.level === "danger" ? "🚨" : "⚠️";
    return `${emoji} ${escapeHtml(p.productName)}\n   ROAS ${p.roas}% · 광고비 ${won(p.adFee)}원 · ${p.actionLabel}`;
  });
  parts.push(shown.join("\n"));
  if (candidates.length > LIST_MAX) parts.push(`… 외 ${candidates.length - LIST_MAX}건`);

  parts.push("");
  parts.push(`💡 위험(ROAS<150%) ${summary.dangerCount}건은 광고 중단을, 경고(150~300%) ${summary.warningCount}건은 감액을 검토하세요.`);
  return parts.join("\n").trim();
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    assertEnv();
    const { licenseKey, start: startIn, end: endIn } = req.body || {};
    if (!licenseKey) return fail(res, 400, "MISSING_LICENSE", "licenseKey는 필수입니다.");

    const def = defaultRange();
    const start = startIn || def.start;
    const end = endIn || def.end;

    const stores = await sbSelect(
      "stores",
      "license_key=eq." + encodeURIComponent(licenseKey) + "&select=id,store_name,config&limit=1"
    );
    const store = Array.isArray(stores) && stores.length ? stores[0] : null;
    if (!store) return fail(res, 404, "STORE_NOT_FOUND", "등록된 스토어가 없습니다.");

    const rows = await sbSelect(
      "navone_settlements",
      "store_id=eq." + encodeURIComponent(store.id) +
        "&settlement_date=gte." + encodeURIComponent(start) +
        "&settlement_date=lte." + encodeURIComponent(end) +
        "&ad_fee=gt.0" +
        "&select=channel_product_no,product_name,product_order_id,quantity,sales_amount,settlement_amount,commission_fee,ad_fee,delivery_fee,return_deduct" +
        "&order=settlement_date.desc&limit=5000"
    );

    const costMap = buildCostMap(store.config);
    const products = computeAdEfficiency(rows || [], costMap);
    const { summary } = summarizeRecommendations(products);

    // ROAS < 300% (위험+경고). computeAdEfficiency 가 ROAS 오름차순이라 비효율 순.
    const candidates = products.filter((p) => p.roas < ALERT_ROAS_THRESHOLD);

    let notified = false;
    if (candidates.length) {
      const tg = await sendTelegram(formatMessage(store.store_name, candidates, summary, { start, end }));
      notified = !!tg.ok;
    }

    return res.status(200).json({
      success: true,
      data: {
        notified,
        candidateCount: candidates.length,
        candidates,
        summary,
        range: { start, end },
      },
    });
  } catch (err) {
    return sendFail(res, err);
  }
}
