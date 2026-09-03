/**
 * Reddit agents router — CLI-driven monitors (no auto scheduler).
 *
 * POST /reddit-agents/karyam/run
 * GET  /reddit-agents/karyam/relevant
 * POST /reddit-agents/ihatereading/run
 * GET  /reddit-agents/ihatereading/relevant
 * POST /reddit-agents/saas/run
 * POST /reddit-agents/scraping/run
 * POST /reddit-agents/buildsaas/run
 * GET  /reddit-agents/saas/relevant
 * GET  /reddit-agents/buildsaas/relevant
 * GET  /reddit-agents
 */

import { Hono } from "hono";
import { getAgent, listAgentIds, AGENTS } from "./redditAgents/configs.js";
import { listAgentPosts, wantRedditLlmFromRequest } from "./redditAgents/core.js";
import { runKaryamAgent } from "./redditAgents/karyam.js";
import { runIhatereadingAgent } from "./redditAgents/ihatereading.js";
import { runSaasProblemsAgent } from "./redditAgents/saasProblems.js";
import { runDirectoryIdeasAgent } from "./redditAgents/directoryIdeas.js";
import { runScrapingProblemsAgent } from "./redditAgents/scrapingProblems.js";
import { runBuildsaasAgent } from "./redditAgents/buildsaas.js";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";

export const redditAgentsRouter = new Hono();

const RUNNERS = {
	karyam: (opts) => runKaryamAgent(opts),
	ihatereading: (opts) => runIhatereadingAgent(opts),
	saas: (opts) => runSaasProblemsAgent(opts),
	directories: (opts) => runDirectoryIdeasAgent(opts),
	scraping: (opts) => runScrapingProblemsAgent(opts),
	buildsaas: (opts) => runBuildsaasAgent(opts),
};

function assertAgent(id) {
	return getAgent(id);
}

redditAgentsRouter.get("/reddit-agents", (c) => {
	return c.json({
		success: true,
		agents: listAgentIds().map((id) => {
			const a = AGENTS[id];
			return {
				id: a.id,
				name: a.name,
				site: a.site,
				collection: a.collection,
				subredditCount: (a.subreddits || []).length,
				cli: `npm run reddit:agent -- ${id}`,
				run: `POST /reddit-agents/${id}/run`,
				relevant: `GET /reddit-agents/${id}/relevant`,
			};
		}),
		note: "Scrape-only by default. Pass { llm: true } or ?llm=1 to score with OpenRouter. Agents do NOT auto-run on server start.",
	});
});

async function handleRun(c, agentId) {
	const agent = assertAgent(agentId);
	if (!agent) {
		return c.json(
			{ success: false, error: { code: "UNKNOWN_AGENT", message: agentId } },
			404,
		);
	}
	try {
		const runner = RUNNERS[agentId];
		if (!runner) {
			return c.json(
				{
					success: false,
					error: { code: "NO_RUNNER", message: agentId },
				},
				500,
			);
		}
		let body = {};
		try {
			if (c.req.method === "POST") body = await c.req.json().catch(() => ({}));
		} catch {
			body = {};
		}
		const llm = wantRedditLlmFromRequest(body, {
			llm: c.req.query("llm"),
			enrich: c.req.query("enrich"),
		});
		if (llm && !process.env.OPENROUTER_API_KEY?.trim()) {
			return c.json(
				{
					success: false,
					error: {
						code: "MISSING_OPENROUTER_KEY",
						message: "OPENROUTER_API_KEY required when llm/enrich is true",
					},
				},
				503,
			);
		}
		const skipGoogle =
			body.skipGoogle === true || c.req.query("skipGoogle") === "1";
		const opts = {
			baseUrl: resolveResearchBaseUrl(c),
			skipGoogle,
			subsPerRun: body.subsPerRun ? Number(body.subsPerRun) : undefined,
			llm,
		};
		const summary = await runner(opts);
		return c.json({
			success: true,
			agentId,
			...summary,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		console.error(`[reddit-agents] ${agentId} run failed:`, err);
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

async function handleRelevant(c, agentId) {
	const agent = assertAgent(agentId);
	if (!agent) {
		return c.json(
			{ success: false, error: { code: "UNKNOWN_AGENT", message: agentId } },
			404,
		);
	}
	const minRaw = c.req.query("minScore");
	const min = minRaw === undefined || minRaw === "" ? 0 : Number(minRaw);
	const limit = Math.min(200, Number(c.req.query("limit") || 100));
	const tag = c.req.query("tag") || c.req.query("niche") || undefined;
	try {
		let posts = await listAgentPosts(agentId, {
			minScore: min,
			limit: tag ? limit * 3 : limit,
		});
		if (tag) {
			const t = String(tag).toLowerCase();
			posts = posts
				.filter((p) =>
					(p.tags || []).some((x) => String(x).toLowerCase() === t) ||
					String(p.directoryCategory || p.problemType || "")
						.toLowerCase()
						.includes(t),
				)
				.slice(0, limit);
		}
		return c.json({
			success: true,
			agentId,
			collection: agent.collection,
			count: posts.length,
			minScore: min,
			tag: tag || null,
			posts,
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
}

for (const id of listAgentIds()) {
	redditAgentsRouter.post(`/reddit-agents/${id}/run`, (c) => handleRun(c, id));
	redditAgentsRouter.get(`/reddit-agents/${id}/run`, (c) => handleRun(c, id));
	redditAgentsRouter.get(`/reddit-agents/${id}/relevant`, (c) =>
		handleRelevant(c, id),
	);
}
