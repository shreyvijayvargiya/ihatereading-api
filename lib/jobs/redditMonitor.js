/**
 * Simple Reddit monitor for saascrm.site — cron every 30 min.
 * Fetch public /new/.rss → dedupe → one Claude batch score → Firestore.
 */

import { createHash } from "node:crypto";
import { firestore } from "../../config/firebase.js";
import { fetchRssFeed } from "../scrapefast.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import {
	PRODUCT_CONTEXT,
	REDDIT_POSTS_COLL,
	RELEVANCE_MIN,
	SONAR_MODEL,
	SUBREDDITS,
} from "../redditMonitor/constants.js";
import { buildNewPostFeedUrl, parseRedditPostFeed } from "../redditMonitor/rss.js";

function permalinkDocId(permalink) {
	return createHash("sha256")
		.update(String(permalink))
		.digest("hex")
		.slice(0, 32);
}

function normalizeSub(sub) {
	return String(sub || "")
		.trim()
		.replace(/^r\//i, "")
		.toLowerCase();
}

async function postExists(permalink) {
	const id = permalinkDocId(permalink);
	const snap = await firestore.collection(REDDIT_POSTS_COLL).doc(id).get();
	return snap.exists;
}

async function scorePostsWithClaude(posts) {
	if (!posts.length) return [];

	const { content } = await openRouterChat({
		model: SONAR_MODEL,
		jsonMode: true,
		temperature: 0.1,
		maxTokens: 2048,
		messages: [
			{
				role: "system",
				content: `You score Reddit posts for relevance to a CRM SaaS product.
${PRODUCT_CONTEXT}

Score each post 1-5 (5 = perfect fit — someone describing a problem this product solves or actively asking for something like it).
Return ONLY a JSON object: { "results": [{ "permalink": "/r/...", "score": number, "reason": "short" }] }
Include every post from the input. Use the exact permalink string from each post.`,
			},
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

	let parsed = [];
	try {
		const raw = parseJsonFromLLM(content);
		parsed = Array.isArray(raw)
			? raw
			: Array.isArray(raw.results)
				? raw.results
				: Array.isArray(raw.posts)
					? raw.posts
					: [];
	} catch (err) {
		console.error("[reddit-monitor] LLM parse failed:", err?.message || err);
		return posts.map((p) => ({
			permalink: p.permalink,
			score: 0,
			reason: "llm_parse_failed",
		}));
	}

	return parsed;
}

async function saveScoredPost(post, subreddit, match) {
	const id = permalinkDocId(post.permalink);
	const now = new Date().toISOString();
	await firestore
		.collection(REDDIT_POSTS_COLL)
		.doc(id)
		.set({
			subreddit: normalizeSub(subreddit),
			title: post.title,
			body: post.body,
			author: post.author,
			permalink: post.permalink,
			publishedAt: post.publishedAt || null,
			fetchedAt: now,
			relevanceScore: Number(match?.score) || 0,
			relevanceReason: String(match?.reason || "").slice(0, 500),
			checked: true,
		});
}

export async function runRedditMonitor() {
	const summary = {
		subreddits: SUBREDDITS.length,
		newPosts: 0,
		relevant: [],
		errors: [],
	};

	for (const sub of SUBREDDITS) {
		const feedUrl = buildNewPostFeedUrl(sub);
		try {
			const xml = await fetchRssFeed(feedUrl);
			const posts = parseRedditPostFeed(xml, normalizeSub(sub));

			const newPosts = [];
			for (const p of posts) {
				if (!p.permalink) continue;
				const exists = await postExists(p.permalink);
				if (!exists) newPosts.push(p);
			}

			if (newPosts.length === 0) {
				console.log(`[reddit-monitor] r/${sub}: no new posts`);
				continue;
			}

			console.log(
				`[reddit-monitor] r/${sub}: scoring ${newPosts.length} new post(s)`,
			);
			const scored = await scorePostsWithClaude(newPosts);

			for (const post of newPosts) {
				const match = scored.find(
					(r) =>
						r.permalink === post.permalink ||
						String(r.permalink || "").endsWith(post.permalink),
				);
				await saveScoredPost(post, sub, match);
				summary.newPosts += 1;

				const score = Number(match?.score) || 0;
				if (score >= RELEVANCE_MIN) {
					summary.relevant.push({
						subreddit: normalizeSub(sub),
						title: post.title,
						body: post.body,
						author: post.author,
						permalink: post.permalink,
						publishedAt: post.publishedAt,
						relevanceScore: score,
						relevanceReason: match?.reason || "",
						threadUrl: post.permalink.startsWith("http")
							? post.permalink
							: `https://www.reddit.com${post.permalink}`,
					});
				}
			}
		} catch (err) {
			const msg = err?.message || String(err);
			console.error(`[reddit-monitor] r/${sub} failed:`, msg);
			summary.errors.push({ subreddit: sub, error: msg });
		}
	}

	console.log(
		`[reddit-monitor] done — ${summary.newPosts} new, ${summary.relevant.length} relevant (≥${RELEVANCE_MIN})`,
	);
	return summary;
}

/** List stored posts with relevanceScore >= min, newest first. */
export async function listRelevantRedditPosts(minScore = RELEVANCE_MIN, limit = 100) {
	const snap = await firestore
		.collection(REDDIT_POSTS_COLL)
		.where("relevanceScore", ">=", minScore)
		.get();

	const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	rows.sort((a, b) => {
		const ta = new Date(a.publishedAt || 0).getTime();
		const tb = new Date(b.publishedAt || 0).getTime();
		return tb - ta;
	});
	return rows.slice(0, limit);
}
