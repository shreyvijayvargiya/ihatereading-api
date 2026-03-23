/**
 * Standalone Hono scraping API — drop-in server for:
 *   POST /scrape
 *   POST /scrape-multiple
 *   POST /take-screenshot
 *   POST /take-screenshot-multiple
 *   GET  /health
 *
 * Also bundles an inlined BrowserPool (same idea as ./browser-pool.js).
 *
 * Setup:
 *   1. Copy this file to your project root.
 *   2. Copy ./lib/extractSemanticContent.js from this repo (markdown extraction).
 *   3. npm i hono @hono/node-server puppeteer-core @sparticuz/chromium jsdom user-agents
 *   4. Optional (aiSummary on /scrape): npm i @google/genai @langchain/textsplitters
 *      and set GOOGLE_GENAI_API_KEY
 *
 * Run: node scrape-api-standalone.js
 * Env: PORT (default 3001), BROWSER_POOL_SIZE, PUPPETEER_EXECUTABLE_PATH (optional Chrome path),
 *      GOOGLE_GENAI_API_KEY (optional)
 */

import fs from "fs";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { JSDOM } from "jsdom";
import UserAgents from "user-agents";
import { extractSemanticContentWithFormattedMarkdown } from "./lib/extractSemanticContent.js";

// ─── BrowserPool (inlined; mirrors browser-pool.js) ─────────────────────────

const POOL_SIZE = parseInt(process.env.BROWSER_POOL_SIZE, 10) || 3;
const CHROME_LAUNCH_ARGS = [
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-dev-shm-usage",
	"--disable-gpu",
	"--disable-web-security",
	"--disable-extensions",
	"--no-zygote",
	"--single-process",
];

function pickSystemChromeExecutable() {
	const envPath =
		process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
	if (envPath && fs.existsSync(envPath)) return envPath;
	const candidates = [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
	];
	for (const p of candidates) {
		if (fs.existsSync(p)) return p;
	}
	return candidates[0];
}

class BrowserPool {
	constructor({ poolSize = POOL_SIZE } = {}) {
		this._pool = [];
		this._poolSize = poolSize;
		this._waitQueue = [];
		this._initialised = false;
		this._initialising = false;
		this._puppeteer = null;
		this._chromium = null;
	}

	async _loadDeps() {
		if (!this._puppeteer) {
			this._puppeteer = (await import("puppeteer-core")).default;
		}
		if (!this._chromium) {
			this._chromium = (await import("@sparticuz/chromium")).default;
		}
	}

	async _launchBrowser() {
		await this._loadDeps();
		let browser;
		try {
			const executablePath = await this._chromium.executablePath();
			browser = await this._puppeteer.launch({
				headless: true,
				args: [...this._chromium.args, "--disable-web-security"],
				executablePath,
				ignoreDefaultArgs: ["--disable-extensions"],
			});
		} catch {
			const fallback = pickSystemChromeExecutable();
			browser = await this._puppeteer.launch({
				headless: true,
				executablePath: fallback,
				args: CHROME_LAUNCH_ARGS,
			});
		}
		return browser;
	}

	async initialise() {
		if (this._initialised || this._initialising) return;
		this._initialising = true;
		console.log(`🚀 BrowserPool: launching ${this._poolSize} browser(s)…`);
		const launches = Array.from({ length: this._poolSize }, (_, i) =>
			this._launchBrowser().then((browser) => {
				const entry = { browser, busy: false, lastUsed: Date.now(), index: i };
				this._pool.push(entry);
				this._attachCrashHandler(entry);
				console.log(`  ✅ Browser #${i} ready`);
				return entry;
			}),
		);
		await Promise.all(launches);
		this._initialised = true;
		this._initialising = false;
		console.log(
			`🎉 BrowserPool initialised with ${this._pool.length} browser(s)`,
		);
	}

	_attachCrashHandler(entry) {
		entry.browser.on("disconnected", async () => {
			console.warn(`⚠️  Browser #${entry.index} disconnected — replacing…`);
			entry.busy = false;
			try {
				const replacement = await this._launchBrowser();
				entry.browser = replacement;
				entry.lastUsed = Date.now();
				this._attachCrashHandler(entry);
				console.log(`✅ Browser #${entry.index} replaced`);
			} catch (err) {
				console.error(`❌ Could not replace browser #${entry.index}:`, err);
			}
			this._drainQueue();
		});
	}

	_acquire() {
		const free = this._pool.find((e) => !e.busy);
		if (free) {
			free.busy = true;
			free.lastUsed = Date.now();
			return Promise.resolve(free);
		}
		return new Promise((resolve, reject) => {
			this._waitQueue.push({ resolve, reject });
		});
	}

	_release(entry) {
		entry.busy = false;
		entry.lastUsed = Date.now();
		this._drainQueue();
	}

	_drainQueue() {
		if (this._waitQueue.length === 0) return;
		const free = this._pool.find((e) => !e.busy);
		if (!free) return;
		const { resolve } = this._waitQueue.shift();
		free.busy = true;
		free.lastUsed = Date.now();
		resolve(free);
	}

	async withPage(task) {
		if (!this._initialised) await this.initialise();
		const entry = await this._acquire();
		let page;
		try {
			page = await entry.browser.newPage();
			return await task(page);
		} finally {
			if (page) {
				try {
					await page.close();
				} catch {
					/* ignore */
				}
			}
			this._release(entry);
		}
	}

	async destroy() {
		console.log("🛑 BrowserPool: shutting down…");
		await Promise.allSettled(this._pool.map((e) => e.browser.close()));
		this._pool = [];
		this._initialised = false;
		console.log("💤 BrowserPool: all browsers closed");
	}

	get stats() {
		return {
			size: this._pool.length,
			busy: this._pool.filter((e) => e.busy).length,
			free: this._pool.filter((e) => !e.busy).length,
			queued: this._waitQueue.length,
		};
	}
}

const browserPool = new BrowserPool();
browserPool.initialise().catch((err) => {
	console.error("❌ BrowserPool warm-up failed:", err);
});
process.on("SIGTERM", () => browserPool.destroy());
process.on("SIGINT", () => browserPool.destroy());

// ─── Rate limit ──────────────────────────────────────────────────────────────

const rateLimitMap = new Map();

function rateLimit(ip, limit, windowMs) {
	const now = Date.now();
	const record = rateLimitMap.get(ip);
	if (!record || now > record.resetTime) {
		rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
		return { allowed: true, remaining: limit - 1 };
	}
	if (record.count >= limit) {
		return {
			allowed: false,
			retryAfter: Math.ceil((record.resetTime - now) / 1000),
			remaining: 0,
		};
	}
	record.count++;
	return { allowed: true, remaining: limit - record.count };
}

setInterval(
	() => {
		const now = Date.now();
		for (const [ip, record] of rateLimitMap.entries()) {
			if (now > record.resetTime) rateLimitMap.delete(ip);
		}
	},
	5 * 60 * 1000,
);

// ─── Scrape helpers ──────────────────────────────────────────────────────────

function isValidURL(urlString) {
	try {
		new URL(urlString);
		return true;
	} catch {
		return false;
	}
}

function removeEmptyKeys(obj) {
	for (const key of Object.keys(obj)) {
		const value = obj[key];
		if (
			value === null ||
			(Array.isArray(value) && value.length === 0) ||
			(typeof value === "string" && value.trim() === "")
		) {
			delete obj[key];
		} else if (typeof value === "object" && value !== null) {
			removeEmptyKeys(value);
		}
	}
}

function rewriteUrl(url) {
	if (
		url.startsWith("https://docs.google.com/document/d/") ||
		url.startsWith("http://docs.google.com/document/d/")
	) {
		const id = url.match(/\/document\/d\/([-\w]+)/)?.[1];
		if (id) {
			return `https://docs.google.com/document/d/${id}/export?format=html`;
		}
	} else if (
		url.startsWith("https://docs.google.com/presentation/d/") ||
		url.startsWith("http://docs.google.com/presentation/d/")
	) {
		const id = url.match(/\/presentation\/d\/([-\w]+)/)?.[1];
		if (id) {
			return `https://docs.google.com/presentation/d/${id}/export?format=json`;
		}
	} else if (
		url.startsWith("https://drive.google.com/file/d/") ||
		url.startsWith("http://drive.google.com/file/d/")
	) {
		const id = url.match(/\/file\/d\/([-\w]+)/)?.[1];
		if (id) {
			return `https://drive.google.com/uc?export=download&id=${id}`;
		}
	} else if (
		url.startsWith("https://docs.google.com/spreadsheets/d/") ||
		url.startsWith("http://docs.google.com/spreadsheets/d/")
	) {
		const id = url.match(/\/spreadsheets\/d\/([-\w]+)/)?.[1];
		if (id) {
			return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:html`;
		}
	}
	return url;
}

const scrapJson = async (url) => {
	const response = await fetch(url);
	return response.json();
};

const scrapHtml = async (url) => {
	const response = await fetch(url);
	return response.text();
};

/** Same shape as in-browser extraction in index.js scrapeSingleUrlWithPuppeteer */
function dataExtractionFromHtml(html, options) {
	const {
		includeSemanticContent = false,
		includeImages = true,
		includeLinks = true,
		extractMetadata = true,
	} = options;
	const dom = new JSDOM(html);
	const document = dom.window.document;
	const data = {
		url: "",
		title: document.title || "",
		content: {},
		metadata: {},
		links: [],
		images: [],
	};
	const remove = [
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
	remove.forEach((sel) =>
		document.querySelectorAll(sel).forEach((el) => el.remove()),
	);
	["h1", "h2", "h3", "h4", "h5", "h6"].forEach((tag) => {
		data.content[tag] = Array.from(document.querySelectorAll(tag)).map((h) =>
			h.textContent.trim(),
		);
	});
	if (extractMetadata) {
		document.querySelectorAll("meta").forEach((meta) => {
			const name = meta.getAttribute("name") || meta.getAttribute("property");
			const content = meta.getAttribute("content");
			if (name && content) data.metadata[name] = content;
		});
		document.querySelectorAll('meta[property^="og:"]').forEach((meta) => {
			const p = meta.getAttribute("property");
			const c = meta.getAttribute("content");
			if (p && c) data.metadata[p] = c;
		});
		document.querySelectorAll('meta[name^="twitter:"]').forEach((meta) => {
			const n = meta.getAttribute("name");
			const c = meta.getAttribute("content");
			if (n && c) data.metadata[n] = c;
		});
	}
	let seedDomain = "";
	try {
		const b = document.querySelector("base[href]")?.getAttribute("href");
		if (b) seedDomain = new URL(b, "https://example.com").hostname;
	} catch {
		/* ignore */
	}
	if (includeLinks) {
		const seen = new Set();
		data.links = Array.from(document.querySelectorAll("a[href]"))
			.map((link) => ({
				text: link.textContent.trim(),
				href: link.href,
				title: link.getAttribute("title") || "",
			}))
			.filter((link) => {
				if (!(link?.text?.length > 0 || link?.title?.length > 0)) return false;
				try {
					const u = new URL(link.href);
					if (u.protocol !== "http:" && u.protocol !== "https:") return false;
					if (seedDomain && u.hostname !== seedDomain) return false;
				} catch {
					return false;
				}
				const key = `${link.text}|${link.href}|${link.title}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
	}
	if (includeSemanticContent) {
		const ext = (sel, proc = (el) => el.textContent.trim()) =>
			Array.from(document.querySelectorAll(sel)).map(proc);
		const extTable = (t) =>
			Array.from(t.querySelectorAll("tr"))
				.map((r) =>
					Array.from(r.querySelectorAll("td, th"))
						.map((c) => c.textContent.trim())
						.filter(Boolean),
				)
				.filter((r) => r.length > 0);
		const extList = (l) =>
			Array.from(l.querySelectorAll("li"))
				.map((li) => li.textContent.trim())
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
		data.images = Array.from(document.querySelectorAll("img[src]"))
			.filter(
				(img) =>
					!["data:image/", "blob:", "image:", "data:"].some((p) =>
						img.src.startsWith(p),
					),
			)
			.map((img) => ({
				src: img.src,
				alt: img.alt || "",
				title: img.title || "",
				width: img.naturalWidth || img.width,
				height: img.naturalHeight || img.height,
			}));
	}
	return data;
}

function parseRedditData(rawJsonText, url) {
	let data;
	try {
		data = JSON.parse(rawJsonText);
	} catch {
		return { markdown: "Invalid Reddit JSON", posts: [] };
	}
	let listing = data;
	if (Array.isArray(data) && data.length > 0) {
		listing = data[0];
	}
	if (!listing || !listing.data || !listing.data.children) {
		return { markdown: "No Reddit data found", posts: [] };
	}

	const posts = [];
	let markdown = `# Reddit Posts from ${url}\n\n`;

	listing.data.children.forEach((child, index) => {
		if (child.kind === "t3" && child.data) {
			const post = child.data;
			const postData = {
				title: post.title || "No Title",
				author: post.author || "Unknown",
				subreddit: post.subreddit || "Unknown",
				score: post.score || 0,
				upvoteRatio: post.upvote_ratio || 0,
				numComments: post.num_comments || 0,
				created: new Date(post.created_utc * 1000).toISOString(),
				permalink: post.permalink ? `https://reddit.com${post.permalink}` : "",
				url: post.url || "",
				selftext: post.selftext || "",
				linkFlairText: post.link_flair_text || "",
				domain: post.domain || "",
				isSelf: post.is_self || false,
				stickied: post.stickied || false,
				over18: post.over_18 || false,
				spoiler: post.spoiler || false,
				locked: post.locked || false,
				archived: post.archived || false,
				distinguished: post.distinguished || null,
				gilded: post.gilded || 0,
				totalAwards: post.total_awards_received || 0,
			};
			posts.push(postData);
			markdown += `## Post ${index + 1}: ${postData.title}\n\n`;
			markdown += `**Author:** u/${postData.author}\n`;
			markdown += `**Subreddit:** r/${postData.subreddit}\n`;
			markdown += `**Score:** ${postData.score} (${Math.round(
				postData.upvoteRatio * 100,
			)}% upvoted)\n`;
			markdown += `**Comments:** ${postData.numComments}\n`;
			markdown += `**Posted:** ${postData.created}\n`;
			const status = [];
			if (postData.stickied) status.push("📌 Pinned");
			if (postData.locked) status.push("🔒 Locked");
			if (postData.archived) status.push("📁 Archived");
			if (postData.over18) status.push("🔞 NSFW");
			if (postData.spoiler) status.push("⚠️ Spoiler");
			if (postData.distinguished) status.push(`👑 ${postData.distinguished}`);
			if (postData.gilded > 0) status.push(`🏆 ${postData.gilded} gilded`);
			if (postData.totalAwards > 0)
				status.push(`🎖️ ${postData.totalAwards} awards`);
			if (status.length > 0) markdown += `**Status:** ${status.join(", ")}\n`;
			if (postData.linkFlairText) {
				markdown += `**Flair:** ${postData.linkFlairText}\n`;
			}
			if (postData.selftext) {
				markdown += `\n**Content:**\n${postData.selftext}\n`;
			}
			if (!postData.isSelf && postData.url) {
				markdown += `\n**External Link:** ${postData.url}\n`;
			}
			markdown += `\n**Reddit Link:** ${postData.permalink}\n\n---\n\n`;
		}
	});

	markdown += `## Summary\n\n`;
	markdown += `- **Total Posts:** ${posts.length}\n`;
	markdown += `- **Subreddit:** r/${posts[0]?.subreddit || "Unknown"}\n`;
	if (posts.length > 0) {
		markdown += `- **Total Score:** ${posts.reduce((s, p) => s + p.score, 0)}\n`;
		markdown += `- **Total Comments:** ${posts.reduce((s, p) => s + p.numComments, 0)}\n`;
		markdown += `- **Average Score:** ${Math.round(
			posts.reduce((s, p) => s + p.score, 0) / posts.length,
		)}\n`;
		markdown += `- **Average Upvote Ratio:** ${Math.round(
			(posts.reduce((s, p) => s + p.upvoteRatio, 0) / posts.length) * 100,
		)}%\n`;
	}

	return { markdown, posts };
}

const commonViewports = [
	{ width: 1920, height: 1080 },
	{ width: 1366, height: 768 },
	{ width: 1536, height: 864 },
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
];

const pickRandomViewport = () =>
	commonViewports[Math.floor(Math.random() * commonViewports.length)];

const generateRandomHeaders = () => {
	const acceptLanguages = [
		"en-US,en;q=0.9",
		"en-GB,en;q=0.9",
		"en-CA,en;q=0.8",
		"en-IN,en;q=0.8",
		"en;q=0.9",
	];
	const ua = new UserAgents();
	return {
		userAgent: ua.random().toString(),
		extraHTTPHeaders: {
			Accept:
				"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
			"Accept-Encoding": "gzip, deflate, br",
			"Accept-Language":
				acceptLanguages[Math.floor(Math.random() * acceptLanguages.length)],
			"Cache-Control": "no-cache",
			Pragma: "no-cache",
			"Sec-Ch-Ua":
				'"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
			"Sec-Ch-Ua-Mobile": "?0",
			"Sec-Ch-Ua-Platform": '"macOS"',
			"Sec-Fetch-Dest": "document",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Site": "none",
			"Sec-Fetch-User": "?1",
			"Upgrade-Insecure-Requests": "1",
		},
		viewport: pickRandomViewport(),
	};
};

async function maybeSummarizeMarkdown(markdown) {
	if (!markdown || !process.env.GOOGLE_GENAI_API_KEY) return null;
	try {
		const { RecursiveCharacterTextSplitter } =
			await import("@langchain/textsplitters");
		const { GoogleGenAI } = await import("@google/genai");
		const genai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENAI_API_KEY });
		const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
			separators: "\n\n",
			chunkSize: 1024,
			chunkOverlap: 128,
		});
		const chunks = await splitter.splitText(markdown);
		const chunked = chunks.slice(0, 3000).join("\n\n");
		const aiResponse = await genai.models.generateContent({
			model: "gemini-1.5-flash",
			contents: [
				{
					role: "user",
					parts: [
						{
							text: `Summarize the following markdown: ${chunked}; The length or token count for the summary depend on the content but always lies between 100 to 1000 tokens`,
						},
					],
				},
			],
		});
		return aiResponse.candidates[0].content.parts[0].text;
	} catch {
		return null;
	}
}

/**
 * Core scrape (no Supabase, Firebase, or proxy — portable for open source).
 * useProxy / includeCache are accepted for API compatibility but ignored.
 */
async function scrapeSingleUrlWithPuppeteer(
	url,
	{
		selectors = {},
		waitForSelector = null,
		timeout = 30000,
		includeSemanticContent = false,
		includeImages = true,
		includeLinks = true,
		extractMetadata = true,
		includeCache: _includeCache = false,
		useProxy: _useProxy = false,
		aiSummary = false,
		takeScreenshot = false,
	} = {},
) {
	void _includeCache;
	void _useProxy;

	let targetUrl = rewriteUrl(url) || url;

	if (targetUrl.includes("format=json")) {
		const data = await scrapJson(targetUrl);
		return {
			success: true,
			data,
			markdown: null,
			summary: null,
			screenshot: null,
		};
	}
	if (targetUrl.includes("format=html")) {
		const html = await scrapHtml(targetUrl);
		const data = dataExtractionFromHtml(html, {
			includeSemanticContent,
			includeImages,
			includeLinks,
			extractMetadata,
		});
		return {
			success: true,
			data,
			markdown: null,
			summary: null,
			screenshot: null,
		};
	}

	const poolResult = await browserPool.withPage(async (page) => {
		const { userAgent, extraHTTPHeaders, viewport } = generateRandomHeaders();
		await page.setViewport(viewport);
		await page.setUserAgent(userAgent);
		await page.setExtraHTTPHeaders(extraHTTPHeaders);

		await page.evaluateOnNewDocument(() => {
			Object.defineProperty(navigator, "webdriver", {
				get: () => undefined,
			});
			Object.defineProperty(navigator, "plugins", {
				get: () => [1, 2, 3, 4, 5],
			});
			Object.defineProperty(navigator, "languages", {
				get: () => ["en-US", "en"],
			});
			const orig = window.navigator.permissions.query;
			window.navigator.permissions.query = (p) =>
				p.name === "notifications"
					? Promise.resolve({ state: Notification.permission })
					: orig(p);
		});

		await page.setRequestInterception(true);
		page.on("request", (request) => {
			const resourceType = request.resourceType();
			const reqUrl = request.url().toLowerCase();
			if (
				(reqUrl.includes("vercel") &&
					(reqUrl.includes("security") || reqUrl.includes("checkpoint"))) ||
				reqUrl.includes("cloudflare") ||
				reqUrl.includes("bot-detection") ||
				reqUrl.includes("challenge")
			) {
				request.abort();
				return;
			}
			if (resourceType === "image") {
				request.abort();
				return;
			}
			const imgExts = [
				".jpg",
				".jpeg",
				".png",
				".gif",
				".bmp",
				".webp",
				".svg",
				".ico",
				".tiff",
				".tif",
				".heic",
				".heif",
				".avif",
			];
			if (imgExts.some((ext) => reqUrl.includes(ext))) {
				request.abort();
				return;
			}
			const imgServices = [
				"cdn",
				"images",
				"img",
				"photo",
				"pic",
				"media",
				"assets",
			];
			if (
				imgServices.some((s) => reqUrl.includes(s)) &&
				[".jpg", ".png", ".gif"].some((e) => reqUrl.includes(e))
			) {
				request.abort();
				return;
			}
			if (reqUrl.startsWith("data:image/")) {
				request.abort();
				return;
			}
			if (resourceType === "stylesheet") {
				request.respond({ status: 200, contentType: "text/css", body: "" });
				return;
			}
			if (resourceType === "font" || resourceType === "media") {
				request.abort();
				return;
			}
			request.continue();
		});

		if (targetUrl.includes("reddit.com")) {
			const redditUrl = targetUrl.endsWith("/")
				? targetUrl.slice(0, -1) + ".json"
				: targetUrl + "/.json";
			await page.goto(redditUrl, {
				waitUntil: "domcontentloaded",
				timeout,
			});
			const jsonText = await page.$eval("pre", (el) => el.textContent);
			const { markdown, posts } = parseRedditData(jsonText, targetUrl);
			return {
				summary: null,
				scrapedData: {
					posts,
					url: targetUrl,
					title: "Reddit Posts",
					metadata: null,
				},
				markdown,
				screenshotUrl: null,
			};
		}

		await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout });

		if (waitForSelector) {
			try {
				await page.waitForSelector(waitForSelector, { timeout: 10000 });
			} catch {
				/* ignore */
			}
		}

		let scrapedData = {};
		if (includeSemanticContent) {
			scrapedData = await page.evaluate(
				(opts) => {
					const data = {
						url: window.location.href,
						title: document.title,
						content: {},
						metadata: {},
						links: [],
						images: [],
						screenshot: null,
						orderedContent: null,
					};
					const remove = [
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
					remove.forEach((sel) =>
						document.querySelectorAll(sel).forEach((el) => el.remove()),
					);
					["h1", "h2", "h3", "h4", "h5", "h6"].forEach((tag) => {
						data.content[tag] = Array.from(document.querySelectorAll(tag)).map(
							(h) => h.textContent.trim(),
						);
					});
					if (opts.extractMetadata) {
						document.querySelectorAll("meta").forEach((meta) => {
							const name =
								meta.getAttribute("name") || meta.getAttribute("property");
							const content = meta.getAttribute("content");
							if (name && content) data.metadata[name] = content;
						});
						document
							.querySelectorAll('meta[property^="og:"]')
							.forEach((meta) => {
								const p = meta.getAttribute("property");
								const c = meta.getAttribute("content");
								if (p && c) data.metadata[p] = c;
							});
						document
							.querySelectorAll('meta[name^="twitter:"]')
							.forEach((meta) => {
								const n = meta.getAttribute("name");
								const c = meta.getAttribute("content");
								if (n && c) data.metadata[n] = c;
							});
					}
					if (opts.includeLinks) {
						const currentUrl = new URL(window.location.href);
						const seedDomain = currentUrl.hostname;
						const seen = new Set();
						data.links = Array.from(document.querySelectorAll("a[href]"))
							.map((link) => ({
								text: link.textContent.trim(),
								href: link.href,
								title: link.getAttribute("title") || "",
							}))
							.filter((link) => {
								if (!(link?.text?.length > 0 || link?.title?.length > 0))
									return false;
								try {
									if (new URL(link.href).hostname !== seedDomain) return false;
								} catch {
									return false;
								}
								const key = `${link.text}|${link.href}|${link.title}`;
								if (seen.has(key)) return false;
								seen.add(key);
								return true;
							});
					}
					if (opts.includeSemanticContent) {
						const ext = (sel, proc = (el) => el.textContent.trim()) =>
							Array.from(document.querySelectorAll(sel)).map(proc);
						const extTable = (t) =>
							Array.from(t.querySelectorAll("tr"))
								.map((r) =>
									Array.from(r.querySelectorAll("td, th"))
										.map((c) => c.textContent.trim())
										.filter(Boolean),
								)
								.filter((r) => r.length > 0);
						const extList = (l) =>
							Array.from(l.querySelectorAll("li"))
								.map((li) => li.textContent.trim())
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
					if (opts.includeImages) {
						data.images = Array.from(document.querySelectorAll("img[src]"))
							.filter(
								(img) =>
									!["data:image/", "blob:", "image:", "data:"].some((p) =>
										img.src.startsWith(p),
									),
							)
							.map((img) => ({
								src: img.src,
								alt: img.alt || "",
								title: img.title || "",
								width: img.naturalWidth || img.width,
								height: img.naturalHeight || img.height,
							}));
					}
					if (opts.selectors && Object.keys(opts.selectors).length > 0) {
						data.customSelectors = {};
						for (const [key, selector] of Object.entries(opts.selectors)) {
							try {
								const els = document.querySelectorAll(selector);
								data.customSelectors[key] =
									els.length === 1
										? els[0].textContent.trim()
										: Array.from(els).map((e) => e.textContent.trim());
							} catch {
								data.customSelectors[key] = null;
							}
						}
					}
					return data;
				},
				{
					extractMetadata,
					includeImages,
					includeLinks,
					includeSemanticContent,
					selectors,
				},
			);
		}

		const pageHtml = await page.content();
		const dom = new JSDOM(pageHtml);
		const doc = dom.window.document;
		const remove = [
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
		remove.forEach((sel) =>
			doc.querySelectorAll(sel).forEach((el) => el.remove()),
		);
		const { markdown } = extractSemanticContentWithFormattedMarkdown(doc.body);

		let screenshotUrl = null;
		if (takeScreenshot) {
			try {
				const buf = await page.screenshot({ fullPage: true });
				screenshotUrl = `data:image/png;base64,${buf.toString("base64")}`;
			} catch {
				/* ignore */
			}
		}

		if (includeSemanticContent && scrapedData?.content) {
			removeEmptyKeys(scrapedData.content);
		}

		let summary = null;
		if (aiSummary && markdown) {
			summary = await maybeSummarizeMarkdown(markdown);
		}

		return { summary, scrapedData, markdown, screenshotUrl };
	});

	return {
		success: true,
		data: poolResult.scrapedData,
		markdown: poolResult.markdown,
		summary: poolResult.summary,
		screenshot: poolResult.screenshotUrl,
	};
}

// ─── Screenshot helpers ──────────────────────────────────────────────────────

const SCREENSHOT_VIEWPORT_MAP = {
	desktop: { width: 1920, height: 1080, scale: 1 },
	tablet: { width: 1024, height: 768, scale: 1 },
	mobile: { width: 375, height: 667, scale: 1 },
};

const screenshotUserAgents = new UserAgents();

const BLOCK_DISTRACTIONS_CSS = `
  [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i],
  [id*="onetrust" i], [class*="onetrust" i], [id*="gdpr" i], [class*="gdpr" i], [data-consent],
  .cc-banner, .cc-window, #cookie-notice, .cookie-notice, #truste-consent, [class*="optanon"],
  #CybotCookiebotDialog, .cookiebot, [class*="cookie-banner" i], .cookie-law-info-bar,
  .cky-consent-container, #cookielaw, [class*="tarteaucitron"],
  [class*="intercom" i], #intercom-container, [class*="drift" i], .drift-frame,
  [class*="zendesk" i], .zEWidget-launcher, [class*="crisp" i], #crisp-chatbox,
  [class*="tawk" i], #tawk-bubble, [class*="livechat" i], #chat-widget, .chat-widget,
  [class*="hubspot-messages" i], #hubspot-messages-iframe-container, .widget--chat,
  [class*="tidio" i], .tidio-chat, [id*="chat-" i],
  .ad, .ads, .advert, [id*="ad-" i], [class*="ad-container" i], .advertisement,
  .ad-slot, .google-ad, ins.adsbygoogle, [id*="google_ads" i], .ad-banner, .sidebar-ad,
  [class*="1Password" i], [id*="1password" i], .lastpass-overlay, #lp-iframe,
  [class*="bitwarden" i], [class*="dashlane" i], [class*="password-manager" i],
  iframe[src*="consent"], iframe[src*="cookie"], iframe[src*="intercom"], iframe[src*="drift"]
  { display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; }
`;

async function captureOneScreenshotWithPage(page, options) {
	const {
		url,
		device = "desktop",
		waitUntil = "domcontentloaded",
		waitForSelector,
		timeout = 50000,
		contentReadyTimeout = 12000,
		postLoadWaitMs = 1200,
		fullPage = false,
		coords,
		blockDistractions = true,
	} = options;

	const viewport =
		SCREENSHOT_VIEWPORT_MAP[device] || SCREENSHOT_VIEWPORT_MAP.desktop;
	await page.setViewport(viewport);
	await page.setUserAgent(screenshotUserAgents.random().toString());
	await page.setExtraHTTPHeaders({
		dnt: "1",
		"upgrade-insecure-requests": "1",
		accept:
			"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
		"sec-fetch-site": "none",
		"sec-fetch-mode": "navigate",
		"sec-fetch-user": "?1",
		"sec-fetch-dest": "document",
		"accept-language": "en-US,en;q=0.9",
	});
	await page.setRequestInterception(true);
	await page.setJavaScriptEnabled(true);
	page.on("request", (req) => req.continue());

	await page.goto(url, { waitUntil, timeout });

	if (waitForSelector) {
		try {
			await page.waitForSelector(waitForSelector, { timeout: 10000 });
		} catch {
			/* ignore */
		}
	}

	try {
		await page.waitForFunction(
			() => {
				const rs = document.readyState;
				const body = document.body;
				if (!body) return false;
				const rect = body.getBoundingClientRect();
				const textLen = (body.innerText || "").trim().length;
				const hasMedia =
					document.images.length > 0 || document.querySelector("video, canvas");
				return (
					(rs === "interactive" || rs === "complete") &&
					rect.width > 0 &&
					rect.height > 0 &&
					(textLen > 80 || hasMedia)
				);
			},
			{ timeout: Math.min(contentReadyTimeout, timeout) },
		);
	} catch {
		/* ignore */
	}

	if (postLoadWaitMs > 0) {
		await new Promise((r) => setTimeout(r, postLoadWaitMs));
	}

	if (blockDistractions && BLOCK_DISTRACTIONS_CSS) {
		await page.addStyleTag({ content: BLOCK_DISTRACTIONS_CSS }).catch(() => {});
		await new Promise((r) => setTimeout(r, 200));
	}

	let screenshotOptions = { optimizeForSpeed: true, encoding: "binary" };
	if (fullPage) {
		screenshotOptions.fullPage = true;
	} else if (
		coords &&
		typeof coords.x === "number" &&
		typeof coords.y === "number" &&
		typeof coords.width === "number" &&
		typeof coords.height === "number"
	) {
		screenshotOptions.clip = {
			x: coords.x,
			y: coords.y,
			width: coords.width,
			height: coords.height,
		};
	} else {
		screenshotOptions.clip = {
			x: 0,
			y: 0,
			width: viewport.width,
			height: viewport.height,
		};
	}
	const buffer = await page.screenshot(screenshotOptions);

	const pageHtml = await page.content();
	const dom = new JSDOM(pageHtml);
	const doc = dom.window.document;
	const remove = [
		"script",
		"style",
		"noscript",
		".ad",
		".ads",
		"#ad",
		".cookie",
		"#cookie",
		"[class*='consent']",
		"[id*='consent']",
		"[class*='intercom']",
		"[class*='chat-widget']",
	];
	remove.forEach((sel) =>
		doc.querySelectorAll(sel).forEach((el) => el.remove()),
	);
	const { markdown } = extractSemanticContentWithFormattedMarkdown(doc.body);

	let metadata = {};
	try {
		metadata = await page.evaluate(() => {
			const data = {};
			document.querySelectorAll("meta").forEach((meta) => {
				const n = meta.getAttribute("name") || meta.getAttribute("property");
				const c = meta.getAttribute("content");
				if (n && c) data[n] = c;
			});
			return data;
		});
	} catch {
		/* ignore */
	}

	return {
		buffer,
		metadata,
		markdown,
		dimensions: { width: viewport.width, height: viewport.height },
	};
}

function bufferToDataUrlPng(buffer) {
	return `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
}

// ─── Hono app ────────────────────────────────────────────────────────────────

const app = new Hono();
app.use("*", logger(console.log));
app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
	}),
);

app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

function clientIp(c) {
	return (
		c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown"
	);
}

app.post("/scrape", async (c) => {
	const RATE_LIMIT = 50;
	const RATE_WINDOW_MS = 10 * 60 * 1000;
	const ip = clientIp(c);
	const rl = rateLimit(ip, RATE_LIMIT, RATE_WINDOW_MS);
	if (!rl.allowed) {
		c.header("Retry-After", String(rl.retryAfter));
		c.header("X-RateLimit-Limit", String(RATE_LIMIT));
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Window", "10 minutes");
		return c.json(
			{
				success: false,
				error: "Rate limit exceeded",
				message: `You have exceeded ${RATE_LIMIT} requests per 10 minutes. Please retry after ${rl.retryAfter}s.`,
				retryAfter: rl.retryAfter,
				ip,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(rl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");

	let {
		url,
		selectors = {},
		waitForSelector = null,
		timeout = 30000,
		includeSemanticContent = true,
		includeImages = true,
		includeLinks = true,
		extractMetadata = true,
		includeCache = false,
		useProxy = false,
		aiSummary = false,
		takeScreenshot = false,
	} = await c.req.json();

	if (!url || !isValidURL(url)) {
		return c.json({ error: "URL is required or invalid" }, 400);
	}

	try {
		const result = await scrapeSingleUrlWithPuppeteer(url, {
			selectors,
			waitForSelector,
			timeout,
			includeSemanticContent,
			includeImages,
			includeLinks,
			extractMetadata,
			includeCache,
			useProxy,
			aiSummary,
			takeScreenshot,
		});
		return c.json({
			success: true,
			...result,
			url,
			timestamp: new Date().toISOString(),
			poolStats: browserPool.stats,
		});
	} catch (error) {
		console.error("❌ Web scraping error (Puppeteer):", error);
		return c.json(
			{
				success: false,
				error: "Failed to scrape URL using Puppeteer",
				details: error?.message || String(error),
				url,
			},
			500,
		);
	}
});

app.post("/scrape-multiple", async (c) => {
	const RATE_LIMIT = 100;
	const RATE_WINDOW_MS = 10 * 60 * 1000;
	const MAX_URLS = 20;
	const ip = clientIp(c);
	const rl = rateLimit(ip, RATE_LIMIT, RATE_WINDOW_MS);
	if (!rl.allowed) {
		c.header("Retry-After", String(rl.retryAfter));
		return c.json(
			{
				success: false,
				error: "Rate limit exceeded",
				retryAfter: rl.retryAfter,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(rl.remaining));

	let {
		urls,
		selectors = {},
		waitForSelector = null,
		timeout = 30000,
		includeSemanticContent = true,
		includeImages = true,
		includeLinks = true,
		extractMetadata = true,
		includeCache = false,
		useProxy = false,
		aiSummary = false,
		takeScreenshot = false,
	} = await c.req.json();

	if (!Array.isArray(urls) || urls.length === 0) {
		return c.json(
			{ success: false, error: "urls must be a non-empty array" },
			400,
		);
	}
	if (urls.length > MAX_URLS) {
		return c.json(
			{ success: false, error: `Maximum ${MAX_URLS} URLs per request` },
			400,
		);
	}

	const options = {
		selectors,
		waitForSelector,
		timeout,
		includeSemanticContent,
		includeImages,
		includeLinks,
		extractMetadata,
		includeCache,
		useProxy,
		aiSummary,
		takeScreenshot,
	};

	const results = await Promise.all(
		urls.map(async (url) => {
			const inputUrl = typeof url === "string" ? url : (url?.url ?? url);
			if (!inputUrl || !isValidURL(inputUrl)) {
				return {
					url: inputUrl || "invalid",
					success: false,
					error: "Invalid or missing URL",
					data: {},
					markdown: null,
					summary: null,
					screenshot: null,
				};
			}
			try {
				const result = await scrapeSingleUrlWithPuppeteer(inputUrl, options);
				return {
					url: inputUrl,
					success: true,
					data: result.data,
					markdown: result.markdown,
					summary: result.summary,
					screenshot: result.screenshot,
					error: null,
				};
			} catch (err) {
				const msg = err?.message || "Scraping failed";
				console.warn(`⚠️ Scrape failed for ${inputUrl}:`, msg);
				return {
					url: inputUrl,
					success: false,
					error: msg,
					data: {},
					markdown: null,
					summary: null,
					screenshot: null,
				};
			}
		}),
	);

	return c.json({
		success: true,
		results,
		timestamp: new Date().toISOString(),
		poolStats: browserPool.stats,
	});
});

app.post("/take-screenshot", async (c) => {
	try {
		const {
			url,
			fullPage,
			coords,
			waitForSelector,
			timeout = 50000,
			device = "desktop",
			waitUntil = "domcontentloaded",
			blockDistractions = true,
		} = await c.req.json();

		if (!url) {
			return c.json({ success: false, error: "URL is required" }, 400);
		}
		try {
			new URL(url);
		} catch {
			return c.json({ success: false, error: "Invalid URL format" }, 400);
		}

		const { buffer, metadata, markdown, dimensions } =
			await browserPool.withPage((page) =>
				captureOneScreenshotWithPage(page, {
					url,
					device,
					waitUntil,
					waitForSelector,
					timeout,
					fullPage,
					coords,
					blockDistractions,
				}),
			);

		const screenshot = bufferToDataUrlPng(buffer);

		return c.json({
			success: true,
			url,
			markdown,
			metadata,
			screenshot,
			dimensions,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error("❌ Screenshot API error:", error);
		return c.json(
			{
				success: false,
				error: "Internal server error",
				details: error.message,
			},
			500,
		);
	}
});

app.post("/take-screenshot-multiple", async (c) => {
	try {
		const {
			urls,
			device = "desktop",
			waitForSelector,
			timeout = 45000,
			waitUntil = "domcontentloaded",
			blockDistractions = true,
		} = await c.req.json();

		if (!Array.isArray(urls) || urls.length === 0) {
			return c.json(
				{ success: false, error: "urls must be a non-empty array" },
				400,
			);
		}
		const MAX_URLS = 50;
		const list = urls
			.slice(0, MAX_URLS)
			.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));
		if (list.length === 0) {
			return c.json({ success: false, error: "No valid URLs" }, 400);
		}

		const opts = {
			device,
			waitForSelector,
			timeout,
			waitUntil,
			blockDistractions,
		};
		const results = await Promise.all(
			list.map((url) =>
				browserPool
					.withPage((page) =>
						captureOneScreenshotWithPage(page, { ...opts, url }),
					)
					.then(({ buffer, metadata, markdown, dimensions }) => ({
						url,
						screenshot: bufferToDataUrlPng(buffer),
						metadata,
						markdown,
						success: true,
						dimensions,
					}))
					.catch((err) => ({
						url,
						screenshot: null,
						metadata: null,
						markdown: null,
						success: false,
						error: err?.message || "Screenshot failed",
						dimensions:
							SCREENSHOT_VIEWPORT_MAP[opts.device] ||
							SCREENSHOT_VIEWPORT_MAP.desktop,
					})),
			),
		);

		return c.json({
			success: true,
			results,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error("❌ take-screenshot-multiple error:", error);
		return c.json(
			{ success: false, error: error?.message || "Internal server error" },
			500,
		);
	}
});

const port = Number(process.env.PORT) || 3001;
console.log(`Standalone scrape API on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
