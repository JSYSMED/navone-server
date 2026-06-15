import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

// state 임시 저장 (단일 인스턴스라 메모리로 충분, 10분 TTL)
const stateStore = new Map();
export function saveState(state) {
  stateStore.set(state, Date.now() + 10 * 60 * 1000);
}
export function consumeState(state) {
  const exp = stateStore.get(state);
  stateStore.delete(state);
  return exp && exp > Date.now();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of stateStore) if (v < now) stateStore.delete(k);
}, 5 * 60 * 1000);

export function signSession(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}
export function verifySession(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// 랜덤 라이선스 키: NAVONE-XXXXXXXX-XXXXXXXX
export function genLicenseKey() {
  const seg = () => Math.random().toString(36).slice(2, 10).toUpperCase();
  return `NAVONE-${seg()}-${seg()}`;
}
