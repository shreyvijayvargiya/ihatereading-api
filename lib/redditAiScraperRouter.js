/**
 * Generic Reddit scraper — prompt in, no hardcoded subreddit list.
 * Default scrape-only. Pass { llm: true } / ?llm=1 to use OpenRouter.
 *
 * GET  /reddit-ai-scraper
 * POST /reddit-ai-scraper/run   { prompt, llm?, rediscover?, skipGoogle?, subsPerRun? }
 * GET  /reddit-ai-scraper/topics
 * GET  /reddit-ai-scraper/posts?topic=
 */

import { Hono } from "hono";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import { wantRedditLlmFromRequest } from "./redditAgents/core.js";
import { REDDIT_AI_SCRAPER } from "./redditAiScraper/configs.js";
import {
	listAiScraperPosts,
	listAiScraperTopics,
	runRedditAiScraper,
} from "./redditAiScraper/orchestrator.js";

export const redditAiScraperRouter = new Hono();

redditAiScraperRouter.get("/reddit-ai-scraper", (c) => {
	return c.json({
		success: true,
		agent: {
			id: REDDIT_AI_SCRAPER.id,
			name: REDDIT_AI_SCRAPER.name,
			collection: REDDIT_AI_SCRAPER.collection,
			topicsCollection: REDDIT_AI_SCRAPER.topicsCollection,
			cli: 'npm run reddit:ai-scraper -- --prompt "your research goal"',
			run: "POST /reddit-ai-scraper/run",
			topics: "GET /reddit-ai-scraper/topics",
			posts: "GET /reddit-ai-scraper/posts?topic=",
		},
		layers: [
			"Default scrape-only: Google site:reddit.com → RSS → store",
			"With llm:true: LLM plans queries + seed subs",
			"Google site:reddit.com scrape → more subs + threads",
			"With llm:true: LLM finalizes 10–20 subreddits",
			"RSS fetch posts/metadata",
			"With llm:true: OpenRouter enrich then store redditAiScraperPosts",
		],
		note: "Scrape-only by default. Pass { llm: true } or --llm to use OpenRouter. First scrape-only run needs Google.",
	});
});

async function handleRun(c, body, query) {
	const llm = wantRedditLlmFromRequest(body, query);
	if (llm && !process.env.OPENROUTER_API_KEY?.trim()) {
		return c.json(
			{ success: false, error: "OPENROUTER_API_KEY required when llm/enrich is true" },
			503,
		);
	}
	const prompt = body.prompt || body.query || query.prompt || "";
	if (!String(prompt).trim()) {
		return c.json({ success: false, error: "prompt is required" }, 400);
	}
	try {
		const summary = await runRedditAiScraper({
			prompt,
			baseUrl: resolveResearchBaseUrl(c),
			skipGoogle: body.skipGoogle === true || query.skipGoogle === "1",
			rediscover: body.rediscover === true || query.rediscover === "1",
			subsPerRun: body.subsPerRun ? Number(body.subsPerRun) : undefined,
			llm,
		});
		return c.json({
			success: true,
			...summary,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		console.error("[reddit-ai-scraper]", err);
		return c.json(
			{ success: false, error: err?.message || String(err) },
			500,
		);
	}
}

redditAiScraperRouter.post("/reddit-ai-scraper/run", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	return handleRun(c, body, {
		prompt: c.req.query("prompt"),
		llm: c.req.query("llm"),
		enrich: c.req.query("enrich"),
		skipGoogle: c.req.query("skipGoogle"),
		rediscover: c.req.query("rediscover"),
	});
});

redditAiScraperRouter.get("/reddit-ai-scraper/run", async (c) => {
	return handleRun(c, {}, {
		prompt: c.req.query("prompt"),
		llm: c.req.query("llm"),
		enrich: c.req.query("enrich"),
		skipGoogle: c.req.query("skipGoogle"),
		rediscover: c.req.query("rediscover"),
	});
});

redditAiScraperRouter.get("/reddit-ai-scraper/topics", async (c) => {
	try {
		const topics = await listAiScraperTopics(Number(c.req.query("limit") || 50));
		return c.json({ success: true, count: topics.length, topics });
	} catch (err) {
		return c.json({ success: false, error: err?.message || String(err) }, 500);
	}
});

redditAiScraperRouter.get("/reddit-ai-scraper/posts", async (c) => {
	try {
		const minRaw = c.req.query("minScore");
		const posts = await listAiScraperPosts({
			topicId: c.req.query("topic") || undefined,
			minScore: minRaw === undefined || minRaw === "" ? 0 : Number(minRaw),
			limit: Number(c.req.query("limit") || 50),
		});
		return c.json({
			success: true,
			count: posts.length,
			collection: REDDIT_AI_SCRAPER.collection,
			posts,
		});
	} catch (err) {
		return c.json({ success: false, error: err?.message || String(err) }, 500);
	}
});
