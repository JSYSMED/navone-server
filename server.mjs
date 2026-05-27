import express from "express";
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// Direct route loading for _prefixed files
async function loadPrefixedRoutes(dir, base) {
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("_") || !f.endsWith(".js")) continue;
    const routeName = f.replace(/^_/, "").replace(".js", "");
    const route = base + "/" + routeName;
    const mod = await import("./" + relative(".", join(dir, f)));
    app.all(route, async (req, res) => {
      try { await mod.default(req, res); } catch (e) {
        console.error(route, e);
        res.status(500).json({ error: e.message });
      }
    });
    console.log("  " + route);
  }
}

// Top-level route loading
async function loadTopRoutes(dir, base = "/api") {
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) continue;
    if (!f.endsWith(".js") || f.startsWith("_") || f.startsWith("[")) continue;
    const route = base + "/" + f.replace(".js", "");
    const mod = await import("./" + relative(".", full));
    app.all(route, async (req, res) => {
      try { await mod.default(req, res); } catch (e) {
        console.error(route, e);
        res.status(500).json({ error: e.message });
      }
    });
    console.log("  " + route);
  }
}

console.log("Loading routes:");
await loadTopRoutes("api");
for (const sub of ["claim", "inquiry", "order", "penalty", "settlement"]) {
  const dir = join("api", sub);
  try { statSync(dir); await loadPrefixedRoutes(dir, "/api/" + sub); } catch {}
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("NavOne server on port " + port));
