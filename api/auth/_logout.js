export default async function handler(req, res) {
  res.setHeader("Set-Cookie", [
    `co_session=; Domain=.commerone.store; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  ]);
  res.status(200).json({ ok: true });
}
