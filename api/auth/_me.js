import { sbSelect } from "../../lib/supabase.js";
import { verifySession } from "../../lib/auth-util.js";

export default async function handler(req, res) {
  const token = req.cookies?.co_session;
  const sess = token && verifySession(token);
  if (!sess) return res.status(401).json({ error: "unauthorized" });

  const rows = await sbSelect(
    "navone_users",
    "id=eq." + encodeURIComponent(sess.uid) +
    "&select=id,name,email,license_key,plan,status,trial_ends_at&limit=1"
  );
  const user = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!user) return res.status(401).json({ error: "unauthorized" });

  res.status(200).json({ user });
}
