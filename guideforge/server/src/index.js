import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { ensureDataDirs } from "./storage/filesystem.js";
import { getEnv } from "./config/env.js";
import research from "./routes/research.js";
import guides from "./routes/guides.js";
import jobs from "./routes/jobs.js";
import settings from "./routes/settings.js";

const app = new Hono();

app.use(
  "/api/*",
  cors({
    origin: ["http://localhost:5174", "http://127.0.0.1:5174"],
    credentials: true,
  }),
);

app.get("/api/health", async (c) => {
  const env = getEnv();
  let openRouter = {
    configured: Boolean(env.openRouterKey),
    model: env.openRouterModel,
    envFile: env.openRouterEnvFile,
    chatOk: false,
    error: null,
  };
  if (env.openRouterKey) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.openRouterKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://ihatereading.in",
          "X-Title": "GuideForge",
        },
        body: JSON.stringify({
          model: env.openRouterModel,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(12_000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && !data.error) {
        openRouter.chatOk = true;
      } else {
        openRouter.error = data.error?.message || data.error || `HTTP ${res.status}`;
      }
    } catch (err) {
      openRouter.error = err.message;
    }
  } else {
    openRouter.error = "OPENROUTER_API_KEY missing";
  }
  return c.json({
    ok: true,
    service: "guideforge",
    scraperBase: env.scraperBase,
    hasOpenRouter: openRouter.configured,
    openRouter,
  });
});

app.route("/api/research", research);
app.route("/api/guides", guides);
app.route("/api/jobs", jobs);
app.route("/api/settings", settings);

app.onError((err, c) => {
  console.error("[guideforge]", err);
  return c.json({ error: err.message || "Request failed" }, 500);
});

await ensureDataDirs();

const port = getEnv().port;
const hostname = process.env.GUIDEFORGE_HOST || "0.0.0.0";
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[guideforge] API listening on http://${hostname}:${info.port}`);
  console.log(`[guideforge] Health: http://127.0.0.1:${info.port}/api/health`);
});
