/**
 * Angel / seed investor agents — CLI / POST only (no auto on npm run dev).
 *
 * GET  /angel-investors
 * POST /angel-investors/run
 * GET  /angel-investors/list
 * GET  /angel-investors/queries
 */

import { Hono } from "hono";
import { ANGEL_AGENT, ALL_QUERIES } from "./angelInvestors/configs.js";
import {
	listInvestors,
	runAngelInvestorsAgent,
} from "./angelInvestors/orchestrator.js";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import { hasOpenRouterKey, wantUseAiFromRequest } from "./useAi.js";

export const angelInvestorsRouter = new Hono();

angelInvestorsRouter.get("/angel-investors", (c) => {
	return c.json({
		success: true,
		agent: {
			id: ANGEL_AGENT.id,
			name: ANGEL_AGENT.name,
			collection: ANGEL_AGENT.collection,
			queryCount: ALL_QUERIES.length,
			platforms: ["x", "linkedin", "google"],
			cli: "npm run angel:investors",
			run: "POST /angel-investors/run",
			list: "GET /angel-investors/list",
		},
		note: "Scrape-only by default. Pass useAI:true to score with OpenRouter. Does not auto-run on npm run dev.",
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

	const platform = body.platform || c.req.query("platform") || undefined;
	const queriesPerRun = body.queriesPerRun
		? Number(body.queriesPerRun)
		: c.req.query("queriesPerRun")
			? Number(c.req.query("queriesPerRun"))
			: undefined;

	try {
		const summary = await runAngelInvestorsAgent({
			baseUrl: resolveResearchBaseUrl(c),
			platform,
			queriesPerRun,
			enrich: body.enrich !== false,
			useAI,
		});
		return c.json({
			success: true,
			...summary,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		console.error("[angel-investors] run failed:", err);
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

angelInvestorsRouter.post("/angel-investors/run", handleRun);
angelInvestorsRouter.get("/angel-investors/run", handleRun);

angelInvestorsRouter.get("/angel-investors/list", async (c) => {
	const min = Number(c.req.query("minScore") || 0);
	const limit = Math.min(200, Number(c.req.query("limit") || 100));
	const platform = c.req.query("platform") || undefined;

	try {
		const investors = await listInvestors(ANGEL_AGENT.collection, {
			minScore: min,
			platform,
			limit,
		});
		return c.json({
			success: true,
			agentId: ANGEL_AGENT.id,
			collection: ANGEL_AGENT.collection,
			count: investors.length,
			minScore: min,
			platform: platform || null,
			investors,
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

angelInvestorsRouter.get("/angel-investors/queries", (c) => {
	const platform = c.req.query("platform");
	let queries = ALL_QUERIES;
	if (platform) {
		const p = String(platform).toLowerCase();
		queries = queries.filter((q) => q.platform === p);
	}
	return c.json({
		success: true,
		count: queries.length,
		queries,
	});
});
