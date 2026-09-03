/**
 * England football clubs — Soccer Wiki ENG listing. CLI / POST only.
 *
 * GET  /england-clubs
 * POST /england-clubs/run
 * GET  /england-clubs/list
 */

import { Hono } from "hono";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import { ENGLAND_CLUBS_AGENT, TOTAL_CLUBS } from "./englandClubs/configs.js";
import {
	countClubs,
	listClubs,
	runEnglandClubsAgent,
} from "./englandClubs/orchestrator.js";

export const englandClubsRouter = new Hono();

englandClubsRouter.get("/england-clubs", async (c) => {
	let count = 0;
	try {
		count = await countClubs();
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
			cli: "npm run england:clubs",
			run: "POST /england-clubs/run",
			list: "GET /england-clubs/list",
			pipeline: [
				"scrape Soccer Wiki England clubs listing",
				"store Firestore clubs (hash by clubid)",
				"next offset (+50) until 333",
			],
		},
		count,
		note: "England only. No LLM. Does not auto-run on npm run dev. Optional { enrich: true } for Google + site emails/socials.",
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
			baseUrl: resolveResearchBaseUrl(c),
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

englandClubsRouter.get("/england-clubs/list", async (c) => {
	const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;
	const clubs = await listClubs({ limit });
	return c.json({ success: true, count: clubs.length, clubs });
});
