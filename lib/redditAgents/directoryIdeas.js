/**
 * Directory / aggregator idea finder — RSS (rotating ~10 subs) + Google site:reddit.com.
 */

import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { googleSearch } from "../contentResearch/http.js";
import { getAgent } from "./configs.js";
import {
	agentCollection,
	normalizeSub,
	permalinkDocId,
	runRssAgent,
	saveAgentPost,
	maybeScorePosts,
	isRedditLlmOn,
	threadUrl,
} from "./core.js";

async function postExists(agent, permalink) {
	const id = permalinkDocId(permalink);
	const snap = await firestore
		.collection(agentCollection(agent))
		.doc(id)
		.get();
	return snap.exists;
}

async function loadCursor(agent) {
	const snap = await firestore
		.collection(agent.stateCollection)
		.doc(agent.id)
		.get();
	if (!snap.exists) return { subIndex: 0, queryIndex: 0 };
	const d = snap.data() || {};
	return {
		subIndex: Number(d.lastSubIndex) || 0,
		queryIndex: Number(d.lastQueryIndex) || 0,
	};
}

async function saveCursor(agent, subIndex, queryIndex) {
	await firestore
		.collection(agent.stateCollection)
		.doc(agent.id)
		.set(
			{
				agentId: agent.id,
				lastSubIndex: subIndex,
				lastQueryIndex: queryIndex,
				updatedAt: FieldValue.serverTimestamp(),
			},
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

function mapGoogleToPost(row) {
	const url = row.url || row.link || "";
	if (!/reddit\.com\/r\/[^/]+\/comments\//i.test(url)) return null;
	let pathname = url;
	let subreddit = "";
	try {
		const u = new URL(url);
		pathname = u.pathname;
		const m = pathname.match(/\/r\/([^/]+)/i);
		if (m) subreddit = normalizeSub(m[1]);
	} catch {
		return null;
	}
	return {
		subreddit,
		title: row.title || pathname,
		body: row.snippet || row.description || "",
		author: "unknown",
		permalink: pathname,
		publishedAt: null,
		source: "google_site",
	};
}

function extraFromMatch(match) {
	return {
		fields: {
			discoverySource: "google_site",
			ideaTitle: match?.ideaTitle || null,
			directoryCategory: match?.directoryCategory || match?.problemType || null,
			tags: Array.isArray(match?.tags) ? match.tags : [],
		},
	};
}

async function scoreAndSaveDiscovered(agent, posts, opts = {}) {
	const relevant = [];
	const newPosts = [];
	for (const p of posts) {
		if (!p.permalink) continue;
		if (!(await postExists(agent, p.permalink))) newPosts.push(p);
	}
	if (!newPosts.length) return { newPosts: 0, relevant };

	const seen = new Set();
	const unique = [];
	for (const p of newPosts) {
		if (seen.has(p.permalink)) continue;
		seen.add(p.permalink);
		unique.push(p);
	}

	const llm = isRedditLlmOn(opts);
	console.log(
		`[reddit-agent:directories] ${llm ? "scoring" : "saving"} ${unique.length} Google-discovered posts`,
	);
	const scored = await maybeScorePosts(agent, unique, opts);

	for (const post of unique) {
		const match = scored.find(
			(r) =>
				r.permalink === post.permalink ||
				String(r.permalink || "").endsWith(post.permalink),
		);
		const { score } = await saveAgentPost(
			agent,
			post,
			match,
			extraFromMatch(match),
		);
		if (!llm || score >= (agent.relevanceMin ?? 4)) {
			relevant.push({
				agentId: agent.id,
				subreddit: post.subreddit,
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
			});
		}
	}

	return { newPosts: unique.length, relevant };
}

/**
 * @param {{ baseUrl?: string, skipGoogle?: boolean, subsPerRun?: number, llm?: boolean }} [opts]
 */
export async function runDirectoryIdeasAgent(opts = {}) {
	const agent = getAgent("directories");
	if (!agent) throw new Error("directories agent config missing");

	const subsPool = (agent.subreddits || []).map(normalizeSub);
	const queryPool = agent.discoverQueries || [];
	const subsPerRun = opts.subsPerRun ?? agent.subsPerRun ?? 10;
	const queriesPerRun = agent.queriesPerRun ?? 3;

	const cursor = await loadCursor(agent);
	const { batch: subBatch, next: nextSub } = takeRotated(
		subsPool,
		cursor.subIndex,
		subsPerRun,
	);
	const { batch: queryBatch, next: nextQuery } = takeRotated(
		queryPool,
		cursor.queryIndex,
		opts.skipGoogle ? 0 : queriesPerRun,
	);
	await saveCursor(agent, nextSub, nextQuery);

	const summary = {
		agentId: agent.id,
		collection: agentCollection(agent),
		subreddits: subBatch.length,
		subsRun: subBatch,
		queriesRun: queryBatch,
		queryCursor: { from: cursor.queryIndex, to: nextQuery, total: queryPool.length },
		subCursor: { from: cursor.subIndex, to: nextSub, total: subsPool.length },
		llm: isRedditLlmOn(opts),
		newPosts: 0,
		relevant: [],
		errors: [],
	};

	if (!opts.skipGoogle && queryBatch.length) {
		try {
			const discovered = [];
			const settled = await Promise.allSettled(
				queryBatch.map((q) => {
					console.log(`[reddit-agent:directories] google ${q}`);
					return googleSearch(q, { baseUrl: opts.baseUrl, num: 8 });
				}),
			);
			for (const r of settled) {
				if (r.status !== "fulfilled") {
					summary.errors.push({
						step: "google",
						error: r.reason?.message || String(r.reason),
					});
					continue;
				}
				for (const row of r.value || []) {
					const post = mapGoogleToPost(row);
					if (post) discovered.push(post);
				}
			}
			const g = await scoreAndSaveDiscovered(agent, discovered, opts);
			summary.newPosts += g.newPosts;
			summary.relevant.push(...g.relevant);
		} catch (err) {
			const msg = err?.message || String(err);
			console.error("[reddit-agent:directories] Google failed:", msg);
			summary.errors.push({ step: "google_discovery", error: msg });
		}
	}

	const llm = isRedditLlmOn(opts);
	const rssSummary = await runRssAgent(agent, {
		subreddits: subBatch,
		llm: opts.llm,
		enrich: opts.enrich,
		enrichPost: (_post, match) => ({
			fields: {
				discoverySource: "rss",
				ideaTitle: match?.ideaTitle || null,
				directoryCategory:
					match?.directoryCategory || match?.problemType || null,
				tags: Array.isArray(match?.tags) ? match.tags : [],
			},
		}),
	});
	summary.newPosts += rssSummary.newPosts;
	summary.relevant.push(...rssSummary.relevant);
	summary.errors.push(...(rssSummary.errors || []));

	const seen = new Set();
	summary.relevant = summary.relevant.filter((r) => {
		if (seen.has(r.permalink)) return false;
		seen.add(r.permalink);
		return true;
	});

	console.log(
		`[reddit-agent:directories] total — ${summary.newPosts} new, ${summary.relevant.length} relevant${llm ? ` (≥${agent.relevanceMin})` : " (scrape-only)"} → ${summary.collection}`,
	);
	return summary;
}
