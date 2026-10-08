/**
 * Adapter over existing Google search (lib/contentResearch/http.js).
 */

import { googleSearch } from "../../contentResearch/http.js";
import { dedupeByUrl, isJunkUrl, normalizeUrl } from "../utils.js";

/**
 * @param {string} query
 * @param {{ baseUrl?: string, num?: number, country?: string, language?: string, reddit?: boolean }} [options]
 * @returns {Promise<Array<{ title: string, url: string, snippet: string }>>}
 */
export async function searchWeb(query, options = {}) {
	const q = String(query || "").trim();
	if (!q) return [];

	const fullQuery = options.reddit ? `site:reddit.com ${q}` : q;
	const rows = await googleSearch(fullQuery, {
		baseUrl: options.baseUrl,
		num: options.num || 8,
		country: options.country || "us",
		language: options.language || "en",
		skipPuppeteer: options.skipPuppeteer,
	});

	return dedupeByUrl(
		(rows || [])
			.map((r) => ({
				title: String(r.title || "").trim(),
				url: normalizeUrl(r.url || r.link || ""),
				snippet: String(r.snippet || r.description || "").trim(),
			}))
			.filter((r) => r.title && r.url && !isJunkUrl(r.url)),
	);
}

/**
 * Run multiple queries with a cap.
 * @param {string[]} queries
 * @param {{ baseUrl?: string, maxQueries?: number, redditRatio?: number }} opts
 */
export async function searchWebBatch(queries, opts = {}) {
	const cap = opts.maxQueries ?? 16;
	const unique = [...new Set(queries.map((q) => String(q).trim()).filter(Boolean))].slice(
		0,
		cap,
	);
	const all = [];

	for (const query of unique) {
		const isReddit =
			/site:reddit\.com/i.test(query) ||
			(opts.redditQueries || []).some((rq) => rq === query);
		try {
			const rows = await searchWeb(query, {
				baseUrl: opts.baseUrl,
				num: opts.numPerQuery || 6,
				country: opts.country,
				reddit: isReddit || /reddit/i.test(query),
			});
			for (const row of rows) {
				all.push({
					...row,
					query,
					sourceType: /reddit\.com/i.test(row.url) ? "reddit" : "google",
				});
			}
		} catch (err) {
			console.warn(`[CONTENT] search failed "${query}":`, err?.message || err);
		}
	}

	return dedupeByUrl(all);
}
