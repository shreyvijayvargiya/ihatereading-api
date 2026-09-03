/**
 * Shared Reddit agent runner — RSS (/new/.rss) → dedupe → optional OpenRouter score → Firestore.
 * LLM is opt-in (`opts.llm` / `--llm`). Default is scrape-only.
 */

import { createHash } from "node:crypto";
import { firestore } from "../../config/firebase.js";
import { fetchRssFeed } from "../scrapefast.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import { getAgent } from "./configs.js";
import {
	buildNewPostFeedUrl,
	parseRedditPostFeed,
} from "../redditMonitor/rss.js";

export const DEFAULT_MODEL =
	process.env.REDDIT_CLAUDE_SONNET ||
	process.env.OPENROUTER_MODEL ||
	"anthropic/claude-sonnet-4";

export function agentCollection(agent) {
	const coll = agent?.collection?.trim();
	if (!coll) throw new Error(`Agent ${agent?.id || "?"} missing collection`);
	return coll;
}

export function permalinkDocId(permalink) {
	return createHash("sha256")
		.update(String(permalink || ""))
		.digest("hex")
		.slice(0, 32);
}

export function normalizeSub(sub) {
	return String(sub || "")
		.trim()
		.replace(/^r\//i, "")
		.toLowerCase();
}

export function threadUrl(permalink) {
	const p = String(permalink || "");
	return p.startsWith("http") ? p : `https://www.reddit.com${p}`;
}

async function postExists(agent, permalink) {
	const id = permalinkDocId(permalink);
	const snap = await firestore
		.collection(agentCollection(agent))
		.doc(id)
		.get();
	return snap.exists;
}

/**
 * @param {object[]} posts
 * @param {{ systemPrompt: string, model?: string }} opts
 */
export async function scorePostsWithLlm(posts, opts) {
	if (!posts.length) return [];
	const model = opts.model || DEFAULT_MODEL;

	const { content } = await openRouterChat({
		model,
		jsonMode: true,
		temperature: 0.15,
		maxTokens: 2800,
		messages: [
			{ role: "system", content: opts.systemPrompt },
			{
				role: "user",
				content: `Posts:\n${JSON.stringify(
					posts.map((p) => ({
						permalink: p.permalink,
						title: p.title,
						body: String(p.body || "").slice(0, 1500),
						author: p.author,
						subreddit: p.subreddit,
					})),
				)}`,
			},
		],
	});

	try {
		const raw = parseJsonFromLLM(content);
		return Array.isArray(raw)
			? raw
			: Array.isArray(raw.results)
				? raw.results
				: Array.isArray(raw.posts)
					? raw.posts
					: [];
	} catch (err) {
		console.error("[reddit-agent] LLM parse failed:", err?.message || err);
		return posts.map((p) => ({
			permalink: p.permalink,
			score: 0,
			reason: "llm_parse_failed",
		}));
	}
}

function flagOn(v) {
	return v === true || v === 1 || v === "1" || v === "true" || v === "yes";
}

/** Opt-in OpenRouter scoring. Default off (scrape only). */
export function isRedditLlmOn(opts = {}) {
	if (opts.llm === true || opts.enrich === true) return true;
	if (opts.llm === false) return false;
	const env = String(process.env.REDDIT_USE_LLM || "").trim().toLowerCase();
	return env === "1" || env === "true";
}

/** CLI `--llm` / `--enrich` or HTTP `{ llm: true }` / `?llm=1`. */
export function wantRedditLlmFromRequest(body = {}, query = {}) {
	if (flagOn(body.llm) || flagOn(body.enrich)) return true;
	if (flagOn(query.llm) || flagOn(query.enrich)) return true;
	return isRedditLlmOn({});
}

export function scrapeOnlyMatch(agent, post) {
	const sub = normalizeSub(post.subreddit);
	return {
		permalink: post.permalink,
		score: 0,
		reason: "scrape_only",
		tags: [agent?.id, sub].filter(Boolean),
	};
}

/**
 * Score with OpenRouter when `opts.llm` (or REDDIT_USE_LLM=1). Otherwise tag from source.
 */
export async function maybeScorePosts(agent, posts, opts = {}) {
	if (!posts.length) return [];
	if (!isRedditLlmOn(opts)) {
		console.log(`[reddit-agent:${agent.id}] scrape-only — pass --llm to score`);
		return posts.map((p) => scrapeOnlyMatch(agent, p));
	}
	if (!process.env.OPENROUTER_API_KEY?.trim()) {
		console.warn(
			`[reddit-agent:${agent.id}] --llm set but OPENROUTER_API_KEY missing — scrape-only`,
		);
		return posts.map((p) => scrapeOnlyMatch(agent, p));
	}
	return scorePostsWithLlm(posts, {
		systemPrompt: agent.scoreSystemPrompt,
		model: agent.model,
	});
}

function findScore(scored, permalink) {
	return scored.find(
		(r) =>
			r.permalink === permalink ||
			String(r.permalink || "").endsWith(permalink),
	);
}

/**
 * @param {object} agent - agent config (must include `collection`)
 * @param {object} post
 * @param {object} match
 * @param {object} [extra]
 */
export async function saveAgentPost(agent, post, match, extra = {}) {
	const coll = agentCollection(agent);
	const id = permalinkDocId(post.permalink);
	const now = new Date().toISOString();
	const score = Number(match?.score) || 0;
	await firestore
		.collection(coll)
		.doc(id)
		.set(
			{
				agentId: agent.id,
				subreddit: normalizeSub(post.subreddit),
				title: post.title,
				body: post.body,
				author: post.author,
				permalink: post.permalink,
				threadUrl: threadUrl(post.permalink),
				publishedAt: post.publishedAt || null,
				fetchedAt: now,
				relevanceScore: score,
				relevanceReason: String(match?.reason || "").slice(0, 800),
				problemType: match?.problemType || extra.problemType || null,
				solutionFit: match?.solutionFit || extra.solutionFit || null,
				ideaTitle: match?.ideaTitle || extra.ideaTitle || null,
				directoryCategory:
					match?.directoryCategory || extra.directoryCategory || null,
				tags: Array.isArray(match?.tags)
					? match.tags
					: extra.tags || [],
				matchedArticles: extra.matchedArticles || [],
				marketingAngle: match?.marketingAngle || extra.marketingAngle || null,
				intent: match?.intent || extra.intent || null,
				checked: true,
				...extra.fields,
			},
			{ merge: true },
		);
	return { id, score };
}

/**
 * Fetch /new/.rss for each subreddit, optionally LLM-score, save, return relevant.
 * @param {object} agent
 * @param {{ subreddits?: string[], enrichPost?: Function, llm?: boolean }} [opts]
 */
export async function runRssAgent(agent, opts = {}) {
	const subs = (opts.subreddits || agent.subreddits || []).map(normalizeSub);
	const llm = isRedditLlmOn(opts);
	const minScore = llm ? (agent.relevanceMin ?? 4) : 0;
	const summary = {
		agentId: agent.id,
		collection: agentCollection(agent),
		subreddits: subs.length,
		llm,
		newPosts: 0,
		relevant: [],
		errors: [],
	};

	for (const sub of subs) {
		const feedUrl = buildNewPostFeedUrl(sub);
		try {
			const xml = await fetchRssFeed(feedUrl);
			const posts = parseRedditPostFeed(xml, sub);

			const newPosts = [];
			for (const p of posts) {
				if (!p.permalink) continue;
				if (!(await postExists(agent, p.permalink))) newPosts.push(p);
			}

			if (!newPosts.length) {
				console.log(`[reddit-agent:${agent.id}] r/${sub}: no new posts`);
				continue;
			}

			console.log(
				`[reddit-agent:${agent.id}] r/${sub}: ${llm ? "scoring" : "saving"} ${newPosts.length} new`,
			);
			const scored = await maybeScorePosts(agent, newPosts, opts);

			for (const post of newPosts) {
				const match = findScore(scored, post.permalink);
				let extra = {};
				if (typeof opts.enrichPost === "function") {
					extra = (await opts.enrichPost(post, match)) || {};
				}
				const { score } = await saveAgentPost(agent, post, match, extra);
				summary.newPosts += 1;

				if (!llm || score >= minScore) {
					summary.relevant.push({
						agentId: agent.id,
						subreddit: normalizeSub(post.subreddit),
						title: post.title,
						body: post.body,
						author: post.author,
						permalink: post.permalink,
						threadUrl: threadUrl(post.permalink),
						publishedAt: post.publishedAt,
						relevanceScore: score,
						relevanceReason: match?.reason || "",
						problemType: match?.problemType || null,
						solutionFit: match?.solutionFit || null,
						ideaTitle: match?.ideaTitle || null,
						directoryCategory: match?.directoryCategory || null,
						tags: Array.isArray(match?.tags) ? match.tags : [],
						matchedArticles: extra.matchedArticles || [],
						marketingAngle: match?.marketingAngle || null,
						intent: match?.intent || extra.fields?.intent || extra.intent || null,
					});
				}
			}
			console.log(
				`[reddit-agent:${agent.id}] r/${sub}: stored ${newPosts.length} in ${summary.collection}`,
			);
		} catch (err) {
			const msg = err?.message || String(err);
			console.error(`[reddit-agent:${agent.id}] r/${sub} failed:`, msg);
			summary.errors.push({ subreddit: sub, error: msg });
		}
	}

	console.log(
		`[reddit-agent:${agent.id}] done — ${summary.newPosts} new, ${summary.relevant.length} relevant${llm ? ` (≥${minScore})` : " (scrape-only)"} → ${summary.collection}`,
	);
	return summary;
}

/** List stored posts for an agent (from that agent's collection). */
export async function listAgentPosts(agentId, { minScore = 0, limit = 100 } = {}) {
	const agent = getAgent(agentId);
	if (!agent) throw new Error(`Unknown agent: ${agentId}`);

	const snap = await firestore
		.collection(agentCollection(agent))
		.where("relevanceScore", ">=", minScore)
		.get();

	const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	rows.sort((a, b) => {
		const ta = new Date(a.publishedAt || a.fetchedAt || 0).getTime();
		const tb = new Date(b.publishedAt || b.fetchedAt || 0).getTime();
		return tb - ta;
	});
	return rows.slice(0, limit);
}
