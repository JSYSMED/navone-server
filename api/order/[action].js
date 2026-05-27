import autoConfirm from "./_auto-confirm.js";
import dispatch from "./_dispatch.js";
import dispatchBulk from "./_dispatch-bulk.js";
import pending from "./_pending.js";
const routes = { "auto-confirm": autoConfirm, "dispatch": dispatch, "dispatch-bulk": dispatchBulk, "pending": pending };
export default async function handler(req, res) {
  const fn = routes[req.query.action];
  if (!fn) return res.status(404).json({ error: "Unknown action: " + req.query.action });
  return fn(req, res);
}
