/**
 * Outbound B2B prospect pipeline — karyam.xyz + saascrm.site
 *
 * GET  /outbound-prospects
 * POST /outbound-prospects/run
 */

import { Hono } from "hono";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import { hasOpenRouterKey, requestAiOpts } from "./useAi.js";
import {
	DISCOVERY_JOBS,
	INTENTS,
	KARYAM_PITCH,
	OUTBOUND_AGENT,
	SAASCRM_PITCH,
} from "./outboundProspects/configs.js";
import { runOutboundProspectsAgent } from "./outboundProspects/orchestrator.js";

export const outboundProspectsRouter = new Hono();

outboundProspectsRouter.get("/outbound-prospects", (c) => {
	return c.json({
		success: true,
		agent: {
			id: OUTBOUND_AGENT.id,
			name: OUTBOUND_AGENT.name,
			brands: OUTBOUND_AGENT.brands,
			collection: OUTBOUND_AGENT.collection,
			jobCount: DISCOVERY_JOBS.length,
			intents: INTENTS,
			pipeline: [
				"rotating Google Search + Google Maps jobs (US → AU → EU → IN)",
				"/scrape enrichment for email + phone",
				"optional OpenRouter scoring + outreach draft (useAI / --use-ai)",
			],
			cli: "npm run outbound:prospects",
			run: "POST /outbound-prospects/run",
		},
		offers: { karyam: KARYAM_PITCH, saascrm: SAASCRM_PITCH },
		note: "Scrape-only by default. Pass { useAI: true } or --use-ai for LLM scoring and draft messages. Does not auto-run on npm run dev.",
	});
});

outboundProspectsRouter.post("/outbound-prospects/run", async (c) => {
	const body = await c.req.json().catch(() => ({}));
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
		const summary = await runOutboundProspectsAgent({
			baseUrl: resolveResearchBaseUrl(c),
			brand: body.brand || c.req.query("brand"),
			intent: body.intent || c.req.query("intent"),
			channel: body.channel || c.req.query("channel"),
			country: body.country || c.req.query("country"),
			jobId: body.jobId || c.req.query("jobId"),
			jobsPerRun: body.jobsPerRun
				? Number(body.jobsPerRun)
				: c.req.query("jobsPerRun")
					? Number(c.req.query("jobsPerRun"))
					: undefined,
			enrich: body.enrich !== false && c.req.query("enrich") !== "0",
			...ai,
		});
		return c.json({ success: true, ...summary });
	} catch (err) {
		return c.json(
			{
				success: false,
				error: err?.message || "Outbound prospect run failed",
			},
			500,
		);
	}
});
