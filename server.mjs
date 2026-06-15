import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";

const app = express();
app.use(express.json());
app.use(cookieParser());

// 쿠키 세션이 있으면 licenseKey를 query에 주입 (기존 라우트 무수정 호환)
app.use(async (req, res, next) => {
  try {
    const token = req.cookies?.co_session;
    if (token && !req.query.licenseKey) {
      const { verifySession } = await import("./lib/auth-util.js");
      const sess = verifySession(token);
      if (sess?.licenseKey) req.query.licenseKey = sess.licenseKey;
    }
  } catch {}
  next();
});

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

async function load(route, path) {
  const mod = await import(path);
  app.all(route, async (req, res) => {
    try { await mod.default(req, res); } catch (e) {
      console.error(route, e);
      res.status(500).json({ error: e.message });
    }
  });
  console.log("  " + route);
}

console.log("Loading routes:");
await load("/api/review-reply", "./api/review-reply.js");
await load("/api/store-register", "./api/store-register.js");
await load("/api/cs-reply", "./api/cs-reply.js");
await load("/api/my-ip", "./api/my-ip.js");
await load("/api/dashboard-stats", "./api/dashboard-stats.js");
await load("/api/history-list", "./api/history-list.js");
await load("/api/history-push", "./api/history-push.js");
await load("/api/claim/pending", "./api/claim/_pending.js");
await load("/api/claim/auto-process", "./api/claim/_auto-process.js");
await load("/api/claim/manual-decide", "./api/claim/_manual-decide.js");
await load("/api/inquiry/ai-answer", "./api/inquiry/_ai-answer.js");
await load("/api/inquiry/list", "./api/inquiry/_list.js");
await load("/api/inquiry/submit", "./api/inquiry/_submit.js");
await load("/api/order/pending", "./api/order/_pending.js");
await load("/api/order/auto-confirm", "./api/order/_auto-confirm.js");
await load("/api/order/dispatch", "./api/order/_dispatch.js");
await load("/api/order/dispatch-bulk", "./api/order/_dispatch-bulk.js");
await load("/api/order/sales-status", "./api/order/_sales-status.js");
await load("/api/penalty/risk-scan", "./api/penalty/_risk-scan.js");
await load("/api/penalty/history", "./api/penalty/_history.js");
await load("/api/settlement/daily", "./api/settlement/_daily.js");
await load("/api/settlement/sync", "./api/settlement/_sync.js");
await load("/api/settlement/margin-rank", "./api/settlement/_margin-rank.js");
await load("/api/settlement/commission-roi", "./api/settlement/_commission-roi.js");await load("/api/ad/efficiency", "./api/ad/_efficiency.js");
await load("/api/ad/recommendations", "./api/ad/_recommendations.js");
await load("/api/ad/alert", "./api/ad/_alert.js");
await load("/api/qa/list", "./api/qa/_list.js");
await load("/api/qa/ai-answer", "./api/qa/_ai-answer.js");
await load("/api/qa/auto-process", "./api/qa/_auto-process.js");
await load("/api/group/suggest", "./api/group/_suggest.js");
await load("/api/group/create", "./api/group/_create.js");
await load("/api/group/list", "./api/group/_list.js");
await load("/api/product/cost-list", "./api/product/_cost-list.js");
await load("/api/product/cost-bulk", "./api/product/_cost-bulk.js");
await load("/api/product/cost", "./api/product/_cost.js");
await load("/api/catalog-map/bulk", "./api/catalog-map/_bulk.js");
await load("/api/catalog-map/list", "./api/catalog-map/_list.js");
await load("/api/automation/config", "./api/automation/_config.js");
await load("/api/cache/feature", "./api/cache/_feature.js");
await load("/api/settings", "./api/settings/_settings.js");
await load("/api/product-ai/analyze", "./api/product-ai/_analyze.js");
await load("/api/product-ai/generate", "./api/product-ai/_generate.js");
await load("/api/product-ai/apply", "./api/product-ai/_apply.js");
await load("/api/product-ai/bulk-analyze", "./api/product-ai/_bulk-analyze.js");
await load("/api/review/sync", "./api/review/_sync.js");
await load("/api/review/list", "./api/review/_list.js");
await load("/api/review/replied", "./api/review/_replied.js");
await load("/api/auth/naver/login", "./api/auth/_login.js");
await load("/api/auth/naver/callback", "./api/auth/_callback.js");
await load("/api/auth/me", "./api/auth/_me.js");
await load("/api/auth/logout", "./api/auth/_logout.js");
await load("/api/auth/signup", "./api/auth/_signup.js");
await load("/api/auth/email-login", "./api/auth/_email-login.js");
await load("/api/auth/verify-password", "./api/auth/_verify-password.js");

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("NavOne server on port " + port));
