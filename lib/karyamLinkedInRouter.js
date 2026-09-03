/**
 * Karyam LinkedIn leads — one API surface.
 * GET  /karyam-linkedin?info=1
 * GET  /karyam-linkedin?geo=in
 * POST /karyam-linkedin  { geo, city, queriesPerRun }
 */

import { Hono } from "hono";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import { hasOpenRouterKey, wantUseAiFromRequest } from "./useAi.js";
import {
	AGENT,
	CITIES,
	GEOS,
	buildQueries,
	listLeads,
	resolveCity,
	resolveGeo,
	runKaryamLinkedInAgent,
} from "./karyamLinkedIn/agent.js";

export const karyamLinkedInRouter = new Hono();

karyamLinkedInRouter.get("/karyam-linkedin", async (c) => {
	if (c.req.query("info") === "1") {
		return c.json({
			success: true,
			agent: AGENT,
			defaultGeo: "in",
			geos: GEOS,
			cities: CITIES,
			queryCountIndia: buildQueries({ geo: "in" }).length,
			cli: "npm run karyam:linkedin -- --geo world",
			pipeline: [
				"google → linkedin profiles (retry simpler query if empty)",
				"google enrich contacts",
				"llm score (+ rescrape if missing)",
			],
		});
	}
	try {
		const minScore = Number(c.req.query("minScore") || 0);
		const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
		const geo = c.req.query("geo") || undefined;
		const city = c.req.query("city") || undefined;
		const leads = await listLeads({ minScore, limit, geo, city });
		return c.json({
			success: true,
			count: leads.length,
			minScore,
			geo: geo || null,
			city: city || null,
			leads,
		});
	} catch (err) {
		return c.json({ success: false, error: err?.message || String(err) }, 500);
	}
});

karyamLinkedInRouter.post("/karyam-linkedin", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const useAI = wantUseAiFromRequest(body, {
		useAI: c.req.query("useAI") || c.req.query("useAi") || c.req.query("llm"),
	});
	if (useAI && !hasOpenRouterKey()) {
		return c.json(
			{ success: false, error: "OPENROUTER_API_KEY required when useAI is true" },
			503,
		);
	}
	const geo = body.geo || c.req.query("geo") || "in";
	const city = body.city || c.req.query("city") || undefined;

	if (geo && !resolveGeo(geo)) {
		return c.json(
			{
				success: false,
				error: `Unknown geo "${geo}"`,
				geos: GEOS.map((g) => g.id),
			},
			400,
		);
	}
	if (city && !resolveCity(city)) {
		return c.json(
			{
				success: false,
				error: `Unknown city "${city}"`,
				cities: CITIES.map((x) => x.id),
			},
			400,
		);
	}

	try {
		const summary = await runKaryamLinkedInAgent({
			baseUrl: resolveResearchBaseUrl(c),
			geo,
			city,
			queriesPerRun: body.queriesPerRun
				? Number(body.queriesPerRun)
				: undefined,
			useAI,
		});
		return c.json({
			success: true,
			...summary,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		console.error("[karyam-linkedin]", err);
		return c.json({ success: false, error: err?.message || String(err) }, 500);
	}
});
