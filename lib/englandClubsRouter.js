/**
 * England football clubs — Soccer Wiki ENG listing + Maps/site enrich.
 *
 * GET  /england-clubs
 * POST /england-clubs/run
 * POST /england-clubs/enrich
 * GET  /england-clubs/list
 */

import { Hono } from "hono";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import {
	ENGLAND_CLUBS_AGENT,
	ENRICH_BATCH_SIZE,
	LOCAL_API_BASE,
	TOTAL_CLUBS,
} from "./englandClubs/configs.js";
import {
	countClubs,
	countEnrichedClubs,
	listClubs,
} from "./englandClubs/core.js";
import { hasOpenRouterKey, requestAiOpts } from "./useAi.js";
import { runEnglandClubsEnrichAgent } from "./englandClubs/enrich.js";
import { runEnglandClubsAgent } from "./englandClubs/orchestrator.js";

export const englandClubsRouter = new Hono();

englandClubsRouter.get("/england-clubs", async (c) => {
	let count = 0;
	let enriched = 0;
	try {
		count = await countClubs();
		enriched = await countEnrichedClubs();
	} catch {
		/* ignore */
	}
	return c.json({
		success: true,
		agent: {
			id: ENGLAND_CLUBS_AGENT.id,
			name: ENGLAND_CLUBS_AGENT.name,
			collection: ENGLAND_CLUBS_AGENT.collection,
			country: ENGLAND_CLUBS_AGENT.country,
			total: TOTAL_CLUBS,
			enrichBatchSize: ENRICH_BATCH_SIZE,
			cli: "npm run england:clubs",
			enrichCli: "npm run england:clubs:enrich",
			run: "POST /england-clubs/run",
			enrich: "POST /england-clubs/enrich",
			list: "GET /england-clubs/list",
			pipeline: [
				"scrape Soccer Wiki England clubs listing",
				"store Firestore clubs (hash by clubid)",
				"enrich 4 at a time: Google + LinkedIn/X SERP for HT / CMO / marketing emails, then site + maps",
			],
		},
		count,
		enriched,
		note: "England only. Enrich searches Google/LinkedIn/X for Head of Ticketing, CMO, Marketing Head, and staff emails (no invented addresses). Pass useAI:true to extract from evidence with OpenRouter.",
	});
});

englandClubsRouter.post("/england-clubs/run", async (c) => {
	let body = {};
	try {
		body = await c.req.json().catch(() => ({}));
	} catch {
		body = {};
	}
	try {
		const summary = await runEnglandClubsAgent({
			baseUrl: resolveResearchBaseUrl(c) || LOCAL_API_BASE,
			reset: body.reset === true || c.req.query("reset") === "1",
			enrich: body.enrich === true || c.req.query("enrich") === "1",
			pagesPerRun: body.pagesPerRun ? Number(body.pagesPerRun) : undefined,
		});
		return c.json({ success: true, ...summary });
	} catch (err) {
		return c.json(
			{ success: false, error: { message: err?.message || String(err) } },
			500,
		);
	}
});

englandClubsRouter.post("/england-clubs/enrich", async (c) => {
	let body = {};
	try {
		body = await c.req.json().catch(() => ({}));
	} catch {
		body = {};
	}
	const ai = requestAiOpts(body, {
		useAI: c.req.query("useAI") || c.req.query("useAi") || c.req.query("llm"),
		model: c.req.query("model"),
	});
	if (ai.useAI && !hasOpenRouterKey()) {
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
	try {
		const summary = await runEnglandClubsEnrichAgent({
			baseUrl: resolveResearchBaseUrl(c) || LOCAL_API_BASE,
			reset: body.reset === true || c.req.query("reset") === "1",
			...ai,
		});
		return c.json({ success: true, ...summary });
	} catch (err) {
		return c.json(
			{ success: false, error: { message: err?.message || String(err) } },
			500,
		);
	}
});

englandClubsRouter.get("/england-clubs/list", async (c) => {
	const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;
	const clubs = await listClubs({ limit });
	return c.json({ success: true, count: clubs.length, clubs });
});
