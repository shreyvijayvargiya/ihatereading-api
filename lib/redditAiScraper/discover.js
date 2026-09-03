/**
 * Layers 1–2: LLM understands the prompt, Google finds Reddit URLs,
 * LLM finalizes 10–20 subreddits.
 */

import { googleSearch } from "../contentResearch/http.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import { DEFAULT_MODEL, normalizeSub } from "../redditAgents/core.js";
import { REDDIT_AI_SCRAPER, sanitizeTopicId } from "./configs.js";

function llmJson(content, fallback) {
	try {
		const raw = parseJsonFromLLM(content);
		return raw && typeof raw === "object" ? raw : fallback;
	} catch {
		return fallback;
	}
}

/**
 * Layer 1 — turn a free-text prompt into queries + seed subs + scoring criteria.
 */
export async function planFromPrompt(prompt) {
	const { content } = await openRouterChat({
		model: DEFAULT_MODEL,
		jsonMode: true,
		temperature: 0.2,
		maxTokens: 1800,
		messages: [
			{
				role: "system",
				content: `You plan a Reddit research crawl. The user will reuse this for many topics — do not assume one niche.

Return ONLY JSON:
{
  "topicId": "kebab-case-id",
  "topicName": "short name",
  "goal": "one sentence",
  "googleQueries": ["5 to 8 Google queries, each should find Reddit threads. Prefer site:reddit.com ..."],
  "seedSubreddits": ["8 to 12 likely subreddit names without r/"],
  "keepCriteria": "what posts to keep",
  "rejectCriteria": "what to reject"
}`,
			},
			{ role: "user", content: String(prompt).trim() },
		],
	});

	const raw = llmJson(content, {});
	const googleQueries = (Array.isArray(raw.googleQueries) ? raw.googleQueries : [])
		.map((q) => String(q || "").trim())
		.filter(Boolean)
		.slice(0, 8)
		.map((q) => (/site:\s*reddit\.com/i.test(q) ? q : `site:reddit.com ${q}`));
	const seedSubreddits = [
		...new Set(
			(Array.isArray(raw.seedSubreddits) ? raw.seedSubreddits : [])
				.map(normalizeSub)
				.filter((s) => s && /^[a-z0-9_]+$/.test(s)),
		),
	].slice(0, 12);

	return {
		topicId: sanitizeTopicId(raw.topicId || raw.topicName || "topic"),
		topicName: String(raw.topicName || raw.topicId || "Topic").slice(0, 120),
		goal: String(raw.goal || prompt).slice(0, 400),
		googleQueries:
			googleQueries.length > 0
				? googleQueries
				: [`site:reddit.com ${String(prompt).slice(0, 80)}`],
		seedSubreddits,
		keepCriteria: String(raw.keepCriteria || "").slice(0, 600),
		rejectCriteria: String(raw.rejectCriteria || "").slice(0, 600),
	};
}

/** Scrape-only first run: Google `site:reddit.com {prompt}` — no OpenRouter. */
export function scrapeOnlyPlanFromPrompt(prompt) {
	const p = String(prompt || "").trim();
	const q = p.slice(0, 80);
	return {
		topicId: sanitizeTopicId(p),
		topicName: p.slice(0, 120) || "Topic",
		goal: p.slice(0, 400),
		googleQueries: q ? [`site:reddit.com ${q}`] : [],
		seedSubreddits: [],
		keepCriteria: "",
		rejectCriteria: "",
	};
}

/** Take subreddit names from Google hits (no LLM pick). */
export function pickSubredditsFromGoogle(googleSubs, max = REDDIT_AI_SCRAPER.maxSubs) {
	const out = [];
	const seen = new Set();
	for (const s of googleSubs || []) {
		const name = normalizeSub(s);
		if (!name || !/^[a-z0-9_]+$/.test(name) || seen.has(name)) continue;
		seen.add(name);
		out.push({ name, reason: "scrape_only" });
		if (out.length >= max) break;
	}
	return out;
}

export function postsFromGoogleRows(rows) {
	const posts = [];
	const subs = new Set();
	for (const row of rows || []) {
		const url = row.url || row.link || "";
		if (!/reddit\.com\/r\/[^/]+/i.test(url)) continue;
		let pathname = url;
		let subreddit = "";
		try {
			const u = new URL(url);
			pathname = u.pathname;
			const m = pathname.match(/\/r\/([^/]+)/i);
			if (m) subreddit = normalizeSub(m[1]);
		} catch {
			continue;
		}
		if (subreddit) subs.add(subreddit);
		if (!/\/comments\//i.test(pathname)) continue;
		posts.push({
			subreddit,
			title: row.title || pathname,
			body: row.snippet || row.description || "",
			author: "unknown",
			permalink: pathname,
			publishedAt: null,
			source: "google_site",
		});
	}
	return { posts, subreddits: [...subs] };
}

export async function googleReddit(queries, { baseUrl, num = 8 } = {}) {
	const allPosts = [];
	const allSubs = new Set();
	const errors = [];
	const settled = await Promise.allSettled(
		queries.map((q) => googleSearch(q, { baseUrl, num })),
	);
	for (let i = 0; i < settled.length; i++) {
		const r = settled[i];
		if (r.status !== "fulfilled") {
			errors.push({
				query: queries[i],
				error: r.reason?.message || String(r.reason),
			});
			continue;
		}
		const { posts, subreddits } = postsFromGoogleRows(r.value);
		allPosts.push(...posts);
		for (const s of subreddits) allSubs.add(s);
	}
	return {
		posts: allPosts,
		subreddits: [...allSubs],
		errors,
	};
}

/**
 * Layer 2 — pick the crawl list (10–20 subs) from seeds + Google evidence.
 */
export async function pickSubreddits({ prompt, plan, googleSubs, sampleTitles }) {
	const max = REDDIT_AI_SCRAPER.maxSubs;
	const { content } = await openRouterChat({
		model: DEFAULT_MODEL,
		jsonMode: true,
		temperature: 0.15,
		maxTokens: 1600,
		messages: [
			{
				role: "system",
				content: `You choose Reddit communities to monitor for a research goal.
Return 10 to ${max} real subreddit names (no r/ prefix) that actually exist and match the goal.
Prefer active, on-topic subs. Drop generic mega-subs unless they clearly fit.

Return ONLY JSON:
{ "subreddits": [{ "name": "webscraping", "reason": "short" }] }`,
			},
			{
				role: "user",
				content: JSON.stringify({
					prompt,
					goal: plan.goal,
					seedSubreddits: plan.seedSubreddits,
					googleFoundSubreddits: googleSubs.slice(0, 40),
					sampleThreadTitles: (sampleTitles || []).slice(0, 20),
				}),
			},
		],
	});

	const raw = llmJson(content, {});
	const rows = Array.isArray(raw.subreddits) ? raw.subreddits : [];
	const out = [];
	const seen = new Set();
	for (const row of rows) {
		const name = normalizeSub(row?.name || row);
		if (!name || !/^[a-z0-9_]+$/.test(name) || seen.has(name)) continue;
		seen.add(name);
		out.push({ name, reason: String(row?.reason || "").slice(0, 200) });
		if (out.length >= max) break;
	}
	if (out.length < 5) {
		for (const s of [...plan.seedSubreddits, ...googleSubs]) {
			const name = normalizeSub(s);
			if (!name || seen.has(name)) continue;
			seen.add(name);
			out.push({ name, reason: "fallback" });
			if (out.length >= Math.min(12, max)) break;
		}
	}
	return out;
}
