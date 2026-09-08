/**
 * Business CRM directory — CLI / POST only (no auto on npm run dev). LLM off.
 *
 * GET  /business-crms
 * POST /business-crms/run
 * GET  /business-crms/list
 * GET  /business-crms/queries
 */

import { Hono } from "hono";
import { CRM_AGENT, CRM_QUERIES } from "./crmDirectory/configs.js";
import { countCrms } from "./crmDirectory/core.js";
import { listCrms, runCrmDirectoryAgent } from "./crmDirectory/orchestrator.js";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";

export const crmDirectoryRouter = new Hono();

crmDirectoryRouter.get("/business-crms", async (c) => {
	let count = 0;
	try {
		count = await countCrms();
	} catch {
		/* ignore */
	}
	return c.json({
		success: true,
		agent: {
			id: CRM_AGENT.id,
			name: CRM_AGENT.name,
			collection: CRM_AGENT.collection,
			queryCount: CRM_QUERIES.length,
			pipeline: [
				"20 Google keyword queries (rotate)",
				"scrape CRM list/directory pages for product websites",
				"optional homepage scrape for name/description",
				"firestore business-crms (sha256 domain, no LLM)",
			],
			cli: "npm run crm:directory",
			run: "POST /business-crms/run",
			list: "GET /business-crms/list",
		},
		count,
		note: "Scrape-only. Does not auto-run on npm run dev.",
	});
});

async function handleRun(c) {
	let body = {};
	try {
		body = await c.req.json().catch(() => ({}));
	} catch {
		body = {};
	}
	const queriesPerRun = body.queriesPerRun
		? Number(body.queriesPerRun)
		: c.req.query("queriesPerRun")
			? Number(c.req.query("queriesPerRun"))
			: undefined;
	try {
		const summary = await runCrmDirectoryAgent({
			baseUrl: resolveResearchBaseUrl(c),
			queriesPerRun,
			enrich: body.enrich !== false && c.req.query("enrich") !== "0",
		});
		return c.json({ success: true, ...summary, timestamp: new Date().toISOString() });
	} catch (err) {
		console.error("[business-crms] run failed:", err);
		return c.json({ success: false, error: err?.message || "CRM directory run failed" }, 500);
	}
}

crmDirectoryRouter.post("/business-crms/run", handleRun);
crmDirectoryRouter.get("/business-crms/run", handleRun);

crmDirectoryRouter.get("/business-crms/list", async (c) => {
	try {
		const limit = Math.min(Number(c.req.query("limit")) || 80, 300);
		const crms = await listCrms(CRM_AGENT.collection, { limit });
		return c.json({ success: true, count: crms.length, crms });
	} catch (err) {
		return c.json({ success: false, error: err?.message || "Failed to list CRMs" }, 500);
	}
});

crmDirectoryRouter.get("/business-crms/queries", (c) => {
	return c.json({
		success: true,
		count: CRM_QUERIES.length,
		queries: CRM_QUERIES,
	});
});
