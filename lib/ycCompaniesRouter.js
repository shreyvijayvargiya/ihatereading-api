/**
 * YC companies agent — CLI / POST only (no auto on npm run dev).
 *
 * GET  /yc-companies
 * POST /yc-companies/run
 * GET  /yc-companies/list
 * GET  /yc-companies/sources
 */

import { Hono } from "hono";
import { ALL_SOURCES, YC_AGENT } from "./ycCompanies/configs.js";
import {
	listCompanies,
	runYcCompaniesAgent,
} from "./ycCompanies/orchestrator.js";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import { hasOpenRouterKey, wantUseAiFromRequest } from "./useAi.js";

export const ycCompaniesRouter = new Hono();

ycCompaniesRouter.get("/yc-companies", (c) => {
	return c.json({
		success: true,
		agent: {
			id: YC_AGENT.id,
			name: YC_AGENT.name,
			collection: YC_AGENT.collection,
			sourceCount: ALL_SOURCES.length,
			pipeline: [
				"discover (YC directory + Hacker News + Google)",
				"enrich (Google scrape: founders, funding, email, address)",
				"llm synthesize",
				"firestore yc-companies (hash dedupe)",
			],
			cli: "npm run yc:companies",
			run: "POST /yc-companies/run",
			list: "GET /yc-companies/list",
		},
		note: "Uses yc-oss company JSON (real YC startups + hiring). Junk listicle SERP domains filtered. Does not auto-run on npm run dev.",
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

	try {
		const summary = await runYcCompaniesAgent({
			baseUrl: resolveResearchBaseUrl(c),
			status,
			hiring,
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
	let sources = ALL_SOURCES;
	if (status) {
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
