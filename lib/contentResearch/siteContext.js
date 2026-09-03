/**
 * Build iHateReading site context (homepage scrape + sitemap + RSS)
 * so keyword research covers the full domain, not only the typed topic.
 */

import { load } from "cheerio";
import { scrapeUrl } from "../scrapefast.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import { fetchWithTimeout } from "./http.js";
import { dedupeBy, normalize } from "./utils.js";

const SITE_ORIGIN =
	(process.env.IHATEREADING_SITE_URL || "https://ihatereading.in").replace(
		/\/$/,
		"",
	);

const SITEMAP_CANDIDATES = [
	"/sitemap.xml",
	"/sitemap_index.xml",
	"/sitemap-0.xml",
];

const RSS_CANDIDATES = ["/rss.xml", "/feed", "/feed.xml", "/atom.xml", "/rss"];

async function fetchText(url) {
	const res = await fetchWithTimeout(url, {
		timeoutMs: 15_000,
		headers: {
			Accept: "application/xml, text/xml, application/rss+xml, text/html, */*",
		},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return res.text();
}

function parseSitemapLocs(xml, limit = 80) {
	const $ = load(xml, { xmlMode: true });
	const locs = [];
	$("loc").each((_, el) => {
		const loc = $(el).text().trim();
		if (loc) locs.push(loc);
	});
	return [...new Set(locs)].slice(0, limit);
}

function parseRssItems(xml, limit = 40) {
	const $ = load(xml, { xmlMode: true });
	const items = [];
	$("item, entry").each((_, el) => {
		if (items.length >= limit) return;
		const node = $(el);
		const title = node.find("title").first().text().trim();
		const link =
			node.find("link").attr("href") ||
			node.find("link").first().text().trim() ||
			"";
		const cat = node.find("category").first().text().trim();
		if (!title) return;
		items.push({
			title,
			url: link || undefined,
			category: cat || undefined,
		});
	});
	return items;
}

function titlesFromPaths(locs) {
	return locs
		.map((u) => {
			try {
				const path = new URL(u).pathname.replace(/\/$/, "");
				const slug = path.split("/").filter(Boolean).pop() || "";
				return slug
					.replace(/[-_]+/g, " ")
					.replace(/\.[a-z]+$/i, "")
					.trim();
			} catch {
				return "";
			}
		})
		.filter((t) => t.length > 2 && t.length < 80);
}

/**
 * @param {{ baseUrl?: string }} [opts]
 */
export async function loadSiteContext(opts = {}) {
	const warnings = [];
	const context = {
		origin: SITE_ORIGIN,
		homepageTitle: "",
		homepageSnippet: "",
		sitemapTitles: [],
		rssItems: [],
		categories: [],
		themes: [],
	};

	const settled = await Promise.allSettled([
		(async () => {
			const row = await scrapeUrl(SITE_ORIGIN, {
				baseUrl: opts.baseUrl,
				timeoutMs: 60_000,
				includeImages: false,
			});
			return {
				title: row?.data?.title || "",
				markdown: String(row?.markdown || "").slice(0, 6000),
			};
		})(),
		(async () => {
			for (const path of SITEMAP_CANDIDATES) {
				try {
					const xml = await fetchText(`${SITE_ORIGIN}${path}`);
					const locs = parseSitemapLocs(xml, 100);
					if (locs.length) return { path, locs };
				} catch {
					/* try next */
				}
			}
			return null;
		})(),
		(async () => {
			for (const path of RSS_CANDIDATES) {
				try {
					const xml = await fetchText(`${SITE_ORIGIN}${path}`);
					const items = parseRssItems(xml, 40);
					if (items.length) return { path, items };
				} catch {
					/* try next */
				}
			}
			return null;
		})(),
	]);

	if (settled[0].status === "fulfilled") {
		context.homepageTitle = settled[0].value.title || "";
		context.homepageSnippet = settled[0].value.markdown || "";
	} else {
		warnings.push(
			`Homepage scrape failed: ${settled[0].reason?.message || settled[0].reason}`,
		);
	}

	if (settled[1].status === "fulfilled" && settled[1].value) {
		context.sitemapTitles = titlesFromPaths(settled[1].value.locs).slice(0, 60);
	} else if (settled[1].status === "rejected") {
		warnings.push(
			`Sitemap fetch failed: ${settled[1].reason?.message || settled[1].reason}`,
		);
	} else {
		warnings.push("Sitemap not found on ihatereading.in");
	}

	if (settled[2].status === "fulfilled" && settled[2].value) {
		context.rssItems = settled[2].value.items;
		context.categories = [
			...new Set(
				settled[2].value.items
					.map((i) => i.category)
					.filter(Boolean)
					.map((c) => String(c).trim()),
			),
		].slice(0, 30);
	} else {
		warnings.push("RSS feed not found on ihatereading.in");
	}

	// Lightweight theme tokens from titles
	const blob = [
		context.homepageTitle,
		...context.sitemapTitles,
		...context.rssItems.map((i) => i.title),
	]
		.join(" ")
		.toLowerCase();
	const themeHints = [
		"next.js",
		"react",
		"saas",
		"firebase",
		"tailwind",
		"authentication",
		"boilerplate",
		"ai",
		"vercel",
		"typescript",
		"nodejs",
		"supabase",
		"payment",
		"portfolio",
		"scraping",
	].filter((t) => blob.includes(t.replace(".", "")) || blob.includes(t));
	context.themes = themeHints;

	return { siteContext: context, warnings };
}

/**
 * AI expands topic into research keywords using site categories / sitemap / RSS.
 * Research still comes from suggest/SERP afterward — this only seeds angles.
 *
 * @param {string} topic
 * @param {object} siteContext
 */
export async function aiKeywordSeedsFromSite(topic, siteContext) {
	if (!process.env.OPENROUTER_API_KEY?.trim()) {
		return { seeds: [], usage: null };
	}

	const rssTitles = (siteContext?.rssItems || [])
		.slice(0, 25)
		.map((i) => i.title)
		.join("\n- ");
	const sitemapSample = (siteContext?.sitemapTitles || []).slice(0, 40).join(", ");
	const cats = (siteContext?.categories || []).join(", ");
	const themes = (siteContext?.themes || []).join(", ");

	const { content, usage } = await openRouterChat({
		jsonMode: true,
		temperature: 0.3,
		maxTokens: 1400,
		timeoutMs: 60_000,
		messages: [
			{
				role: "system",
				content: `You plan SEO keyword seeds for iHateReading (developer publication).
Return ONLY JSON:
{ "seeds": [{ "keyword": string, "intent": "informational|commercial|comparison", "angle": string }] }

Rules:
- 15–25 seeds.
- Mix: (1) direct topic phrases, (2) bridges from topic → other site categories, (3) gap angles not already covered by listed article titles.
- Do NOT invent URLs or search volume.
- Prefer developer-focused phrases people actually search.`,
			},
			{
				role: "user",
				content: `User topic: ${topic}

Site: ${siteContext?.origin || SITE_ORIGIN}
Homepage title: ${siteContext?.homepageTitle || "n/a"}
Known themes: ${themes || "n/a"}
Categories: ${cats || "n/a"}
Sitemap title samples: ${sitemapSample || "n/a"}
Recent RSS titles:
- ${rssTitles || "n/a"}

Homepage snippet:
${String(siteContext?.homepageSnippet || "").slice(0, 2500)}`,
			},
		],
	});

	let parsed = {};
	try {
		parsed = parseJsonFromLLM(content);
	} catch {
		parsed = {};
	}
	const seeds = (Array.isArray(parsed.seeds) ? parsed.seeds : [])
		.map((s) => ({
			keyword: String(s.keyword || s.phrase || "").trim(),
			intent: s.intent || "informational",
			angle: s.angle || "",
			source: "site_ai",
		}))
		.filter((s) => s.keyword.length > 2 && s.keyword.length < 100);

	return {
		seeds: dedupeBy(seeds, (s) => s.keyword).slice(0, 25),
		usage,
	};
}

export { SITE_ORIGIN, normalize };
