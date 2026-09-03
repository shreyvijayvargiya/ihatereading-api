/**
 * Shared HTTP helpers for content research.
 * Prefer this API's /google-search; fall back to DuckDuckGo HTML.
 */

import { resolveScrapeBaseUrl } from "../scrapefast.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const UA =
	process.env.CONTENT_RESEARCH_USER_AGENT ||
	"ihatereading-content-research/1.0 (+https://ihatereading.in)";

/**
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [options]
 */
export async function fetchWithTimeout(url, options = {}) {
	const { timeoutMs = DEFAULT_TIMEOUT_MS, headers, ...rest } = options;
	const res = await fetch(url, {
		...rest,
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			"User-Agent": UA,
			Accept: "application/json, text/html, */*",
			...(headers || {}),
		},
	});
	return res;
}

export function resolveResearchBaseUrl(c = null) {
	return resolveScrapeBaseUrl(c).replace(/\/$/, "");
}

/**
 * Google/web search with layered fallbacks.
 * Prefer Firecrawl + CSE (reliable); Puppeteer /google-search and DDG are last-resort.
 *
 * @param {string} query
 * @param {{ baseUrl?: string, num?: number, country?: string, language?: string, useProxy?: boolean, debug?: boolean }} [opts]
 */
export async function googleSearch(query, opts = {}) {
	const baseUrl =
		opts.baseUrl ||
		resolveResearchBaseUrl() ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;
	const num = Math.min(10, Math.max(1, opts.num || 8));

	// 1) Firecrawl search — works with site:linkedin (CSE/Puppeteer/DDG often empty)
	const fc = await firecrawlSearch(query, {
		num,
		country: opts.country,
	});
	if (fc.results?.length) return fc.results;
	if (fc.error && opts.debug) {
		console.warn(`[googleSearch] Firecrawl: ${fc.error}`);
	}

	// 2) Google Custom Search API when configured
	const cse = await googleCustomSearch(query, {
		num,
		country: opts.country,
	});
	if (cse.results?.length) return cse.results;
	if (cse.error && opts.debug) {
		console.warn(`[googleSearch] CSE: ${cse.error}`);
	}

	// 3) Local /google-search (Puppeteer)
	for (const useProxy of [Boolean(opts.useProxy), false]) {
		if (opts.useProxy === false && useProxy) continue;
		try {
			const res = await fetch(`${baseUrl}/google-search`, {
				method: "POST",
				signal: AbortSignal.timeout(90_000),
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					query,
					num,
					country: opts.country || "us",
					language: opts.language || "en",
					skipDdgFallback: false,
					useProxy,
				}),
			});
			const data = await res.json().catch(() => ({}));
			const results = Array.isArray(data.results) ? data.results : [];
			if (results.length) {
				return results.map((r) => ({
					title: r.title || "",
					url: r.link || r.url || "",
					link: r.link || r.url || "",
					snippet: r.snippet || r.description || "",
					source: data.source || "google-search",
				}));
			}
		} catch {
			/* try next */
		}
		if (opts.useProxy === true) break;
	}

	// 4) DuckDuckGo HTML (often empty / blocked)
	try {
		const ddg = await searchDuckDuckGo(query, num);
		if (ddg.length) return ddg;
	} catch {
		/* ignore */
	}
	return [];
}

/**
 * Firecrawl /v1/search — reliable SERP when local scrapers + CSE are dead.
 * Env: FIRECRAWL_API_KEY
 */
export async function firecrawlSearch(query, opts = {}) {
	const key = (process.env.FIRECRAWL_API_KEY || "").trim();
	if (!key) return { results: [], error: null };

	try {
		const res = await fetch("https://api.firecrawl.dev/v1/search", {
			method: "POST",
			signal: AbortSignal.timeout(45_000),
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query,
				limit: Math.min(10, Math.max(1, opts.num || 8)),
				...(opts.country
					? { country: String(opts.country).toLowerCase() }
					: {}),
			}),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok || data.success === false) {
			return {
				results: [],
				error: data.error || `Firecrawl HTTP ${res.status}`,
			};
		}
		const raw = Array.isArray(data.data)
			? data.data
			: Array.isArray(data.web)
				? data.web
				: [];
		const results = raw
			.map((r) => ({
				title: r.title || "",
				url: r.url || r.link || "",
				link: r.url || r.link || "",
				snippet: r.description || r.snippet || "",
				source: "firecrawl",
			}))
			.filter((r) => r.url);
		return { results, error: null };
	} catch (err) {
		return { results: [], error: err?.message || String(err) };
	}
}

/**
 * Google Programmable Search (Custom Search JSON API).
 * Env: GOOGLE_CSE_ID + GOOGLE_CSE_API_KEY|GOOGLE_API_KEY
 */
export async function googleCustomSearch(query, opts = {}) {
	const key = (
		process.env.GOOGLE_CSE_API_KEY ||
		process.env.GOOGLE_API_KEY ||
		""
	).trim();
	const cx = (process.env.GOOGLE_CSE_ID || "").trim();
	if (!key || !cx) return { results: [], error: null };

	try {
		const params = new URLSearchParams({
			key,
			cx,
			q: query,
			num: String(Math.min(10, Math.max(1, opts.num || 8))),
		});
		if (opts.country) params.set("gl", String(opts.country).toLowerCase());
		params.set("hl", opts.language || "en");
		const res = await fetch(
			`https://www.googleapis.com/customsearch/v1?${params}`,
			{ signal: AbortSignal.timeout(20_000) },
		);
		const data = await res.json().catch(() => ({}));
		if (data.error) {
			return {
				results: [],
				error: data.error.message || `CSE HTTP ${res.status}`,
			};
		}
		const results = (data.items || []).map((it) => ({
			title: it.title || "",
			url: it.link || "",
			link: it.link || "",
			snippet: it.snippet || "",
			source: "google-cse",
		}));
		return { results, error: null };
	} catch (err) {
		return { results: [], error: err?.message || String(err) };
	}
}

/**
 * Lightweight DuckDuckGo HTML SERP (no API key).
 * @param {string} query
 * @param {number} [maxResults]
 */
export async function searchDuckDuckGo(query, maxResults = 10) {
	const endpoints = [
		`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
		`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
	];
	for (const searchUrl of endpoints) {
		try {
			const res = await fetchWithTimeout(searchUrl, {
				timeoutMs: 8_000,
				headers: {
					Accept: "text/html,application/xhtml+xml",
					"Accept-Language": "en-US,en;q=0.9",
				},
			});
			if (!res.ok) continue;
			const html = await res.text();
			const results = parseDdgHtml(html, maxResults);
			if (results.length) return results;
		} catch {
			/* try next */
		}
	}
	return [];
}

function parseDdgHtml(html, maxResults) {
	const out = [];
	const re =
		/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	let m;
	while ((m = re.exec(html)) && out.length < maxResults) {
		let href = m[1];
		const title = String(m[2] || "")
			.replace(/<[^>]+>/g, "")
			.replace(/\s+/g, " ")
			.trim();
		try {
			const u = new URL(href, "https://duckduckgo.com");
			if (u.pathname === "/l/" && u.searchParams.get("uddg")) {
				href = decodeURIComponent(u.searchParams.get("uddg"));
			} else {
				href = u.href;
			}
		} catch {
			continue;
		}
		if (!/^https?:\/\//i.test(href)) continue;
		out.push({
			title,
			url: href,
			link: href,
			snippet: "",
			source: "duckduckgo",
		});
	}
	return out;
}
