/**
 * Claude toprated agent API — SSE chat + table inspect.
 *
 * GET  /claude-toprated
 * POST /claude-toprated/chat          SSE (default) or JSON if stream:false
 * GET  /claude-toprated/tables
 * GET  /claude-toprated/tables/:name
 */

import { Hono } from "hono";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import { CLAUDE_TOPRATED, runClaudeToprated } from "./claudeToprated/agent.js";
import { CLAUDE_TOPRATED_TOOLS } from "./claudeToprated/tools.js";
import {
	listTables,
	tableGetRow,
	tableListRows,
} from "./claudeToprated/table.js";

export const claudeTopratedRouter = new Hono();

claudeTopratedRouter.get("/claude-toprated", (c) => {
	return c.json({
		success: true,
		agent: {
			id: CLAUDE_TOPRATED.id,
			name: CLAUDE_TOPRATED.name,
			model: CLAUDE_TOPRATED.model,
			chat: "POST /claude-toprated/chat",
			tables: "GET /claude-toprated/tables",
			realtime: "SSE (text/event-stream)",
		},
		tools: CLAUDE_TOPRATED_TOOLS.map((t) => t.function.name),
		note: "Claude with scrape + Firestore table tools. POST a message; stream tool calls and the final answer.",
	});
});

function sseEncode(event) {
	return `data: ${JSON.stringify(event)}\n\n`;
}

claudeTopratedRouter.post("/claude-toprated/chat", async (c) => {
	if (!process.env.OPENROUTER_API_KEY?.trim()) {
		return c.json({ success: false, error: "OPENROUTER_API_KEY required" }, 503);
	}

	const body = await c.req.json().catch(() => ({}));
	const message = body.message || body.prompt || body.query || "";
	const messages = body.messages;
	const stream = body.stream !== false;
	const baseUrl = resolveResearchBaseUrl(c);

	if (!String(message || "").trim() && !Array.isArray(messages)) {
		return c.json({ success: false, error: "message is required" }, 400);
	}

	if (!stream) {
		try {
			const result = await runClaudeToprated({ message, messages, baseUrl });
			return c.json({ success: true, ...result });
		} catch (err) {
			console.error("[claude-toprated]", err);
			return c.json(
				{ success: false, error: err?.message || String(err) },
				500,
			);
		}
	}

	const encoder = new TextEncoder();
	const output = new ReadableStream({
		async start(controller) {
			const send = (event) => {
				controller.enqueue(encoder.encode(sseEncode(event)));
			};
			try {
				await runClaudeToprated({
					message,
					messages,
					baseUrl,
					onEvent: async (event) => send(event),
				});
			} catch (err) {
				send({ type: "error", error: err?.message || String(err) });
			} finally {
				controller.close();
			}
		},
	});

	return new Response(output, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
});

claudeTopratedRouter.get("/claude-toprated/tables", async (c) => {
	try {
		const tables = await listTables(Number(c.req.query("limit") || 50));
		return c.json({ success: true, count: tables.length, tables });
	} catch (err) {
		return c.json({ success: false, error: err?.message || String(err) }, 500);
	}
});

claudeTopratedRouter.get("/claude-toprated/tables/:name", async (c) => {
	const name = c.req.param("name");
	const docId = c.req.query("docId");
	try {
		if (docId) {
			const row = await tableGetRow(name, docId);
			return c.json({ success: true, ...row });
		}
		const listed = await tableListRows(name, Number(c.req.query("limit") || 40));
		return c.json({ success: true, ...listed });
	} catch (err) {
		return c.json({ success: false, error: err?.message || String(err) }, 500);
	}
});
