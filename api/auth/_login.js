import crypto from "crypto";
import { saveState } from "../../lib/auth-util.js";

export default async function handler(req, res) {
  const state = crypto.randomBytes(16).toString("hex");
  saveState(state);

  const redirectUri = `${process.env.APP_BASE_URL}/api/auth/naver/callback`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.NAVER_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
  });
  res.redirect(`https://nid.naver.com/oauth2.0/authorize?${params}`);
}
