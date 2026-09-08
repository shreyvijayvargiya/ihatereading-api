/**
 * a16z companies agent — CLI / POST only (no auto on npm run dev).
 *
 * GET  /a16z-companies
 * POST /a16z-companies/run
 * GET  /a16z-companies/list
 */

import { Hono } from "hono";
import { A16Z_AGENT, A16Z_PORTFOLIO_URL, BATCH_SIZE, INTERVAL_MS } from "./a16zCompanies/configs.js";
import { listCompanies, runA16zCompaniesAgent } from "./a16zCompanies/orchestrator.js";
import { countCompanies } from "./a16zCompanies/core.js";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";

export const a16zCompaniesRouter = new Hono();

a16zCompaniesRouter.get("/a16z-companies", async (c) => {
	let count = 0;
	try {
		count = await countCompanies();
	} catch {
		/* ignore */
	}
	return c.json({
		success: true,
		agent: {
			id: A16Z_AGENT.id,
			name: A16Z_AGENT.name,
			collection: A16Z_AGENT.collection,
			listingUrl: A16Z_PORTFOLIO_URL,
			batchSize: BATCH_SIZE,
			intervalMs: INTERVAL_MS,
			pipeline: [
				"fetch a16z.com/portfolio/?status=Active",
				"parse data-companies JSON (card + modal fields, socials by domain)",
				"next 4 companies",
				"site enrich in-process when website exists",
				"firestore yc-companies (same collection + keys as YC, hash dedupe)",
			],
			cli: "npm run a16z:companies",
			run: "POST /a16z-companies/run",
			list: "GET /a16z-companies/list",
		},
		count,
		note: "Stores into yc-companies (same dashboard table as YC). Does not auto-run on npm run dev. Site enrich is HTTP-only (no Chrome).",
	});
});

async function handleRun(c) {
	let body = {};
	try {
		body = await c.req.json().catch(() => ({}));
	} catch {
		body = {};
	}

	const status = body.status || c.req.query("status") || "Active";
	const reset = body.reset === true || c.req.query("reset") === "1";
	const enrich = body.enrich !== false && c.req.query("enrich") !== "0";

	try {
		const summary = await runA16zCompaniesAgent({
			baseUrl: resolveResearchBaseUrl(c),
			status,
			reset,
			enrich,
		});
		return c.json({
			success: true,
			...summary,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		console.error("[a16z-companies] run failed:", err);
		return c.json(
			{
				success: false,
				error: err?.message || "a16z companies run failed",
			},
			500,
		);
	}
}

a16zCompaniesRouter.post("/a16z-companies/run", handleRun);
a16zCompaniesRouter.get("/a16z-companies/run", handleRun);

a16zCompaniesRouter.get("/a16z-companies/list", async (c) => {
	try {
		const status = c.req.query("status") || undefined;
		const hiring = c.req.query("hiring");
		const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
		const minConfidence = Number(c.req.query("minConfidence")) || 0;
		const companies = await listCompanies(A16Z_AGENT.collection, {
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
