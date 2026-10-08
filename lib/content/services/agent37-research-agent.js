/**
 * LLM query planning + topic discovery for Agent37 multi-source research.
 */

import { openRouterChat } from "../../openrouter.js";
import {
	parseJsonFromLLM,
	stripLlmProviderNoise,
} from "../../geoPipeline/parseLlmJson.js";
import { AGENT37_BRAND } from "../config/agent37.js";
import {
	agent37QueryPlannerPrompt,
	agent37TopicDiscoveryPrompt,
} from "../prompts/agent37-research.js";
import { log, truncate } from "../utils.js";

function researchModel() {
	return (
		process.env.CONTENT_INTEL_RESEARCH_MODEL?.trim() ||
		process.env.CONTENT_INTEL_MODEL?.trim() ||
		"google/gemini-2.5-flash-lite"
	);
}

function queryModel() {
	return (
		process.env.CONTENT_INTEL_QUERY_MODEL?.trim() ||
		"google/gemini-2.5-flash-lite"
	);
}

const FALLBACK_PLAN = {
	redditQueries: [
		"site:reddit.com AI agents framework comparison",
		"site:reddit.com MCP model context protocol",
		"site:reddit.com autonomous AI agent production",
		"site:reddit.com LangGraph CrewAI AutoGPT",
		"site:reddit.com LLM tool calling reliability",
		"site:reddit.com multi agent orchestration",
	],
	linkedinQueries: [
		'site:linkedin.com/posts "AI agents" production',
		"site:linkedin.com/pulse AI agent architecture",
		'site:linkedin.com/in founder "AI automation"',
		"site:linkedin.com/posts MCP tools LLM",
	],
	xQueries: [
		"site:x.com AI agents shipping",
		"site:x.com MCP server LLM",
		"site:twitter.com autonomous agents dev",
		"site:x.com agent framework opinion",
	],
	webQueries: [
		"AI agent orchestration patterns 2026",
		"MCP model context protocol tutorial",
		"multi-agent LLM architecture best practices",
		"AI agent observability tracing",
		"compare LangGraph vs CrewAI",
		"agent37.com",
	],
	redditSearchRss: [
		"AI agents framework",
		"MCP protocol LLM",
		"autonomous agents",
		"multi agent system",
	],
	seedSubreddits: [
		"LocalLLaMA",
		"MachineLearning",
		"artificial",
		"LangChain",
		"OpenAI",
		"programming",
		"devops",
		"selfhosted",
	],
	focusAreas: [],
};

export async function planAgent37Queries(site, existingTopics = [], opts = {}) {
	const existingTitles = (existingTopics || []).map((t) => t.title).filter(Boolean).slice(0, 40);

	try {
		const { content } = await openRouterChat({
			model: queryModel(),
			jsonMode: true,
			temperature: 0.2,
			maxTokens: 2200,
			messages: [
				{ role: "system", content: agent37QueryPlannerPrompt() },
				{
					role: "user",
					content: JSON.stringify({
						site: {
							name: site.name || AGENT37_BRAND.name,
							domain: site.domain || AGENT37_BRAND.domain,
							description: site.description || AGENT37_BRAND.tagline,
							audience: site.audience || AGENT37_BRAND.audience,
							contentGoals: site.contentGoals || AGENT37_BRAND.contentPillars,
						},
						brand: AGENT37_BRAND,
						existingTopicTitles: existingTitles,
					}),
				},
			],
		});

		const parsed = parseJsonFromLLM(stripLlmProviderNoise(content) || content);
		const plan = {
			redditQueries: (parsed.redditQueries || []).slice(0, 10),
			linkedinQueries: (parsed.linkedinQueries || []).slice(0, 8),
			xQueries: (parsed.xQueries || []).slice(0, 8),
			webQueries: (parsed.webQueries || []).slice(0, 10),
			redditSearchRss: (parsed.redditSearchRss || []).slice(0, 6),
			seedSubreddits: (parsed.seedSubreddits || []).slice(0, 12),
			focusAreas: parsed.focusAreas || [],
		};

		if (plan.redditQueries.length >= 4 && plan.webQueries.length >= 4) {
			log("Agent37 queries planned", "LLM");
			return plan;
		}
	} catch (err) {
		console.warn("[agent37] query planner failed:", err?.message || err);
	}

	log("Agent37 queries planned", "fallback");
	return { ...FALLBACK_PLAN };
}

function compactSignals(signals, limit = 60) {
	return signals.slice(0, limit).map((s) => ({
		query: s.query,
		title: truncate(s.title, 140),
		url: s.url,
		snippet: truncate(s.snippet, 280),
		content: truncate(s.content, 500),
		sourceType: s.sourceType || "web",
		domain: s.domain || "",
	}));
}

export async function discoverAgent37Topics(
	site,
	existingContent,
	existingTopics,
	signals,
	opts = {},
) {
	const limit = Math.min(30, Math.max(1, Number(opts.limit) || 20));

	const { content } = await openRouterChat({
		model: researchModel(),
		jsonMode: true,
		temperature: 0.3,
		maxTokens: 8000,
		messages: [
			{ role: "system", content: agent37TopicDiscoveryPrompt() },
			{
				role: "user",
				content: JSON.stringify({
					website: {
						name: site.name || AGENT37_BRAND.name,
						domain: site.domain || AGENT37_BRAND.domain,
						description: site.description,
						audience: site.audience || AGENT37_BRAND.audience,
					},
					existingArticleTitles: (existingContent || []).map((p) => p.title).filter(Boolean),
					existingTopicTitles: (existingTopics || []).map((t) => t.title).filter(Boolean),
					researchSignals: compactSignals(signals, 65),
					targetCount: limit,
				}),
			},
		],
	});

	let parsed;
	try {
		parsed = parseJsonFromLLM(content);
	} catch {
		const { content: repair } = await openRouterChat({
			model: researchModel(),
			jsonMode: true,
			temperature: 0,
			maxTokens: 8000,
			messages: [
				{ role: "system", content: 'Fix JSON. Return ONLY { "topics": [...] }' },
				{ role: "user", content: String(content || "") },
			],
		});
		parsed = parseJsonFromLLM(repair);
	}

	const topics = (Array.isArray(parsed?.topics) ? parsed.topics : [])
		.map((item) => (typeof item === "string" ? { title: item.trim() } : item))
		.filter((item) => item && String(item.title || "").trim());

	log("Agent37 topic discovery", `${topics.length} raw`);
	return topics.slice(0, limit);
}
