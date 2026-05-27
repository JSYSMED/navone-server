import aiAnswer from "./_ai-answer.js";
import list from "./_list.js";
import submit from "./_submit.js";
const routes = { "ai-answer": aiAnswer, "list": list, "submit": submit };
export default async function handler(req, res) {
  const fn = routes[req.query.action];
  if (!fn) return res.status(404).json({ error: "Unknown action: " + req.query.action });
  return fn(req, res);
}
