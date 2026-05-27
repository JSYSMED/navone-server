import express from "express";
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// Auto-load all api/**/*.js files (skip _prefixed)
async function loadRoutes(dir, base = "/api") {
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) {
      await loadRoutes(full, base + "/" + f);
    } else if (f.endsWith(".js") && !f.startsWith("_") && !f.startsWith("[")) {
      const route = base + "/" + f.replace(".js", "");
      const mod = await import("./" + relative(".", full));
      const handler = mod.default;
      app.all(route, async (req, res) => {
        try { await handler(req, res); } catch (e) {
          console.error(route, e);
          res.status(500).json({ error: e.message });
        }
      });
      console.log("  " + route);
    }
  }
}

// Load [action].js routers
async function loadActionRoutes(dir, base) {
  const actionFile = join(dir, "[action].js");
  try {
    statSync(actionFile);
    const mod = await import("./" + relative(".", actionFile));
    const handler = mod.default;
    app.all(base + "/:action", async (req, res) => {
      req.query.action = req.params.action;
      try { await handler(req, res); } catch (e) {
        console.error(base + "/:action", e);
        res.status(500).json({ error: e.message });
      }
    });
    console.log("  " + base + "/:action");
  } catch {}
}

console.log("Loading routes:");
await loadRoutes("api");
for (const sub of ["claim", "inquiry", "order", "penalty", "settlement"]) {
  await loadActionRoutes(join("api", sub), "/api/" + sub);
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`NavOne server running on port ${port}`));
