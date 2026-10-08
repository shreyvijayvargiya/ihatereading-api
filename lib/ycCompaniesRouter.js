/**
 * YC companies agent — CLI / POST only (no auto on npm run dev).
 *
 * GET  /yc-companies
 * POST /yc-companies/run
 * POST /yc-companies/enrich
 * POST /yc-companies/launch-enrich
 * GET  /yc-companies/list
 * GET  /yc-companies/sources
 */

import { Hono } from "hono";
import {
	ALL_SOURCES,
	LOCAL_API_BASE,
	parseBatchFilters,
	sourcesForBatches,
	SITE_ENRICH_BATCH_SIZE,
	LAUNCH_ENRICH_BATCH_SIZE,
	LAUNCH_ENRICH_BATCH_ORDER,
	YC_AGENT,
} from "./ycCompanies/configs.js";
import {
	listCompanies,
	runYcCompaniesAgent,
} from "./ycCompanies/orchestrator.js";
import { runYcCompaniesSiteEnrichAgent } from "./ycCompanies/siteEnrich.js";
import { runYcCompaniesLaunchEnrichAgent } from "./ycCompanies/launchEnrich.js";
import {
	countCompanies,
	countLaunchEnrichedCompanies,
	countSiteEnrichedCompanies,
} from "./ycCompanies/core.js";
import { resolveScrapeBaseUrl } from "./scrapefast.js";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import { hasOpenRouterKey, wantUseAiFromRequest } from "./useAi.js";

export const ycCompaniesRouter = new Hono();

ycCompaniesRouter.get("/yc-companies", async (c) => {
	let count = 0;
	let siteEnriched = 0;
	let launchEnriched = 0;
	try {
		count = await countCompanies();
		siteEnriched = await countSiteEnrichedCompanies();
		launchEnriched = await countLaunchEnrichedCompanies();
	} catch {
		/* ignore */
	}
	return c.json({
		success: true,
		agent: {
			id: YC_AGENT.id,
			name: YC_AGENT.name,
			collection: YC_AGENT.collection,
			sourceCount: ALL_SOURCES.length,
			siteEnrichBatchSize: SITE_ENRICH_BATCH_SIZE,
			launchEnrichBatchSize: LAUNCH_ENRICH_BATCH_SIZE,
			launchEnrichBatchOrder: LAUNCH_ENRICH_BATCH_ORDER.slice(0, 8),
			pipeline: [
				"discover (YC directory + Hacker News + Google)",
				"enrich (Google scrape: founders, funding, email, address)",
				"llm synthesize",
				"firestore yc-companies (hash dedupe)",
				"site enrich 4 at a time: pages + logo/brand + address/lat/lng/mapsUrl",
				"launch enrich: YC company page → Launch YC post → email/founders",
			],
			cli: "npm run yc:companies",
			enrichCli: "npm run yc:companies:enrich",
			launchEnrichCli: "npm run yc:companies:launch-enrich",
			run: "POST /yc-companies/run",
			enrich: "POST /yc-companies/enrich",
			launchEnrich: "POST /yc-companies/launch-enrich",
			list: "GET /yc-companies/list",
		},
		count,
		siteEnriched,
		launchEnriched,
		note: "Uses yc-oss company JSON (real YC startups + hiring). Site enrich is HTTP-only (no Chrome). Does not auto-run on npm run dev.",
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

	const status = body.status || c.req.query("status") || undefined;
	const hiring =
		body.hiring === true ||
		c.req.query("hiring") === "true" ||
		c.req.query("hiring") === "1";
	const sourcesPerRun = body.sourcesPerRun
		? Number(body.sourcesPerRun)
		: c.req.query("sourcesPerRun")
			? Number(c.req.query("sourcesPerRun"))
			: undefined;
	const batch = body.batch || c.req.query("batch") || undefined;
	const batches = body.batches || c.req.query("batches") || undefined;
	const year = body.year ?? c.req.query("year") ?? undefined;

	try {
		const summary = await runYcCompaniesAgent({
			baseUrl: resolveResearchBaseUrl(c),
			status,
			hiring,
			batch,
			batches,
			year,
			sourcesPerRun,
			enrich: body.enrich !== false,
			useAI,
		});
		return c.json({
			success: true,
			...summary,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		console.error("[yc-companies] run failed:", err);
		return c.json(
			{
				success: false,
				error: err?.message || "YC companies run failed",
			},
			500,
		);
	}
}

ycCompaniesRouter.post("/yc-companies/run", handleRun);
ycCompaniesRouter.get("/yc-companies/run", handleRun);

ycCompaniesRouter.post("/yc-companies/launch-enrich", async (c) => {
	let body = {};
	try {
		body = await c.req.json().catch(() => ({}));
	} catch {
		body = {};
	}
	try {
		const summary = await runYcCompaniesLaunchEnrichAgent({
			baseUrl: resolveScrapeBaseUrl(c) || LOCAL_API_BASE,
			reset: body.reset === true || c.req.query("reset") === "1",
		});
		return c.json({
			success: true,
			...summary,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		console.error("[yc-companies] launch enrich failed:", err);
		return c.json(
			{
				success: false,
				error: err?.message || "YC companies launch enrich failed",
			},
			500,
		);
	}
});

ycCompaniesRouter.post("/yc-companies/enrich", async (c) => {
	let body = {};
	try {
		body = await c.req.json().catch(() => ({}));
	} catch {
		body = {};
	}
	try {
		const summary = await runYcCompaniesSiteEnrichAgent({
			baseUrl: resolveResearchBaseUrl(c) || LOCAL_API_BASE,
			reset: body.reset === true || c.req.query("reset") === "1",
		});
		return c.json({
			success: true,
			...summary,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		console.error("[yc-companies] site enrich failed:", err);
		return c.json(
			{
				success: false,
				error: err?.message || "YC companies site enrich failed",
			},
			500,
		);
	}
});

ycCompaniesRouter.get("/yc-companies/list", async (c) => {
	try {
		const status = c.req.query("status") || undefined;
		const hiring = c.req.query("hiring");
		const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
		const minConfidence = Number(c.req.query("minConfidence")) || 0;
		const companies = await listCompanies(YC_AGENT.collection, {
			status,
			hiring,
			limit,
			minConfidence,
		});
		return c.json({
			success: true,
			count: companies.length,
			status: status || null,
			hiring: hiring || null,
			companies,
		});
	} catch (err) {
		return c.json(
			{ success: false, error: err?.message || "Failed to list companies" },
			500,
		);
	}
});

ycCompaniesRouter.get("/yc-companies/sources", (c) => {
	const status = c.req.query("status") || undefined;
	const batch = c.req.query("batch") || undefined;
	const batches = c.req.query("batches") || undefined;
	const year = c.req.query("year") || undefined;
	let sources = ALL_SOURCES;
	const batchFilter = parseBatchFilters({ batch, batches, year });
	if (batchFilter.length) {
		sources = sourcesForBatches(batchFilter);
	} else if (status) {
		sources = sources.filter(
			(s) => String(s.statusHint || "").toLowerCase() === status.toLowerCase(),
		);
	}
	return c.json({
		success: true,
		count: sources.length,
		sources: sources.map((s) => ({
			id: s.id,
			type: s.type,
			statusHint: s.statusHint,
			url: s.url || null,
			query: s.query || null,
			label: s.label,
			batch: s.batch || null,
		})),
	});
});
