/**
 * Club enrich search — local Google scrape + DuckDuckGo only.
 * Does not use Firecrawl, Google CSE, or OpenRouter.
 */

import { searchDuckDuckGo } from "../contentResearch/http.js";
import { LOCAL_API_BASE } from "./configs.js";

function mapRows(rows, source) {
	return (rows || [])
		.map((r) => ({
			title: r.title || "",
			url: r.url || r.link || "",
			link: r.url || r.link || "",
			snippet: r.snippet || r.description || "",
			source: r.source || source,
		}))
		.filter((r) => r.url);
}

let scrapeLock = Promise.resolve();
function withScrapeLock(fn) {
	const run = scrapeLock.then(fn, fn);
	scrapeLock = run.then(
		() => {},
		() => {},
	);
	return run;
}

async function scrapeGoogleSearch(query, opts = {}) {
	return withScrapeLock(async () => {
		const baseUrl = String(opts.baseUrl || LOCAL_API_BASE).replace(/\/$/, "");
		const num = Math.min(10, Math.max(1, opts.num || 8));
		const res = await fetch(`${baseUrl}/google-search`, {
			method: "POST",
			signal: AbortSignal.timeout(opts.timeoutMs || 45_000),
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query,
				num,
				country: opts.country || "gb",
				language: opts.language || "en",
				skipDdgFallback: false,
				useProxy: false,
			}),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			throw new Error(data.error || `Google scrape HTTP ${res.status}`);
		}
		return mapRows(data.results, data.source || "google-search");
	});
}

/**
 * DuckDuckGo first (no keys). If thin, POST /google-search (Puppeteer scrape).
 * @param {string} query
 * @param {{ baseUrl?: string, num?: number }} [opts]
 */
export async function clubGoogleSearch(query, opts = {}) {
	const q = String(query || "").trim();
	if (!q) return [];
	const num = opts.num || 8;
	let ddg = [];
	try {
		ddg = await searchDuckDuckGo(q, num);
	} catch {
		ddg = [];
	}
	if (ddg.length >= 3) return mapRows(ddg, "duckduckgo");

	try {
		const scraped = await scrapeGoogleSearch(q, opts);
		if (scraped.length) return scraped;
	} catch (err) {
		console.warn(`[england-clubs] /google-search "${q.slice(0, 60)}": ${err?.message || err}`);
	}

	return mapRows(ddg, "duckduckgo");
}

export function isVendorKeyError(msg) {
	return /api key expired|renew the api key|insufficient credits|invalid api key|cse |custom search/i.test(
		String(msg || ""),
	);
}
