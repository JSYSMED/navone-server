import { readFileSync } from "fs";
import { createServer } from "http";

// .env.local 로드
try {
  const env = readFileSync(".env.local", "utf8");
  env.split("\n").forEach(line => {
    const [k, ...v] = line.split("=");
    if (k && !k.startsWith("#")) process.env[k.trim()] = v.join("=").trim();
  });
} catch {}

const routes = {};
async function load(path, mod) { routes[path] = (await import(mod)).default; }

await load("/api/review-reply", "./api/review-reply.js");
await load("/api/store-register", "./api/store-register.js");
await load("/api/cs-reply", "./api/cs-reply.js");
await load("/api/settlement/daily", "./api/settlement/_daily.js");
await load("/api/settlement/sync", "./api/settlement/_sync.js");
await load("/api/settlement/margin-rank", "./api/settlement/_margin-rank.js");
await load("/api/claim/pending", "./api/claim/_pending.js");
await load("/api/claim/auto-process", "./api/claim/_auto-process.js");
await load("/api/order/pending", "./api/order/_pending.js");
await load("/api/order/auto-confirm", "./api/order/_auto-confirm.js");
await load("/api/order/dispatch", "./api/order/_dispatch.js");
await load("/api/penalty/risk-scan", "./api/penalty/_risk-scan.js");

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const handler = routes[url.pathname];
  if (!handler) { res.writeHead(404); res.end("Not found: " + url.pathname); return; }
  const query = Object.fromEntries(url.searchParams);
  let body = {};
  if (req.method === "POST") {
    const chunks = []; for await (const c of req) chunks.push(c);
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
  }
  const fakeReq = { method: req.method, headers: req.headers, query, body };
  const fakeRes = {
    statusCode: 200, _headers: {}, _body: "",
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(data) { res.writeHead(this.statusCode, { ...this._headers, "Content-Type": "application/json" }); res.end(JSON.stringify(data)); },
    end(d) { res.writeHead(this.statusCode, this._headers); res.end(d); },
  };
  try { await handler(fakeReq, fakeRes); } catch (e) {
    console.error(e);
    res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
  }
}).listen(3000, () => console.log("Dev server: http://localhost:3000"));
