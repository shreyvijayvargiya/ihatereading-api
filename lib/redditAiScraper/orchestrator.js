/**
 * Reddit AI scraper orchestrator.
 * Default: Google + RSS scrape-only (no OpenRouter).
 * With `opts.llm` / `--llm`: LLM plan → pick subs → score posts.
 */

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { fetchRssFeed } from "../scrapefast.js";
import {
	buildNewPostFeedUrl,
	parseRedditPostFeed,
} from "../redditMonitor/rss.js";
import {
	normalizeSub,
	permalinkDocId,
	saveAgentPost,
	scorePostsWithLlm,
	scrapeOnlyMatch,
	isRedditLlmOn,
	threadUrl,
} from "../redditAgents/core.js";
import { REDDIT_AI_SCRAPER, buildScorePrompt } from "./configs.js";
import {
	googleReddit,
	pickSubreddits,
	pickSubredditsFromGoogle,
	planFromPrompt,
	scrapeOnlyPlanFromPrompt,
} from "./discover.js";

function promptHash(prompt) {
	return createHash("sha256")
		.update(String(prompt || "").trim().toLowerCase())
		.digest("hex")
		.slice(0, 16);
}

function topicRef(hash) {
	return firestore.collection(REDDIT_AI_SCRAPER.topicsCollection).doc(hash);
}

async function loadTopic(hash) {
	const snap = await topicRef(hash).get();
	return snap.exists ? snap.data() : null;
}

async function saveTopic(hash, data) {
	await topicRef(hash).set(
		{ ...data, updatedAt: FieldValue.serverTimestamp() },
		{ merge: true },
	);
}

function takeRotated(list, start, count) {
	if (!list.length) return { batch: [], next: 0 };
	const batch = [];
	for (let i = 0; i < Math.min(count, list.length); i++) {
		batch.push(list[(start + i) % list.length]);
	}
	return { batch, next: (start + batch.length) % list.length };
}

async function postExists(permalink) {
	const id = permalinkDocId(permalink);
	const snap = await firestore
		.collection(REDDIT_AI_SCRAPER.collection)
		.doc(id)
		.get();
	return snap.exists;
}

async function fetchRssPosts(subs) {
	const posts = [];
	const errors = [];
	for (const sub of subs) {
		try {
			const xml = await fetchRssFeed(buildNewPostFeedUrl(sub));
			const parsed = parseRedditPostFeed(xml, sub);
			for (const p of parsed) {
				posts.push({ ...p, source: "rss" });
			}
			console.log(`[reddit-ai-scraper] r/${sub}: ${parsed.length} rss`);
		} catch (err) {
			const msg = err?.message || String(err);
			console.error(`[reddit-ai-scraper] r/${sub} failed:`, msg);
			errors.push({ subreddit: sub, error: msg });
		}
	}
	return { posts, errors };
}

const AGENT = {
	id: REDDIT_AI_SCRAPER.id,
	collection: REDDIT_AI_SCRAPER.collection,
	relevanceMin: REDDIT_AI_SCRAPER.relevanceMin,
};

/**
 * @param {{ prompt: string, baseUrl?: string, skipGoogle?: boolean, rediscover?: boolean, subsPerRun?: number, llm?: boolean }} opts
 */
export async function runRedditAiScraper(opts = {}) {
	const prompt = String(opts.prompt || "").trim();
	if (!prompt) throw new Error("prompt is required");

	const llm = isRedditLlmOn(opts);
	const hash = promptHash(prompt);
	const subsPerRun = opts.subsPerRun ?? REDDIT_AI_SCRAPER.subsPerRun;
	let topic = await loadTopic(hash);
	const summary = {
		agentId: REDDIT_AI_SCRAPER.id,
		collection: REDDIT_AI_SCRAPER.collection,
		promptHash: hash,
		topicId: topic?.topicId || null,
		llm,
		newPosts: 0,
		relevant: [],
		subreddits: [],
		subsRun: [],
		googleQueries: [],
		errors: [],
		layers: {},
	};

	if (!topic || opts.rediscover) {
		let plan;
		let googlePosts = [];
		let googleSubs = [];

		if (llm) {
			console.log("[reddit-ai-scraper] layer 1 — LLM plan from prompt");
			plan = await planFromPrompt(prompt);
		} else {
			console.log(
				"[reddit-ai-scraper] scrape-only plan (pass --llm to use OpenRouter)",
			);
			plan = scrapeOnlyPlanFromPrompt(prompt);
			if (opts.skipGoogle) {
				throw new Error(
					"Scrape-only first run needs Google discovery. Omit --skip-google, or pass --llm to plan subreddits.",
				);
			}
		}

		summary.layers.plan = {
			topicId: plan.topicId,
			topicName: plan.topicName,
			seedSubreddits: plan.seedSubreddits,
			queryCount: plan.googleQueries.length,
			llm,
		};

		const queryBatch = plan.googleQueries.slice(
			0,
			opts.skipGoogle ? 0 : REDDIT_AI_SCRAPER.queriesPerRun,
		);
		summary.googleQueries = queryBatch;
		if (queryBatch.length) {
			console.log("[reddit-ai-scraper] google", queryBatch.length, "queries");
			const g = await googleReddit(queryBatch, { baseUrl: opts.baseUrl });
			googlePosts = g.posts;
			googleSubs = g.subreddits;
			summary.errors.push(...g.errors);
			summary.layers.google = {
				threads: googlePosts.length,
				subreddits: googleSubs.length,
			};
		}

		let picked;
		if (llm) {
			console.log("[reddit-ai-scraper] layer 2 — LLM pick subreddits");
			picked = await pickSubreddits({
				prompt,
				plan,
				googleSubs,
				sampleTitles: googlePosts.map((p) => p.title),
			});
		} else {
			picked = pickSubredditsFromGoogle(googleSubs);
			if (!picked.length) {
				throw new Error(
					"No Reddit subreddits found from Google. Try a more specific --prompt, or pass --llm.",
				);
			}
			console.log(
				`[reddit-ai-scraper] scrape-only pick — ${picked.length} subs from Google`,
			);
		}

		topic = {
			prompt,
			promptHash: hash,
			topicId: plan.topicId,
			topicName: plan.topicName,
			goal: plan.goal,
			keepCriteria: plan.keepCriteria,
			rejectCriteria: plan.rejectCriteria,
			googleQueries: plan.googleQueries,
			seedSubreddits: plan.seedSubreddits,
			subreddits: picked.map((p) => p.name),
			subReasons: picked,
			googleCachePosts: googlePosts.slice(0, 40),
			lastSubIndex: 0,
		};
		await saveTopic(hash, topic);
		summary.layers.pick = { count: picked.length, subreddits: topic.subreddits };
	} else {
		summary.layers.reusedTopic = true;
		summary.googleQueries = (topic.googleQueries || []).slice(
			0,
			REDDIT_AI_SCRAPER.queriesPerRun,
		);
	}

	summary.topicId = topic.topicId;
	summary.topicName = topic.topicName;
	const pool = (topic.subreddits || []).map(normalizeSub).filter(Boolean);
	summary.subreddits = pool;

	const start = Number(topic.lastSubIndex) || 0;
	const { batch: subBatch, next } = takeRotated(pool, start, subsPerRun);
	await saveTopic(hash, { lastSubIndex: next, googleCachePosts: [] });
	summary.subsRun = subBatch;
	summary.subCursor = { from: start, to: next, total: pool.length };

	const { posts: rssPosts, errors: rssErrors } = await fetchRssPosts(subBatch);
	summary.errors.push(...rssErrors);

	const googlePosts = Array.isArray(topic.googleCachePosts)
		? topic.googleCachePosts
		: [];
	const combined = [...rssPosts, ...googlePosts];
	const seen = new Set();
	const unique = [];
	for (const p of combined) {
		if (!p.permalink || seen.has(p.permalink)) continue;
		seen.add(p.permalink);
		if (await postExists(p.permalink)) continue;
		unique.push(p);
	}

	if (!unique.length) {
		console.log("[reddit-ai-scraper] no new posts");
		return summary;
	}

	const scoredAll = [];
	if (llm) {
		console.log(`[reddit-ai-scraper] layer 3 — LLM enrich ${unique.length} posts`);
		const batches = [];
		for (let i = 0; i < unique.length; i += 12) {
			batches.push(unique.slice(i, i + 12));
		}
		for (const batch of batches) {
			const scored = await scorePostsWithLlm(batch, {
				systemPrompt: buildScorePrompt(topic),
			});
			scoredAll.push(...scored);
		}
	} else {
		console.log(
			`[reddit-ai-scraper] scrape-only save ${unique.length} posts (pass --llm to score)`,
		);
		for (const p of unique) scoredAll.push(scrapeOnlyMatch(AGENT, p));
	}

	const minScore = llm ? REDDIT_AI_SCRAPER.relevanceMin : 0;
	for (const post of unique) {
		const match = scoredAll.find(
			(r) =>
				r.permalink === post.permalink ||
				String(r.permalink || "").endsWith(post.permalink),
		);
		const { score } = await saveAgentPost(AGENT, post, match, {
			fields: {
				topicId: topic.topicId,
				topicName: topic.topicName,
				promptHash: hash,
				prompt: topic.prompt,
				discoverySource: post.source || "rss",
				summary: match?.summary || null,
				intent: match?.intent || null,
				tags: Array.isArray(match?.tags) ? match.tags : [],
			},
		});
		summary.newPosts += 1;
		if (!llm || score >= minScore) {
			summary.relevant.push({
				topicId: topic.topicId,
				subreddit: normalizeSub(post.subreddit),
				title: post.title,
				body: post.body,
				author: post.author,
				permalink: post.permalink,
				threadUrl: threadUrl(post.permalink),
				relevanceScore: score,
				relevanceReason: match?.reason || "",
				problemType: match?.problemType || null,
				intent: match?.intent || null,
				solutionFit: match?.solutionFit || null,
				summary: match?.summary || null,
				tags: Array.isArray(match?.tags) ? match.tags : [],
			});
		}
	}

	console.log(
		`[reddit-ai-scraper] ${summary.topicId} — ${summary.newPosts} new, ${summary.relevant.length} relevant${llm ? "" : " (scrape-only)"} → ${REDDIT_AI_SCRAPER.collection}`,
	);
	return summary;
}

export async function listAiScraperTopics(limit = 50) {
	const snap = await firestore
		.collection(REDDIT_AI_SCRAPER.topicsCollection)
		.limit(Math.min(200, Math.max(1, Number(limit) || 50)))
		.get();
	return snap.docs.map((d) => {
		const data = d.data() || {};
		return {
			id: d.id,
			topicId: data.topicId,
			topicName: data.topicName,
			prompt: data.prompt,
			subreddits: data.subreddits || [],
			goal: data.goal,
		};
	});
}

export async function listAiScraperPosts({
	topicId,
	minScore = 0,
	limit = 50,
} = {}) {
	const snap = await firestore
		.collection(REDDIT_AI_SCRAPER.collection)
		.where("relevanceScore", ">=", minScore)
		.get();
	let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	if (topicId) {
		const t = String(topicId).toLowerCase();
		rows = rows.filter(
			(r) =>
				String(r.topicId || "").toLowerCase() === t ||
				String(r.promptHash || "") === String(topicId),
		);
	}
	rows.sort((a, b) => {
		const ta = new Date(a.publishedAt || a.fetchedAt || 0).getTime();
		const tb = new Date(b.publishedAt || b.fetchedAt || 0).getTime();
		return tb - ta;
	});
	return rows.slice(0, limit);
}
