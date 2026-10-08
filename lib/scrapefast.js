/**
 * Scrapefast client — all scraping goes through our own /scrape API.
 */

const DEFAULT_TIMEOUT_MS = 90_000;

export function resolveScrapeBaseUrl(c) {
	const envHint = (
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		""
	).trim();
	if (envHint) return envHint.replace(/\/$/, "");
	if (c?.req?.url) {
		try {
			const origin = new URL(c.req.url).origin;
			if (origin && origin !== "null") return origin;
		} catch {
			/* ignore */
		}
	}
	return `http://127.0.0.1:${process.env.PORT || 3002}`;
}

/**
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {number} [options.timeout]
 * @param {string|null} [options.waitForSelector]
 */
export async function scrapeUrl(url, options = {}) {
	const baseUrl = (options.baseUrl || resolveScrapeBaseUrl(options.c)).replace(
		/\/$/,
		"",
	);
	const res = await fetch(`${baseUrl}/scrape`, {
		method: "POST",
		signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			url,
			timeout: options.timeout || 45_000,
			waitForSelector: options.waitForSelector || null,
			includeSemanticContent: options.includeSemanticContent !== false,
			includeImages: options.includeImages === true,
			includeLinks: options.includeLinks !== false,
			extractMetadata: options.extractMetadata !== false,
			useProxy: options.useProxy === true,
			takeScreenshot: options.takeScreenshot === true,
		}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.success === false) {
		throw new Error(
			data.error || data.details || `Scrape failed HTTP ${res.status}`,
		);
	}
	return data;
}

export function buildGoogleSerpUrl(keyword, { language = "en", country = "in" } = {}) {
	const params = new URLSearchParams({
		q: keyword,
		hl: language,
		gl: country,
		num: "10",
		pws: "0",
	});
	return `https://www.google.com/search?${params.toString()}`;
}

/**
 * POST /scrape-google-news { keyword } (city+state still accepted).
 * @param {string} keyword
 * @param {{ baseUrl?: string, limit?: number, timeoutMs?: number }} [opts]
 */
export async function scrapeGoogleNews(keyword, opts = {}) {
	const q = String(keyword || "").trim();
	if (!q) throw new Error("keyword is required");
	const baseUrl = (opts.baseUrl || resolveScrapeBaseUrl(opts.c)).replace(
		/\/$/,
		"",
	);
	const res = await fetch(`${baseUrl}/scrape-google-news`, {
		method: "POST",
		signal: AbortSignal.timeout(opts.timeoutMs || 90_000),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			keyword: q,
			limit: opts.limit || 20,
		}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.success === false) {
		throw new Error(
			data.error || data.details || `Google News scrape failed HTTP ${res.status}`,
		);
	}
	return data;
}

/** Prefix variants for autocomplete-style mining via SERP scrape (not suggest API). */
export const AUTocomplete_PREFIXES = [
	"how",
	"why",
	"what",
	"is",
	"can",
	"does",
	"vs",
	"for",
];

/** Min delay between any reddit.com RSS request (default 10s). */
const REDDIT_RSS_INTERVAL_MS = Number(process.env.REDDIT_RSS_MIN_INTERVAL_MS || "10000");
let redditGlobalLastFetchAt = 0;

function rssSleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function isRedditFeedUrl(url) {
	return /reddit\.com/i.test(String(url || ""));
}

function redditFeedFallbacks(feedUrl) {
	const urls = [feedUrl];
	if (feedUrl.includes("www.reddit.com")) {
		urls.push(feedUrl.replace("www.reddit.com", "old.reddit.com"));
	} else if (feedUrl.includes("old.reddit.com")) {
		urls.push(feedUrl.replace("old.reddit.com", "www.reddit.com"));
	}
	return [...new Set(urls)];
}

async function paceRedditRss() {
	const elapsed = Date.now() - redditGlobalLastFetchAt;
	if (elapsed < REDDIT_RSS_INTERVAL_MS) {
		await rssSleep(REDDIT_RSS_INTERVAL_MS - elapsed);
	}
	redditGlobalLastFetchAt = Date.now();
}

async function fetchRssOnce(url) {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(45_000),
		headers: {
			"User-Agent":
				"ihatereading-scrapefast/1.0 (public RSS reader; +https://ihatereading.in)",
			Accept: "application/atom+xml, application/rss+xml, text/xml, */*",
		},
		redirect: "follow",
	});
	return res;
}

/**
 * Fetch Reddit public RSS/Atom XML. Uses direct HTTP with global reddit.com pacing
 * (default 8s between requests), retries on 429/network errors, old.reddit.com fallback.
 * @param {string} feedUrl
 * @param {{ maxRetries?: number }} [options]
 */
export async function fetchRssFeed(feedUrl, options = {}) {
	const maxRetries = options.maxRetries ?? 3;
	const candidates = isRedditFeedUrl(feedUrl)
		? redditFeedFallbacks(feedUrl)
		: [feedUrl];

	let lastError = null;

	for (const url of candidates) {
		let attempt = 0;
		while (attempt <= maxRetries) {
			if (isRedditFeedUrl(url)) {
				await paceRedditRss();
			}

			try {
				const res = await fetchRssOnce(url);

				if (res.status === 429) {
					const backoff = REDDIT_RSS_INTERVAL_MS * (attempt + 1);
					console.warn(
						`[scrapefast] RSS 429 for ${url}, backing off ${backoff}ms (attempt ${attempt + 1}/${maxRetries + 1})`,
					);
					await rssSleep(backoff);
					attempt += 1;
					continue;
				}

				if (!res.ok) {
					throw new Error(`RSS fetch failed HTTP ${res.status} for ${url}`);
				}

				const text = await res.text();
				if (!text.includes("<") || text.length < 100) {
					throw new Error(`RSS fetch returned non-XML for ${url}`);
				}
				return text;
			} catch (err) {
				lastError = err;
				const msg = err?.message || String(err);
				if (attempt >= maxRetries) break;
				const backoff = REDDIT_RSS_INTERVAL_MS * (attempt + 1);
				console.warn(
					`[scrapefast] RSS fetch failed for ${url}: ${msg} — retry in ${backoff}ms`,
				);
				await rssSleep(backoff);
				attempt += 1;
			}
		}
	}

	throw new Error(
		lastError?.message || `RSS fetch failed after retries: ${feedUrl}`,
	);
}
