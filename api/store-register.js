// =============================================
// NavOne Vercel API — /api/store-register.js
// 스토어 등록/갱신 (license_key 기준 upsert)
// =============================================

import { setCors, handlePreflight, assertEnv, sbUpsert, sendError } from "../lib/supabase.js";

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    assertEnv();
    const { licenseKey, storeName, clientId, clientSecret, config } = req.body || {};

    if (!licenseKey || !storeName) {
      return res.status(400).json({ error: "licenseKey와 storeName은 필수입니다." });
    }

    const row = {
      license_key: licenseKey,
      store_name: storeName,
      client_id: clientId || null,
      client_secret: clientSecret || null,
      config: config || {},
      updated_at: new Date().toISOString(),
    };

    const data = await sbUpsert("stores", row, "license_key");
    const storeId = Array.isArray(data) && data.length ? data[0].id : null;

    return res.status(200).json({ success: true, storeId });
  } catch (err) {
    return sendError(res, err);
  }
}
