import riskScan from "./_risk-scan.js";
import history from "./_history.js";
const routes = { "risk-scan": riskScan, "history": history };
export default async function handler(req, res) {
  const fn = routes[req.query.action];
  if (!fn) return res.status(404).json({ error: "Unknown action: " + req.query.action });
  return fn(req, res);
}
