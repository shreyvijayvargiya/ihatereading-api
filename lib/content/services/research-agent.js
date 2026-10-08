/**
 * OpenRouter research agent — query planning + topic discovery.
 */

import { openRouterChat } from "../../openrouter.js";
import {
	parseJsonFromLLM,
	stripLlmProviderNoise,
} from "../../geoPipeline/parseLlmJson.js";
import { resolveAgentLlmModel } from "../../useAi.js";
import {
	queryPlannerSystemPrompt,
	researchAgentSystemPrompt,
} from "../prompts/research.js";
import { log, truncate, urlDomain } from "../utils.js";

function researchModel() {
	return (
		process.env.CONTENT_INTEL_RESEARCH_MODEL?.trim() ||
		process.env.CONTENT_INTEL_MODEL?.trim() ||
		"google/gemini-2.5-flash-lite"
	);
}

/** Query planner uses a JSON-reliable model (openrouter/free often returns safety prose). */
function queryPlannerModel() {
	return (
		process.env.CONTENT_INTEL_QUERY_MODEL?.trim() ||
		"google/gemini-2.5-flash-lite"
	);
}

function normalizeQueries(raw) {
	return [...new Set((raw || []).map((q) => String(q).trim()).filter(Boolean))];
}

export function buildFallbackQueries(site) {
	const brand = String(site.name || "").trim() || urlDomain(site.domain) || "site";
	const audience = String(site.audience || "users").trim();
	const desc = String(site.description || "").trim();
	const topicHint = desc.split(/[.!?]/)[0]?.slice(0, 60) || brand;

	return normalizeQueries([
		`${brand} FAQ`,
		`${brand} how to`,
		`${topicHint} explained`,
		`${brand} vs alternatives`,
		`alternative to ${brand}`,
		`${audience} ${topicHint} problems`,
		`${topicHint} glossary terms`,
		`${topicHint} beginner guide`,
		`${brand} reddit questions`,
		`${topicHint} comparison`,
		`${topicHint} news 2026`,
		...(site.competitors || []).slice(0, 3).map((c) => `${c} vs ${brand}`),
		...(site.contentGoals || []).slice(0, 2).map((g) => `${brand} ${g}`),
	]);
}

function parseQueriesFromLlm(content) {
	const cleaned = stripLlmProviderNoise(content);
	if (!cleaned) return [];

	try {
		const parsed = parseJsonFromLLM(cleaned);
		const queries = normalizeQueries(parsed.queries);
		if (queries.length) return queries;
	} catch {
		/* try line salvage below */
	}

	// Bullets / numbered list fallback
	const lines = cleaned
		.split("\n")
		.map((line) =>
			line
				.replace(/^[\s\-*•\d.)]+/, "")
				.replace(/^["']|["']$/g, "")
				.trim(),
		)
		.filter((q) => q.length > 8 && q.length < 140 && !/^user safety/i.test(q));

	if (lines.length >= 5) return normalizeQueries(lines).slice(0, 18);
	return [];
}

async function requestQueryPlan(site, existingContent) {
	const coverage = (existingContent || [])
		.slice(0, 25)
		.map((p) => ({ title: p.title, url: p.url }));

	return openRouterChat({
		model: queryPlannerModel(),
		jsonMode: true,
		temperature: 0.15,
		maxTokens: 1400,
		messages: [
			{ role: "system", content: queryPlannerSystemPrompt() },
			{
				role: "user",
				content: JSON.stringify({
					site: {
						name: site.name,
						domain: site.domain,
						description: site.description,
						audience: site.audience,
						competitors: site.competitors || [],
						contentGoals: site.contentGoals || [],
					},
					existingCoverage: coverage,
				}),
			},
		],
	});
}

export async function planSearchQueries(site, existingContent, opts = {}) {
	const fallback = buildFallbackQueries(site);

	try {
		const { content } = await requestQueryPlan(site, existingContent);
		let queries = parseQueriesFromLlm(content);

		if (!queries.length) {
			log("Query planner retry", "repairing JSON");
			const { content: repair } = await openRouterChat({
				model: queryPlannerModel(),
				jsonMode: true,
				temperature: 0,
				maxTokens: 1400,
				messages: [
					{
						role: "system",
						content:
							'Return ONLY valid JSON: { "queries": ["search query 1", "..."] } with 10-18 strings. No prose.',
					},
					{ role: "user", content: stripLlmProviderNoise(content) },
				],
			});
			queries = parseQueriesFromLlm(repair);
		}

		if (queries.length) {
			// Top up with fallback if model returned too few
			const merged = normalizeQueries([...queries, ...fallback]).slice(0, 18);
			log("Research queries planned", `${merged.length} (${queries.length} from LLM)`);
			return merged;
		}
	} catch (err) {
		console.warn("[CONTENT] query planner failed:", err?.message || err);
	}

	log("Research queries planned", `${fallback.length} (rule-based fallback)`);
	return fallback.slice(0, 18);
}

function compactSignals(signals, limit = 40) {
	return signals.slice(0, limit).map((s) => ({
		query: s.query,
		title: truncate(s.title, 120),
		url: s.url,
		snippet: truncate(s.snippet, 200),
		content: truncate(s.content, 500),
		sourceType: s.sourceType || "google",
		domain: s.domain || urlDomain(s.url),
	}));
}

export async function discoverTopics(site, existingContent, existingTopics, signals, opts = {}) {
	const limit = Math.min(30, Math.max(1, opts.limit || 30));

	const { content } = await openRouterChat({
		model: researchModel(),
		jsonMode: true,
		temperature: 0.25,
		maxTokens: 8000,
		messages: [
			{ role: "system", content: researchAgentSystemPrompt() },
			{
				role: "user",
				content: JSON.stringify({
					website: {
						name: site.name,
						domain: site.domain,
						description: site.description,
						audience: site.audience,
						competitors: site.competitors || [],
						contentGoals: site.contentGoals || [],
					},
					existingArticleTitles: (existingContent || []).map((p) => p.title).filter(Boolean),
					existingArticleUrls: (existingContent || []).map((p) => p.url).filter(Boolean),
					existingTopicTitles: (existingTopics || []).map((t) => t.title).filter(Boolean),
					researchSignals: compactSignals(signals),
					targetCount: limit,
				}),
			},
		],
	});

	let parsed;
	try {
		parsed = parseJsonFromLLM(content);
	} catch (err) {
		log("Research agent retry", "repairing JSON");
		const { content: repair } = await openRouterChat({
			model: researchModel(),
			jsonMode: true,
			temperature: 0,
			maxTokens: 8000,
			messages: [
				{
					role: "system",
					content:
						"Fix the JSON below. Return ONLY valid JSON with the same structure: { topics: [...] }",
				},
				{ role: "user", content: String(content || "") },
			],
		});
		parsed = parseJsonFromLLM(repair);
	}

	const topics = (Array.isArray(parsed?.topics) ? parsed.topics : [])
		.map((item) => {
			if (typeof item === "string") return { title: item.trim() };
			return item;
		})
		.filter((item) => item && (item.title || item.topic || item.headline));

	const withTitle = topics.filter((t) =>
		String(t.title || t.topic || t.headline || "").trim(),
	);
	if (topics.length && !withTitle.length) {
		console.warn(
			"[CONTENT] research topics parsed but none had title/topic/headline fields",
		);
	}
	log("Research agent running", `raw ${withTitle.length} topics`);
	return withTitle.slice(0, limit);
}

export function normalizeSignals(searchResults, scrapedPages) {
	const byUrl = new Map();

	for (const row of searchResults) {
		const url = row.url;
		if (!url) continue;
		byUrl.set(url, {
			query: row.query || "",
			title: row.title || "",
			url,
			snippet: row.snippet || "",
			content: "",
			sourceType: row.sourceType || "google",
			domain: urlDomain(url),
		});
	}

	for (const page of scrapedPages) {
		if (!page.url) continue;
		const prev = byUrl.get(page.url) || {
			query: "",
			title: page.title || "",
			url: page.url,
			snippet: "",
			content: "",
			sourceType: "scrape",
			domain: urlDomain(page.url),
		};
		byUrl.set(page.url, {
			...prev,
			title: page.title || prev.title,
			content: page.text || prev.content,
			snippet: page.description || prev.snippet,
		});
	}

	return [...byUrl.values()].filter((s) => s.title || s.snippet || s.content);
}
