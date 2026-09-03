/**
 * AI DESIGN.md style prompts — Refero catalog + Firestore enrich.
 *
 * GET  /ai-styles-prompts
 * POST /ai-styles-prompts/run
 * POST /ai-styles-prompts/enrich
 * GET  /ai-styles-prompts/list
 */

import { Hono } from "hono";
import {
	AI_STYLES_AGENT,
	AI_STYLES_ENRICH,
	REFERO_LIST_URL,
} from "./aiStylesPrompts/configs.js";
import {
	countPrompts,
	listPrompts,
	runAiStylesPromptsAgent,
} from "./aiStylesPrompts/orchestrator.js";
import {
	loadEnrichState,
	runAiStylesEnrichAgent,
} from "./aiStylesPrompts/enrich.js";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import { hasOpenRouterKey, wantUseAiFromRequest } from "./useAi.js";

export const aiStylesPromptsRouter = new Hono();

aiStylesPromptsRouter.get("/ai-styles-prompts", async (c) => {
	let count = 0;
	let enrich = null;
	try {
		count = await countPrompts(AI_STYLES_AGENT.collection);
	} catch {
		/* ignore */
	}
	try {
		enrich = await loadEnrichState();
	} catch {
		/* ignore */
	}
	return c.json({
		success: true,
		agent: {
			id: AI_STYLES_AGENT.id,
			name: AI_STYLES_AGENT.name,
			collection: AI_STYLES_AGENT.collection,
			targetCount: AI_STYLES_AGENT.targetCount,
			currentCount: count,
			listUrl: REFERO_LIST_URL,
			cli: "npm run ai:styles",
			run: "POST /ai-styles-prompts/run",
			enrich: "POST /ai-styles-prompts/enrich",
			enrichCli: "npm run ai:styles:enrich",
			list: "GET /ai-styles-prompts/list",
		},
		enrichAgent: {
			id: AI_STYLES_ENRICH.id,
			batchSize: AI_STYLES_ENRICH.batchSize,
			intervalMs: AI_STYLES_ENRICH.intervalMs,
			state: enrich,
		},
		note: "Discover: Refero catalog → Firestore. Enrich: 4 docs/tick, Google + scrape, update/delete/add until last doc. CLI every 10s.",
	});
});

async function handleRun(c) {
	let body = {};
	try {
		body = await c.req.json().catch(() => ({}));
	} catch {
		body = {};
	}

	const stylesPerRun = body.stylesPerRun
		? Number(body.stylesPerRun)
		: c.req.query("stylesPerRun")
			? Number(c.req.query("stylesPerRun"))
			: undefined;

	try {
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
		const summary = await runAiStylesPromptsAgent({
			baseUrl: resolveResearchBaseUrl(c),
			stylesPerRun,
			scrape: body.scrape !== false,
			useAI,
		});
		return c.json({
			success: true,
			...summary,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		console.error("[ai-styles] run failed:", err);
		return c.json(
			{
				success: false,
				error: { code: "RUN_FAILED", message: err?.message || String(err) },
			},
			500,
		);
	}
}

aiStylesPromptsRouter.post("/ai-styles-prompts/run", handleRun);
aiStylesPromptsRouter.get("/ai-styles-prompts/run", handleRun);

async function handleEnrich(c) {
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

	const batch = body.batch
		? Number(body.batch)
		: c.req.query("batch")
			? Number(c.req.query("batch"))
			: undefined;
	const reset =
		body.reset === true ||
		c.req.query("reset") === "1" ||
		c.req.query("reset") === "true";

	try {
		const summary = await runAiStylesEnrichAgent({
			baseUrl: resolveResearchBaseUrl(c),
			batch,
			reset,
			useAI,
		});
		return c.json({
			success: true,
			...summary,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		console.error("[ai-styles:enrich] run failed:", err);
		return c.json(
			{
				success: false,
				error: { code: "ENRICH_FAILED", message: err?.message || String(err) },
			},
			500,
		);
	}
}

aiStylesPromptsRouter.post("/ai-styles-prompts/enrich", handleEnrich);
aiStylesPromptsRouter.get("/ai-styles-prompts/enrich", handleEnrich);

aiStylesPromptsRouter.get("/ai-styles-prompts/list", async (c) => {
	const limit = Math.min(200, Number(c.req.query("limit") || 50));
	const tag = c.req.query("tag") || undefined;
	const category = c.req.query("category") || undefined;
	try {
		const prompts = await listPrompts(AI_STYLES_AGENT.collection, {
			tag,
			category,
			limit,
		});
		const total = await countPrompts(AI_STYLES_AGENT.collection);
		return c.json({
			success: true,
			collection: AI_STYLES_AGENT.collection,
			total,
			count: prompts.length,
			prompts,
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
