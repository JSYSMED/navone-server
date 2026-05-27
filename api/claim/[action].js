import autoProcess from "./_auto-process.js";
import manualDecide from "./_manual-decide.js";
import pending from "./_pending.js";
const routes = { "auto-process": autoProcess, "manual-decide": manualDecide, "pending": pending };
export default async function handler(req, res) {
  const fn = routes[req.query.action];
  if (!fn) return res.status(404).json({ error: "Unknown action: " + req.query.action });
  return fn(req, res);
}
