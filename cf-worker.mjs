/**
 * Minimal Hono app for Cloudflare Workers only.
 * The main API (index.js + Puppeteer, Firebase, etc.) cannot run on Workers —
 * deploy that with Docker / Fly.io / Railway / Render. This worker is a healthy
 * edge stub or place to add Worker-only routes later.
 */
import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) =>
	c.json({
		ok: true,
		service: "ihatereading-api",
		runtime: "cloudflare-workers",
		note: "Full Node API is not deployed here. Run the Docker/Fly image for index.js.",
	}),
);

app.get("/health", (c) => c.text("ok"));

export default app;
