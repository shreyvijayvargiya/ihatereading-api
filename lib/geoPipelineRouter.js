/**
 * SEO/GEO research pipeline routes.
 *
 * POST   /sites                    { url, userId? }     → siteProfile + first run
 * POST   /sites/:id/runs           { triggerType? }     → manual run
 * GET    /runs/:id                                      → status + stage
 * GET    /runs/:id/ideas                                → blogIdeas for run
 * GET    /sites/:id/ideas?status=new                    → backlog across runs
 * PATCH  /ideas/:id                { status }           → update idea status
 */

import { Hono } from "hono";
import { resolveScrapeBaseUrl } from "./scrapefast.js";
import {
	col,
	getRun,
	getSiteProfile,
	queryBlogIdeasByRun,
	queryBlogIdeasBySite,
} from "./geoPipeline/collections.js";
import {
	createSiteProfile,
	createResearchRun,
	scheduleResearchRun,
} from "./jobs/runPipeline.js";

export const geoPipelineRouter = new Hono();

function assertUrl(raw) {
	let u;
	try {
		u = new URL(raw);
	} catch {
		throw new Error("Invalid url");
	}
	if (!["http:", "https:"].includes(u.protocol)) {
		throw new Error("Only http(s) URLs allowed");
	}
	return u.toString();
}

geoPipelineRouter.post("/sites", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const url = assertUrl(body.url);
		const userId = body.userId || c.req.header("x-user-id") || "anonymous";
		const niche = body.niche?.trim() || null;
		const description = body.description?.trim() || null;

		const siteProfileId = await createSiteProfile({
			userId,
			url,
			niche,
			description,
		});
		const runId = await createResearchRun({
			siteProfileId,
			triggerType: "manual",
		});

		scheduleResearchRun(runId, {
			scrapeOptions: {
				baseUrl: resolveScrapeBaseUrl(c),
				c,
				niche,
				description,
				serpGeo: body.serpGeo || { language: "en", country: "in" },
			},
		});

		return c.json(
			{
				success: true,
				siteProfileId,
				runId,
				status: "queued",
				message: "Research run started. Poll GET /runs/:id for progress.",
			},
			202,
		);
	} catch (err) {
		return c.json({ success: false, error: err.message }, 400);
	}
});

geoPipelineRouter.post("/sites/:id/runs", async (c) => {
	try {
		const siteProfileId = c.req.param("id");
		const site = await getSiteProfile(siteProfileId);
		if (!site) return c.json({ success: false, error: "Site not found" }, 404);

		const body = await c.req.json().catch(() => ({}));
		const triggerType = body.triggerType === "scheduled" ? "scheduled" : "manual";
		const runId = await createResearchRun({ siteProfileId, triggerType });

		scheduleResearchRun(runId, {
			scrapeOptions: {
				baseUrl: resolveScrapeBaseUrl(c),
				c,
				niche: site.niche,
				description: site.description,
				serpGeo: body.serpGeo || { language: "en", country: "in" },
			},
		});

		return c.json({ success: true, runId, siteProfileId, status: "queued" }, 202);
	} catch (err) {
		return c.json({ success: false, error: err.message }, 400);
	}
});

geoPipelineRouter.get("/runs/:id", async (c) => {
	const runId = c.req.param("id");
	const run = await getRun(runId);
	if (!run) return c.json({ success: false, error: "Run not found" }, 404);
	return c.json({ success: true, run });
});

geoPipelineRouter.get("/runs/:id/ideas", async (c) => {
	try {
		const runId = c.req.param("id");
		const run = await getRun(runId);
		if (!run) return c.json({ success: false, error: "Run not found" }, 404);

		const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
		const ideas = await queryBlogIdeasByRun(runId, { limit });
		return c.json({ success: true, runId, count: ideas.length, ideas });
	} catch (err) {
		console.error("[geo] GET /runs/:id/ideas:", err);
		return c.json({ success: false, error: err.message }, 500);
	}
});

geoPipelineRouter.get("/sites/:id/ideas", async (c) => {
	try {
		const siteProfileId = c.req.param("id");
		const site = await getSiteProfile(siteProfileId);
		if (!site) return c.json({ success: false, error: "Site not found" }, 404);

		const status = c.req.query("status") || "new";
		const limit = Math.min(Number(c.req.query("limit")) || 100, 300);
		const ideas = await queryBlogIdeasBySite(siteProfileId, { status, limit });
		return c.json({ success: true, siteProfileId, status, count: ideas.length, ideas });
	} catch (err) {
		console.error("[geo] GET /sites/:id/ideas:", err);
		return c.json({ success: false, error: err.message }, 500);
	}
});

geoPipelineRouter.patch("/ideas/:id", async (c) => {
	try {
		const ideaId = c.req.param("id");
		const body = await c.req.json();
		const allowed = ["new", "shortlisted", "written", "published", "dismissed"];
		if (!allowed.includes(body.status)) {
			return c.json(
				{ success: false, error: `status must be one of: ${allowed.join(", ")}` },
				400,
			);
		}
		const ref = col("blogIdeas").doc(ideaId);
		const snap = await ref.get();
		if (!snap.exists) {
			return c.json({ success: false, error: "Idea not found" }, 404);
		}
		await ref.set({ status: body.status }, { merge: true });
		return c.json({ success: true, id: ideaId, status: body.status });
	} catch (err) {
		return c.json({ success: false, error: err.message }, 400);
	}
});
