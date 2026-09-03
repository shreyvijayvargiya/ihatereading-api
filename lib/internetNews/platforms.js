/**
 * Discover article URLs from Google News (keyword) + list pages / RSS.
 */

import { load } from "cheerio";
import { fetchRssFeed, scrapeGoogleNews, scrapeUrl } from "../scrapefast.js";
import { NEWS_KEYWORDS, clampUrlsPerPlatform, keywordQuery } from "./configs.js";
import { normalizeUrl } from "./core.js";

function hrefOf(link) {
	if (!link) return "";
	if (typeof link === "string") return link.trim();
	return String(link.href || link.url || link.link || "").trim();
}

function textOf(link) {
	if (!link || typeof link === "string") return String(link || "").trim();
	return String(link.text || link.title || link.name || "").trim();
}

const SKIP_HOST =
	/accounts\.google|support\.google|play\.google|policies\.google|facebook\.com|twitter\.com|x\.com\/intent|linkedin\.com\/share|instagram\.com/i;

const SKIP_PATH =
	/\/(login|signin|signup|register|privacy|terms|cookie|careers|about-us|contact|subscribe|advertis|cdn-cgi|wp-admin)\b/i;

function hostOf(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return "";
	}
}

function looksLikeAsset(url) {
	return /\.(png|jpe?g|gif|webp|svg|css|js|woff2?|mp4|pdf)(\?|$)/i.test(url);
}

export function parseRssItems(xml) {
	const $ = load(String(xml || ""), { xmlMode: true });
	const out = [];
	$("item, entry").each((_, el) => {
		const node = $(el);
		const title = node.find("title").first().text().trim();
		let link =
			node.find("link").first().attr("href") ||
			node.find("link").first().text().trim() ||
			node.find("guid").first().text().trim();
		const snippet = (
			node.find("description").first().text() ||
			node.find("summary").first().text() ||
			""
		)
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 400);
		const publishedAt =
			node.find("pubDate").first().text().trim() ||
			node.find("published").first().text().trim() ||
			node.find("updated").first().text().trim() ||
			null;
		if (!link || !title) return;
		out.push({
			title,
			url: normalizeUrl(link),
			snippet,
			publishedAt,
		});
	});
	return out;
}

function hostAllowed(url, platform) {
	const host = hostOf(url);
	if (!host || SKIP_HOST.test(host)) return false;
	if (platform.allowOffsite) return true;
	const allow = platform.hostAllow || [];
	if (!allow.length) return true;
	return allow.some(
		(h) => host === h || host.endsWith(`.${h}`),
	);
}

function pathOk(url, platform) {
	let path = "/";
	try {
		path = new URL(url).pathname;
	} catch {
		return false;
	}
	if (SKIP_PATH.test(path)) return false;
	for (const re of platform.pathDeny || []) {
		if (re.test(path) || re.test(url)) return false;
	}
	const allow = platform.pathAllow || [];
	if (!allow.length) return true;
	return allow.some((re) => re.test(path) || re.test(url));
}

export function pickTopUrls(links, platform, limit) {
	const cap = clampUrlsPerPlatform(limit);
	const seen = new Set();
	const out = [];
	for (const link of links || []) {
		const raw = hrefOf(link);
		if (!raw || !/^https?:\/\//i.test(raw)) continue;
		if (looksLikeAsset(raw)) continue;
		const url = normalizeUrl(raw);
		if (!url || seen.has(url)) continue;
		if (!hostAllowed(url, platform)) continue;
		if (!pathOk(url, platform)) continue;
		if (platform.listUrl && url.replace(/\/$/, "") === normalizeUrl(platform.listUrl)) {
			continue;
		}
		seen.add(url);
		out.push({
			title: textOf(link) || url,
			url,
			snippet: "",
			source: hostOf(url),
		});
		if (out.length >= cap) break;
	}
	return out;
}

async function scrapeListPage(platform, baseUrl) {
	const row = await scrapeUrl(platform.listUrl, {
		baseUrl,
		timeoutMs: 75_000,
		timeout: 50_000,
		includeImages: false,
		includeLinks: true,
		waitForSelector: "a",
	});
	const links = row.links || row.data?.links || [];
	return { links, via: "scrape", error: null };
}

/**
 * @param {object} platform
 * @param {{ baseUrl?: string, limit?: number, keyword?: string }} opts
 */
export async function discoverPlatformStories(platform, opts = {}) {
	const limit = clampUrlsPerPlatform(opts.limit);
	const baseUrl = opts.baseUrl;

	if (platform.kind === "google-news") {
		const keyword = String(opts.keyword || keywordQuery(NEWS_KEYWORDS[0])).trim();
		const data = await scrapeGoogleNews(keyword, {
			baseUrl,
			limit,
		});
		const news = Array.isArray(data.news) ? data.news : [];
		return {
			via: "google-news",
			keyword,
			items: news.slice(0, limit).map((n) => ({
				title: n.title || n.url,
				url: normalizeUrl(n.url),
				snippet: n.snippet || "",
				source: n.source || "news.google.com",
				keyword,
			})),
			queries: [data.url || keyword],
		};
	}

	const errors = [];
	let items = [];

	if (platform.listUrl) {
		try {
			const page = await scrapeListPage(platform, baseUrl);
			items = pickTopUrls(page.links, platform, limit);
		} catch (err) {
			errors.push(err?.message || String(err));
			console.warn(
				`[internet-news] scrape ${platform.id}: ${err?.message || err}`,
			);
		}
	}

	if (items.length < 8 && platform.feedUrl) {
		try {
			const xml = await fetchRssFeed(platform.feedUrl);
			const rss = parseRssItems(xml)
				.filter((r) => r.url && hostAllowed(r.url, platform) && pathOk(r.url, platform))
				.slice(0, limit)
				.map((r) => ({
					...r,
					source: hostOf(r.url),
				}));
			const seen = new Set(items.map((i) => i.url));
			for (const row of rss) {
				if (seen.has(row.url)) continue;
				seen.add(row.url);
				items.push(row);
				if (items.length >= limit) break;
			}
		} catch (err) {
			errors.push(err?.message || String(err));
			console.warn(
				`[internet-news] rss ${platform.id}: ${err?.message || err}`,
			);
		}
	}

	return {
		via: items.length ? "list+rss" : "empty",
		keyword: null,
		items: items.slice(0, limit),
		queries: [platform.listUrl, platform.feedUrl].filter(Boolean),
		errors,
	};
}
