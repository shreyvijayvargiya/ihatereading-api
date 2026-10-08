/**
 * Content Intelligence API — enroll, research, generate, dashboard.
 *
 * POST /content/enroll
 * POST /content/research
 * POST /content/generate (legacy)
 * POST /airdropbounty-generate-blog-agent
 * POST /content/generate-batch
 * GET  /content/dashboard
 * PATCH /content/topics/:topicId
 */

import { Hono } from "hono";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import {
	enrollSite,
	runResearch,
	runGenerate,
	runGenerateBatch,
	getDashboard,
	patchTopic,
	createTopic,
	removeTopic,
	copyTopic,
	patchArticle,
	removeArticle,
	listSites,
	listTopics,
	listArticles,
	runRedditAirdropBountyScraper,
	runAgent37MultiSourceResearch,
} from "./content/orchestrator.js";

export const contentIntelligenceRouter = new Hono();

function err(c, err, fallback = 500) {
	const status = err?.status || fallback;
	return c.json(
		{
			success: false,
			error: {
				code: status === 400 ? "INVALID_REQUEST" : status === 404 ? "NOT_FOUND" : "ERROR",
				message: err?.message || "Request failed",
			},
		},
		status,
	);
}

contentIntelligenceRouter.get("/content", (c) => {
	return c.json({
		success: true,
		agent: {
			id: "content-intelligence",
			name: "Content Intelligence / AI Blog Generation",
			collection: "content_sites",
			endpoints: {
				enroll: "POST /content/enroll",
				research: "POST /content/research",
				generate: "POST /content/generate",
				airdropBountyGenerate: "POST /airdropbounty-generate-blog-agent",
				generateBatch: "POST /content/generate-batch",
				redditAirdropScraper: "POST /reddit-airdrop-bounty-scraper",
				agent37Research: "POST /agent37-research-topics",
				dashboard: "GET /content/dashboard?siteId=...",
				patchTopic: "PATCH /content/topics/:topicId?siteId=...",
			},
			cli: "npm run content:intelligence",
		},
	});
});

contentIntelligenceRouter.post("/content/enroll", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const result = await enrollSite(body);
		return c.json({ success: true, ...result });
	} catch (e) {
		return err(c, e, 400);
	}
});

contentIntelligenceRouter.post("/agent37-research-topics", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const siteId = body.siteId || c.req.query("siteId") || "agent37-com";
		const limit = Math.min(30, Number(body.limit) || 20);
		const sources = Array.isArray(body.sources)
			? body.sources
			: body.sources
				? String(body.sources).split(",").map((s) => s.trim())
				: undefined;
		const summary = await runAgent37MultiSourceResearch(siteId, {
			baseUrl: resolveResearchBaseUrl(c),
			limit,
			sources,
			refreshContent: body.refreshContent !== false,
			scrapeLimit: body.scrapeLimit,
			numPerQuery: body.numPerQuery,
		});
		return c.json(summary);
	} catch (e) {
		return err(c, e);
	}
});

contentIntelligenceRouter.post("/reddit-airdrop-bounty-scraper", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const siteId =
			body.siteId || c.req.query("siteId") || "airdropbounty-events";
		const limit = Math.min(30, Number(body.limit) || 20);
		const summary = await runRedditAirdropBountyScraper(siteId, {
			baseUrl: resolveResearchBaseUrl(c),
			limit,
			llm: body.llm !== false,
			refreshContent: body.refreshContent !== false,
			model: body.model,
		});
		return c.json(summary);
	} catch (e) {
		return err(c, e);
	}
});

contentIntelligenceRouter.get("/agent37-research-topics", async (c) => {
	return c.json({
		success: true,
		agent: "agent37-multi-source-research",
		description:
			"Parallel Reddit + LinkedIn + X + web discovery → LLM topics → content_sites/{siteId}/topics",
		endpoint: "POST /agent37-research-topics",
		defaultSiteId: "agent37-com",
		sources: ["reddit", "linkedin", "x", "web"],
		enroll:
			'npm run content:intelligence -- enroll --name "Agent37" --domain https://agent37.com',
		cli: "npm run agent37:research",
	});
});

contentIntelligenceRouter.post("/content/research", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const siteId = body.siteId || c.req.query("siteId");
		if (!siteId) {
			return err(c, Object.assign(new Error("siteId is required"), { status: 400 }));
		}
		const limit = Math.min(30, Number(body.limit) || 30);
		const summary = await runResearch(siteId, {
			baseUrl: resolveResearchBaseUrl(c),
			limit,
			force: Boolean(body.force),
			refreshContent: body.refreshContent !== false,
		});
		return c.json({ success: true, ...summary });
	} catch (e) {
		return err(c, e);
	}
});

async function handleBlogGenerate(c, agent) {
	const body = await c.req.json().catch(() => ({}));
	const siteId = body.siteId || c.req.query("siteId");
	const topicId = body.topicId || c.req.query("topicId");
	if (!siteId || !topicId) {
		return err(
			c,
			Object.assign(new Error("siteId and topicId are required"), { status: 400 }),
		);
	}
	const result = await runGenerate(siteId, topicId, {
		baseUrl: resolveResearchBaseUrl(c),
		force: Boolean(body.force),
		agent,
		refreshBrandContext: Boolean(body.refreshBrandContext),
	});
	return c.json({ success: true, agent: agent || "default", ...result });
}

contentIntelligenceRouter.post("/airdropbounty-generate-blog-agent", async (c) => {
	try {
		return await handleBlogGenerate(c, "airdropbounty");
	} catch (e) {
		return err(c, e);
	}
});

contentIntelligenceRouter.post("/content/generate", async (c) => {
	try {
		return await handleBlogGenerate(c, null);
	} catch (e) {
		return err(c, e);
	}
});

contentIntelligenceRouter.post("/content/generate-batch", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const siteId = body.siteId || c.req.query("siteId");
		if (!siteId) {
			return err(c, Object.assign(new Error("siteId is required"), { status: 400 }));
		}
		const summary = await runGenerateBatch(siteId, {
			baseUrl: resolveResearchBaseUrl(c),
			limit: body.limit,
			topicIds: body.topicIds,
			force: Boolean(body.force),
			concurrency: body.concurrency,
		});
		return c.json(summary);
	} catch (e) {
		return err(c, e);
	}
});

contentIntelligenceRouter.get("/content/dashboard", async (c) => {
	try {
		const siteId = c.req.query("siteId");
		if (!siteId) {
			return err(c, Object.assign(new Error("siteId query param is required"), { status: 400 }));
		}
		const filters = {};
		if (c.req.query("status")) filters.status = c.req.query("status");
		if (c.req.query("hook")) filters.hook = c.req.query("hook");
		const data = await getDashboard(siteId, filters);
		return c.json({ success: true, ...data });
	} catch (e) {
		return err(c, e);
	}
});

contentIntelligenceRouter.patch("/content/topics/:topicId", async (c) => {
	try {
		const topicId = c.req.param("topicId");
		const body = await c.req.json().catch(() => ({}));
		const siteId = c.req.query("siteId") || body.siteId;
		if (!siteId || !topicId) {
			return err(
				c,
				Object.assign(new Error("siteId and topicId are required"), { status: 400 }),
			);
		}
		const topic = await patchTopic(siteId, topicId, body);
		return c.json({ success: true, topic });
	} catch (e) {
		return err(c, e);
	}
});

contentIntelligenceRouter.get("/content/sites", async (c) => {
	try {
		const sites = await listSites();
		return c.json({ success: true, sites });
	} catch (e) {
		return err(c, e);
	}
});

contentIntelligenceRouter.get("/content/topics", async (c) => {
	try {
		const siteId = c.req.query("siteId");
		if (!siteId) {
			return err(c, Object.assign(new Error("siteId is required"), { status: 400 }));
		}
		const topics = await listTopics(siteId, {
			status: c.req.query("status"),
			hook: c.req.query("hook"),
		});
		return c.json({ success: true, siteId, count: topics.length, topics });
	} catch (e) {
		return err(c, e);
	}
});

contentIntelligenceRouter.post("/content/topics", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const siteId = body.siteId || c.req.query("siteId");
		if (!siteId) {
			return err(c, Object.assign(new Error("siteId is required"), { status: 400 }));
		}
		const topic = await createTopic(siteId, body);
		return c.json({ success: true, topic });
	} catch (e) {
		return err(c, e, 400);
	}
});

contentIntelligenceRouter.delete("/content/topics/:topicId", async (c) => {
	try {
		const topicId = c.req.param("topicId");
		const siteId = c.req.query("siteId");
		if (!siteId || !topicId) {
			return err(
				c,
				Object.assign(new Error("siteId and topicId are required"), { status: 400 }),
			);
		}
		const result = await removeTopic(siteId, topicId);
		return c.json({ success: true, ...result });
	} catch (e) {
		return err(c, e);
	}
});

contentIntelligenceRouter.post("/content/topics/:topicId/duplicate", async (c) => {
	try {
		const topicId = c.req.param("topicId");
		const siteId = c.req.query("siteId") || (await c.req.json().catch(() => ({}))).siteId;
		if (!siteId || !topicId) {
			return err(
				c,
				Object.assign(new Error("siteId and topicId are required"), { status: 400 }),
			);
		}
		const topic = await copyTopic(siteId, topicId);
		return c.json({ success: true, topic });
	} catch (e) {
		return err(c, e);
	}
});

contentIntelligenceRouter.get("/content/articles", async (c) => {
	try {
		const siteId = c.req.query("siteId");
		if (!siteId) {
			return err(c, Object.assign(new Error("siteId is required"), { status: 400 }));
		}
		const articles = await listArticles(siteId, Number(c.req.query("limit") || 100));
		return c.json({ success: true, siteId, count: articles.length, articles });
	} catch (e) {
		return err(c, e);
	}
});

contentIntelligenceRouter.patch("/content/articles/:articleId", async (c) => {
	try {
		const articleId = c.req.param("articleId");
		const body = await c.req.json().catch(() => ({}));
		const siteId = c.req.query("siteId") || body.siteId;
		if (!siteId || !articleId) {
			return err(
				c,
				Object.assign(new Error("siteId and articleId are required"), { status: 400 }),
			);
		}
		const article = await patchArticle(siteId, articleId, body);
		return c.json({ success: true, article });
	} catch (e) {
		return err(c, e);
	}
});

contentIntelligenceRouter.delete("/content/articles/:articleId", async (c) => {
	try {
		const articleId = c.req.param("articleId");
		const siteId = c.req.query("siteId");
		if (!siteId || !articleId) {
			return err(
				c,
				Object.assign(new Error("siteId and articleId are required"), { status: 400 }),
			);
		}
		const result = await removeArticle(siteId, articleId);
		return c.json({ success: true, ...result });
	} catch (e) {
		return err(c, e);
	}
});
