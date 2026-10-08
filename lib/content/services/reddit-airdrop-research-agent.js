/**
 * LLM query planning + topic discovery for Reddit → AirdropBounty content topics.
 */

import { openRouterChat } from "../../openrouter.js";
import {
	parseJsonFromLLM,
	stripLlmProviderNoise,
} from "../../geoPipeline/parseLlmJson.js";
import { resolveAgentLlmModel } from "../../useAi.js";
import { AIRDROPBOUNTY_BRAND } from "../config/airdropbounty.js";
import {
	redditQueryPlannerPrompt,
	redditTopicDiscoveryPrompt,
} from "../prompts/reddit-airdrop-research.js";
import { log, truncate, urlDomain } from "../utils.js";

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

function ensureRedditQuery(q) {
	const s = String(q || "").trim();
	if (!s) return "";
	return /site:\s*reddit\.com/i.test(s) ? s : `site:reddit.com ${s}`;
}

const FALLBACK_GOOGLE_QUERIES = [
	"site:reddit.com crypto airdrop eligibility how to claim",
	"site:reddit.com testnet airdrop guide 2026",
	"site:reddit.com airdrop scam warning red flags",
	"site:reddit.com free crypto airdrop legitimate",
	"site:reddit.com DeFi bounty campaign walkthrough",
	"site:reddit.com wallet setup airdrop farming",
	"site:reddit.com new airdrop projects discussion",
	"site:reddit.com airdrop hunter tips",
];

const FALLBACK_RSS_QUERIES = [
	"crypto airdrop eligibility",
	"testnet airdrop guide",
	"airdrop scam",
	"free crypto airdrop",
	"DeFi bounty",
	"airdrop farming wallet",
];

const FALLBACK_SUBREDDITS = [
	"CryptoAirdrops",
	"defi",
	"ethtrader",
	"solana",
	"airdropalert",
	"CryptoCurrency",
	"web3",
	"altcoin",
	"ethereum",
	"cosmosnetwork",
];

export async function planRedditAirdropQueries(site, existingTopics = [], opts = {}) {
	const existingTitles = (existingTopics || []).map((t) => t.title).filter(Boolean).slice(0, 40);

	try {
		const { content } = await openRouterChat({
			model: queryModel(),
			jsonMode: true,
			temperature: 0.2,
			maxTokens: 2000,
			messages: [
				{ role: "system", content: redditQueryPlannerPrompt() },
				{
					role: "user",
					content: JSON.stringify({
						site: {
							name: site.name || AIRDROPBOUNTY_BRAND.name,
							domain: site.domain || AIRDROPBOUNTY_BRAND.domain,
							description: site.description || AIRDROPBOUNTY_BRAND.tagline,
							audience: site.audience || AIRDROPBOUNTY_BRAND.audience,
							contentGoals: site.contentGoals || AIRDROPBOUNTY_BRAND.contentPillars,
						},
						brand: AIRDROPBOUNTY_BRAND,
						existingTopicTitles: existingTitles,
						limit: opts.queryLimit || 12,
					}),
				},
			],
		});

		const parsed = parseJsonFromLLM(stripLlmProviderNoise(content) || content);
		const googleQueries = [
			...new Set(
				(Array.isArray(parsed.googleQueries) ? parsed.googleQueries : [])
					.map(ensureRedditQuery)
					.filter(Boolean),
			),
		].slice(0, 12);

		const searchRssQueries = [
			...new Set(
				(Array.isArray(parsed.searchRssQueries) ? parsed.searchRssQueries : [])
					.map((q) => String(q || "").trim())
					.filter(Boolean),
			),
		].slice(0, 10);

		const seedSubreddits = [
			...new Set(
				(Array.isArray(parsed.seedSubreddits) ? parsed.seedSubreddits : [])
					.map((s) => String(s || "").replace(/^r\//i, "").toLowerCase())
					.filter((s) => /^[a-z0-9_]+$/.test(s)),
			),
		].slice(0, 15);

		if (googleQueries.length >= 5) {
			log("Reddit queries planned", `${googleQueries.length} Google + ${searchRssQueries.length} RSS`);
			return {
				googleQueries,
				searchRssQueries:
					searchRssQueries.length > 0 ? searchRssQueries : FALLBACK_RSS_QUERIES,
				seedSubreddits:
					seedSubreddits.length > 0 ? seedSubreddits : FALLBACK_SUBREDDITS,
				focusAreas: parsed.focusAreas || [],
			};
		}
	} catch (err) {
		console.warn("[reddit-airdrop] query planner failed:", err?.message || err);
	}

	log("Reddit queries planned", "using fallbacks");
	return {
		googleQueries: FALLBACK_GOOGLE_QUERIES,
		searchRssQueries: FALLBACK_RSS_QUERIES,
		seedSubreddits: FALLBACK_SUBREDDITS,
		focusAreas: [],
	};
}

export function redditPostsToSignals(posts) {
	const out = [];
	const seen = new Set();

	for (const post of posts || []) {
		const permalink = String(post.permalink || "").trim();
		const url = post.threadUrl || (permalink.startsWith("http") ? permalink : `https://www.reddit.com${permalink}`);
		if (!url || seen.has(url)) continue;
		seen.add(url);

		out.push({
			query: post.query || post.discoverySource || "reddit",
			title: String(post.title || "").trim(),
			url,
			snippet: truncate(String(post.body || post.snippet || ""), 400),
			content: truncate(String(post.body || ""), 2000),
			sourceType: "reddit",
			domain: "reddit.com",
			subreddit: post.subreddit || "",
			relevanceScore: post.relevanceScore ?? null,
			relevanceReason: post.relevanceReason || "",
		});
	}

	return out;
}

function compactSignals(signals, limit = 50) {
	return signals.slice(0, limit).map((s) => ({
		query: s.query,
		title: truncate(s.title, 140),
		url: s.url,
		snippet: truncate(s.snippet, 280),
		content: truncate(s.content, 600),
		sourceType: s.sourceType || "reddit",
		domain: s.domain || urlDomain(s.url),
		subreddit: s.subreddit || "",
	}));
}

export function fallbackTopicsFromSignals(signals, limit = 20) {
	return (signals || [])
		.filter((s) => s?.title && s?.url)
		.slice(0, limit)
		.map((s) => ({
			title: String(s.title).trim(),
			researchSummary: truncate(String(s.snippet || s.content || ""), 500),
			sourceUrls: [s.url],
			inspiredByReddit: s.url,
			hook: "faq",
			priority: "medium",
			angle: s.subreddit ? `Inspired by r/${s.subreddit}` : "Reddit discussion",
		}));
}

async function chatWithRetry(params, retries = 2) {
	let lastErr;
	for (let i = 0; i <= retries; i++) {
		try {
			return await openRouterChat(params);
		} catch (err) {
			lastErr = err;
			const msg = err?.message || String(err);
			if (i >= retries) break;
			const wait = 2000 * (i + 1);
			console.warn(`[reddit-airdrop] LLM retry ${i + 1}/${retries}: ${msg}`);
			await new Promise((r) => setTimeout(r, wait));
		}
	}
	throw lastErr;
}

export async function discoverRedditAirdropTopics(
	site,
	existingContent,
	existingTopics,
	signals,
	opts = {},
) {
	const limit = Math.min(30, Math.max(1, Number(opts.limit) || 20));

	const { content } = await chatWithRetry({
		model: researchModel(),
		jsonMode: true,
		temperature: 0.3,
		maxTokens: 8000,
		messages: [
			{ role: "system", content: redditTopicDiscoveryPrompt() },
			{
				role: "user",
				content: JSON.stringify({
					website: {
						name: site.name || AIRDROPBOUNTY_BRAND.name,
						domain: site.domain || AIRDROPBOUNTY_BRAND.domain,
						description: site.description,
						audience: site.audience || AIRDROPBOUNTY_BRAND.audience,
					},
					existingArticleTitles: (existingContent || []).map((p) => p.title).filter(Boolean),
					existingTopicTitles: (existingTopics || []).map((t) => t.title).filter(Boolean),
					redditSignals: compactSignals(signals, 55),
					targetCount: limit,
				}),
			},
		],
	});

	let parsed;
	try {
		parsed = parseJsonFromLLM(content);
	} catch (err) {
		log("Reddit topic discovery retry", "repairing JSON");
		const { content: repair } = await chatWithRetry({
			model: researchModel(),
			jsonMode: true,
			temperature: 0,
			maxTokens: 8000,
			messages: [
				{
					role: "system",
					content: 'Fix JSON. Return ONLY { "topics": [...] }',
				},
				{ role: "user", content: String(content || "") },
			],
		});
		parsed = parseJsonFromLLM(repair);
	}

	const topics = (Array.isArray(parsed?.topics) ? parsed.topics : [])
		.map((item) => (typeof item === "string" ? { title: item.trim() } : item))
		.filter((item) => item && String(item.title || item.topic || "").trim());

	log("Reddit topic discovery", `${topics.length} raw topics`);
	return topics.slice(0, limit);
}
