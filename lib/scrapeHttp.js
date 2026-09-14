/**
 * Fast HTTP-first scrape path — fetch HTML without headless Chromium.
 * Falls back to Puppeteer when content is empty, blocked, or browser-only.
 */

import { JSDOM } from "jsdom";
import { extractSemanticContentWithFormattedMarkdown } from "./extractSemanticContent.js";
import { generateScreenshotHeaders } from "./prepareScreenshotPage.js";

const MIN_MARKDOWN_CHARS = 80;
const MIN_BODY_TEXT_CHARS = 120;

const BROWSER_ONLY_HOST_RE =
	/\b(g2\.com|g2crowd\.com|instagram\.com|facebook\.com|linkedin\.com)\b/i;

const BLOCKED_HTML_RE =
	/(checking your browser|cf-browser-verification|cf-challenge|enable javascript|just a moment|access denied|bot detection|security check|please turn javascript on)/i;

const NOISE_SELECTORS = [
	"header",
	"footer",
	"nav",
	"aside",
	".header",
	".top",
	".navbar",
	"#header",
	".footer",
	".bottom",
	"#footer",
	".sidebar",
	".side",
	".aside",
	"#sidebar",
	".modal",
	".popup",
	"#modal",
	".overlay",
	".ad",
	".ads",
	".advert",
	"#ad",
	".lang-selector",
	".language",
	"#language-selector",
	".social",
	".social-media",
	".social-links",
	"#social",
	".menu",
	".navigation",
	"#nav",
	".breadcrumbs",
	"#breadcrumbs",
	".share",
	"#share",
	".widget",
	"#widget",
	".cookie",
	"#cookie",
	"script",
	"style",
	"noscript",
];

/**
 * @param {string} url
 * @param {object} [options]
 */
export function requiresBrowserForScrape(url, options = {}) {
	if (options.takeScreenshot) return true;
	if (options.useProxy) return true;
	if (options.waitForSelector) return true;
	if (options.includeCache) return true;
	if (options.forceBrowser === true || options.preferBrowser === true) return true;
	const u = String(url || "");
	if (BROWSER_ONLY_HOST_RE.test(u)) return true;
	return false;
}

/**
 * @param {string} html
 */
export function extractNextDataMarkdownFromHtml(html) {
	const m = html.match(
		/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
	);
	if (!m?.[1]) return "";
	try {
		const data = JSON.parse(m[1]);
		const seo = data?.props?.pageProps?.seoData;
		if (!seo) return "";
		const lines = [];
		if (seo.title) lines.push(`# ${seo.title}`);
		if (seo.description) lines.push("", seo.description);
		if (seo.keywords) lines.push("", `Keywords: ${seo.keywords}`);
		return lines.join("\n").trim();
	} catch {
		return "";
	}
}

function innerTextFromDoc(doc) {
	const roots = [
		doc.getElementById("__next"),
		doc.getElementById("root"),
		doc.querySelector("main"),
		doc.querySelector('[role="main"]'),
		doc.querySelector("#content"),
		doc.body,
	].filter(Boolean);
	let best = "";
	for (const el of roots) {
		const t = String(el.textContent || "")
			.replace(/\s+/g, " ")
			.trim();
		if (t.length > best.length) best = t;
	}
	return best;
}

function isHttpScrapeSufficient({ html, markdown, scrapedData }) {
	const md = String(markdown || "").trim();
	if (md.length >= MIN_MARKDOWN_CHARS) return true;
	const title = String(scrapedData?.title || "").trim();
	const bodyText = innerTextFromDoc(
		new JSDOM(html || "<html></html>").window.document,
	);
	if (title.length > 3 && bodyText.length >= MIN_BODY_TEXT_CHARS) return true;
	return false;
}

/**
 * @param {Document} doc
 * @param {string} pageUrl
 * @param {object} options
 */
export function buildScrapedDataFromDocument(doc, pageUrl, options = {}) {
	const {
		selectors = {},
		includeSemanticContent = true,
		includeImages = true,
		includeLinks = true,
		extractMetadata = true,
	} = options;

	const data = {
		url: pageUrl,
		title: doc.title || "",
		content: {},
		metadata: {},
		links: [],
		images: [],
		screenshot: null,
		orderedContent: null,
	};

	if (extractMetadata) {
		doc.querySelectorAll("meta").forEach((meta) => {
			const name = meta.getAttribute("name") || meta.getAttribute("property");
			const content = meta.getAttribute("content");
			if (name && content) data.metadata[name] = content;
		});
	}

	if (includeLinks) {
		const currentUrl = new URL(pageUrl);
		const seedDomain = currentUrl.hostname;
		const seen = new Set();
		data.links = Array.from(doc.querySelectorAll("a[href]"))
			.map((link) => ({
				text: (link.textContent || "").trim(),
				href: link.href,
				title: link.getAttribute("title") || "",
			}))
			.filter((link) => {
				try {
					if (new URL(link.href).hostname !== seedDomain) return false;
				} catch {
					return false;
				}
				if (!(link.text?.length > 0 || link.title?.length > 0)) return false;
				const key = `${link.text}|${link.href}|${link.title}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
	}

	["h1", "h2", "h3", "h4", "h5", "h6"].forEach((tag) => {
		data.content[tag] = Array.from(doc.querySelectorAll(tag)).map((h) =>
			(h.textContent || "").trim(),
		);
	});

	if (includeSemanticContent) {
		const ext = (sel, proc = (el) => (el.textContent || "").trim()) =>
			Array.from(doc.querySelectorAll(sel)).map(proc);
		const extTable = (t) =>
			Array.from(t.querySelectorAll("tr"))
				.map((r) =>
					Array.from(r.querySelectorAll("td, th"))
						.map((c) => (c.textContent || "").trim())
						.filter(Boolean),
				)
				.filter((r) => r.length > 0);
		const extList = (l) =>
			Array.from(l.querySelectorAll("li"))
				.map((li) => (li.textContent || "").trim())
				.filter(Boolean);

		data.content.semanticContent = {
			articleContent: ext("article"),
			divs: ext("div"),
			paragraphs: ext("p"),
			span: ext("span"),
			blockquotes: ext("blockquote"),
			codeBlocks: ext("code"),
			preformatted: ext("pre"),
			tables: ext("table", extTable),
			unorderedLists: ext("ul", extList),
			orderedLists: ext("ol", extList),
		};
	}

	if (includeImages) {
		data.images = Array.from(doc.querySelectorAll("img[src]"))
			.filter(
				(img) =>
					!["data:image/", "blob:", "image:", "data:"].some((p) =>
						img.src.startsWith(p),
					),
			)
			.map((img) => ({
				src: img.src,
				alt: img.getAttribute("alt") || "",
				title: img.getAttribute("title") || "",
				width: Number(img.getAttribute("width")) || null,
				height: Number(img.getAttribute("height")) || null,
			}));
	}

	if (selectors && Object.keys(selectors).length > 0) {
		data.customSelectors = {};
		for (const [key, selector] of Object.entries(selectors)) {
			try {
				const els = doc.querySelectorAll(selector);
				data.customSelectors[key] =
					els.length === 1
						? (els[0].textContent || "").trim()
						: Array.from(els).map((e) => (e.textContent || "").trim());
			} catch {
				data.customSelectors[key] = null;
			}
		}
	}

	return data;
}

/**
 * @param {string} html
 * @param {string} pageUrl
 * @param {object} options
 */
export function buildScrapePayloadFromHtml(html, pageUrl, options = {}) {
	if (!html || html.length < 80) {
		return { sufficient: false, scrapedData: {}, markdown: "" };
	}
	if (BLOCKED_HTML_RE.test(html)) {
		return { sufficient: false, scrapedData: {}, markdown: "" };
	}

	const dom = new JSDOM(html, { url: pageUrl });
	const doc = dom.window.document;
	NOISE_SELECTORS.forEach((sel) =>
		doc.querySelectorAll(sel).forEach((el) => el.remove()),
	);

	const scrapedData = buildScrapedDataFromDocument(doc, pageUrl, options);
	let { markdown } = extractSemanticContentWithFormattedMarkdown(doc.body);

	const markdownTooShort =
		!markdown || String(markdown).trim().length < MIN_MARKDOWN_CHARS;
	if (markdownTooShort) {
		const plain = innerTextFromDoc(doc)
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		if (plain && plain.length > String(markdown || "").trim().length) {
			markdown = plain;
		}
	}

	if (!markdown || String(markdown).trim().length < 40) {
		const nextMd = extractNextDataMarkdownFromHtml(html);
		if (nextMd && nextMd.length > String(markdown || "").trim().length) {
			markdown = nextMd;
		}
	}

	const sufficient = isHttpScrapeSufficient({ html, markdown, scrapedData });
	return { sufficient, scrapedData, markdown: markdown || "" };
}

/**
 * @param {string} url
 * @param {{ timeout?: number }} [options]
 */
export async function fetchPageHtml(url, options = {}) {
	const timeout = options.timeout ?? 30_000;
	const { userAgent, extraHTTPHeaders } = generateScreenshotHeaders();
	const res = await fetch(url, {
		method: "GET",
		signal: AbortSignal.timeout(timeout),
		headers: {
			"User-Agent": userAgent,
			Accept:
				"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
			...extraHTTPHeaders,
		},
		redirect: "follow",
	});
	if (!res.ok) {
		throw new Error(`HTTP fetch failed: ${res.status}`);
	}
	const html = await res.text();
	if (!html || html.length < 40) {
		throw new Error("HTTP fetch returned empty HTML");
	}
	return { html, finalUrl: res.url || url };
}

/**
 * Try lightweight HTTP scrape. Returns null when browser should be used instead.
 * @param {string} url
 * @param {object} options
 */
export async function tryScrapeWithHttp(url, options = {}) {
	if (requiresBrowserForScrape(url, options)) return null;

	try {
		const { html, finalUrl } = await fetchPageHtml(url, {
			timeout: options.timeout ?? 30_000,
		});
		const payload = buildScrapePayloadFromHtml(html, finalUrl, options);
		if (!payload.sufficient) return null;

		return {
			success: true,
			data: payload.scrapedData,
			markdown: payload.markdown,
			summary: null,
			screenshot: null,
		};
	} catch (err) {
		console.warn("[scrape] HTTP fast-path failed:", err?.message || err);
		return null;
	}
}
