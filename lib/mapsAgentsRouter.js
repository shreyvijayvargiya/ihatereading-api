/**
 * Google Maps lead agents — CLI / POST only (no auto scheduler on npm run dev).
 *
 * POST /maps-agents/karyam-local/run   body: { city: "bangalore" }
 * GET  /maps-agents/karyam-local/run?city=sf
 * GET  /maps-agents/karyam-local/leads?city=mumbai
 * GET  /maps-agents/karyam-local/cities
 * GET  /maps-agents
 */

import { Hono } from "hono";
import {
	MAPS_KARYAM_AGENT,
	filterQueriesByCity,
	listCityIds,
	resolveCity,
} from "./mapsAgents/configs.js";
import { listMapsLeads } from "./mapsAgents/core.js";
import {
	runKaryamMapsLeadsAgent,
	ALL_QUERIES,
	ALL_KEYWORD_QUERIES,
} from "./mapsAgents/karyamLocal.js";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import { hasOpenRouterKey, wantUseAiFromRequest } from "./useAi.js";

export const mapsAgentsRouter = new Hono();

mapsAgentsRouter.get("/maps-agents", (c) => {
	return c.json({
		success: true,
		agents: [
			{
				id: MAPS_KARYAM_AGENT.id,
				name: MAPS_KARYAM_AGENT.name,
				collection: MAPS_KARYAM_AGENT.collection,
				cities: MAPS_KARYAM_AGENT.cities,
				cityIds: listCityIds(),
				categoryCount: MAPS_KARYAM_AGENT.categories.length,
				defaultKeywords: MAPS_KARYAM_AGENT.categories,
				totalQueries: ALL_QUERIES.length,
				cli: "npm run maps:karyam -- --city bangalore",
				run: "POST /maps-agents/karyam-local/run",
				leads: "GET /maps-agents/karyam-local/leads?city=bangalore",
				citiesEndpoint: "GET /maps-agents/karyam-local/cities",
			},
		],
		note: "Scrape-only by default (5 Maps keywords). Pass useAI:true to score. Pass allKeywords:true for the full category list.",
	});
});

mapsAgentsRouter.get("/maps-agents/karyam-local/cities", (c) => {
	return c.json({
		success: true,
		count: MAPS_KARYAM_AGENT.cities.length,
		cities: MAPS_KARYAM_AGENT.cities,
		ids: listCityIds(),
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

	const city = body.city || c.req.query("city") || undefined;
	if (city && !resolveCity(city)) {
		return c.json(
			{
				success: false,
				error: {
					code: "UNKNOWN_CITY",
					message: `Unknown city "${city}"`,
					cities: MAPS_KARYAM_AGENT.cities,
					ids: listCityIds(),
				},
			},
			400,
		);
	}

	const queriesPerRun = body.queriesPerRun
		? Number(body.queriesPerRun)
		: c.req.query("queriesPerRun")
			? Number(c.req.query("queriesPerRun"))
			: undefined;

	try {
		const summary = await runKaryamMapsLeadsAgent({
			baseUrl: resolveResearchBaseUrl(c),
			city,
			queriesPerRun,
			enrichWebsites: body.enrichWebsites !== false,
			useAI,
			allKeywords:
				body.allKeywords === true ||
				c.req.query("allKeywords") === "1",
		});
		return c.json({
			success: true,
			...summary,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		console.error("[maps-agents] run failed:", err);
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

mapsAgentsRouter.post("/maps-agents/karyam-local/run", handleRun);
mapsAgentsRouter.get("/maps-agents/karyam-local/run", handleRun);

mapsAgentsRouter.get("/maps-agents/karyam-local/leads", async (c) => {
	const minRaw = c.req.query("minScore");
	const min = minRaw === undefined || minRaw === "" ? 0 : Number(minRaw);
	const limit = Math.min(200, Number(c.req.query("limit") || 100));
	const city = c.req.query("city") || undefined;
	const resolved = city ? resolveCity(city) : null;

	try {
		const leads = await listMapsLeads(MAPS_KARYAM_AGENT.collection, {
			minScore: min,
			city: resolved?.name || city,
			cityId: resolved?.id,
			limit,
		});
		return c.json({
			success: true,
			agentId: MAPS_KARYAM_AGENT.id,
			collection: MAPS_KARYAM_AGENT.collection,
			count: leads.length,
			minScore: min,
			city: resolved || city || null,
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

mapsAgentsRouter.get("/maps-agents/karyam-local/queries", (c) => {
	const city = c.req.query("city");
	const all = c.req.query("allKeywords") === "1";
	const pool = all ? ALL_KEYWORD_QUERIES : ALL_QUERIES;
	const queries = filterQueriesByCity(pool, city);
	return c.json({
		success: true,
		city: city ? resolveCity(city) : null,
		keywords: all
			? MAPS_KARYAM_AGENT.allCategories
			: MAPS_KARYAM_AGENT.categories,
		count: queries.length,
		queries,
	});
});
