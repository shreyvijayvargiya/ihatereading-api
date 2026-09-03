/**
 * iHateReading internet news — programming / startups / SaaS / funding.
 *
 * GET  /internet-news
 * POST /internet-news/run
 * GET  /internet-news/list
 * GET  /internet-news/platforms
 */

import { Hono } from "hono";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import {
	INTERNET_NEWS_AGENT,
	NEWS_KEYWORDS,
	NEWS_PLATFORMS,
	listPlatformIds,
	resolvePlatform,
} from "./internetNews/configs.js";
import {
	countArticles,
	listArticles,
	runInternetNewsAgent,
} from "./internetNews/orchestrator.js";

export const internetNewsRouter = new Hono();

internetNewsRouter.get("/internet-news", async (c) => {
	let count = 0;
	try {
		count = await countArticles();
	} catch {
		/* ignore */
	}
	return c.json({
		success: true,
		agent: {
			id: INTERNET_NEWS_AGENT.id,
			name: INTERNET_NEWS_AGENT.name,
			collection: INTERNET_NEWS_AGENT.collection,
			platformsPerRun: INTERNET_NEWS_AGENT.platformsPerRun,
			urlsPerPlatform: INTERNET_NEWS_AGENT.urlsPerPlatform,
			platformIds: listPlatformIds(),
			keywords: NEWS_KEYWORDS,
			cli: "npm run news:ihatereading",
			run: "POST /internet-news/run",
			list: "GET /internet-news/list",
		},
		count,
		note: "No AI. Google News (keyword) + 19 lists. 4 platforms/tick, 10–20 URLs each. Tags/category from the source. Does not auto-run on npm run dev.",
	});
});

internetNewsRouter.get("/internet-news/platforms", (c) => {
	return c.json({
		success: true,
		platforms: NEWS_PLATFORMS.map((p) => ({
			id: p.id,
			name: p.name,
			aliases: p.aliases || [],
			listUrl: p.listUrl,
			kind: p.kind || "list",
			category: p.category,
			tags: p.tags || [],
		})),
		keywords: NEWS_KEYWORDS,
	});
});

async function handleRun(c) {
	let body = {};
	try {
		if (c.req.method === "POST") body = await c.req.json().catch(() => ({}));
	} catch {
		body = {};
	}

	const platform = body.platform || c.req.query("platform") || undefined;
	if (platform && !resolvePlatform(platform)) {
		return c.json(
			{
				success: false,
				error: {
					code: "UNKNOWN_PLATFORM",
					message: platform,
					platforms: listPlatformIds(),
				},
			},
			400,
		);
	}

	const platformsPerRun = body.platformsPerRun
		? Number(body.platformsPerRun)
		: c.req.query("platformsPerRun")
			? Number(c.req.query("platformsPerRun"))
			: undefined;
	const urlsPerPlatform = body.urlsPerPlatform
		? Number(body.urlsPerPlatform)
		: body.limit
			? Number(body.limit)
			: c.req.query("urlsPerPlatform")
				? Number(c.req.query("urlsPerPlatform"))
				: undefined;
	const keyword = body.keyword || c.req.query("keyword") || undefined;

	try {
		const summary = await runInternetNewsAgent({
			baseUrl: resolveResearchBaseUrl(c),
			platform,
			platformsPerRun,
			urlsPerPlatform,
			keyword,
		});
		return c.json({
			success: true,
			...summary,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		console.error("[internet-news] run failed:", err);
		return c.json(
			{
				success: false,
				error: { code: "RUN_FAILED", message: err?.message || String(err) },
			},
			500,
		);
	}
}

internetNewsRouter.post("/internet-news/run", handleRun);
internetNewsRouter.get("/internet-news/run", handleRun);

internetNewsRouter.get("/internet-news/list", async (c) => {
	const limit = Math.min(200, Number(c.req.query("limit") || 40));
	try {
		const articles = await listArticles(INTERNET_NEWS_AGENT.collection, {
			platform: c.req.query("platform") || undefined,
			tag: c.req.query("tag") || undefined,
			category: c.req.query("category") || undefined,
			limit,
		});
		const total = await countArticles();
		return c.json({
			success: true,
			collection: INTERNET_NEWS_AGENT.collection,
			total,
			count: articles.length,
			articles,
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
});
