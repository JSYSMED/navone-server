export default async function handler(req, res) {
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    const data = await r.json();
    return res.status(200).json({ serverIp: data.ip, forwardedFor: ip });
  } catch(e) {
    return res.status(200).json({ error: e.message, forwardedFor: ip });
  }
}
