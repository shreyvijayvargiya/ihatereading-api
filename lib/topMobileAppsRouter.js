/**
 * Top Mobile Apps — App Store + Google Play only.
 *
 * GET  /top-mobile-apps
 * POST /top-mobile-apps/run
 * GET  /top-mobile-apps/list
 * GET  /top-mobile-apps/sources
 */

import { Hono } from "hono";
import {
	MOBILE_CATEGORIES,
	TOP_MOBILE_APPS_AGENT,
	ALL_SOURCES,
} from "./topApps/configs.js";
import {
	countApps,
	listApps,
	runTopMobileAppsAgent,
} from "./topApps/orchestrator.js";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";
import { hasOpenRouterKey, wantUseAiFromRequest } from "./useAi.js";

export const topMobileAppsRouter = new Hono();
/** @deprecated */
export const topAppsRouter = topMobileAppsRouter;

async function handleRun(c) {
	let body = {};
	try {
		body = await c.req.json().catch(() => ({}));
	} catch {
		body = {};
	}

	const category = body.category || c.req.query("category") || undefined;
	const platform = body.platform || c.req.query("platform") || undefined;
	const sourcesPerRun = body.sourcesPerRun
		? Number(body.sourcesPerRun)
		: c.req.query("sourcesPerRun")
			? Number(c.req.query("sourcesPerRun"))
			: undefined;

	try {
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
		const summary = await runTopMobileAppsAgent({
			baseUrl: resolveResearchBaseUrl(c),
			category,
			platform,
			sourcesPerRun,
			enrich: body.enrich !== false,
			useAI,
		});
		return c.json({ success: true, ...summary, timestamp: new Date().toISOString() });
	} catch (err) {
		console.error("[top-mobile-apps] run failed:", err);
		return c.json(
			{ success: false, error: { code: "RUN_FAILED", message: err?.message || String(err) } },
			500,
		);
	}
}

function mountRoutes(router) {
	router.get("/top-mobile-apps", async (c) => {
		let count = 0;
		try {
			count = await countApps(TOP_MOBILE_APPS_AGENT.collection);
		} catch {
			/* ignore */
		}
		return c.json({
			success: true,
			agent: {
				id: TOP_MOBILE_APPS_AGENT.id,
				name: TOP_MOBILE_APPS_AGENT.name,
				collection: TOP_MOBILE_APPS_AGENT.collection,
				targetCount: TOP_MOBILE_APPS_AGENT.targetCount,
				currentCount: count,
				categories: MOBILE_CATEGORIES.length,
				sourceCount: ALL_SOURCES.length,
				cli: "npm run top:mobile-apps",
				run: "POST /top-mobile-apps/run",
			},
			note: "Mobile apps only — HTTP + iTunes RSS discovery, listing scrape for screenshots, Google for founders/socials. Stores every listing found. Cap 10k.",
		});
	});

	router.post("/top-mobile-apps/run", handleRun);
	router.get("/top-mobile-apps/run", handleRun);

	router.get("/top-mobile-apps/list", async (c) => {
		const min = Number(c.req.query("minScore") || 0);
		const limit = Math.min(500, Number(c.req.query("limit") || 100));
		const category = c.req.query("category") || undefined;
		const platform = c.req.query("platform") || undefined;

		try {
			let apps = await listApps(TOP_MOBILE_APPS_AGENT.collection, {
				minScore: min,
				category,
				limit: limit * 2,
			});
			if (platform) {
				const p = String(platform).toLowerCase();
				apps = apps.filter(
					(a) =>
						String(a.platform || "").toLowerCase() === p ||
						(p === "ios" && a.appStoreUrl) ||
						(p === "android" && a.playStoreUrl),
				);
			}
			const total = await countApps(TOP_MOBILE_APPS_AGENT.collection);
			return c.json({
				success: true,
				collection: TOP_MOBILE_APPS_AGENT.collection,
				total,
				count: apps.slice(0, limit).length,
				apps: apps.slice(0, limit),
			});
		} catch (err) {
			return c.json(
				{ success: false, error: { code: "LIST_FAILED", message: err?.message || String(err) } },
				500,
			);
		}
	});

	router.get("/top-mobile-apps/sources", (c) => {
		const category = c.req.query("category");
		const platform = c.req.query("platform");
		let sources = ALL_SOURCES;
		if (category) {
			const cl = String(category).toLowerCase();
			sources = sources.filter((s) =>
				String(s.category || "").toLowerCase().includes(cl),
			);
		}
		if (platform === "ios") sources = sources.filter((s) => s.platform === "ios");
		if (platform === "android") sources = sources.filter((s) => s.platform === "android");
		return c.json({
			success: true,
			categories: MOBILE_CATEGORIES,
			count: sources.length,
			sources: sources.map((s) => ({
				id: s.id,
				store: s.store,
				platform: s.platform,
				category: s.category,
				label: s.label,
				scrapeUrls: s.scrapeUrls,
				itunesRssUrls: s.itunesRssUrls || [],
				googleQueries: s.googleQueries || [],
			})),
		});
	});
}

mountRoutes(topMobileAppsRouter);
