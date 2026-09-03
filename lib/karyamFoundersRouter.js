/**
 * Karyam B2B founder leads — CLI / POST only (no auto on npm run dev).
 *
 * GET  /karyam-founders
 * POST /karyam-founders/run
 * GET  /karyam-founders/list
 * GET  /karyam-founders/queries
 * POST /karyam-founders/send
 * GET  /karyam-founders/autosend
 */

import { Hono } from "hono";
import {
	ALL_QUERIES,
	INTENTS,
	KARYAM_AGENT,
	KARYAM_OFFERINGS,
	queriesForIntent,
} from "./karyamFounders/configs.js";
import { getLead, listLeads } from "./karyamFounders/core.js";
import {
	runKaryamFoundersAgent,
	sendLeadEmail,
	sendLeadsByIds,
} from "./karyamFounders/orchestrator.js";
import { autosendConfig } from "./karyamFounders/autosend.js";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import { hasOpenRouterKey, wantUseAiFromRequest } from "./useAi.js";

export const karyamFoundersRouter = new Hono();

karyamFoundersRouter.get("/karyam-founders", (c) => {
	return c.json({
		success: true,
		agent: {
			id: KARYAM_AGENT.id,
			name: KARYAM_AGENT.name,
			agency: KARYAM_AGENT.agency,
			collection: KARYAM_AGENT.collection,
			queryCount: ALL_QUERIES.length,
			intents: INTENTS,
			offerings: KARYAM_OFFERINGS,
			pipeline: [
				"google search (rotating query hash)",
				"nested scrape (contact / about / team + listicle outbound)",
				"optional OpenRouter drafts",
				"optional AutoSend from dashboard / POST /send",
			],
			cli: "npm run karyam:founders",
			run: "POST /karyam-founders/run",
			list: "GET /karyam-founders/list",
			send: "POST /karyam-founders/send",
		},
		note: "Scrape-only by default. Pass useAI:true to draft emails. Pass send:true to actually send via AutoSend. Does not auto-run on npm run dev.",
	});
});

karyamFoundersRouter.get("/karyam-founders/autosend", (c) => {
	const cfg = autosendConfig();
	return c.json({
		success: true,
		configured: cfg.configured,
		fromEmail: cfg.fromEmail,
		fromName: cfg.fromName,
		hasProjectId: Boolean(cfg.projectId),
	});
});

async function handleRun(c) {
	let body = {};
	try {
		body = await c.req.json().catch(() => ({}));
	} catch {
		body = {};
	}

	const useAI = wantUseAiFromRequest(body, {
		useAI: c.req.query("useAI") || c.req.query("useAi") || c.req.query("llm"),
	});
	if (useAI && !hasOpenRouterKey()) {
		return c.json(
			{
				success: false,
				error: {
					code: "MISSING_OPENROUTER_KEY",
					message: "OPENROUTER_API_KEY required when useAI is true",
				},
			},
			503,
		);
	}

	const send =
		body.send === true ||
		c.req.query("send") === "1" ||
		c.req.query("send") === "true";
	if (send && !autosendConfig().configured) {
		return c.json(
			{
				success: false,
				error: {
					code: "MISSING_AUTOSEND_KEY",
					message: "AUTOSEND_API_KEY required when send is true",
				},
			},
			503,
		);
	}

	const intent = body.intent || c.req.query("intent") || undefined;
	const queryId = body.queryId || c.req.query("queryId") || undefined;
	const queriesPerRun = body.queriesPerRun
		? Number(body.queriesPerRun)
		: c.req.query("queriesPerRun")
			? Number(c.req.query("queriesPerRun"))
			: undefined;

	try {
		const summary = await runKaryamFoundersAgent({
			baseUrl: resolveResearchBaseUrl(c),
			intent,
			queryId,
			queriesPerRun,
			enrich: body.enrich !== false,
			useAI,
			send,
			sendMinScore: body.sendMinScore ? Number(body.sendMinScore) : undefined,
		});
		return c.json({
			success: true,
			...summary,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		console.error("[karyam-founders] run failed:", err);
		return c.json(
			{
				success: false,
				error: {
					code: "RUN_FAILED",
					message: err?.message || String(err),
				},
			},
			500,
		);
	}
}

karyamFoundersRouter.post("/karyam-founders/run", handleRun);
karyamFoundersRouter.get("/karyam-founders/run", handleRun);

karyamFoundersRouter.get("/karyam-founders/list", async (c) => {
	const min = Number(c.req.query("minScore") || 0);
	const limit = Math.min(200, Number(c.req.query("limit") || 100));
	const intent = c.req.query("intent") || undefined;
	const outreachStatus = c.req.query("outreachStatus") || undefined;
	const hasEmail =
		c.req.query("hasEmail") === "1" || c.req.query("hasEmail") === "true";

	try {
		const leads = await listLeads(KARYAM_AGENT.collection, {
			minScore: min,
			intent,
			hasEmail: hasEmail || undefined,
			outreachStatus,
			limit,
		});
		return c.json({
			success: true,
			agentId: KARYAM_AGENT.id,
			collection: KARYAM_AGENT.collection,
			count: leads.length,
			minScore: min,
			intent: intent || null,
			leads,
		});
	} catch (err) {
		return c.json(
			{
				success: false,
				error: { code: "LIST_FAILED", message: err?.message || String(err) },
			},
			500,
		);
	}
});

karyamFoundersRouter.get("/karyam-founders/queries", (c) => {
	const intent = c.req.query("intent");
	const queries = intent ? queriesForIntent(intent) : ALL_QUERIES;
	return c.json({
		success: true,
		count: queries.length,
		intents: INTENTS,
		queries,
	});
});

karyamFoundersRouter.post("/karyam-founders/send", async (c) => {
	if (!autosendConfig().configured) {
		return c.json(
			{
				success: false,
				error: {
					code: "MISSING_AUTOSEND_KEY",
					message: "AUTOSEND_API_KEY is not set",
				},
			},
			503,
		);
	}

	let body = {};
	try {
		body = await c.req.json().catch(() => ({}));
	} catch {
		body = {};
	}

	const ids = Array.isArray(body.ids)
		? body.ids.map(String)
		: body.id
			? [String(body.id)]
			: [];

	try {
		if (ids.length) {
			const results = await sendLeadsByIds(ids, {
				subject: body.subject,
				text: body.text,
				html: body.html,
			});
			return c.json({
				success: true,
				sent: results.filter((r) => r.success).length,
				failed: results.filter((r) => !r.success).length,
				results,
			});
		}

		const minScore = Number(body.minScore ?? 0);
		const limit = Math.min(25, Number(body.limit) || 10);
		const leads = await listLeads(KARYAM_AGENT.collection, {
			minScore,
			hasEmail: true,
			limit: limit * 2,
		});
		const unsent = leads
			.filter((l) => body.includeSent || l.outreachStatus !== "sent")
			.slice(0, limit);
		const results = await sendLeadsByIds(
			unsent.map((l) => l.id),
			{
				subject: body.subject,
				text: body.text,
				html: body.html,
			},
		);
		return c.json({
			success: true,
			sent: results.filter((r) => r.success).length,
			failed: results.filter((r) => !r.success).length,
			results,
		});
	} catch (err) {
		console.error("[karyam-founders] send failed:", err);
		return c.json(
			{
				success: false,
				error: { code: "SEND_FAILED", message: err?.message || String(err) },
			},
			500,
		);
	}
});

karyamFoundersRouter.post("/karyam-founders/send/:id", async (c) => {
	if (!autosendConfig().configured) {
		return c.json(
			{
				success: false,
				error: {
					code: "MISSING_AUTOSEND_KEY",
					message: "AUTOSEND_API_KEY is not set",
				},
			},
			503,
		);
	}
	const id = c.req.param("id");
	const lead = await getLead(KARYAM_AGENT.collection, id);
	if (!lead) {
		return c.json(
			{ success: false, error: { code: "NOT_FOUND", message: id } },
			404,
		);
	}
	let body = {};
	try {
		body = await c.req.json().catch(() => ({}));
	} catch {
		body = {};
	}
	try {
		const result = await sendLeadEmail(lead, { ...body, force: body.force === true });
		return c.json({
			success: true,
			id,
			to: body.to || lead.founderEmail || lead.email,
			emailId: result.emailId,
		});
	} catch (err) {
		return c.json(
			{
				success: false,
				error: { code: "SEND_FAILED", message: err?.message || String(err) },
			},
			500,
		);
	}
});
