/**
 * Content research as a graph. Same input and same result shape as
 * runContentResearch(), but each step is a named node, so we can run the three
 * independent lookups in parallel by design, branch on empty/failed research,
 * and report per-step timings.
 *
 *   loadSite → keywords → ┬ reddit ───┐
 *                         ├ internal ─┼→ clean → validate ─┬→ finish (error)
 *                         └ external ─┘                    └→ plan ─┬→ finish (error)
 *                                                                  └→ save → finish
 */

import { randomUUID } from "node:crypto";
import { runGraph, parallel } from "../graph/runGraph.js";
import {
	cleanKeyword,
	cleanReddit,
	cleanInternal,
	cleanExternal,
	siteContextSummary,
	hasAnyResearch,
} from "./researchShapes.js";

const RUNS_COLL = "content_research_runs";
const CALENDAR_COLL = "content_calendar";

const uniqueWarnings = (list) => [...new Set((list || []).filter(Boolean))];
const msg = (err) => err?.message || String(err);

/**
 * Real implementations, imported lazily: some of these modules import Firebase,
 * which we don't want to load when a caller (e.g. a test) injects its own deps.
 */
async function defaultDeps() {
	const [site, kw, reddit, internal, external, planner, run] = await Promise.all([
		import("./siteContext.js"),
		import("./keywordResearch.js"),
		import("./redditResearch.js"),
		import("./internalResearch.js"),
		import("./externalResearch.js"),
		import("./contentPlanner.js"),
		import("./runContentResearch.js"),
	]);
	return {
		loadSiteContext: site.loadSiteContext,
		researchKeywords: kw.researchKeywords,
		researchReddit: reddit.researchReddit,
		searchInternalArticles: internal.searchInternalArticles,
		researchExternalReferences: external.researchExternalReferences,
		generateContentIdeas: planner.generateContentIdeas,
		saveRun: run.saveRun,
		saveCalendarIdeas: run.saveCalendarIdeas,
	};
}

/**
 * Wrap a node so a thrown error becomes a warning instead of stopping the run.
 * This mirrors the original try/catch blocks: one failed provider must not
 * kill the whole research run.
 */
const guarded = (label, fn) => async (state) => {
	try {
		return await fn(state);
	} catch (err) {
		return { warnings: [`${label} failed: ${msg(err)}`] };
	}
};

function buildNodes(deps) {
	return {
		loadSite: guarded("Site context", async (s) => {
			const site = await deps.loadSiteContext({ baseUrl: s.baseUrl });
			return { siteContext: site.siteContext, warnings: site.warnings || [] };
		}),

		keywords: guarded("Keyword research", async (s) => {
			const r = await deps.researchKeywords(s.topic, {
				language: s.language,
				region: s.region,
				baseUrl: s.baseUrl,
				siteContext: s.siteContext,
			});
			return { keywords: r.keywords || [], warnings: r.warnings || [] };
		}),

		// These three only need topic + keywords, not each other, so they run in parallel.
		reddit: guarded("Reddit research", async (s) => {
			const r = await deps.researchReddit(s.topic, s.keywords, { baseUrl: s.baseUrl });
			return { reddit: r.reddit || [], warnings: r.warnings || [] };
		}),
		internal: guarded("Internal research", async (s) => {
			const r = await deps.searchInternalArticles(s.topic, s.keywords, { baseUrl: s.baseUrl });
			return { internalArticles: r.internalArticles || [], warnings: r.warnings || [] };
		}),
		external: guarded("External reference research", async (s) => {
			const r = await deps.researchExternalReferences(s.topic, s.keywords, {
				baseUrl: s.baseUrl,
				language: s.language,
			});
			return { externalReferences: r.externalReferences || [], warnings: r.warnings || [] };
		}),

		// Always expose Firestore-safe shapes in API + storage.
		clean: async (s) => ({
			keywords: s.keywords.map(cleanKeyword).filter(Boolean),
			reddit: s.reddit.map(cleanReddit).filter(Boolean),
			internalArticles: s.internalArticles.map(cleanInternal).filter(Boolean),
			externalReferences: s.externalReferences.map(cleanExternal).filter(Boolean),
		}),

		// Decide whether it makes sense to call the LLM at all. Sets `error` to stop the run.
		validate: async (s) => {
			if (!hasAnyResearch(s.keywords, s.reddit, s.internalArticles, s.externalReferences)) {
				return {
					error: {
						code: "RESEARCH_EMPTY",
						message: "All research providers failed or returned no data. Cannot generate content ideas.",
					},
				};
			}
			if (!process.env.OPENROUTER_API_KEY?.trim()) {
				return {
					error: { code: "MISSING_OPENROUTER_KEY", message: "OPENROUTER_API_KEY is not configured" },
					includeResearch: true,
				};
			}
			return {};
		},

		plan: async (s) => {
			try {
				const g = await deps.generateContentIdeas({
					topic: s.topic,
					count: s.count,
					keywords: s.keywords,
					reddit: s.reddit,
					internalArticles: s.internalArticles,
					externalReferences: s.externalReferences,
				});
				return { contentIdeas: g.contentIdeas, usage: g.usage, model: g.model };
			} catch (err) {
				return {
					error: { code: "LLM_FAILED", message: msg(err) || "Content idea generation failed" },
					includeResearch: true,
				};
			}
		},

		// A save failure is only a warning: the user still gets their ideas back.
		save: async (s) => {
			const runId = randomUUID();
			try {
				await deps.saveRun({
					id: runId,
					topic: s.topic,
					count: s.count,
					region: s.region,
					language: s.language,
					keywords: s.keywords,
					reddit: s.reddit,
					internalArticles: s.internalArticles,
					externalReferences: s.externalReferences,
					contentIdeas: s.contentIdeas,
					warnings: uniqueWarnings(s.warnings),
					generatedAt: s.generatedAt,
					model: s.model,
					siteContext: s.siteContext,
				});
				await deps.saveCalendarIdeas(runId, s.topic, s.contentIdeas);
				console.log(`[content-research] saved run ${runId} → ${RUNS_COLL} + ${CALENDAR_COLL}`);
			} catch (err) {
				console.error("[content-research] Firestore save failed:", err);
				return { runId, warnings: [`Firestore save failed: ${msg(err)}`] };
			}
			return { runId };
		},

		// Terminal node: turns final state into the API response (success or error).
		finish: async (s) => {
			const warnings = uniqueWarnings(s.warnings);
			const research = {
				keywords: s.keywords,
				reddit: s.reddit,
				internal_articles: s.internalArticles,
				external_references: s.externalReferences,
			};
			if (s.error) {
				return {
					result: {
						success: false,
						error: s.error,
						warnings,
						topic: s.topic,
						...(s.includeResearch ? { research } : {}),
					},
				};
			}
			return {
				result: {
					success: true,
					topic: s.topic,
					runId: s.runId,
					research: { ...research, site_context: siteContextSummary(s.siteContext) },
					content_ideas: s.contentIdeas,
					warnings,
					meta: {
						keyword_count: s.keywords.length,
						reddit_result_count: s.reddit.length,
						internal_article_count: s.internalArticles.length,
						external_reference_count: s.externalReferences.length,
						generated_at: s.generatedAt,
						model: s.model,
						region: s.region,
						language: s.language,
					},
					...(s.usage ? { usage: s.usage } : {}),
				},
			};
		},
	};
}

// Edges: the "arrows". A function edge chooses the next node from the state.
const edges = {
	loadSite: "keywords",
	keywords: parallel(["reddit", "internal", "external"], "clean"),
	clean: "validate",
	validate: (s) => (s.error ? "finish" : "plan"),
	plan: (s) => (s.error ? "finish" : "save"),
	save: "finish",
	finish: null,
};

// Several nodes add warnings, so merge by appending instead of overwriting.
const reducers = { warnings: (old = [], added = []) => [...old, ...added] };

/**
 * @param {{ topic: string, count?: number, region?: string, language?: string, baseUrl?: string }} input
 * @param {{ deps?: object, onStep?: Function }} [options]  deps: inject fakes for tests
 */
export async function runContentResearchGraph(input, { deps, onStep } = {}) {
	const { state, trace } = await runGraph({
		nodes: buildNodes(deps || (await defaultDeps())),
		edges,
		reducers,
		start: "loadSite",
		onStep,
		state: {
			topic: String(input.topic || "").trim(),
			count: input.count ?? 10,
			region: input.region || "global",
			language: input.language || "en",
			baseUrl: input.baseUrl || undefined,
			generatedAt: new Date().toISOString(),
			warnings: [],
			siteContext: null,
			keywords: [],
			reddit: [],
			internalArticles: [],
			externalReferences: [],
			contentIdeas: [],
		},
	});

	const result = state.result;
	if (result.success) result.meta.trace = trace; // which steps ran, and how long each took
	return result;
}
