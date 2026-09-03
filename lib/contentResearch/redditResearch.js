/**
 * Reddit research via Google site:reddit.com only.
 * Skips Reddit RSS (frequent 429) so the pipeline always completes.
 */

import { googleSearch } from "./http.js";
import { topKeywordsForSearch } from "./keywordResearch.js";
import { dedupeBy } from "./utils.js";

const MAX_GOOGLE_SEARCHES = 6;
const MAX_RESULTS = 40;

function mapGoogleRedditResult(row) {
	const url = row.url || row.link || "";
	if (!/reddit\.com/i.test(url)) return null;
	// Prefer post permalinks over bare subreddit hubs
	const isPost = /\/comments\//i.test(url);
	let subreddit;
	try {
		const m = new URL(url).pathname.match(/\/r\/([^/]+)/i);
		if (m) subreddit = `r/${m[1]}`;
	} catch {
		/* ignore */
	}
	const title = String(row.title || "").trim();
	if (!title || !url) return null;
	return {
		title,
		question: title,
		subreddit,
		url,
		snippet: row.snippet || row.description || undefined,
		isPost,
		source: "google_site",
	};
}

async function searchRedditViaGoogle(query, baseUrl) {
	const results = await googleSearch(`site:reddit.com ${query}`, {
		baseUrl,
		num: 10,
	});
	return (results || []).map(mapGoogleRedditResult).filter(Boolean);
}

/**
 * @param {string} topic
 * @param {object[]} keywords
 * @param {{ baseUrl?: string }} [opts]
 */
export async function researchReddit(topic, keywords = [], opts = {}) {
	const warnings = [];
	const seedKw = topKeywordsForSearch(keywords, 4).map((k) => k.keyword);

	const queries = [
		topic,
		`${topic} questions`,
		`${topic} vs`,
		`${topic} how to`,
		...seedKw,
	]
		.map((q) => String(q).trim())
		.filter(Boolean);

	const uniqueQueries = dedupeBy(
		queries.map((q) => ({ q })),
		(x) => x.q,
	)
		.map((x) => x.q)
		.slice(0, MAX_GOOGLE_SEARCHES);

	const settled = await Promise.allSettled(
		uniqueQueries.map((q) => searchRedditViaGoogle(q, opts.baseUrl)),
	);

	const reddit = [];
	let googleOk = false;
	for (const r of settled) {
		if (r.status === "fulfilled") {
			googleOk = true;
			reddit.push(...(r.value || []));
		} else {
			warnings.push(
				`Reddit Google site search failed: ${r.reason?.message || r.reason}`,
			);
		}
	}

	// Prefer comment threads; keep subreddit hubs only if thin
	const posts = reddit.filter((r) => r.isPost);
	const hubs = reddit.filter((r) => !r.isPost);
	const ordered = posts.length >= 5 ? [...posts, ...hubs] : [...posts, ...hubs];

	const deduped = dedupeBy(ordered, (r) => r.url || r.title)
		.map(({ source, isPost, snippet, ...rest }) => {
			const out = { ...rest };
			if (snippet) out.snippet = snippet;
			return out;
		})
		.slice(0, MAX_RESULTS);

	if (!deduped.length) {
		if (!googleOk) {
			warnings.push(
				"Reddit research unavailable (Google site:reddit.com returned no results)",
			);
		} else {
			warnings.push(
				"Reddit Google search returned no reddit.com threads for this topic",
			);
		}
		return { reddit: [], warnings };
	}

	return { reddit: deduped, warnings };
}
