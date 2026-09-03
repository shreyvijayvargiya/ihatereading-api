/**
 * Programming magazine creators — YouTube + X by cover category.
 *
 * GET  /dev-magazine
 * POST /dev-magazine/run
 * GET  /dev-magazine/list
 * GET  /dev-magazine/videos
 * GET  /dev-magazine/categories
 */

import { Hono } from "hono";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import { hasOpenRouterKey, wantUseAiFromRequest } from "./useAi.js";
import {
	ALL_MAGAZINE_QUERIES,
	MAGAZINE_AGENT,
	MAGAZINE_CATEGORIES,
	filterMagazineQueries,
	listCategoryIds,
	resolveCategory,
} from "./devMagazine/configs.js";
import { listVideos } from "./devMagazine/core.js";
import {
	countChannels,
	listChannels,
	runDevMagazineAgent,
} from "./devMagazine/orchestrator.js";

export const devMagazineRouter = new Hono();

devMagazineRouter.get("/dev-magazine", async (c) => {
	let count = 0;
	try {
		count = await countChannels();
	} catch {
		/* ignore */
	}
	return c.json({
		success: true,
		agent: {
			id: MAGAZINE_AGENT.id,
			name: MAGAZINE_AGENT.name,
			channelsCollection: MAGAZINE_AGENT.channelsCollection,
			videosCollection: MAGAZINE_AGENT.videosCollection,
			categories: MAGAZINE_CATEGORIES,
			categoryIds: listCategoryIds(),
			queryCount: ALL_MAGAZINE_QUERIES.length,
			cli: "npm run magazine:creators -- --category frontend --topic react",
			run: "POST /dev-magazine/run",
			list: "GET /dev-magazine/list",
			videos: "GET /dev-magazine/videos",
		},
		channelCount: count,
		note: "Google discover YouTube/X programming educators per magazine cover, scrape profiles, LLM classify, fetch latest YouTube videos. Not the lifestyle influencers agent.",
	});
});

devMagazineRouter.get("/dev-magazine/categories", (c) => {
	return c.json({
		success: true,
		categories: MAGAZINE_CATEGORIES,
		ids: listCategoryIds(),
	});
});

async function handleRun(c) {
	let body = {};
	try {
		if (c.req.method === "POST") body = await c.req.json().catch(() => ({}));
	} catch {
		body = {};
	}
	const videosOnly =
		body.videosOnly === true || c.req.query("videosOnly") === "1";
	const useAI = wantUseAiFromRequest(body, {
		useAI: c.req.query("useAI") || c.req.query("useAi") || c.req.query("llm"),
	});
	if (useAI && !hasOpenRouterKey()) {
		return c.json(
			{
				success: false,
				error: "OPENROUTER_API_KEY required when useAI is true",
			},
			503,
		);
	}
	const category = body.category || c.req.query("category");
	const topic = body.topic || c.req.query("topic");
	const platform = body.platform || c.req.query("platform");
	if (category && !resolveCategory(category)) {
		return c.json(
			{
				success: false,
				error: `Unknown category "${category}"`,
				categories: listCategoryIds(),
			},
			400,
		);
	}
	try {
		const summary = await runDevMagazineAgent({
			baseUrl: resolveResearchBaseUrl(c),
			category,
			topic,
			platform,
			queriesPerRun: body.queriesPerRun
				? Number(body.queriesPerRun)
				: undefined,
			enrich: body.enrich !== false,
			fetchVideos: body.fetchVideos !== false,
			videosOnly,
			useAI,
		});
		return c.json({
			success: true,
			...summary,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		console.error("[dev-magazine]", err);
		return c.json({ success: false, error: err?.message || String(err) }, 500);
	}
}

devMagazineRouter.post("/dev-magazine/run", handleRun);
devMagazineRouter.get("/dev-magazine/run", handleRun);

devMagazineRouter.get("/dev-magazine/list", async (c) => {
	try {
		const people = await listChannels({
			category: c.req.query("category"),
			topic: c.req.query("topic"),
			platform: c.req.query("platform"),
			limit: Number(c.req.query("limit") || 80),
		});
		return c.json({
			success: true,
			collection: MAGAZINE_AGENT.channelsCollection,
			count: people.length,
			channels: people,
		});
	} catch (err) {
		return c.json({ success: false, error: err?.message || String(err) }, 500);
	}
});

devMagazineRouter.get("/dev-magazine/videos", async (c) => {
	try {
		const videos = await listVideos({
			category: c.req.query("category"),
			topic: c.req.query("topic"),
			channelId: c.req.query("channelId"),
			limit: Number(c.req.query("limit") || 80),
		});
		return c.json({
			success: true,
			collection: MAGAZINE_AGENT.videosCollection,
			count: videos.length,
			videos,
		});
	} catch (err) {
		return c.json({ success: false, error: err?.message || String(err) }, 500);
	}
});

devMagazineRouter.get("/dev-magazine/queries", (c) => {
	const queries = filterMagazineQueries(ALL_MAGAZINE_QUERIES, {
		category: c.req.query("category"),
		topic: c.req.query("topic"),
		platform: c.req.query("platform"),
	});
	return c.json({ success: true, count: queries.length, queries });
});
