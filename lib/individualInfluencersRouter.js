/**
 * Individual influencers — CLI / POST only (no auto on npm run dev).
 *
 * GET  /individual-influencers
 * POST /individual-influencers/run
 * GET  /individual-influencers/list
 * GET  /individual-influencers/queries
 */

import { Hono } from "hono";
import {
	ALL_QUERIES,
	INFLUENCER_AGENT,
	INFLUENCER_NICHES,
} from "./individualInfluencers/configs.js";
import {
	countInfluencers,
	listInfluencers,
	runIndividualInfluencersAgent,
} from "./individualInfluencers/orchestrator.js";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import { hasOpenRouterKey, wantUseAiFromRequest } from "./useAi.js";

export const individualInfluencersRouter = new Hono();

individualInfluencersRouter.get("/individual-influencers", async (c) => {
	let count = 0;
	try {
		count = await countInfluencers(INFLUENCER_AGENT.collection);
	} catch {
		/* ignore */
	}
	return c.json({
		success: true,
		agent: {
			id: INFLUENCER_AGENT.id,
			name: INFLUENCER_AGENT.name,
			collection: INFLUENCER_AGENT.collection,
			targetCount: INFLUENCER_AGENT.targetCount,
			currentCount: count,
			minFollowers: INFLUENCER_AGENT.minFollowers,
			niches: INFLUENCER_NICHES,
			platforms: ["x", "instagram", "youtube"],
			cli: "npm run top:influencers",
			run: "POST /individual-influencers/run",
			list: "GET /individual-influencers/list",
			scrapers: [
				"POST /scrape-instagram",
				"POST /scrape-x",
				"POST /scrape-youtube-channel",
			],
		},
		note: "Google discover → dedicated IG/X/YouTube scrapers (no RapidAPI, no login modal) → LLM keeps individual people + niche tags. Does not auto-run on npm run dev.",
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
	const niche = body.niche || c.req.query("niche") || undefined;
	const queriesPerRun = body.queriesPerRun
		? Number(body.queriesPerRun)
		: c.req.query("queriesPerRun")
			? Number(c.req.query("queriesPerRun"))
			: undefined;

	try {
		const summary = await runIndividualInfluencersAgent({
			baseUrl: resolveResearchBaseUrl(c),
			platform,
			niche,
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
		console.error("[individual-influencers] run failed:", err);
		return c.json(
			{
				success: false,
				error: { code: "RUN_FAILED", message: err?.message || String(err) },
			},
			500,
		);
	}
}

individualInfluencersRouter.post("/individual-influencers/run", handleRun);
individualInfluencersRouter.get("/individual-influencers/run", handleRun);

individualInfluencersRouter.get("/individual-influencers/list", async (c) => {
	const min = Number(c.req.query("minScore") || 0);
	const limit = Math.min(500, Number(c.req.query("limit") || 100));
	const platform = c.req.query("platform") || undefined;
	const tag = c.req.query("tag") || c.req.query("niche") || undefined;

	try {
		const people = await listInfluencers(INFLUENCER_AGENT.collection, {
			minScore: min,
			platform,
			tag,
			limit,
		});
		const total = await countInfluencers(INFLUENCER_AGENT.collection);
		return c.json({
			success: true,
			collection: INFLUENCER_AGENT.collection,
			total,
			count: people.length,
			tag: tag || null,
			platform: platform || null,
			people,
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

individualInfluencersRouter.get("/individual-influencers/queries", (c) => {
	const platform = c.req.query("platform");
	const niche = c.req.query("niche");
	let queries = ALL_QUERIES;
	if (platform) {
		const p = String(platform).toLowerCase();
		queries = queries.filter((q) => q.platform === p);
	}
	if (niche) {
		const n = String(niche).toLowerCase();
		queries = queries.filter((q) =>
			String(q.niche || "").toLowerCase().includes(n),
		);
	}
	return c.json({
		success: true,
		niches: INFLUENCER_NICHES,
		count: queries.length,
		queries,
	});
});
