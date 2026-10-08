/**
 * Discover existing site content via sitemap + lightweight scrape.
 */

import { load } from "cheerio";
import { fetchWithTimeout } from "../../contentResearch/http.js";
import { scrapePage } from "./scraper.js";
import { getSite, saveSiteExistingContent } from "./firestore.js";
import {
	dedupeByUrl,
	domainHost,
	log,
	normalizeDomain,
	normalizeUrl,
	truncate,
} from "../utils.js";

const SITEMAP_PATHS = ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-0.xml"];

async function fetchXml(url) {
	const res = await fetchWithTimeout(url, {
		timeoutMs: 15_000,
		headers: { Accept: "application/xml, text/xml, */*" },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.text();
}

function parseSitemapLocs(xml, limit = 60) {
	const $ = load(xml, { xmlMode: true });
	const locs = [];
	$("loc").each((_, el) => {
		const loc = $(el).text().trim();
		if (loc) locs.push(loc);
	});
	return [...new Set(locs)].slice(0, limit);
}

async function discoverSitemapUrls(domain) {
	const origin = normalizeDomain(domain);
	const warnings = [];
	for (const path of SITEMAP_PATHS) {
		try {
			const xml = await fetchXml(`${origin}${path}`);
			const locs = parseSitemapLocs(xml, 80);
			if (locs.length) return { urls: locs, source: path };
		} catch (err) {
			warnings.push(`${path}: ${err?.message || err}`);
		}
	}
	return { urls: [], source: null, warnings };
}

function titleFromUrl(url) {
	try {
		const slug = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
		return slug
			.replace(/[-_]+/g, " ")
			.replace(/\.[a-z]+$/i, "")
			.trim();
	} catch {
		return "";
	}
}

/**
 * Load + optionally refresh existing content for a site.
 * @param {string} siteId
 * @param {{ baseUrl?: string, refresh?: boolean, scrapeSample?: number }} [opts]
 */
export async function getExistingContent(siteId, opts = {}) {
	const site = await getSite(siteId);
	if (!site) throw new Error(`Site not found: ${siteId}`);

	if (site.existingContent?.length && !opts.refresh) {
		return site.existingContent;
	}

	log("Loading existing content", siteId);
	const { urls, source } = await discoverSitemapUrls(site.domain);
	let pages = [];

	if (urls.length) {
		pages = urls.map((url) => ({
			title: titleFromUrl(url),
			url: normalizeUrl(url),
			description: "",
			headings: [],
			source: "sitemap",
		}));
	}

	// Enrich a small sample via scraper for descriptions/headings
	const sample = (opts.scrapeSample ?? 8);
	const toScrape = pages.slice(0, sample).map((p) => p.url);
	for (const url of toScrape) {
		const scraped = await scrapePage(url, { baseUrl: opts.baseUrl, maxText: 1500 });
		const idx = pages.findIndex((p) => p.url === url);
		if (idx >= 0 && scraped.title) {
			pages[idx] = {
				...pages[idx],
				title: scraped.title || pages[idx].title,
				description: scraped.description || "",
				headings: (scraped.headings || []).map((h) => h.text).slice(0, 8),
				source: "sitemap+scrape",
			};
		}
	}

	// Merge manual URLs from enrollment
	const manual = (site.existingArticleUrls || []).map((url) => ({
		title: titleFromUrl(url),
		url: normalizeUrl(url),
		description: "",
		headings: [],
		source: "manual",
	}));

	const merged = dedupeByUrl([...pages, ...manual]).map((p) => ({
		...p,
		domain: domainHost(site.domain),
	}));

	await saveSiteExistingContent(siteId, {
		existingContent: merged,
		existingContentSource: source || "manual",
		existingContentUpdatedAt: new Date().toISOString(),
	});

	log("Existing content loaded", `${merged.length} pages`);
	return merged;
}

export function findInternalLinkCandidates(topic, existingContent, limit = 10) {
	const title = String(topic.title || "").toLowerCase();
	const entities = (topic.entities || []).map((e) => String(e).toLowerCase());
	const words = new Set(
		title.split(/\s+/).filter((w) => w.length > 3),
	);

	const scored = [];
	for (const page of existingContent || []) {
		const hay = `${page.title} ${page.description} ${(page.headings || []).join(" ")}`.toLowerCase();
		let score = 0;
		for (const w of words) if (hay.includes(w)) score += 1;
		for (const e of entities) if (e && hay.includes(e)) score += 2;
		if (score > 0) {
			scored.push({
				title: page.title || titleFromUrl(page.url),
				url: page.url,
				description: truncate(page.description, 200),
				relevance: score >= 3 ? "high" : "medium",
				_score: score,
			});
		}
	}

	return scored
		.sort((a, b) => b._score - a._score)
		.slice(0, limit)
		.map(({ _score, ...rest }) => rest);
}
