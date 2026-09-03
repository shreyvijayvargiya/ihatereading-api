/**
 * SaaS problem finder — smart discovery via Google site:reddit.com + seed RSS.
 * Finds SaaS-shaped pains that can become landing pages, Gumroad products,
 * subscription SaaS, or open-source tools.
 */

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
import { firestore } from "../../config/firebase.js";

async function postExists(agent, permalink) {
	const id = permalinkDocId(permalink);
	const snap = await firestore
		.collection(agentCollection(agent))
		.doc(id)
		.get();
	return snap.exists;
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

async function discoverViaGoogle(agent, baseUrl) {
	const queries = agent.discoverQueries || [];
	const discovered = [];
	const extraSubs = new Set();

	const settled = await Promise.allSettled(
		queries.map((q) => googleSearch(q, { baseUrl, num: 8 })),
	);

	for (const r of settled) {
		if (r.status !== "fulfilled") continue;
		for (const row of r.value || []) {
			const post = mapGoogleToPost(row);
			if (!post) continue;
			discovered.push(post);
			if (post.subreddit) extraSubs.add(post.subreddit);
		}
	}

	return { discovered, extraSubs: [...extraSubs] };
}

async function scoreAndSaveDiscovered(agent, posts, opts = {}) {
	const relevant = [];
	const newPosts = [];
	for (const p of posts) {
		if (!p.permalink) continue;
		if (!(await postExists(agent, p.permalink))) newPosts.push(p);
	}
	if (!newPosts.length) return { newPosts: 0, relevant };

	// Dedupe by permalink
	const seen = new Set();
	const unique = [];
	for (const p of newPosts) {
		if (seen.has(p.permalink)) continue;
		seen.add(p.permalink);
		unique.push(p);
	}

	const llm = isRedditLlmOn(opts);
	console.log(
		`[reddit-agent:${agent.id}] ${llm ? "scoring" : "saving"} ${unique.length} Google-discovered posts`,
	);
	const scored = await maybeScorePosts(agent, unique, opts);

	for (const post of unique) {
		const match = scored.find(
			(r) =>
				r.permalink === post.permalink ||
				String(r.permalink || "").endsWith(post.permalink),
		);
		const { score } = await saveAgentPost(agent, post, match, {
			fields: { discoverySource: "google_site" },
		});
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
				intent: match?.intent || null,
			});
		}
	}

	return { newPosts: unique.length, relevant };
}

/**
 * @param {string} agentId
 * @param {{ baseUrl?: string, skipGoogle?: boolean, llm?: boolean }} [opts]
 */
export async function runGooglePlusRssAgent(agentId, opts = {}) {
	const agent = getAgent(agentId);
	if (!agent) throw new Error(`${agentId} agent config missing`);

	const summary = {
		agentId: agent.id,
		collection: agentCollection(agent),
		llm: isRedditLlmOn(opts),
		subreddits: 0,
		newPosts: 0,
		relevant: [],
		errors: [],
		discoveredSubs: [],
	};

	// 1) Google discovery of SaaS problem threads + extra subreddits
	let extraSubs = [];
	if (!opts.skipGoogle) {
		try {
			const { discovered, extraSubs: found } = await discoverViaGoogle(
				agent,
				opts.baseUrl,
			);
			extraSubs = found;
			summary.discoveredSubs = found;
			const g = await scoreAndSaveDiscovered(agent, discovered, opts);
			summary.newPosts += g.newPosts;
			summary.relevant.push(...g.relevant);
		} catch (err) {
			const msg = err?.message || String(err);
			console.error(`[reddit-agent:${agent.id}] Google discovery failed:`, msg);
			summary.errors.push({ step: "google_discovery", error: msg });
		}
	}

	// 2) RSS on seed subs + discovered subs (cap)
	const subs = [
		...new Set([
			...(agent.subreddits || []).map(normalizeSub),
			...extraSubs.slice(0, 8),
		]),
	];
	summary.subreddits = subs.length;

	const rssSummary = await runRssAgent(agent, {
		subreddits: subs,
		llm: opts.llm,
		enrich: opts.enrich,
	});
	summary.newPosts += rssSummary.newPosts;
	summary.relevant.push(...rssSummary.relevant);
	summary.errors.push(...(rssSummary.errors || []));

	// Dedupe relevant by permalink
	const seen = new Set();
	summary.relevant = summary.relevant.filter((r) => {
		if (seen.has(r.permalink)) return false;
		seen.add(r.permalink);
		return true;
	});

	console.log(
		`[reddit-agent:${agent.id}] total — ${summary.newPosts} new, ${summary.relevant.length} relevant`,
	);
	return summary;
}

/**
 * @param {{ baseUrl?: string, skipGoogle?: boolean }} [opts]
 */
export async function runSaasProblemsAgent(opts = {}) {
	return runGooglePlusRssAgent("saas", opts);
}
