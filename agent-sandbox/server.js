import { serve } from "@hono/node-server";
import { handle as vercelHandle } from "@hono/node-server/vercel";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { timingSafeEqual } from "node:crypto";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentLoop } from "./lib/agent.js";
import { ensureSession, newSessionId, normalizeSessionId } from "./lib/jail.js";
import { bundleReact, readPreviewHtml, runTool, toolList } from "./lib/tools.js";
import { uiHtml } from "./lib/ui.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(HERE, "../.env") });

const app = new Hono();
const PORT = Number(process.env.SANDBOX_PORT || process.env.PORT || 8787);

app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: ["content-type", "authorization", "x-sandbox-session", "x-sandbox-token"],
	}),
);

function readToken(c) {
	const header =
		c.req.header("x-sandbox-token") ||
		(c.req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
	return header || c.req.query("token") || "";
}

function tokenOk(c) {
	const expected = process.env.SANDBOX_TOKEN?.trim();
	if (!expected) return true;
	const supplied = readToken(c);
	if (!supplied) return false;
	const a = Buffer.from(supplied);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

app.use("*", async (c, next) => {
	if (c.req.path === "/health" || c.req.path === "/") return next();
	if (!tokenOk(c)) return c.json({ error: "unauthorized" }, 401);
	return next();
});

function sessionFrom(c) {
	return normalizeSessionId(
		c.req.header("x-sandbox-session") || c.req.query("session") || "default",
	);
}

app.get("/health", (c) =>
	c.json({
		ok: true,
		service: "agent-sandbox",
		host: process.env.VERCEL ? "vercel" : "node",
		ts: Date.now(),
	}),
);

app.get("/", (c) => c.html(uiHtml()));

app.get("/v1/tools", (c) =>
	c.json({
		sessionHeader: "x-sandbox-session",
		exec: { method: "POST", path: "/v1/exec", body: { tool: "fs_list", input: {} } },
		chat: { method: "POST", path: "/v1/chat", body: { message: "..." } },
		preview: "/preview?session=",
		tools: toolList().map((t) => t.function.name),
		schemas: toolList(),
	}),
);

app.post("/v1/session", async (c) => {
	const id = newSessionId();
	await ensureSession(id);
	await bundleReact(id);
	return c.json({ session: id });
});

app.post("/v1/exec", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const tool = String(body.tool || body.name || "").trim();
	if (!tool) return c.json({ error: "tool is required" }, 400);
	const session = sessionFrom(c);
	try {
		const result = await runTool(session, tool, body.input || body.args || {});
		return c.json({ ok: true, session, tool, result });
	} catch (err) {
		return c.json({ ok: false, error: err.message }, 400);
	}
});

app.post("/v1/chat", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const message = String(body.message || "").trim();
	if (!message) return c.json({ error: "message is required" }, 400);
	const session = sessionFrom(c);
	await ensureSession(session);

	c.header("Content-Type", "text/event-stream");
	c.header("Cache-Control", "no-cache");
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (event) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			};
			try {
				await runAgentLoop({
					messages: [{ role: "user", content: message }],
					tools: toolList(),
					execute: (name, args) => runTool(session, name, args),
					onEvent: send,
				});
			} catch (err) {
				send({ type: "error", error: err.message });
				send({ type: "done" });
			}
			controller.close();
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
});

app.get("/preview", async (c) => {
	const session = sessionFrom(c);
	try {
		const html = await readPreviewHtml(session);
		return c.html(html);
	} catch (err) {
		return c.html(`<pre>${err.message}</pre>`, 500);
	}
});

export default process.env.VERCEL ? vercelHandle(app) : app;
export const config = { maxDuration: 60 };
export { app };

if (!process.env.VERCEL) {
	serve({ fetch: app.fetch, port: PORT }, (info) => {
		console.log(`agent-sandbox http://localhost:${info.port}`);
	});
}
