import daily from "./_daily.js";
import marginRank from "./_margin-rank.js";
import sync from "./_sync.js";
const routes = { "daily": daily, "margin-rank": marginRank, "sync": sync };
export default async function handler(req, res) {
  const fn = routes[req.query.action];
  if (!fn) return res.status(404).json({ error: "Unknown action: " + req.query.action });
  return fn(req, res);
}
