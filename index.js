import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { firestore, storage } from "./config/firebase.js";
import chromium from "@sparticuz/chromium";
import { supabase } from "./config/supabase.js";
import { performance } from "perf_hooks";
import { cpus } from "os";
import UserAgent from "user-agents";
import { v4 as uuidv4 } from "uuid";
import { JSDOM } from "jsdom";
import axios from "axios";
import { load } from "cheerio";
import { extractSemanticContentWithFormattedMarkdown } from "./lib/extractSemanticContent.js";
import {
	parseRepoUrl,
	analyzeRepo,
	analyzeSingleFile,
	fetchRepoTree,
} from "./lib/repoAst.js";
import {
	extractUrlsFromText,
	scrapeUrlsViaApi,
	scrapeYoutubeViaApi,
	scrapeRedditViaApi,
	isYoutubeUrl,
	isRedditUrl,
	ROUTER_SYSTEM_PROMPT,
	parseAgentResponse,
	SKILLS,
	TASK_TYPES,
	CREDITS,
} from "./lib/inkgestAgent.js";
import { browserAgentRouter } from "./lib/inkgestBrowserAgent.js";
import { logger } from "hono/logger";
import UserAgents from "user-agents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { GoogleGenAI } from "@google/genai";
import browserPool from "./browser-pool.js";
import fs from "fs";
import NodeCache from "node-cache";
import { fetch, ProxyAgent } from "undici";
import { z } from "zod";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import {
	fetchTranscript,
	YoutubeTranscriptNotAvailableLanguageError,
} from "youtube-transcript-plus";

// Load .env from project root (same dir as this file) so it works regardless of cwd or platform
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

// Safely parse JSON from an AI response that may include markdown fences or trailing text
function parseAIJson(raw) {
	if (!raw || typeof raw !== "string") {
		throw new SyntaxError(
			`parseAIJson received invalid input: ${JSON.stringify(raw)}`,
		);
	}
	let text = raw.trim();
	// Strip markdown code fences
	text = text
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();
	// Extract the first complete JSON object or array (handles trailing prose)
	const start = text.search(/[{\[]/);
	if (start === -1) {
		throw new SyntaxError(
			`No JSON object found in AI response. Raw content: "${text.slice(0, 200)}"`,
		);
	}
	const opener = text[start];
	const closer = opener === "{" ? "}" : "]";
	let depth = 0;
	let end = -1;
	for (let i = start; i < text.length; i++) {
		if (text[i] === opener) depth++;
		else if (text[i] === closer) {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end === -1) throw new SyntaxError("Unterminated JSON in AI response");
	return JSON.parse(text.slice(start, end + 1));
}

// Wrapper around OpenRouter chat completions with error checking
async function openRouterChat({
	model = "openai/gpt-4o-mini",
	prompt,
	temperature = 0.7,
	label = "AI",
}) {
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
		},
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "system",
					content:
						"You are a JSON-only API. You MUST respond with valid JSON and nothing else. Never ask clarifying questions. Never add explanations. If information seems missing, use reasonable placeholder values.",
				},
				{ role: "user", content: prompt },
			],
			temperature,
			response_format: { type: "json_object" },
		}),
	});

	const data = await res.json();

	if (data.error) {
		throw new Error(
			`[${label}] OpenRouter error: ${data.error.message || JSON.stringify(data.error)}`,
		);
	}

	const content = data.choices?.[0]?.message?.content;
	if (!content) {
		console.error(
			`[${label}] Unexpected OpenRouter response:`,
			JSON.stringify(data).slice(0, 500),
		);
		throw new Error(
			`[${label}] Empty or missing content in OpenRouter response`,
		);
	}

	return parseAIJson(content);
}

const OUTPUT_FILE = "./templates.json";

const EMAIL_DIR = path.join(__dirname, "./templates");
const INDEX_FILE = path.join(__dirname, "../templates-index.json");

async function getEmbedding(text) {
	const res = await fetch("http://localhost:11434/api/embeddings", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "mxbai-embed-large",
			prompt: `Represent this sentence for searching relevant passages: ${text}`,
		}),
	});
	const { embedding } = await res.json();
	return embedding;
}

async function indexAll() {
	const files = fs
		.readdirSync(EMAIL_DIR)
		.filter((f) => /\.(html|jsx|tsx)$/.test(f));
	console.log(`Indexing ${files.length} emails...`);

	const index = [];

	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		const html = fs.readFileSync(path.join(EMAIL_DIR, file), "utf8");

		const base = path.basename(file, path.extname(file));
		const category = base.split("-")[0];
		const stripped = html
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.slice(0, 800);
		const subject = base.replace(/-/g, " ");

		const embedding = await getEmbedding(`${subject} ${category} ${stripped}`);

		index.push({
			filename: file,
			category,
			subject,
			description: stripped.slice(0, 200),
			embedding, // just a number[] in JSON
		});

		console.log(`[${i + 1}/${files.length}] ${file}`);
	}

	fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
	console.log(`✅ email-index.json written (${index.length} entries)`);
}

indexAll().catch(console.error);

async function loadExistingTemplates() {
	if (!fs.existsSync(OUTPUT_FILE)) return [];
	return JSON.parse(await fs.readFileSync(OUTPUT_FILE, "utf-8"));
}

const userAgents = new UserAgent();

// Add the Imports before StealthPlugin
import("puppeteer-extra-plugin-stealth/evasions/chrome.app/index.js");
import("puppeteer-extra-plugin-stealth/evasions/chrome.csi/index.js");
import("puppeteer-extra-plugin-stealth/evasions/chrome.loadTimes/index.js");
import("puppeteer-extra-plugin-stealth/evasions/chrome.runtime/index.js");
import("puppeteer-extra-plugin-stealth/evasions/defaultArgs/index.js"); // pkg warned me this one was missing
import("puppeteer-extra-plugin-stealth/evasions/iframe.contentWindow/index.js");
import("puppeteer-extra-plugin-stealth/evasions/media.codecs/index.js");
import("puppeteer-extra-plugin-stealth/evasions/navigator.hardwareConcurrency/index.js");
import("puppeteer-extra-plugin-stealth/evasions/navigator.languages/index.js");
import("puppeteer-extra-plugin-stealth/evasions/navigator.permissions/index.js");
import("puppeteer-extra-plugin-stealth/evasions/navigator.plugins/index.js");
import("puppeteer-extra-plugin-stealth/evasions/navigator.vendor/index.js");
import("puppeteer-extra-plugin-stealth/evasions/navigator.webdriver/index.js");
import("puppeteer-extra-plugin-stealth/evasions/sourceurl/index.js");
import("puppeteer-extra-plugin-stealth/evasions/user-agent-override/index.js");
import("puppeteer-extra-plugin-stealth/evasions/webgl.vendor/index.js");
import("puppeteer-extra-plugin-stealth/evasions/window.outerdimensions/index.js");

// GitHub Trending Cache
const trendingCache = new NodeCache({ stdTTL: 60 * 5, checkperiod: 120 }); // default 5 min cache

// GitHub Trending Types
// Repo type: { name, url, description?, stars?, language?, forks?, avatar?, trendingRank? }

const CATEGORY_MAP = {
	// categories are flexible — map to language(s) or topics for the GitHub search approach
	web: ["JavaScript", "TypeScript", "HTML", "CSS"],
	mobile: ["Kotlin", "Swift", "Dart", "Java"],
	ai: ["Python", "Jupyter Notebook", "Machine Learning"],
	infra: ["Dockerfile", "Go", "Rust"],
	security: ["C", "Assembly", "Go"],
	data: ["Python", "R", "SQL"],
	all: [], // empty = no language filter
};

function cacheKey(prefix, params) {
	const sorted = Object.keys(params)
		.sort()
		.map((k) => `${k}=${params[k] ?? ""}`)
		.join("&");
	return `${prefix}:${sorted}`;
}

// Helper: Use GitHub Search API to approximate trending by stars in recent period
async function fetchTrendingFromGitHubSearch({
	language,
	since = "weekly", // daily|weekly|monthly
	per_page = 25,
}) {
	// compute created after date for time window
	const now = new Date();
	let fromDate = new Date(now);
	if (since === "daily") fromDate.setDate(now.getDate() - 1);
	else if (since === "weekly") fromDate.setDate(now.getDate() - 7);
	else fromDate.setMonth(now.getMonth() - 1);

	const created = fromDate.toISOString().slice(0, 10); // YYYY-MM-DD
	// Build query: repos created after 'created' sorted by stars desc
	// If language provided, add language filter
	let q = `created:>${created}`;
	if (language) q += ` language:${language}`;

	const params = new URLSearchParams({
		q,
		sort: "stars",
		order: "desc",
		per_page: (per_page ?? 25).toString(),
	});

	const url = `https://api.github.com/search/repositories?${params.toString()}`;

	const headers = {
		Accept: "application/vnd.github+json",
		"User-Agent": "ihatereading-api",
	};
	if (process.env.GITHUB_TOKEN) {
		headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
	}

	const res = await fetch(url, { headers });
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GitHub Search API error: ${res.status} ${text}`);
	}
	const data = await res.json();
	const items = data.items ?? [];
	return items.map((it, idx) => ({
		name: `${it.owner.login}/${it.name}`,
		url: it.html_url,
		description: it.description,
		stars: it.stargazers_count,
		forks: it.forks_count,
		language: it.language,
		avatar: it.owner.avatar_url,
		trendingRank: idx + 1,
	}));
}

// Helper: Scrape GitHub trending page (language + since)
async function fetchTrendingFromScrape({
	language,
	since = "daily",
	per_page = 25,
}) {
	// Build URL: https://github.com/trending/<language>?since=daily
	const langPath = language ? `/${encodeURIComponent(language)}` : "";
	const url = `https://github.com/trending${langPath}?since=${since}`;

	const res = await fetch(url, {
		headers: {
			"User-Agent": "hono-trending-bot",
		},
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GitHub trending page fetch failed: ${res.status} ${text}`);
	}

	const html = await res.text();
	const $ = load(html);

	const repos = [];
	$("article.Box-row").each((i, el) => {
		if (i >= per_page) return;
		const title = $(el).find("h2 a").text().trim().replace(/\s+/g, " ");
		// title like "owner / repo"
		const name = title.replace(/\s/g, "").replace(/\//, "/"); // tidy
		const urlPath = $(el).find("h2 a").attr("href") ?? "";
		const urlFull = urlPath ? `https://github.com${urlPath}` : "";
		const desc = $(el).find("p.col-9").text().trim() || undefined;
		const lang =
			$(el).find("span[itemprop=programmingLanguage]").text().trim() ||
			undefined;
		// stars displayed relative to repo, but trending page also shows stars
		const starText =
			$(el)
				.find("a[href$='/stargazers']")
				.first()
				.text()
				.trim()
				.replace(",", "") || "0";
		const forksText =
			$(el)
				.find("a[href$='/network/members']")
				.first()
				.text()
				.trim()
				.replace(",", "") || "0";
		const avatar = $(el).find("img.avatar").attr("src") || undefined;

		repos.push({
			name: name,
			url: urlFull,
			description: desc,
			language: lang,
			stars: Number(starText) || undefined,
			forks: Number(forksText) || undefined,
			avatar,
			trendingRank: i + 1,
		});
	});

	return repos;
}

// Unified endpoint logic: check cache, decide strategy, return JSON
async function getTrending(params) {
	const { category, language, since = "weekly", per_page = 25 } = params;
	// compute effective language(s)
	let langToUse;
	if (language) langToUse = language;
	else if (category && CATEGORY_MAP[category]) {
		// pick first language if multiple
		const langs = CATEGORY_MAP[category];
		if (langs.length > 0) langToUse = langs[0];
	}

	const key = cacheKey("trending", {
		category: category ?? "none",
		language: langToUse ?? "none",
		since,
		per_page: per_page?.toString() ?? "25",
	});

	const cached = trendingCache.get(key);
	if (cached) return cached;

	// Try GitHub Search API if token available, else scrape
	let results = [];
	try {
		if (process.env.GITHUB_TOKEN) {
			// If language not defined and category 'all', we just search without language.
			results = await fetchTrendingFromGitHubSearch({
				language: langToUse ?? undefined,
				since,
				per_page,
			});
		} else {
			// fallback: scrape the trending page. If langToUse is not a GitHub language slug,
			// it may still work; else pass empty for all languages.
			results = await fetchTrendingFromScrape({
				language: langToUse ?? undefined,
				since,
				per_page,
			});
		}
	} catch (err) {
		// if GitHub search failed, try fallback scrape
		console.warn("Primary trending strategy failed:", err);
		try {
			results = await fetchTrendingFromScrape({
				language: langToUse ?? undefined,
				since,
				per_page,
			});
		} catch (err2) {
			console.error("Both trending strategies failed:", err2);
			throw err2;
		}
	}

	trendingCache.set(key, results, 60 * 5); // cache 5 minutes
	return results;
}

// Performance Monitoring Utility
class PerformanceMonitor {
	constructor() {
		this.metrics = new Map();
		this.startTime = performance.now();
		this.initialCpuUsage = process.cpuUsage();
		this.initialMemoryUsage = process.memoryUsage();
	}

	// Start monitoring for a specific operation
	startOperation(operationName) {
		const operationId = `${operationName}_${Date.now()}_${Math.random()
			.toString(36)
			.substr(2, 9)}`;

		this.metrics.set(operationId, {
			name: operationName,
			startTime: performance.now(),
			startCpuUsage: process.cpuUsage(),
			startMemoryUsage: process.memoryUsage(),
			startHrtime: process.hrtime.bigint(),
			status: "running",
		});

		return operationId;
	}

	// End monitoring for a specific operation
	endOperation(operationId) {
		const metric = this.metrics.get(operationId);
		if (!metric) return null;

		const endTime = performance.now();
		const endCpuUsage = process.cpuUsage();
		const endMemoryUsage = process.memoryUsage();
		const endHrtime = process.hrtime.bigint();

		// Calculate metrics
		const duration = endTime - metric.startTime;
		const cpuUsage = {
			user: endCpuUsage.user - metric.startCpuUsage.user,
			system: endCpuUsage.system - metric.startCpuUsage.system,
			total:
				endCpuUsage.user +
				endCpuUsage.system -
				(metric.startCpuUsage.user + metric.startCpuUsage.system),
		};
		const memoryUsage = {
			rss: endMemoryUsage.rss - metric.startMemoryUsage.rss,
			heapUsed: endMemoryUsage.heapUsed - metric.startMemoryUsage.heapUsed,
			heapTotal: endMemoryUsage.heapTotal - metric.startMemoryUsage.heapTotal,
			external: endMemoryUsage.external - metric.startMemoryUsage.external,
		};
		const hrtimeDiff = Number(endHrtime - metric.startHrtime) / 1000000; // Convert to milliseconds

		// Update metric
		metric.endTime = endTime;
		metric.endCpuUsage = endCpuUsage;
		metric.endMemoryUsage = endMemoryUsage;
		metric.endHrtime = endHrtime;
		metric.duration = duration;
		metric.cpuUsage = cpuUsage;
		metric.memoryUsage = memoryUsage;
		metric.hrtimeDiff = hrtimeDiff;
		metric.status = "completed";
		metric.completedAt = new Date().toISOString();

		return metric;
	}

	// Get current system performance metrics
	getSystemMetrics() {
		const currentCpuUsage = process.cpuUsage();
		const currentMemoryUsage = process.memoryUsage();
		const uptime = process.uptime();

		// Calculate CPU usage since start
		const totalCpuUsage = {
			user: currentCpuUsage.user - this.initialCpuUsage.user,
			system: currentCpuUsage.system - this.initialCpuUsage.system,
			total:
				currentCpuUsage.user +
				currentCpuUsage.system -
				(this.initialCpuUsage.user + this.initialCpuUsage.system),
		};

		// Calculate memory usage since start
		const totalMemoryUsage = {
			rss: currentMemoryUsage.rss - this.initialMemoryUsage.rss,
			heapUsed: currentMemoryUsage.heapUsed - this.initialMemoryUsage.heapUsed,
			heapTotal:
				currentMemoryUsage.heapTotal - this.initialMemoryUsage.heapTotal,
			external: currentMemoryUsage.external - this.initialMemoryUsage.external,
		};

		// Get CPU info
		const cpuInfo = cpus();
		const cpuModel = cpuInfo[0]?.model || "Unknown";
		const cpuCores = cpuInfo.length;

		return {
			uptime: {
				process: uptime,
				system: process.hrtime.bigint(),
			},
			cpu: {
				model: cpuModel,
				cores: cpuCores,
				usage: {
					current: currentCpuUsage,
					total: totalCpuUsage,
					percentage: {
						user: (totalCpuUsage.user / 1000000 / uptime) * 100,
						system: (totalCpuUsage.system / 1000000 / uptime) * 100,
						total: (totalCpuUsage.total / 1000000 / uptime) * 100,
					},
				},
			},
			memory: {
				current: currentMemoryUsage,
				total: totalMemoryUsage,
				percentage: {
					rss: (currentMemoryUsage.rss / 1024 / 1024).toFixed(2) + " MB",
					heapUsed:
						(currentMemoryUsage.heapUsed / 1024 / 1024).toFixed(2) + " MB",
					heapTotal:
						(currentMemoryUsage.heapTotal / 1024 / 1024).toFixed(2) + " MB",
					external:
						(currentMemoryUsage.external / 1024 / 1024).toFixed(2) + " MB",
				},
			},
			operations: {
				total: this.metrics.size,
				completed: Array.from(this.metrics.values()).filter(
					(m) => m.status === "completed",
				).length,
				running: Array.from(this.metrics.values()).filter(
					(m) => m.status === "running",
				).length,
			},
		};
	}

	// Get performance summary for a specific operation type
	getOperationSummary(operationName) {
		const operations = Array.from(this.metrics.values()).filter(
			(m) => m.name === operationName && m.status === "completed",
		);

		if (operations.length === 0) return null;

		const durations = operations.map((op) => op.duration);
		const cpuUsages = operations.map((op) => op.cpuUsage.total);
		const memoryUsages = operations.map((op) => op.memoryUsage.heapUsed);

		return {
			operationName,
			count: operations.length,
			timing: {
				min: Math.min(...durations),
				max: Math.max(...durations),
				avg: durations.reduce((a, b) => a + b, 0) / durations.length,
				total: durations.reduce((a, b) => a + b, 0),
			},
			cpu: {
				min: Math.min(...cpuUsages),
				max: Math.max(...cpuUsages),
				avg: cpuUsages.reduce((a, b) => a + b, 0) / cpuUsages.length,
				total: cpuUsages.reduce((a, b) => a + b, 0),
			},
			memory: {
				min: Math.min(...memoryUsages),
				max: Math.max(...memoryUsages),
				avg: memoryUsages.reduce((a, b) => a + b, 0) / memoryUsages.length,
				total: memoryUsages.reduce((a, b) => a + b, 0),
			},
		};
	}

	// Get all performance metrics
	getAllMetrics() {
		return {
			system: this.getSystemMetrics(),
			operations: Array.from(this.metrics.values()),
			summary: {
				scrapUrl: this.getOperationSummary("scrap-url"),
				crawlUrl: this.getOperationSummary("crawl-url"),
				googleMaps: this.getOperationSummary("google-maps"),
				airbnb: this.getOperationSummary("airbnb-scrap"),
				wikipedia: this.getOperationSummary("wikipedia-scrap"),
			},
		};
	}

	// Clear old metrics (keep last 1000 operations)
	cleanup() {
		if (this.metrics.size > 1000) {
			const sortedMetrics = Array.from(this.metrics.entries())
				.sort(([, a], [, b]) => b.startTime - a.startTime)
				.slice(0, 1000);

			this.metrics.clear();
			sortedMetrics.forEach(([key, value]) => this.metrics.set(key, value));
		}
	}

	// Format metrics for console output
	formatMetrics(metrics) {
		return {
			...metrics,
			cpu: {
				...metrics.cpu,
				usage: {
					...metrics.cpu.usage,
					current: {
						user: (metrics.cpu.usage.current.user / 1000000).toFixed(2) + "s",
						system:
							(metrics.cpu.usage.current.system / 1000000).toFixed(2) + "s",
					},
					total: {
						user: (metrics.cpu.usage.total.user / 1000000).toFixed(2) + "s",
						system: (metrics.cpu.usage.total.system / 1000000).toFixed(2) + "s",
					},
				},
			},
			memory: {
				...metrics.memory,
				current: {
					rss: (metrics.memory.current.rss / 1024 / 1024).toFixed(2) + " MB",
					heapUsed:
						(metrics.memory.current.heapUsed / 1024 / 1024).toFixed(2) + " MB",
					heapTotal:
						(metrics.memory.current.heapTotal / 1024 / 1024).toFixed(2) + " MB",
				},
			},
		};
	}
}

// Initialize performance monitor
const performanceMonitor = new PerformanceMonitor();

// Performance monitoring middleware
const performanceMiddleware = async (c, next) => {
	const operationName = c.req.path;
	const operationId = performanceMonitor.startOperation(operationName);

	// Add performance info to context
	c.performance = {
		operationId,
		startTime: Date.now(),
	};

	try {
		await next();
	} finally {
		// End operation monitoring
		const metrics = performanceMonitor.endOperation(operationId);
		if (metrics) {
			console.log(
				`📊 Performance: ${operationName} completed in ${metrics.duration.toFixed(
					2,
				)}ms`,
			);
			console.log(
				`   💻 CPU: ${(metrics.cpuUsage.total / 1000000).toFixed(2)}s`,
			);
			console.log(
				`   🧠 Memory: ${(metrics.memoryUsage.heapUsed / 1024 / 1024).toFixed(
					2,
				)} MB`,
			);
		}
	}
};

// Proxy Management System
class ProxyManager {
	constructor() {
		this.proxies = [
			{
				host: "brd.superproxy.io",
				port: 33335,
				username: "brd-customer-hl_ba1a3411-zone-freemium-ip-185.150.85.170",
				password: "l5birkm39b9q",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "brd.superproxy.io",
				port: 33335,
				username: "brd-customer-hl_ba1a3411-zone-freemium-ip-45.154.194.148",
				password: "l5birkm39b9q",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "brd.superproxy.io",
				port: 33335,
				username: "brd-customer-hl_ba1a3411-zone-freemium-ip-104.244.83.140",
				password: "l5birkm39b9q",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "brd.superproxy.io",
				port: 33335,
				username: "brd-customer-hl_ba1a3411-zone-freemium-ip-58.97.241.46",
				password: "l5birkm39b9q",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "brd.superproxy.io",
				port: 33335,
				username: "brd-customer-hl_ba1a3411-zone-freemium-ip-103.250.82.245",
				password: "l5birkm39b9q",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "brd.superproxy.io",
				port: 33335,
				username: "brd-customer-hl_ba1a3411-zone-freemium-ip-83.229.13.167",
				password: "l5birkm39b9q",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "brd.superproxy.io",
				port: 33335,
				username: "brd-customer-hl_ba1a3411-zone-freemium-ip-80.240.120.78",
				password: "l5birkm39b9q",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "brd.superproxy.io",
				port: 33335,
				username: "brd-customer-hl_ba1a3411-zone-freemium-ip-121.91.189.75",
				password: "l5birkm39b9q",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "brd.superproxy.io",
				port: 33335,
				username: "brd-customer-hl_ba1a3411-zone-freemium-ip-176.119.9.105",
				password: "l5birkm39b9q",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "brd.superproxy.io",
				port: 33335,
				username: "brd-customer-hl_ba1a3411-zone-freemium-ip-185.125.193.152",
				password: "l5birkm39b9q",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "brd.superproxy.io",
				port: 33335,
				username: "brd-customer-hl_ba1a3411-zone-freemium-ip-119.13.224.187",
				password: "l5birkm39b9q",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "brd.superproxy.io",
				port: 33335,
				username: "brd-customer-hl_ba1a3411-zone-freemium-ip-154.30.98.10",
				password: "l5birkm39b9q",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "brd.superproxy.io",
				port: 33335,
				username: "brd-customer-hl_ba1a3411-zone-freemium-ip-209.242.213.180",
				password: "l5birkm39b9q",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "brd.superproxy.io",
				port: 33335,
				username: "brd-customer-hl_ba1a3411-zone-freemium-ip-176.53.216.91",
				password: "l5birkm39b9q",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "brd.superproxy.io",
				port: 33335,
				username: "brd-customer-hl_ba1a3411-zone-freemium-ip-62.241.59.134",
				password: "l5birkm39b9q",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
		];

		this.currentIndex = 0;
		this.healthCheckInterval = null;
		this.startHealthCheck();
	}

	// Get next available proxy with load balancing
	getNextProxy() {
		const now = Date.now();
		const cooldownPeriod = 5000; // 5 seconds cooldown between uses

		// Find healthy proxies that haven't been used recently
		const availableProxies = this.proxies.filter(
			(proxy) => proxy.isHealthy && now - proxy.lastUsed > cooldownPeriod,
		);

		if (availableProxies.length === 0) {
			// If no healthy proxies available, reset all and use any
			this.proxies.forEach((proxy) => {
				proxy.lastUsed = 0;
				proxy.failCount = 0;
				proxy.isHealthy = true;
			});
			return this.proxies[0];
		}

		// Sort by fail count, then avgLatency, then last used time
		const sortedProxies = availableProxies.sort((a, b) => {
			if (a.failCount !== b.failCount) {
				return a.failCount - b.failCount;
			}
			const aLatency =
				typeof a.avgLatency === "number" ? a.avgLatency : Infinity;
			const bLatency =
				typeof b.avgLatency === "number" ? b.avgLatency : Infinity;
			if (aLatency !== bLatency) {
				return aLatency - bLatency;
			}
			return a.lastUsed - b.lastUsed;
		});

		const selectedProxy = sortedProxies[0];
		selectedProxy.lastUsed = now;

		return selectedProxy;
	}

	// Mark proxy as failed
	markProxyFailed(proxyHost) {
		const proxy = this.proxies.find((p) => p.host === proxyHost);
		if (proxy) {
			proxy.failCount++;
			proxy.lastFailureAt = Date.now();
			if (proxy.failCount >= 3) {
				proxy.isHealthy = false;
				console.warn(
					`⚠️ Proxy ${proxyHost} marked as unhealthy after ${proxy.failCount} failures`,
				);
			}
		}
	}

	// Mark proxy as successful
	markProxySuccess(proxyHost) {
		const proxy = this.proxies.find((p) => p.host === proxyHost);
		if (proxy) {
			proxy.failCount = Math.max(0, proxy.failCount - 1);
			if (proxy.failCount === 0) {
				proxy.isHealthy = true;
			}
		}
	}

	// Record latency for a proxy to track performance
	markProxyLatency(proxyHost, latencyMs) {
		const proxy = this.proxies.find((p) => p.host === proxyHost);
		if (!proxy) return;
		if (typeof proxy.avgLatency !== "number") {
			proxy.avgLatency = latencyMs;
			proxy.totalRequests = 1;
			proxy.successfulRequests = 0;
			return;
		}
		// Exponential moving average for stability
		const alpha = 0.3;
		proxy.avgLatency = alpha * latencyMs + (1 - alpha) * proxy.avgLatency;
		proxy.totalRequests = (proxy.totalRequests || 0) + 1;
	}

	// Record request outcome and latency
	recordProxyResult(proxyHost, success, latencyMs) {
		if (typeof latencyMs === "number") {
			this.markProxyLatency(proxyHost, latencyMs);
		}
		if (success) {
			this.markProxySuccess(proxyHost);
			const proxy = this.proxies.find((p) => p.host === proxyHost);
			if (proxy) proxy.successfulRequests = (proxy.successfulRequests || 0) + 1;
		} else {
			this.markProxyFailed(proxyHost);
		}
	}

	// Health check for all proxies
	async checkProxyHealth(proxy) {
		try {
			const browser = await chromium.launch({
				headless: true,
				args: [
					"--no-sandbox",
					"--disable-setuid-sandbox",
					"--disable-dev-shm-usage",
					"--disable-gpu",
				],
			});

			const context = await browser.newContext({
				proxy: {
					server: `http://${proxy.host}:${proxy.port}`,
					username: proxy.username,
					password: proxy.password,
				},
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				timeout: 10000,
			});

			const page = await context.newPage();
			await page.goto("https://httpbin.org/ip", { timeout: 10000 });
			const content = await page.textContent("body");

			await page.close();
			await context.close();
			await browser.close();

			if (content.includes("origin")) {
				this.markProxySuccess(proxy.host);
				return true;
			} else {
				this.markProxyFailed(proxy.host);
				return false;
			}
		} catch (error) {
			this.markProxyFailed(proxy.host);
			return false;
		}
	}

	// Start periodic health checks
	startHealthCheck() {
		this.healthCheckInterval = setInterval(
			async () => {
				console.log("🔍 Running proxy health check...");
				const healthChecks = this.proxies.map((proxy) =>
					this.checkProxyHealth(proxy),
				);
				await Promise.allSettled(healthChecks);

				const healthyCount = this.proxies.filter((p) => p.isHealthy).length;
				console.log(
					`✅ Proxy health check complete: ${healthyCount}/${this.proxies.length} proxies healthy`,
				);
			},
			5 * 60 * 1000,
		); // Check every 5 minutes
	}

	// Stop health checks
	stopHealthCheck() {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}
	}

	// Get proxy statistics
	getStats() {
		const total = this.proxies.length;
		const healthy = this.proxies.filter((p) => p.isHealthy).length;
		const failed = this.proxies.filter((p) => p.failCount > 0).length;

		return {
			total,
			healthy,
			failed,
			healthPercentage: Math.round((healthy / total) * 100),
			proxies: this.proxies.map((p) => ({
				host: p.host,
				port: p.port,
				country: p.country,
				isHealthy: p.isHealthy,
				failCount: p.failCount,
				lastUsed: p.lastUsed,
			})),
		};
	}
}

// Initialize proxy manager
const proxyManager = new ProxyManager();

const genai = new GoogleGenAI({
	apiKey: process.env.GOOGLE_GENAI_API_KEY,
});

const app = new Hono();
export const customLogger = (message, ...rest) => {
	console.log(message, ...rest);
};
app.use(logger(customLogger));

const randomDelay = async (minMs = 150, maxMs = 650) => {
	const jitter = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
	return new Promise((resolve) => setTimeout(resolve, jitter));
};

// ─── IP Rate Limiter ──────────────────────────────────────────────────────────
// Simple in-process sliding-window rate limiter. No Redis required.
// Cleans up expired entries automatically to avoid memory growth.
const rateLimitMap = new Map(); // Map<ip, { count: number, resetTime: number }>

/**
 * Check and update the rate limit for a given IP.
 * @param {string} ip
 * @param {number} limit       Max requests allowed in the window
 * @param {number} windowMs    Rolling window duration in ms
 * @returns {{ allowed: boolean, retryAfter?: number, remaining?: number }}
 */
function rateLimit(ip, limit, windowMs) {
	const now = Date.now();
	const record = rateLimitMap.get(ip);

	// New visitor or window has expired → reset
	if (!record || now > record.resetTime) {
		rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
		return { allowed: true, remaining: limit - 1 };
	}

	// Window still active but limit hit
	if (record.count >= limit) {
		return {
			allowed: false,
			retryAfter: Math.ceil((record.resetTime - now) / 1000), // seconds
			remaining: 0,
		};
	}

	record.count++;
	return { allowed: true, remaining: limit - record.count };
}

// Periodically purge expired entries (every 5 minutes) to avoid memory leaks
setInterval(
	() => {
		const now = Date.now();
		for (const [ip, record] of rateLimitMap.entries()) {
			if (now > record.resetTime) rateLimitMap.delete(ip);
		}
	},
	5 * 60 * 1000,
);
// ─────────────────────────────────────────────────────────────────────────────

const commonViewports = [
	{ width: 1920, height: 1080 },
	{ width: 1366, height: 768 },
	{ width: 1536, height: 864 },
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
];

const pickRandomViewport = () =>
	commonViewports[Math.floor(Math.random() * commonViewports.length)];

/** CSS to hide ads, cookie banners, chat widgets, and password-manager overlays before screenshot */
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

// Add CORS middleware
app.use(
	"*",
	cors({
		origin: [
			"http://localhost:4001",
			"http://localhost:3000",
			"http://localhost:3001",
			"https://ihatereading.in",
			"https://www.inkgest.com",
		], // Allow specific origins
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
		credentials: true,
	}),
);

// Apply performance monitoring middleware
app.use("*", performanceMiddleware);
app.use("/");

app.get("/", (c) => {
	return c.text("Welcome to iHateReading API", 200);
});

// GitHub Trending endpoint
// Query params:
// - category=web|mobile|ai|infra|data|all (maps to languages) OR language=JavaScript
// - since=daily|weekly|monthly
// - per_page=number
app.get("/github-trending", async (c) => {
	try {
		const qp = c.req.query();
		const category = qp.category;
		const language = qp.language;
		const since = qp.since || "weekly";
		const per_page = Math.min(Number(qp.per_page ?? 25), 100);

		// basic validation
		if (category && !CATEGORY_MAP[category] && category !== "all") {
			return c.json({ ok: false, error: "unknown category" }, 400);
		}

		const results = await getTrending({ category, language, since, per_page });
		return c.json(
			{
				ok: true,
				meta: {
					source: process.env.GITHUB_TOKEN
						? "github-search"
						: "github-trending-scrape",
					category,
					language,
					since,
					per_page,
				},
				data: results,
			},
			200,
		);
	} catch (err) {
		console.error(err);
		const errorMessage = err?.message ?? String(err);
		return c.json({ ok: false, error: errorMessage }, 500);
	}
});

// Health check endpoint
app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

// Browser agent (Puppeteer ReAct loop for dynamic SPAs)
app.route("/browser-agent", browserAgentRouter);

app.post("/post-to-devto", async (c) => {
	try {
		const { title } = await c.req.json();
		if (!title) {
			c.status(400);
			return c.json({
				error: "Title is required",
			});
		}

		// Check if DEV_TO_API token is available
		if (!process.env.DEV_TO_API_TOKEN) {
			c.status(500);
			return c.json({
				error: "DEV_TO_API_TOKEN environment variable is not set",
			});
		}

		// Fetch the document from Firestore publish collection using the title
		const postsSnapshot = await firestore
			.collection("publish")
			.where("title", "==", title.replaceAll("-", " "))
			.get();

		if (postsSnapshot.empty) {
			c.status(404);
			return c.json({
				error: `No post found with title: ${title}`,
			});
		}

		const postDoc = postsSnapshot.docs[0];
		const postData = postDoc.data();

		// Validate required fields
		if (!postData.content && !postData.htmlContent) {
			return c.json(
				{
					success: false,
					error: "Post content is required (content or htmlContent field)",
				},
				400,
			);
		}

		// Prepare the article data for Dev.to API
		const processedTags = (() => {
			// Handle tags properly for Dev.to API
			if (!Array.isArray(postData.tags) || postData.tags.length === 0) {
				return ["general"];
			}

			// Dev.to tags must be lowercase, only alphanumeric characters (no hyphens, spaces, or special chars)
			const cleanTags = postData.tags
				.slice(0, 4) // Dev.to allows max 4 tags
				.map((tag) => {
					// Convert to string and clean up
					let cleanTag = String(tag)
						.toLowerCase()
						.trim()
						// Remove ALL non-alphanumeric characters (including hyphens, spaces, underscores, etc.)
						.replace(/[^a-zA-Z0-9]/g, "")
						// Limit length (Dev.to has tag length limits)
						.substring(0, 30);

					return cleanTag;
				})
				.filter((tag) => tag.length > 0 && tag.length <= 30);

			// Ensure we have at least one valid tag
			return cleanTags.length > 0 ? cleanTags : ["general"];
		})();

		// Prepare content for Dev.to (they prefer markdown)
		let bodyContent = "";
		if (postData.content) {
			// If content exists, use it (assume it's markdown)
			bodyContent = postData.content;
		} else if (postData.htmlContent) {
			// If only HTML content exists, convert basic HTML to markdown
			bodyContent = postData.htmlContent
				.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n\n")
				.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n\n")
				.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n\n")
				.replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
				.replace(/<br\s*\/?>/gi, "\n")
				.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
				.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*")
				.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`")
				.replace(/<[^>]*>/g, "") // Remove any remaining HTML tags
				.replace(/\n\s*\n\s*\n/g, "\n\n") // Clean up excessive newlines
				.trim();
		}

		// Add footer with original publication link
		const footerText = `\n\n---\n\n*Originally published on [iHateReading](https://ihatereading.in/t/${encodeURIComponent(
			title.replace(/\s+/g, "-"),
		)})*`;
		bodyContent += footerText;

		const articleData = {
			article: {
				title: postData.title || title,
				body_markdown: bodyContent,
				tags: processedTags,
				published: true,
				series: postData.series || null,
				canonical_url: postData.canonicalUrl || null,
				description: postData.description || "",
				cover_image: postData.coverImage || null,
				main_image: postData.mainImage || null,
			},
		};

		// Post to Dev.to API
		const devtoResponse = await fetch("https://dev.to/api/articles", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"api-key": process.env.DEV_TO_API_TOKEN,
			},
			body: JSON.stringify(articleData),
		});

		if (!devtoResponse.ok) {
			const errorData = await devtoResponse.text();
			console.error("Dev.to API error:", errorData);
			console.error("Response status:", devtoResponse.status);
			console.error(
				"Response headers:",
				Object.fromEntries(devtoResponse.headers.entries()),
			);

			// Try to parse error for better error messages
			let errorMessage = "Failed to post to Dev.to";
			try {
				const parsedError = JSON.parse(errorData);
				if (parsedError.error) {
					errorMessage = `Dev.to API Error: ${parsedError.error}`;
				}
			} catch (e) {
				errorMessage = `Dev.to API Error (${devtoResponse.status}): ${errorData}`;
			}

			throw new Error(errorMessage);
		}

		const responseData = await devtoResponse.json();

		// Update Firestore document with Dev.to post information
		await firestore.collection("publish").doc(postDoc.id).update({
			devtoPostId: responseData.id,
			devtoUrl: responseData.url,
			devtoPublishedAt: new Date(),
			lastUpdated: new Date(),
		});

		return c.json({
			success: true,
			message: "Post published successfully to Dev.to",
			data: {
				devtoPostId: responseData.id,
				devtoUrl: responseData.url,
				title: responseData.title,
				publishedAt: responseData.published_at,
			},
		});
	} catch (error) {
		console.error("Error posting to Dev.to:", error);
		c.status = 500;
		return c.json({
			error: error.message,
		});
	}
});

app.post("/scrap-airbnb", async (c) => {
	const {
		city,
		state,
		country = "India",
		checkin,
		checkout,
		useProxy = false,
	} = await c.req.json();

	if (!city || !state) {
		return c.json({ error: "City and state are required" }, 400);
	}

	// Generate Airbnb search URL
	const searchQuery = `${city.replaceAll(" ", "-")}--${state.replaceAll(
		" ",
		"-",
	)}`;
	const airbnbUrl = `https://www.airbnb.com/s/${searchQuery}--${country}/homes`;

	// Add query parameters if provided
	const urlParams = new URLSearchParams();
	if (checkin) urlParams.append("checkin", checkin);
	if (checkout) urlParams.append("checkout", checkout);

	const fullUrl = urlParams.toString()
		? `${airbnbUrl}?${urlParams.toString()}`
		: airbnbUrl;

	console.log(`🏠 Scraping Airbnb listings from: ${fullUrl}`);

	let scrapedData = {};

	try {
		const response = await fetch(`http://localhost:3001/scrape`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				url: fullUrl,
				useProxy: false,
			}),
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const scrapData = await response.json();

		const allLinks = scrapData.data.links;

		const listings = [];
		// Process each listing link
		const elementsToProcess = allLinks.length;

		for (let i = 0; i < elementsToProcess; i++) {
			const link = allLinks[i];

			try {
				// Extract listing URL
				const listingUrl = link.href || link.url || "N/A";

				// Only include links that match the required Airbnb room URL pattern
				if (
					typeof listingUrl === "string" &&
					listingUrl.startsWith("https://www.airbnb.co")
				) {
					// Extract title from link text
					const title = link.text ? link.text : link.title;

					// Create listing data object
					const listingData = {
						title: title,
						url: listingUrl,
					};

					listings.push(listingData);
				}
			} catch (error) {
				console.warn(`Error processing listing ${i}:`, error);
				continue;
			}
		}

		scrapedData = {
			success: true,
			url: fullUrl,
			searchQuery: searchQuery,
			checkin: checkin || null,
			checkout: checkout || null,
			listings: listings,
			totalListings: listings.length,
			timestamp: new Date().toISOString(),
			useProxy: useProxy,
		};
	} catch (error) {
		console.error("❌ Error scraping Airbnb:", error);
		scrapedData = {
			success: false,
			error: error.message,
			url: fullUrl,
			timestamp: new Date().toISOString(),
		};
	}

	return c.json(scrapedData);
});

// Zod schemas for form generation
const formFieldSchema = z.object({
	id: z.string().describe("Unique identifier for the field"),
	type: z
		.enum([
			"text",
			"email",
			"number",
			"tel",
			"url",
			"password",
			"textarea",
			"select",
			"checkbox",
			"radio",
			"date",
			"time",
			"datetime-local",
			"file",
			"range",
			"switch",
			"card-select",
			"video-upload",
			"gallery-upload",
			"yes-no",
			"polling",
			"rating",
			"signature",
		])
		.describe("Type of the form field"),
	label: z.string().describe("Label for the form field"),
	name: z.string().describe("Name attribute for the form field"),
	placeholder: z.string().optional().describe("Placeholder text for the field"),
	required: z
		.boolean()
		.optional()
		.default(false)
		.describe("Whether the field is required"),
	options: z
		.array(z.string())
		.optional()
		.describe("Options for select, radio, or checkbox fields"),
	value: z
		.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
		.optional()
		.describe("Default or current value for the field"),
	validation: z
		.object({
			min: z
				.number()
				.optional()
				.describe("Minimum value for number/range fields"),
			max: z
				.number()
				.optional()
				.describe("Maximum value for number/range fields"),
			step: z.number().optional().describe("Step value for range fields"),
			minLength: z
				.number()
				.optional()
				.describe("Minimum length for text fields"),
			maxLength: z
				.number()
				.optional()
				.describe("Maximum length for text fields"),
			pattern: z.string().optional().describe("Regex pattern for validation"),
		})
		.optional()
		.describe("Validation rules for the field"),
	helperText: z
		.string()
		.optional()
		.describe("Helper text to display below the field"),
	yesLabel: z
		.string()
		.optional()
		.describe(
			"Custom label for 'Yes' option in yes-no fields (default: 'Yes')",
		),
	noLabel: z
		.string()
		.optional()
		.describe("Custom label for 'No' option in yes-no fields (default: 'No')"),
});

const formStepSchema = z.object({
	id: z.string().describe("Unique identifier for the step"),
	title: z.string().describe("Title of the form step"),
	description: z
		.string()
		.optional()
		.describe("Description or subtitle for the step"),
	fields: z
		.array(formFieldSchema)
		.describe("Array of form fields in this step"),
});

const formOutputSchema = z.object({
	title: z.string().describe("Title of the form"),
	description: z
		.string()
		.optional()
		.describe("Overall description of the form"),
	steps: z.array(formStepSchema).describe("Array of form steps"),
});

/**
 * Scrape website content using Firecrawl API
 * @param {string} url - The URL to scrape
 * @returns {Promise<{success: boolean, markdown?: string, error?: string}>}
 */
async function scrapeWithFirecrawl(url) {
	try {
		const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
		if (!firecrawlApiKey) {
			return {
				success: false,
				error: "FIRECRAWL_API_KEY environment variable is not set",
			};
		}

		// Validate URL format
		let validUrl;
		try {
			validUrl = new URL(url);
		} catch (e) {
			return {
				success: false,
				error: "Invalid URL format",
			};
		}

		// Only allow http/https protocols
		if (!["http:", "https:"].includes(validUrl.protocol)) {
			return {
				success: false,
				error: "Only http and https URLs are allowed",
			};
		}

		// Call Firecrawl API with timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

		try {
			const response = await fetch("https://api.firecrawl.dev/v0/scrape", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${firecrawlApiKey}`,
				},
				body: JSON.stringify({
					url: url,
					formats: ["markdown"],
				}),
				signal: controller.signal,
			});
			clearTimeout(timeoutId);

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				return {
					success: false,
					error:
						errorData.error?.message ||
						`Firecrawl API returned status ${response.status}`,
				};
			}

			const data = await response.json();

			// Extract markdown content from Firecrawl response
			const markdown =
				data.data?.markdown || data.markdown || data.content?.markdown || "";

			if (!markdown || markdown.trim().length === 0) {
				return {
					success: false,
					error: "No markdown content found in the scraped page",
				};
			}

			return {
				success: true,
				markdown: markdown,
			};
		} catch (error) {
			clearTimeout(timeoutId);
			if (error.name === "AbortError") {
				return {
					success: false,
					error: "Request timeout: Firecrawl API took too long to respond",
				};
			}
			console.error("Firecrawl scraping error:", error);
			return {
				success: false,
				error: error.message || "Failed to scrape URL with Firecrawl",
			};
		}
	} catch (error) {
		console.error("Firecrawl scraping error:", error);
		return {
			success: false,
			error: error.message || "Failed to scrape URL with Firecrawl",
		};
	}
}

/**
 * Scrape website content using internal scrape endpoint
 * @param {string} url - The URL to scrape
 * @param {string} baseUrl - The base URL for the API (e.g., http://localhost:3001)
 * @returns {Promise<{success: boolean, markdown?: string, error?: string}>}
 */
async function scrapeWithOwnEndpoint(url, baseUrl) {
	try {
		// Validate URL format
		let validUrl;
		try {
			validUrl = new URL(url);
		} catch (e) {
			return {
				success: false,
				error: "Invalid URL format",
			};
		}

		// Only allow http/https protocols
		if (!["http:", "https:"].includes(validUrl.protocol)) {
			return {
				success: false,
				error: "Only http and https URLs are allowed",
			};
		}

		// Call internal scrape endpoint with timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 120000); // 120 second timeout

		try {
			const response = await fetch(`${baseUrl}/scrape`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					url: url,
					includeSemanticContent: true,
					includeImages: false,
					includeLinks: false,
					extractMetadata: false,
					timeout: 60000,
				}),
				signal: controller.signal,
			});
			clearTimeout(timeoutId);

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				return {
					success: false,
					error:
						errorData.error?.message ||
						`Internal scraping endpoint returned status ${response.status}`,
				};
			}

			const data = await response.json();

			// Extract markdown content from response
			const markdown = data.markdown || "";

			if (!markdown || markdown.trim().length === 0) {
				return {
					success: false,
					error: "No markdown content found in the scraped page",
				};
			}

			return {
				success: true,
				markdown: markdown,
			};
		} catch (error) {
			clearTimeout(timeoutId);
			if (error.name === "AbortError") {
				return {
					success: false,
					error:
						"Request timeout: Internal scraping endpoint took too long to respond",
				};
			}
			console.error("Internal scraping error:", error);
			return {
				success: false,
				error: error.message || "Failed to scrape URL with internal endpoint",
			};
		}
	} catch (error) {
		console.error("Internal scraping error:", error);
		return {
			success: false,
			error: error.message || "Failed to scrape URL with internal endpoint",
		};
	}
}

// Generate form from URL endpoint
app.post("/generate-form-from-url", async (c) => {
	try {
		const { url, prompt } = await c.req.json();

		// Validate required fields
		if (!url || typeof url !== "string") {
			return c.json({ error: "URL is required" }, 400);
		}

		if (!prompt || typeof prompt !== "string") {
			return c.json({ error: "Prompt is required" }, 400);
		}

		// Scrape the website content using Firecrawl
		console.log("Scraping URL with Firecrawl:", url);
		const scrapeResult = await scrapeWithFirecrawl(url);

		if (!scrapeResult.success) {
			return c.json(
				{
					error: "Failed to scrape URL",
					details: scrapeResult.error,
				},
				400,
			);
		}

		const markdownContent = scrapeResult.markdown;

		// Limit markdown content to avoid token limits (keep first 50000 characters)
		const truncatedMarkdown =
			markdownContent.length > 50000
				? markdownContent.substring(0, 50000) +
					"\n\n[Content truncated due to length...]"
				: markdownContent;

		// System prompt for generating form from website content
		const systemPrompt = `You are an AI assistant specialized in generating structured form data from website content and natural language descriptions.

CRITICAL ARCHITECTURE RULE - ONE FIELD PER STEP:

═══════════════════════════════════════════════════════════════

- Each step MUST contain exactly ONE field (fields array with one element)

- Each field gets its own step

- The step title should match or describe the field label

- This creates a Typeform-style experience where users see one question at a time

Example:

- Step 1: { id: "step1", title: "What's your name?", fields: [{ id: "name", type: "text", label: "What's your name?", ... }] }

- Step 2: { id: "step2", title: "Email Address", fields: [{ id: "email", type: "email", label: "Email Address", ... }] }

Your task is to analyze the provided website content (in markdown format) and the user's prompt to create an appropriate multi-step form structure.

Consider:

- The website's purpose and content

- The user's specific requirements from the prompt

- What information would be relevant to collect based on the website context

- Create fields that make sense for the website's domain and the user's intent

IMPORTANT: You MUST return ONLY valid JSON that matches this exact schema:
{
  "title": string,
  "description": string (optional),
  "steps": [
    {
      "id": string,
      "title": string,
      "description": string (optional),
      "fields": [
        {
          "id": string,
          "type": string (one of: text, email, number, tel, url, password, textarea, select, checkbox, radio, date, time, datetime-local, file, range, switch, card-select, video-upload, gallery-upload, yes-no, polling, rating, signature),
          "label": string,
          "name": string,
          "placeholder": string (optional),
          "required": boolean (optional, default: false),
          "options": string[] (optional, for select/radio/checkbox),
          "value": string | number | boolean | string[] (optional),
          "validation": {
            "min": number (optional),
            "max": number (optional),
            "step": number (optional),
            "minLength": number (optional),
            "maxLength": number (optional),
            "pattern": string (optional)
          } (optional),
          "helperText": string (optional),
          "yesLabel": string (optional),
          "noLabel": string (optional)
        }
      ]
    }
  ]
}

Return ONLY the JSON object. Do not include any conversational text, explanations, or markdown code fences.`;

		// Create the prompt with website content and user prompt
		const content = `Website URL: ${url}

Website Content (Markdown):

═══════════════════════════════════════════════════════════════

${truncatedMarkdown}

═══════════════════════════════════════════════════════════════

User Prompt: "${prompt}"

Based on the website content above and the user's prompt, generate a complete multi-step form structure with appropriate fields. Each step should contain exactly one field.

Consider the website's context, purpose, and the user's requirements when creating the form fields.

Return ONLY the JSON object matching the schema above, with no additional text or formatting.`;

		// Generate form using Gemini AI
		let attempts = 0;
		const maxAttempts = 3;
		let formData = null;

		while (attempts < maxAttempts && !formData) {
			try {
				// Add timeout wrapper for Gemini API call
				const aiResponsePromise = genai.models.generateContent({
					model: "gemini-2.0-flash",
					contents: [
						{
							role: "user",
							parts: [
								{
									text: `${systemPrompt}\n\n${content}`,
								},
							],
						},
					],
				});

				// Add timeout to Gemini API call (90 seconds)
				const timeoutPromise = new Promise((_, reject) => {
					setTimeout(() => reject(new Error("Gemini API timeout")), 90000);
				});

				const aiResponse = await Promise.race([
					aiResponsePromise,
					timeoutPromise,
				]);

				const responseText =
					aiResponse?.candidates?.[0]?.content?.parts?.[0]?.text || "";

				// Extract JSON from response (handle code fences if present)
				let jsonText = responseText.trim();
				const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
				if (jsonMatch) {
					jsonText = jsonMatch[1].trim();
				}

				// Try to find JSON object boundaries
				const firstBrace = jsonText.indexOf("{");
				const lastBrace = jsonText.lastIndexOf("}");
				if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
					jsonText = jsonText.substring(firstBrace, lastBrace + 1);
				}

				// Parse and validate JSON
				const parsed = JSON.parse(jsonText);
				formData = formOutputSchema.parse(parsed);
				break;
			} catch (parseError) {
				attempts++;
				const isTimeout = parseError.message.includes("timeout");
				console.warn(
					`Attempt ${attempts} failed to parse/validate form data:`,
					parseError.message,
				);
				if (attempts >= maxAttempts) {
					throw new Error(
						`Failed to generate valid form structure after ${maxAttempts} attempts: ${parseError.message}`,
					);
				}
				// If timeout, wait a bit before retrying
				if (isTimeout) {
					await new Promise((resolve) => setTimeout(resolve, 2000));
				}
			}
		}

		if (!formData) {
			throw new Error("Failed to generate form data");
		}

		return c.json({
			...formData,
			source: {
				url: url,
				contentLength: markdownContent.length,
				truncated: markdownContent.length > 50000,
			},
		});
	} catch (err) {
		console.error("/generate-form-from-url error", err);
		return c.json(
			{
				error: "Failed to generate form data from URL",
				message: err.message || "Unknown error",
			},
			500,
		);
	}
});

// Generate form from URL endpoint using internal LLM scraping
app.post("/generate-form-from-url-llm", async (c) => {
	try {
		const { url, prompt } = await c.req.json();

		// Validate required fields
		if (!url || typeof url !== "string") {
			return c.json({ error: "URL is required" }, 400);
		}

		if (!prompt || typeof prompt !== "string") {
			return c.json({ error: "Prompt is required" }, 400);
		}

		// Determine base URL from request headers
		const xfProto = c.req.header("x-forwarded-proto") || "http";
		const xfHost = c.req.header("x-forwarded-host") || c.req.header("host");
		const fallbackHost = `127.0.0.1:${process.env.PORT || "3001"}`;
		const baseUrl = `${xfProto}://${xfHost || fallbackHost}`;

		// Scrape the website content using internal endpoint
		console.log("Scraping URL with internal endpoint:", url);
		const scrapeResult = await scrapeWithOwnEndpoint(url, baseUrl);

		if (!scrapeResult.success) {
			return c.json(
				{
					error: "Failed to scrape URL",
					details: scrapeResult.error,
				},
				400,
			);
		}

		const markdownContent = scrapeResult.markdown;

		// Limit markdown content to avoid token limits (keep first 50000 characters)
		const truncatedMarkdown =
			markdownContent.length > 50000
				? markdownContent.substring(0, 50000) +
					"\n\n[Content truncated due to length...]"
				: markdownContent;

		// System prompt for generating form from website content
		const systemPrompt = `You are an AI assistant specialized in generating structured form data from website content and natural language descriptions.

CRITICAL ARCHITECTURE RULE - ONE FIELD PER STEP:

═══════════════════════════════════════════════════════════════

- Each step MUST contain exactly ONE field (fields array with one element)

- Each field gets its own step

- The step title should match or describe the field label

- This creates a Typeform-style experience where users see one question at a time

Example:

- Step 1: { id: "step1", title: "What's your name?", fields: [{ id: "name", type: "text", label: "What's your name?", ... }] }

- Step 2: { id: "step2", title: "Email Address", fields: [{ id: "email", type: "email", label: "Email Address", ... }] }

Your task is to analyze the provided website content (in markdown format) and the user's prompt to create an appropriate multi-step form structure.

Consider:

- The website's purpose and content

- The user's specific requirements from the prompt

- What information would be relevant to collect based on the website context

- Create fields that make sense for the website's domain and the user's intent

IMPORTANT: You MUST return ONLY valid JSON that matches this exact schema:
{
  "title": string,
  "description": string (optional),
  "steps": [
    {
      "id": string,
      "title": string,
      "description": string (optional),
      "fields": [
        {
          "id": string,
          "type": string (one of: text, email, number, tel, url, password, textarea, select, checkbox, radio, date, time, datetime-local, file, range, switch, card-select, video-upload, gallery-upload, yes-no, polling, rating, signature),
          "label": string,
          "name": string,
          "placeholder": string (optional),
          "required": boolean (optional, default: false),
          "options": string[] (optional, for select/radio/checkbox),
          "value": string | number | boolean | string[] (optional),
          "validation": {
            "min": number (optional),
            "max": number (optional),
            "step": number (optional),
            "minLength": number (optional),
            "maxLength": number (optional),
            "pattern": string (optional)
          } (optional),
          "helperText": string (optional),
          "yesLabel": string (optional),
          "noLabel": string (optional)
        }
      ]
    }
  ]
}

Return ONLY the JSON object. Do not include any conversational text, explanations, or markdown code fences.`;

		// Create the prompt with website content and user prompt
		const content = `Website URL: ${url}

Website Content (Markdown):

═══════════════════════════════════════════════════════════════

${truncatedMarkdown}

═══════════════════════════════════════════════════════════════

User Prompt: "${prompt}"

Based on the website content above and the user's prompt, generate a complete multi-step form structure with appropriate fields. Each step should contain exactly one field.

Consider the website's context, purpose, and the user's requirements when creating the form fields.

Return ONLY the JSON object matching the schema above, with no additional text or formatting.`;

		// Generate form using Gemini AI
		let attempts = 0;
		const maxAttempts = 3;
		let formData = null;

		while (attempts < maxAttempts && !formData) {
			try {
				// Add timeout wrapper for Gemini API call
				const aiResponsePromise = genai.models.generateContent({
					model: "gemini-2.0-flash",
					contents: [
						{
							role: "user",
							parts: [
								{
									text: `${systemPrompt}\n\n${content}`,
								},
							],
						},
					],
				});

				// Add timeout to Gemini API call (90 seconds)
				const timeoutPromise = new Promise((_, reject) => {
					setTimeout(() => reject(new Error("Gemini API timeout")), 90000);
				});

				const aiResponse = await Promise.race([
					aiResponsePromise,
					timeoutPromise,
				]);

				const responseText =
					aiResponse?.candidates?.[0]?.content?.parts?.[0]?.text || "";

				// Extract JSON from response (handle code fences if present)
				let jsonText = responseText.trim();
				const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
				if (jsonMatch) {
					jsonText = jsonMatch[1].trim();
				}

				// Try to find JSON object boundaries
				const firstBrace = jsonText.indexOf("{");
				const lastBrace = jsonText.lastIndexOf("}");
				if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
					jsonText = jsonText.substring(firstBrace, lastBrace + 1);
				}

				// Parse and validate JSON
				const parsed = JSON.parse(jsonText);
				formData = formOutputSchema.parse(parsed);
				break;
			} catch (parseError) {
				attempts++;
				const isTimeout = parseError.message.includes("timeout");
				console.warn(
					`Attempt ${attempts} failed to parse/validate form data:`,
					parseError.message,
				);
				if (attempts >= maxAttempts) {
					throw new Error(
						`Failed to generate valid form structure after ${maxAttempts} attempts: ${parseError.message}`,
					);
				}
				// If timeout, wait a bit before retrying
				if (isTimeout) {
					await new Promise((resolve) => setTimeout(resolve, 2000));
				}
			}
		}

		if (!formData) {
			throw new Error("Failed to generate form data");
		}

		return c.json({
			...formData,
			source: {
				url: url,
				contentLength: markdownContent.length,
				truncated: markdownContent.length > 50000,
				scraper: "internal-llm",
			},
		});
	} catch (err) {
		console.error("/generate-form-from-url-llm error", err);
		return c.json(
			{
				error: "Failed to generate form data from URL",
				message: err.message || "Unknown error",
			},
			500,
		);
	}
});

// Google Maps scraping endpoint using headless Chrome
app.post("/scrap-google-maps", async (c) => {
	try {
		const { queries, singleQuery } = await c.req.json();

		if (!queries && !singleQuery) {
			return c.json(
				{
					success: false,
					error: "Either 'queries' array or 'singleQuery' string is required",
				},
				400,
			);
		}

		// Handle both single query and array of queries
		const queryArray = Array.isArray(queries)
			? queries
			: [queries || singleQuery];

		if (!queryArray.length || queryArray.some((q) => !q)) {
			return c.json(
				{
					success: false,
					error: "At least one valid query is needed",
				},
				400,
			);
		}

		let browser;
		try {
			// Launch headless Chrome browser with proper configuration
			browser = await chromium.launch({
				headless: true,
				userAgent:
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
				args: [
					"--no-sandbox",
					"--disable-setuid-sandbox",
					"--disable-dev-shm-usage",
					"--disable-accelerated-2d-canvas",
					"--no-first-run",
					"--no-zygote",
					"--single-process",
					"--disable-gpu",
				],
			});

			// Create a shared context for all queries
			const context = await browser.newContext();

			// Block unnecessary resources to improve performance
			await context.route("**/*", (route) => {
				const type = route.request().resourceType();
				return ["image", "font", "stylesheet"].includes(type)
					? route.abort()
					: route.continue();
			});

			// Process all queries in parallel using Promise.all
			const results = await Promise.all(
				queryArray.map(async (query) => {
					const page = await context.newPage();
					try {
						// Navigate to Google Maps
						await page.goto(
							`https://www.google.com/maps/search/${encodeURIComponent(query)}`,
							{
								waitUntil: "networkidle",
								timeout: 30000,
							},
						);

						// Wait a bit for the location to be fully loaded
						await page.waitForTimeout(5000);

						const locationResults = await page.evaluate(() => {
							// Select the results container with role feed and aria-label with Results for ...
							const resultsContainer = Array.from(
								document.querySelectorAll('div[role="feed"]'),
							).find((el) =>
								el.getAttribute("aria-label")?.includes("Results for"),
							);

							if (!resultsContainer) return [];

							// Each child div under feed represents a location card
							const cards = Array.from(
								resultsContainer.querySelectorAll("div"),
							).slice(0, 10);

							return cards.map((card) => {
								// Name
								const name =
									card
										.querySelector('[class*="fontHeadlineSmall"]')
										?.textContent?.trim() || "";

								// Rating text (e.g. "Rated 4.5 stars out of 5")
								const ratingLabel =
									card
										.querySelector('[class*="fontBodyMedium"]')
										?.getAttribute("aria-label") || "";
								const ratingMatch = ratingLabel.match(/Rated ([0-9.]+) stars?/);
								const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

								// Review count text (e.g. "200 reviews")
								const reviewsText =
									card
										.querySelector('[aria-label$="reviews"]')
										?.getAttribute("aria-label") || "";
								const reviewsMatch = reviewsText.match(/(\d+,?\d*) reviews/);
								const reviews = reviewsMatch
									? reviewsMatch[1].replace(/,/g, "")
									: null;

								// Google Maps URL link
								const url =
									card.querySelector(
										'a[href*="https://lh3.googleusercontent.com/gps-cs-s"]',
									)?.href || "";

								// Image URL (if exists)
								const image = card.querySelector("img[src]")?.src || "";

								return { name, rating, reviews, url, image };
							});
						});

						return { query, ...locationResults };
					} catch (error) {
						console.error(`Error processing query "${query}":`, error);
						return {
							query,
							name: "",
							address: "",
							coordinates: null,
							url: "",
							details: [],
							rating: "Rating not available",
							reviews: "Reviews not available",
							type: "Location",
							error: error.message,
						};
					} finally {
						await page.close();
					}
				}),
			);

			// Close the shared context after all queries are complete
			await context.close();

			// If single query was provided, return just the location data
			if (!Array.isArray(queries)) {
				const result = results[0];
				if (!result.coordinates) {
					return c.json(
						{
							success: false,
							error: "Location not found or coordinates not available",
							data: result,
						},
						404,
					);
				}
				return c.json({
					success: true,
					data: result,
				});
			}

			// For multiple queries, return array of results
			return c.json({
				success: true,
				data: {
					totalQueries: queryArray.length,
					results: results,
					generatedAt: new Date().toISOString(),
				},
			});
		} finally {
			if (browser) {
				await browser.close();
			}
		}
	} catch (error) {
		console.error("Google Maps Scraping Error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to fetch location data",
				details: error.message,
			},
			500,
		);
	}
});

// Enhanced Bing Search endpoint using Axios
app.post("/bing-search", async (c) => {
	const {
		query,
		num = 10,
		language = "en",
		country = "in",
		timeout = 10000,
	} = await c.req.json();

	if (!query) {
		return c.json({ error: "Query parameter is required" }, 400);
	}

	try {
		const puppeteer = (await import("puppeteer-core")).default;
		const launchArgs = [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-gpu",
			"--no-zygote",
			"--single-process",
		];
		const selectedProxy = proxyManager.getNextProxy();
		launchArgs.push(
			`--proxy-server=http://${selectedProxy.host}:${selectedProxy.port}`,
		);

		const executablePath = await chromium.executablePath();
		const browser = await puppeteer.launch({
			executablePath: executablePath || undefined,
			headless: "new",
			args: launchArgs,
		});
		const page = await browser.newPage();
		await page.setUserAgent(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
				"AppleWebKit/537.36 (KHTML, like Gecko) " +
				"Chrome/123.0.0.0 Safari/537.36",
		);

		await page.setExtraHTTPHeaders({
			"Accept-Language": "en-US,en;q=0.9",
		});

		// Authenticate proxy if credentials exist
		if (selectedProxy.username && selectedProxy.password) {
			await page.authenticate({
				username: selectedProxy.username,
				password: selectedProxy.password,
			});
		}

		await page.goto(
			`https://www.bing.com/search?q=${encodeURIComponent(
				query,
			)}&setLang=${language}&count=${num}&pws=0`,
			{
				waitUntil: "domcontentloaded",
				timeout: timeout,
			},
		);
		const response = await page.evaluate(() => {
			return {
				html: document.documentElement.outerHTML,
			};
		});

		let bingResults = [];
		const $ = load(response.html);
		$("li.b_algo").each((i, el) => {
			const linkTag = $(el).find("h2 a");
			const href = linkTag.attr("href") || "";
			const title = linkTag.text().trim();
			const description = $(el).find(".b_caption p").text().trim();

			if (href && title) {
				bingResults.push({ title, link: href, description });
			}
		});

		// Use response.data directly - axios already handles UTF-8
		const dom = new JSDOM(response.html, {
			contentType: "text/html",
			includeNodeLocations: false,
			storageQuota: 10000000,
		});
		const document = dom.window.document;
		const { markdown } = await extractSemanticContentWithFormattedMarkdown(
			document.body,
		);

		return c.json({
			query,
			results: bingResults,
			markdown: markdown,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error("❌ Bing search error:", error);
		return c.json(
			{
				success: false,
				error: error.message,
				query,
				engine: "bing",
			},
			500,
		);
	}
});

// Scrap images for the internet
app.post("/scrap-images", async (c) => {
	const { query, platform, allowAllPlatforms = false } = await c.req.json();

	if (!query) {
		return c.json({ success: false, error: "query is required" }, 400);
	}

	// Original single platform logic
	if (!platform && !allowAllPlatforms) {
		return c.json(
			{
				success: false,
				error: `Platform is required. Choose from: 'google', 'unsplash', 'getty', 'istock', 'shutterstock', 'adobe', 'pexels', 'pixabay', 'freepik', 'pinterest', 'flickr', 'fivehundredpx', 'deviantart', 'behance', 'artstation', 'reuters', 'apimages', 'custom'. 
					Or use allowAllPlatforms as true boolean value`,
			},
			400,
		);
	}

	// Define platform configurations
	const platforms = {
		google: {
			url: `https://www.google.com/search?q=${encodeURIComponent(
				query,
			)}&tbm=isch`,
			name: "Google Images",
		},
		unsplash: {
			url: `https://unsplash.com/s/photos/${query.replace(/\s+/g, "-")}`,
			name: "Unsplash",
		},
		getty: {
			url: `https://www.gettyimages.in/photos/${query.replace(/\s+/g, "-")}`,
			name: "Getty Images",
		},
		istock: {
			url: `https://www.istockphoto.com/photos/${query.replace(/\s+/g, "-")}`,
			name: "iStock",
		},
		shutterstock: {
			url: `https://www.shutterstock.com/search/${query.replace(/\s+/g, "-")}`,
			name: "Shutterstock",
		},
		adobe: {
			url: `https://stock.adobe.com/search?k=${encodeURIComponent(query)}`,
			name: "Adobe Stock",
		},
		pexels: {
			url: `https://www.pexels.com/search/${query.replace(/\s+/g, "%20")}/`,
			name: "Pexels",
		},
		pixabay: {
			url: `https://pixabay.com/images/search/${query.replace(/\s+/g, "%20")}/`,
			name: "Pixabay",
		},
		freepik: {
			url: `https://www.freepik.com/search?format=search&query=${encodeURIComponent(
				query,
			)}`,
			name: "Freepik",
		},
		pinterest: {
			url: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(
				query,
			)}`,
			name: "Pinterest",
		},
		flickr: {
			url: `https://www.flickr.com/search/?text=${encodeURIComponent(query)}`,
			name: "Flickr",
		},
		fivehundredpx: {
			url: `https://500px.com/search?q=${encodeURIComponent(query)}`,
			name: "500px",
		},
		deviantart: {
			url: `https://www.deviantart.com/search?q=${encodeURIComponent(query)}`,
			name: "DeviantArt",
		},
		behance: {
			url: `https://www.behance.net/search/projects?search=${encodeURIComponent(
				query,
			)}`,
			name: "Behance",
		},
		artstation: {
			url: `https://www.artstation.com/search?q=${encodeURIComponent(query)}`,
			name: "ArtStation",
		},
		reuters: {
			url: `https://www.reuters.com/search?q=${encodeURIComponent(query)}`,
			name: "Reuters",
		},
		apimages: {
			url: `https://www.apimages.com/search?st=${encodeURIComponent(query)}`,
			name: "AP Images",
		},
		custom: {
			url: query, // Use the location directly as URL
			name: "Custom URL",
		},
	};

	// If allowAllPlatforms is true, we'll scrape from all platforms
	if (allowAllPlatforms) {
		// Define all available platforms (excluding custom)
		const allPlatforms = [
			"google",
			"unsplash",
			"getty",
			"istock",
			"shutterstock",
			"adobe",
			"pexels",
			"pixabay",
			"freepik",
			"pinterest",
			"flickr",
			"fivehundredpx",
			"deviantart",
			"behance",
			"artstation",
			"reuters",
			"apimages",
		];

		try {
			// Scrape from all platforms in parallel
			const platformPromises = allPlatforms.map(async (platformName) => {
				try {
					const platformUrl = platforms[platformName].url;
					const response = await fetch(`http://localhost:3001/scrap-url`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							url: platformUrl,
							includeImages: true,
							includeLinks: false,
							extractMetadata: false,
							includeSemanticContent: false,
							timeout: 30000,
						}),
					});

					if (!response.ok) {
						throw new Error(`HTTP error! status: ${response.status}`);
					}

					const data = await response.json();

					// Limit to 10 results per platform
					const limitedImages = data.images ? data.images.slice(0, 10) : [];

					return {
						platform: platformName,
						platformName: data.platformName,
						success: data.success,
						imageCount: limitedImages.length,
						images: limitedImages,
						url: data.url,
					};
				} catch (error) {
					console.error(`Error scraping ${platformName} for ${query}:`, error);
					return {
						platform: platformName,
						platformName: platformName,
						success: false,
						error: error.message,
						imageCount: 0,
						images: [],
					};
				}
			});

			// Wait for all platforms to complete
			const results = await Promise.all(platformPromises);

			// Calculate total statistics
			const totalImages = results.reduce(
				(sum, result) => sum + result.imageCount,
				0,
			);
			const successfulPlatforms = results.filter((r) => r.success).length;
			const failedPlatforms = results.filter((r) => !r.success).length;

			return c.json({
				success: true,
				message: `Scraped images from all platforms for "${query}"`,
				query: query,
				allowAllPlatforms: true,
				totalImages: totalImages,
				successfulPlatforms: successfulPlatforms,
				failedPlatforms: failedPlatforms,
				platforms: results,
				timestamp: new Date().toISOString(),
			});
		} catch (error) {
			console.error(`Error in allowAllPlatforms mode for ${query}:`, error);
			return c.json(
				{
					success: false,
					error: "Failed to scrape from all platforms",
					details: error.message,
					query: query,
				},
				500,
			);
		}
	}

	// Check if platform is supported
	if (!platforms[platform]) {
		return c.json(
			{
				success: false,
				error: `Unsupported platform. Supported platforms: ${Object.keys(
					platforms,
				).join(", ")}`,
			},
			400,
		);
	}

	const platformConfig = platforms[platform];

	// Handle custom URL case
	let targetUrl;
	if (platform === "custom") {
		// For custom platform, validate that the query is a valid URL
		try {
			new URL(query);
			targetUrl = query;
		} catch (error) {
			return c.json(
				{
					success: false,
					error: "For custom platform, query must be a valid URL",
				},
				400,
			);
		}
	} else {
		targetUrl = platformConfig.url;
	}

	try {
		// Use the existing scrap-url endpoint
		const response = await fetch(`http://localhost:3001/scrap-url`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				url: targetUrl,
				includeImages: true,
				includeLinks: false,
				extractMetadata: false,
				includeSemanticContent: false,
				timeout: 30000,
			}),
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const data = await response.json();
		const scrapedData = data.data?.images || [];

		return c.json({
			success: true,
			message: `${platformConfig.name} images scraped successfully for ${query}`,
			platform: platform,
			platformName: platformConfig.name,
			url: targetUrl,
			imageCount: scrapedData.length,
			images: scrapedData,
		});
	} catch (error) {
		console.error(`Error scraping ${platformConfig.name} for ${query}:`, error);
		return c.json(
			{
				success: false,
				error: `Failed to scrape ${platformConfig.name} images`,
				details: error.message,
				platform: platform,
				query: query,
				url: targetUrl,
			},
			500,
		);
	}
});

app.post("/ddg-search", async (c) => {
	const { query } = await c.req.json();
	const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

	let browser;
	const results = [];
	try {
		const selectedProxy = proxyManager.getNextProxy();
		const puppeteerExtra = (await import("puppeteer-core")).default;
		const chromium = (await import("@sparticuz/chromium")).default;
		let launchArgs = [...chromium.args, "--disable-web-security"];

		try {
			const executablePath = await chromium.executablePath();
			browser = await puppeteerExtra.launch({
				headless: true,
				args: launchArgs,
				executablePath: executablePath,
				ignoreDefaultArgs: ["--disable-extensions"],
				...(selectedProxy
					? [
							`--proxy-server=http://${selectedProxy.host}:${selectedProxy.port}`,
						]
					: []),
			});
		} catch (chromiumError) {
			// Fallback to system Chrome
			browser = await puppeteerExtra.launch({
				headless: true,
				executablePath:
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				args: [
					"--no-sandbox",
					"--disable-setuid-sandbox",
					"--disable-dev-shm-usage",
					"--disable-gpu",
					"--disable-web-security",
					...(selectedProxy
						? [
								`--proxy-server=http://${selectedProxy.host}:${selectedProxy.port}`,
							]
						: []),
				],
			});
		}

		const page = await browser.newPage();

		// Fake a real browser
		await page.setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
		);
		// Authenticate proxy if credentials exist
		if (selectedProxy.username && selectedProxy.password) {
			await page.authenticate({
				username: selectedProxy.username,
				password: selectedProxy.password,
			});
		}

		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

		const html = await page.content();
		const $ = load(html);

		$("div.result").each((i, el) => {
			const linkTag = $(el).find(".result__a");
			const href = linkTag.attr("href") || "";
			const title = linkTag.text().trim();
			const description = $(el).find(".result__snippet").text().trim();

			const url = decodeURIComponent(href.split("uddg=")[1].split("&rut")[0]);
			if (href && title) {
				results.push({ title, link: url, description });
			}
		});

		return c.json({ query, results, timestamp: new Date().toISOString() });
	} catch (err) {
		console.error("DuckDuckGo scraper error:", err.message);
		return c.json({ error: err.message }, 500);
	} finally {
		if (browser) await browser.close();
	}
});

function cleanGoogleUrl(url) {
	try {
		// If url starts with "/url?", prepend a fake host to parse
		if (url.startsWith("/url?")) {
			url = "https://google.com" + url;
		}
		if (!url.includes("https://")) {
			url = "https://" + url.hostname + url;
		}
		const parsedUrl = new URL(url);
		const realUrl = parsedUrl.searchParams.get("q");
		if (realUrl) {
			return realUrl; // cleaned URL
		}
		return url; // return original if no 'q' param
	} catch (e) {
		return url; // fallback to original url if parsing fails
	}
}

function parseGoogleResults(html) {
	const results = [];
	const $ = load(html);

	$("div#search > div#rso").each((i, el) => {
		const linkTag = $(el).find("a[href]").first();
		const href = linkTag.attr("href") || "";
		const title = $(el).find("h3").first().text().trim();
		const description = $(el).find("div[style*='line']").first().text().trim();

		console.log(href, title);
		if (href && title) {
			const link = cleanGoogleUrl(href);
			if (link.startsWith("http")) {
				results.push({ title, link, description });
			}
		}
	});

	return results;
}

app.post("/google-search", async (c) => {
	const {
		query,
		num = 10,
		language = "en",
		country = "us",
		timeout = 30000,
	} = await c.req.json();

	try {
		const puppeteer = (await import("puppeteer-core")).default;
		const launchArgs = [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-gpu",
			"--no-zygote",
			"--single-process",
		];
		const selectedProxy = proxyManager.getNextProxy();
		launchArgs.push(
			`--proxy-server=http://${selectedProxy.host}:${selectedProxy.port}`,
		);
		const browser = await puppeteer.launch({
			executablePath:
				"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			headless: "new",
			args: launchArgs,
		});

		const page = await browser.newPage();

		await page.setUserAgent(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
				"AppleWebKit/537.36 (KHTML, like Gecko) " +
				"Chrome/123.0.0.0 Safari/537.36",
		);

		await page.setExtraHTTPHeaders({
			"Accept-Language": "en-US,en;q=0.9",
		});

		// Authenticate proxy if credentials exist
		if (selectedProxy.username && selectedProxy.password) {
			await page.authenticate({
				username: selectedProxy.username,
				password: selectedProxy.password,
			});
		}

		await page.goto(
			`https://www.google.com/search?q=${encodeURIComponent(
				query,
			)}&hl=${language}&gl=${country}&num=${num}&pws=0`,
			{
				waitUntil: "domcontentloaded",
				timeout: timeout,
			},
		);
		const response = await page.evaluate(() => {
			return {
				html: document.documentElement.outerHTML,
			};
		});

		const results = parseGoogleResults(response.html);

		// Use response.data directly - axios already handles UTF-8
		const dom = new JSDOM(response.html, {
			contentType: "text/html",
			includeNodeLocations: false,
			storageQuota: 10000000,
		});
		const document = dom.window.document;
		const { markdown } = await extractSemanticContentWithFormattedMarkdown(
			document.body,
		);

		return c.json({
			query,
			results,
			searchUrl: response.config.url,
			markdown: markdown,
		});
	} catch (error) {
		console.error("Google search error:", error);
		return c.json({ error: error.message }, 500);
	}
});

function isValidURL(urlString) {
	try {
		new URL(urlString);
		return true;
	} catch (error) {
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
	const data = await response.json();
	return data;
};

const scrapHtml = async (url) => {
	const response = await fetch(url);
	const html = await response.text();
	return html;
};

/**
 * Core scraping logic for a single URL. Returns result object or throws.
 * Used by both /scrape and /scrap-urls-puppeteer.
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
		includeCache = false,
		useProxy = false,
		aiSummary = false,
		takeScreenshot = false,
	} = {},
) {
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

	let existingData;
	if (includeCache) {
		const { data, error: fetchError } = await supabase
			.from("universo")
			.select("scraped_data, scraped_at, markdown, screenshot")
			.eq("url", targetUrl);
		existingData = data?.[0];
		if (fetchError || !existingData) {
			throw new Error("Cache miss or fetch error");
		}
		if (existingData?.scraped_data) {
			return {
				success: true,
				data: JSON.parse(existingData.scraped_data),
				markdown: existingData?.markdown ?? null,
				summary: null,
				screenshot: existingData?.screenshot ?? null,
			};
		}
	}

	const maxAttempts = useProxy ? 3 : 1;
	let lastError;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let selectedProxy = null;
		const { userAgent, extraHTTPHeaders, viewport } = generateRandomHeaders();

		try {
			if (useProxy) selectedProxy = proxyManager.getNextProxy();

			const poolResult = await browserPool.withPage(async (page) => {
				await page.setViewport(viewport);
				await page.setUserAgent(userAgent);
				await page.setExtraHTTPHeaders(extraHTTPHeaders);

				if (useProxy && selectedProxy?.username) {
					await page.authenticate({
						username: selectedProxy.username,
						password: selectedProxy.password,
					});
				}

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

				let blockedResources = {
					images: 0,
					fonts: 0,
					stylesheets: 0,
					media: 0,
				};
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
						blockedResources.images++;
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
						blockedResources.images++;
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
						blockedResources.images++;
						request.abort();
						return;
					}
					if (reqUrl.startsWith("data:image/")) {
						blockedResources.images++;
						request.abort();
						return;
					}
					if (resourceType === "stylesheet") {
						blockedResources.stylesheets++;
						request.respond({ status: 200, contentType: "text/css", body: "" });
						return;
					}
					if (resourceType === "font") {
						blockedResources.fonts++;
						request.abort();
						return;
					}
					if (resourceType === "media") {
						blockedResources.media++;
						request.abort();
						return;
					}
					request.continue();
				});

				const navStart = Date.now();
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
				const navLatency = Date.now() - navStart;

				if (waitForSelector) {
					try {
						await page.waitForSelector(waitForSelector, { timeout: 10000 });
					} catch {}
				}

				let scrapedData = {};
				if (includeSemanticContent) {
					scrapedData = await page.evaluate(
						async (opts) => {
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
								data.content[tag] = Array.from(
									document.querySelectorAll(tag),
								).map((h) => h.textContent.trim());
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
											if (new URL(link.href).hostname !== seedDomain)
												return false;
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
				const { markdown } = extractSemanticContentWithFormattedMarkdown(
					doc.body,
				);

				let screenshotUrl = null;
				if (takeScreenshot) {
					try {
						const buf = await page.screenshot({ fullPage: true });
						const fname = `ihr-website-screenshot/screenshots/${Date.now()}-${uuidv4().replace(/[^a-zA-Z0-9]/g, "")}.png`;
						const bucket = storage.bucket(process.env.FIREBASE_BUCKET);
						const file = bucket.file(fname);
						await file.save(buf, {
							metadata: {
								contentType: "image/png",
								cacheControl: "public, max-age=3600",
							},
						});
						await file.makePublic();
						screenshotUrl = `https://storage.googleapis.com/${process.env.FIREBASE_BUCKET}/${file.name}`;
					} catch {}
				}

				if (useProxy && selectedProxy)
					proxyManager.recordProxyResult(selectedProxy.host, true, navLatency);

				if (!includeCache) {
					try {
						const { data: existingRows, error: fetchError } = await supabase
							.from("universo")
							.select("id")
							.eq("url", targetUrl);
						if (!fetchError && (!existingRows || existingRows.length === 0)) {
							await supabase.from("universo").insert({
								title: scrapedData?.title || "No Title",
								url: targetUrl,
								markdown,
								scraped_at: new Date().toISOString(),
								scraped_data: JSON.stringify(scrapedData),
							});
						}
					} catch {}
				}

				if (includeSemanticContent && scrapedData?.content)
					removeEmptyKeys(scrapedData.content);

				let summary = null;
				if (aiSummary && markdown) {
					try {
						const splitter = RecursiveCharacterTextSplitter.fromLanguage(
							"markdown",
							{ separators: "\n\n", chunkSize: 1024, chunkOverlap: 128 },
						);
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
						summary = aiResponse.candidates[0].content.parts[0].text;
					} catch {}
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
		} catch (attemptError) {
			lastError = attemptError;
			if (useProxy && selectedProxy)
				proxyManager.recordProxyResult(selectedProxy.host, false);
			if (attempt < maxAttempts) {
				await randomDelay(300, 1200);
				continue;
			}
			throw lastError;
		}
	}

	throw lastError || new Error("Scraping failed");
}

// New Puppeteer-based URL scraping endpoint (single URL)
app.post("/scrape", async (c) => {
	customLogger("Scraping URL with Puppeteer", await c.req.header());

	const RATE_LIMIT = 50;
	const RATE_WINDOW_MS = 10 * 60 * 1000;
	const clientIp =
		c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";

	const rl = rateLimit(clientIp, RATE_LIMIT, RATE_WINDOW_MS);
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
				ip: clientIp,
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
			url: url,
			timestamp: new Date().toISOString(),
			poolStats: browserPool.stats,
		});
	} catch (error) {
		console.error("❌ Web scraping error (Puppeteer):", error);
		return c.json(
			{
				success: false,
				error: "Failed to scrape URL using Puppeteer",
				details: "Unable to scrap, check URL",
				url: url,
			},
			500,
		);
	}
});

// Batch Puppeteer scraping: multiple URLs in parallel, never fails entire request
app.post("/scrape-multiple", async (c) => {
	customLogger("Scraping URLs (batch) with Puppeteer", await c.req.header());

	const RATE_LIMIT = 100;
	const RATE_WINDOW_MS = 10 * 60 * 1000;
	const MAX_URLS = 20;

	const clientIp =
		c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";

	const rl = rateLimit(clientIp, RATE_LIMIT, RATE_WINDOW_MS);
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
			{
				success: false,
				error: `Maximum ${MAX_URLS} URLs per request`,
			},
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

// ─── Inkgest Agent: one LLM + scrape endpoints + extensible skills ────────
const INKGEST_SCRAPE_BASE =
	process.env.INKGEST_SCRAPE_BASE_URL ||
	process.env.SCRAPE_API_BASE_URL ||
	"http://localhost:3002";

const OPENROUTER_TIMEOUT_MS = 90_000; // 90s for LLM responses

async function openRouterChatMessages(
	apiKey,
	messages,
	maxTokens = 1200,
	options = {},
) {
	const body = {
		model:
			process.env.OPENROUTER_AGENT_MODEL ||
			process.env.OPENROUTER_MODEL ||
			"openai/gpt-4o-mini",
		messages,
		temperature: options.temperature ?? 0.3,
		max_tokens: maxTokens,
	};
	if (options.response_format) body.response_format = options.response_format;
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data?.error?.message || `OpenRouter error (${res.status})`);
	}
	const content = data?.choices?.[0]?.message?.content || "";
	const usage = data?.usage
		? {
				prompt_tokens: data.usage.prompt_tokens ?? 0,
				completion_tokens: data.usage.completion_tokens ?? 0,
				total_tokens: data.usage.total_tokens ?? 0,
			}
		: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
	return { content, usage };
}

const openRouterKey = process.env.OPENROUTER_API_KEY;

app.post("/inkgest-agent", async (c) => {
	try {
		if (!openRouterKey || !String(openRouterKey).trim()) {
			return c.json(
				{
					error: "OpenRouter API key not configured",
					code: "MISSING_API_KEY",
					details:
						"Set OPENROUTER_API_KEY in your environment (e.g. Vercel, Railway) for the inkgest-agent to work.",
				},
				503,
			);
		}

		const {
			prompt = "",
			chatHistory = [],
			executeTasks = [],
			images: bodyImages = [],
		} = (await c.req.json().catch(() => ({}))) || {};
		const userPrompt = String(prompt).trim();
		const hasExecuteTasks =
			Array.isArray(executeTasks) && executeTasks.length > 0;
		const hasImages =
			Array.isArray(bodyImages) && bodyImages.length > 0;

		if (!userPrompt && !hasExecuteTasks) {
			return c.json({ error: "Prompt or executeTasks required" }, 400);
		}

		const extractedUrls = hasExecuteTasks
			? [
					...new Set(
						executeTasks.flatMap((t) => {
							const fromParams = (
								Array.isArray(t.params?.urls) ? t.params.urls : []
							).filter((u) => /^https?:\/\/\S+$/i.test(String(u)));
							const fromPrompt = extractUrlsFromText(t.params?.prompt || "");
							return [...fromParams, ...fromPrompt];
						}),
					),
				]
			: extractUrlsFromText(userPrompt);

		const urlsToScrape = extractedUrls.slice(0, 10);
		const redditUrls = urlsToScrape.filter(isRedditUrl);
		const youtubeUrls = urlsToScrape.filter(isYoutubeUrl);
		const regularUrls = urlsToScrape.filter(
			(u) => !isRedditUrl(u) && !isYoutubeUrl(u),
		);
		const apiBase = process.env.API_BASE_URL || new URL(c.req.url).origin;
		// In production, INKGEST_SCRAPE_BASE defaults to localhost:3002 which is unreachable.
		// Use apiBase when env vars are unset so /scrape and /scrape-multiple (same app) work.
		const scrapeBase =
			process.env.INKGEST_SCRAPE_BASE_URL || process.env.SCRAPE_API_BASE_URL
				? INKGEST_SCRAPE_BASE
				: apiBase;
		let scrapedSources = [];
		let scrapeErrors = [];
		let parsed = {};
		let suggestedTasks = [];

		const creditsDistribution = [];
		let creditsUsed = 0;
		const tokenUsage = {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		};

		function addTokenUsage(usage) {
			if (usage && typeof usage === "object") {
				tokenUsage.prompt_tokens += usage.prompt_tokens || 0;
				tokenUsage.completion_tokens += usage.completion_tokens || 0;
				tokenUsage.total_tokens += usage.total_tokens || 0;
			}
		}

		if (!hasExecuteTasks) {
			const urlLine = urlsToScrape.length
				? `URLs found: ${urlsToScrape.join(", ")}`
				: 'URLs found: none. You MUST infer the URL from the user\'s message (e.g. \'scrape dev.to\' → params.urls: ["https://dev.to"] or ["https://dev.to/rss"], \'dev.to RSS\' → ["https://dev.to/rss"]). Set suggestedTasks[].params.urls to the inferred URL(s) and shouldExecute: true. Do not say you need URLs.';
			const imageLine = hasImages
				? `Images provided: ${bodyImages.length} image(s). You MUST suggest an image-reading task with params.images (the executor will inject the actual images). Suggest blog, article, newsletter, or table to use the extracted image content.`
				: "";
			const userContent = `User message: ${userPrompt}\n\n${urlLine}${imageLine ? `\n\n${imageLine}` : ""}`;
			const messages = [
				{ role: "system", content: ROUTER_SYSTEM_PROMPT },
				...chatHistory.slice(-6).map((m) => ({
					role: m.role === "user" ? "user" : "assistant",
					content: m.content,
				})),
				{ role: "user", content: userContent },
			];

			async function scrapeAllUrls() {
				if (urlsToScrape.length === 0) return { sources: [], errors: [] };
				const [regularScraped, youtubeScraped, redditScraped] =
					await Promise.all([
						regularUrls.length > 0
							? scrapeUrlsViaApi(scrapeBase, regularUrls, {
									includeImages: true,
									aiSummary: true,
								})
							: { sources: [], errors: [] },
						youtubeUrls.length > 0
							? scrapeYoutubeViaApi(apiBase, youtubeUrls)
							: { sources: [], errors: [] },
						redditUrls.length > 0
							? scrapeRedditViaApi(apiBase, redditUrls)
							: { sources: [], errors: [] },
					]);
				// Fallback: when Reddit API blocks (common in prod), try Puppeteer scrape
				let redditFinal = redditScraped;
				if (
					redditUrls.length > 0 &&
					redditScraped.sources?.length === 0 &&
					redditScraped.errors?.length > 0
				) {
					redditFinal = await scrapeUrlsViaApi(scrapeBase, redditUrls, {
						includeImages: true,
						aiSummary: true,
					});
					if (redditFinal.sources?.length > 0) {
						console.log(
							"[inkgest-agent] Reddit fallback (Puppeteer) succeeded for",
							redditUrls.length,
							"URL(s)",
						);
					}
				}
				return {
					sources: [
						...(regularScraped.sources || []),
						...(youtubeScraped.sources || []),
						...(redditFinal.sources || []),
					],
					errors: [
						...(regularScraped.errors || []),
						...(youtubeScraped.errors || []),
						...(redditFinal.sources?.length > 0
							? []
							: redditScraped.errors || []),
					],
				};
			}

			const [scraped, routerResult] = await Promise.all([
				urlsToScrape.length > 0 ? scrapeAllUrls() : { sources: [], errors: [] },
				openRouterChatMessages(openRouterKey, messages),
			]);

			scrapedSources = scraped.sources || [];
			if (scraped.errors?.length) {
				scrapeErrors.push(...scraped.errors);
				console.error(
					"[inkgest-agent] Scrape errors (router path):",
					scraped.errors,
				);
			}
			const raw = routerResult.content;
			addTokenUsage(routerResult.usage);
			creditsDistribution.push({ task: "thinking", credits: CREDITS.thinking });
			creditsUsed += CREDITS.thinking;

			try {
				parsed = parseAgentResponse(raw);
			} catch (e) {
				return c.json(
					{
						error:
							"Agent could not parse your request. Try being more specific.",
						raw: raw.slice(0, 500),
						creditsUsed,
						creditsDistribution,
						tokenUsage,
					},
					500,
				);
			}

			suggestedTasks = (
				Array.isArray(parsed.suggestedTasks) ? parsed.suggestedTasks : []
			).map((t) => {
				const taskUrls =
					Array.isArray(t.params?.urls) && t.params.urls.length > 0
						? t.params.urls.filter((u) => /^https?:\/\/\S+$/i.test(String(u)))
						: urlsToScrape;
				return { ...t, params: { ...t.params, urls: taskUrls } };
			});
			if (hasImages) {
				const imageReadingIdx = suggestedTasks.findIndex(
					(t) => t.type === "image-reading",
				);
				const imageParams = { images: bodyImages };
				if (imageReadingIdx >= 0) {
					suggestedTasks[imageReadingIdx].params = {
						...suggestedTasks[imageReadingIdx].params,
						...imageParams,
					};
				} else {
					suggestedTasks.unshift({
						type: "image-reading",
						label: "Read image(s)",
						params: imageParams,
					});
				}
			}
		} else {
			if (urlsToScrape.length > 0) {
				const [regularScraped, youtubeScraped, redditScraped] =
					await Promise.all([
						regularUrls.length > 0
							? scrapeUrlsViaApi(scrapeBase, regularUrls, {
									aiSummary: true,
								})
							: { sources: [], errors: [] },
						youtubeUrls.length > 0
							? scrapeYoutubeViaApi(apiBase, youtubeUrls)
							: { sources: [], errors: [] },
						redditUrls.length > 0
							? scrapeRedditViaApi(apiBase, redditUrls)
							: { sources: [], errors: [] },
					]);
				let redditFinal = redditScraped;
				if (
					redditUrls.length > 0 &&
					redditScraped.sources?.length === 0 &&
					redditScraped.errors?.length > 0
				) {
					redditFinal = await scrapeUrlsViaApi(scrapeBase, redditUrls, {
						includeImages: true,
						aiSummary: true,
					});
					if (redditFinal.sources?.length > 0) {
						console.log(
							"[inkgest-agent] Reddit fallback (Puppeteer) succeeded for",
							redditUrls.length,
							"URL(s)",
						);
					}
				}
				scrapedSources = [
					...(regularScraped.sources || []),
					...(youtubeScraped.sources || []),
					...(redditFinal.sources || []),
				];
				if (regularScraped.errors?.length) {
					scrapeErrors.push(...regularScraped.errors);
					console.error(
						"[inkgest-agent] Scrape errors (execute path):",
						regularScraped.errors,
					);
				}
				if (youtubeScraped.errors?.length) {
					scrapeErrors.push(...youtubeScraped.errors);
					console.error(
						"[inkgest-agent] YouTube scrape errors:",
						youtubeScraped.errors,
					);
				}
				if (redditFinal.sources?.length === 0 && redditScraped.errors?.length) {
					scrapeErrors.push(...redditScraped.errors);
					console.error(
						"[inkgest-agent] Reddit scrape errors:",
						redditScraped.errors,
					);
				}
			}
		}

		let tasksToRun = hasExecuteTasks
			? executeTasks
			: parsed.shouldExecute === true
				? suggestedTasks
				: [];

		// Ensure every task has params.urls — scrape/content tasks need URLs.
		// Router may put URL in params.url (singular) or params.urls; inherit from other tasks when missing.
		const urlsFromAllTasks = [
			...new Set(
				tasksToRun.flatMap((t) => {
					const single = t.params?.url;
					const multi = Array.isArray(t.params?.urls) ? t.params.urls : [];
					return [
						...(single && /^https?:\/\/\S+$/i.test(String(single))
							? [single]
							: []),
						...multi.filter((u) => /^https?:\/\/\S+$/i.test(String(u))),
					];
				}),
			),
		];
		const fallbackUrls =
			urlsToScrape.length > 0 ? urlsToScrape : urlsFromAllTasks;
		tasksToRun = tasksToRun.map((t) => {
			const single = t.params?.url;
			const multi = Array.isArray(t.params?.urls) ? t.params.urls : [];
			const fromTask = [
				...(single && /^https?:\/\/\S+$/i.test(String(single)) ? [single] : []),
				...multi.filter((u) => /^https?:\/\/\S+$/i.test(String(u))),
			];
			const hasUrls = fromTask.length > 0;
			const taskUrls = hasUrls ? fromTask : fallbackUrls;
			return { ...t, params: { ...t.params, urls: taskUrls } };
		});

		if (hasImages) {
			tasksToRun = tasksToRun.map((t) =>
				t.type === "image-reading" &&
				(!Array.isArray(t.params?.images) || t.params.images.length === 0)
					? { ...t, params: { ...t.params, images: bodyImages } }
					: t,
			);
		}

		// When router inferred URLs (in tasks) but we didn't scrape (urlsToScrape was empty), scrape now
		if (
			scrapedSources.length === 0 &&
			fallbackUrls.length > 0 &&
			urlsToScrape.length === 0
		) {
			const lateReddit = fallbackUrls.filter(isRedditUrl);
			const lateYoutube = fallbackUrls.filter(isYoutubeUrl);
			const lateRegular = fallbackUrls.filter(
				(u) => !isRedditUrl(u) && !isYoutubeUrl(u),
			);
			const [reg, yt, rd] = await Promise.all([
				lateRegular.length > 0
					? scrapeUrlsViaApi(scrapeBase, lateRegular, {
							includeImages: true,
							aiSummary: true,
						})
					: { sources: [], errors: [] },
				lateYoutube.length > 0
					? scrapeYoutubeViaApi(apiBase, lateYoutube)
					: { sources: [], errors: [] },
				lateReddit.length > 0
					? scrapeRedditViaApi(apiBase, lateReddit)
					: { sources: [], errors: [] },
			]);
			let lateRedditFinal = rd;
			if (
				lateReddit.length > 0 &&
				rd.sources?.length === 0 &&
				rd.errors?.length > 0
			) {
				lateRedditFinal = await scrapeUrlsViaApi(scrapeBase, lateReddit, {
					includeImages: true,
					aiSummary: true,
				});
				if (lateRedditFinal.sources?.length > 0) {
					console.log(
						"[inkgest-agent] Reddit fallback (Puppeteer) succeeded (late scrape)",
					);
				}
			}
			scrapedSources = [
				...(reg.sources || []),
				...(yt.sources || []),
				...(lateRedditFinal.sources || []),
			];
			if (reg.errors?.length) scrapeErrors.push(...reg.errors);
			if (yt.errors?.length) scrapeErrors.push(...yt.errors);
			if (lateRedditFinal.sources?.length === 0 && rd.errors?.length)
				scrapeErrors.push(...rd.errors);
		}

		// Fallback: when only scrape is suggested but user wants a deliverable (summarise, blog, etc.), add article task
		const wantsDeliverable =
			/summarise|summarize|blog|article|create a|write a|from this (link|tweet|post|url)/i.test(
				userPrompt,
			);
		const onlyScrape =
			tasksToRun.length === 1 &&
			tasksToRun[0]?.type === "scrape" &&
			urlsToScrape.length > 0;
		if (onlyScrape && wantsDeliverable) {
			const format = /blog/i.test(userPrompt) ? "blog" : "article";
			tasksToRun = [
				...tasksToRun,
				{
					type: format,
					label: `Create ${format} from scraped content`,
					params: {
						urls: urlsToScrape,
						prompt:
							format === "blog"
								? "Create a blog post from this content"
								: "Summarize the key points and takeaways",
					},
				},
			];
		}

		const sourceByUrl = Object.fromEntries(
			scrapedSources.map((s) => [
				s.url,
				{
					url: s.url,
					markdown: s.markdown || "",
					title: s.title || "",
					links: s.links || [],
				},
			]),
		);

		// Flatten all scraped sources into a simple reference list for the final payload
		const allSourceReferences = scrapedSources
			.filter((s) => s && s.url)
			.map((s) => ({
				url: s.url,
				title: s.title || "",
			}));

		const validTasks = tasksToRun.filter(
			(t) => t && TASK_TYPES.includes(t.type),
		);

		// CRITICAL: When URLs are provided to scrape and scraping fails, do NOT create any asset.
		// End the task immediately — never fall back to AI-only content when scrape was expected.
		const CONTENT_TYPES_NEEDING_SOURCES = [
			"blog",
			"article",
			"newsletter",
			"substack",
			"linkedin",
			"twitter",
			"table",
			"landing-page-generator",
			"image-gallery-creator",
			"infographics-svg-generator",
		];
		const contentTasksNeedingScrape = validTasks.filter(
			(t) =>
				CONTENT_TYPES_NEEDING_SOURCES.includes(t.type) &&
				!t.params?.useCrawlResult,
		);
		if (
			urlsToScrape.length > 0 &&
			scrapedSources.length === 0 &&
			contentTasksNeedingScrape.length > 0
		) {
			const errPayload = {
				error:
					"Scraping failed for all provided URLs. Cannot create content without source data. The AI will not generate assets when URLs are provided and scrape fails.",
				scrapeErrors:
					scrapeErrors.length > 0
						? scrapeErrors
						: ["No content could be extracted from the URLs."],
				creditsUsed,
				creditsDistribution,
				tokenUsage,
			};
			console.error(
				"[inkgest-agent] Aborting: scrape failed for URLs, not running content tasks.",
				"urls:",
				urlsToScrape,
				"scrapeErrors:",
				errPayload.scrapeErrors,
			);
			return c.json(errPayload, 422);
		}

		const state = {
			tokenUsage: { ...tokenUsage },
			creditsUsed,
			creditsDistribution: [...creditsDistribution],
			/** After crawl-url tasks run, filled with { url, markdown, title, links }[] for useCrawlResult content tasks */
			crawlUrlSources: [],
			/** After image-reading task runs, filled with same shape as scrape sources for blog/article etc. */
			imageReadingSources: [],
			/** Top-level list of all scraped source references (URLs + optional titles) */
			references: allSourceReferences,
		};

		/** Build sources array from a crawl-url executed result for use in blog/table/article */
		function buildSourcesFromCrawlResult(executed) {
			const sources = [];
			if (executed.homePageData && executed.homePageData.markdown != null) {
				const hp = executed.homePageData;
				sources.push({
					url: executed.url || hp.url || "",
					markdown: hp.markdown || "",
					title: hp.data?.metadata?.title || hp.data?.title || "",
					links: Array.isArray(hp.data?.links) ? hp.data.links : [],
				});
			}
			(executed.nestedResults || []).forEach((r) => {
				if (r.url) {
					sources.push({
						url: r.url,
						markdown: r.markdown || "",
						title: r.data?.metadata?.title || r.data?.title || "",
						links: Array.isArray(r.data?.links) ? r.data.links : [],
					});
				}
			});
			return sources;
		}

		async function runOneTask(task) {
			const params = task.params || {};
			const urls = (Array.isArray(params.urls) ? params.urls : []).filter((u) =>
				/^https?:\/\/\S+$/i.test(String(u)),
			);
			try {
				if (task.type === "scrape") {
					if (urls.length === 0) {
						return {
							taskLabel: task.label,
							success: false,
							error: "No valid URLs",
						};
					}
					const preScraped = urls.map((u) => sourceByUrl[u]).filter(Boolean);
					let sources = preScraped;
					if (sources.length < urls.length) {
						const missingUrls = urls.filter((u) => !sourceByUrl[u]);
						const missingYoutube = missingUrls.filter(isYoutubeUrl);
						const missingReddit = missingUrls.filter(isRedditUrl);
						const missingRegular = missingUrls.filter(
							(u) => !isYoutubeUrl(u) && !isRedditUrl(u),
						);
						const [regularScraped, youtubeScraped, redditScraped] =
							await Promise.all([
								missingRegular.length > 0
									? scrapeUrlsViaApi(scrapeBase, missingRegular, {
											includeImages: true,
											aiSummary: true,
										})
									: { sources: [], errors: [] },
								missingYoutube.length > 0
									? scrapeYoutubeViaApi(apiBase, missingYoutube)
									: { sources: [], errors: [] },
								missingReddit.length > 0
									? scrapeRedditViaApi(apiBase, missingReddit)
									: { sources: [], errors: [] },
							]);
						let redditTask = redditScraped;
						if (
							missingReddit.length > 0 &&
							redditScraped.sources?.length === 0 &&
							redditScraped.errors?.length > 0
						) {
							redditTask = await scrapeUrlsViaApi(scrapeBase, missingReddit, {
								includeImages: true,
								aiSummary: true,
							});
						}
						sources = [
							...preScraped,
							...(regularScraped.sources || []),
							...(youtubeScraped.sources || []),
							...(redditTask.sources || []),
						];
					}
					if (sources.length === 0) {
						console.error(
							"[inkgest-agent] Scrape task failed: no content for URLs",
							urls,
						);
						return {
							taskLabel: task.label,
							success: false,
							error: "Scrape failed for all URLs",
						};
					}
					const content = sources
						.map(
							(s, i) =>
								`--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${s.markdown}`,
						)
						.join("\n\n");
					const imgExts = /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i;
					const images = sources
						.flatMap((s) => s.links || [])
						.filter((l) =>
							imgExts.test(typeof l === "string" ? l : l?.url || ""),
						)
						.map((l) => (typeof l === "string" ? l : l?.url || ""))
						.filter(Boolean)
						.slice(0, 20);
					state.creditsDistribution.push({
						task: "scrape",
						label: task.label,
						credits: CREDITS.scrape,
					});
					state.creditsUsed += CREDITS.scrape;
					return {
						taskLabel: task.label,
						success: true,
						executed: {
							type: "scrape",
							label: task.label,
							content,
							title: sources[0]?.title || urls[0],
							images,
							urls: sources.map((s) => s.url),
							result: { content, images, urls: sources.map((s) => s.url) },
						},
					};
				}

				if (task.type === "crawl-url") {
					const seedUrl = params.url || urls[0];
					if (!seedUrl || !/^https?:\/\//i.test(String(seedUrl))) {
						return {
							taskLabel: task.label,
							success: false,
							error: "No valid URL for crawl-url",
						};
					}
					const takeScreenshot = params.takeScreenshot === true;
					const scrapeContent = params.scrapeContent === true;
					const timeoutMs = scrapeContent ? 10 * 60 * 1000 : 5 * 60 * 1000;
					const res = await fetch(`${scrapeBase}/crawl-url`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							url: seedUrl,
							takeScreenshot,
							scrapeContent,
							timeout: Math.min(timeoutMs, 300000),
						}),
						signal: AbortSignal.timeout(timeoutMs),
					});
					const data = await res.json().catch(() => ({}));
					state.creditsDistribution.push({
						task: "crawl-url",
						label: task.label,
						credits: CREDITS["crawl-url"],
					});
					state.creditsUsed += CREDITS["crawl-url"];
					if (!res.ok) {
						return {
							taskLabel: task.label,
							success: false,
							error: data?.error || `HTTP ${res.status}`,
						};
					}
					const crawlExecuted = {
						type: "crawl-url",
						label: task.label,
						url: seedUrl,
						allUrls: data.allUrls || [],
						homePageData: data.homePageData,
						nestedResults: data.nestedResults,
						screenshots: data.screenshots || [],
					};
					// Build sources for client rendering (same shape as scrape / useCrawlResult)
					const crawlSources = buildSourcesFromCrawlResult(crawlExecuted);
					if (crawlSources.length > 0) {
						crawlExecuted.sources = crawlSources.map((s) => ({
							url: s.url,
							title: s.title,
							markdown: s.markdown,
							links: s.links,
						}));
						crawlExecuted.content = crawlSources
							.map(
								(s, i) =>
									`--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${s.markdown}`,
							)
							.join("\n\n");
						const imgExts = /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i;
						crawlExecuted.images = crawlSources
							.flatMap((s) => s.links || [])
							.filter((l) =>
								imgExts.test(typeof l === "string" ? l : l?.url || ""),
							)
							.map((l) => (typeof l === "string" ? l : l?.url || ""))
							.filter(Boolean)
							.slice(0, 20);
						crawlExecuted.result = {
							content: crawlExecuted.content,
							images: crawlExecuted.images,
							sources: crawlExecuted.sources,
						};
					} else {
						crawlExecuted.result = { content: "", images: [], sources: [] };
					}
					return {
						taskLabel: task.label,
						success: true,
						executed: crawlExecuted,
					};
				}

				if (task.type === "scrape-git") {
					const gitUrl = params.url || urls[0];
					if (
						!gitUrl ||
						typeof gitUrl !== "string" ||
						!gitUrl.includes("github.com")
					) {
						return {
							taskLabel: task.label,
							success: false,
							error:
								"scrape-git requires a GitHub URL (params.url or params.urls[0])",
						};
					}
					const scrapeGitBody = {
						url: gitUrl,
						...(params.includePullRequests && { includePullRequests: true }),
						...(params.includeIssues && { includeIssues: true }),
					};
					const scrapeGitRes = await fetch(`${apiBase}/scrape-git`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(scrapeGitBody),
						signal: AbortSignal.timeout(90_000),
					});
					const scrapeGitData = await scrapeGitRes.json().catch(() => ({}));
					state.creditsDistribution.push({
						task: "scrape-git",
						label: task.label,
						credits: CREDITS["scrape-git"],
					});
					state.creditsUsed += CREDITS["scrape-git"];
					if (!scrapeGitRes.ok || !scrapeGitData.success) {
						return {
							taskLabel: task.label,
							success: false,
							error: scrapeGitData?.error || `HTTP ${scrapeGitRes.status}`,
						};
					}
					const executed = {
						type: "scrape-git",
						label: task.label,
						url: gitUrl,
						markdown: scrapeGitData.markdown,
						data: scrapeGitData.data,
						ast: scrapeGitData.ast ?? null,
						result: {
							markdown: scrapeGitData.markdown,
							data: scrapeGitData.data,
							ast: scrapeGitData.ast ?? null,
						},
					};
					if (scrapeGitData.stars != null) executed.stars = scrapeGitData.stars;
					if (scrapeGitData.pullRequests != null)
						executed.pullRequests = scrapeGitData.pullRequests;
					if (scrapeGitData.issues != null)
						executed.issues = scrapeGitData.issues;
					if (scrapeGitData.links != null) executed.links = scrapeGitData.links;
					return { taskLabel: task.label, success: true, executed };
				}

				if (task.type === "image-reading") {
					const imgs = Array.isArray(params.images) ? params.images : [];
					if (imgs.length === 0) {
						return {
							taskLabel: task.label,
							success: false,
							error: "image-reading requires params.images (array of { url } or { base64, mimeType })",
						};
					}
					const imageReadingRes = await fetch(`${apiBase}/image-reading`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							images: imgs,
							extractContent: true,
							convertToCode: params.convertToCode === true,
						}),
						signal: AbortSignal.timeout(120_000),
					});
					const imageReadingData = await imageReadingRes.json().catch(() => ({}));
					state.creditsDistribution.push({
						task: "image-reading",
						label: task.label,
						credits: CREDITS["image-reading"],
					});
					state.creditsUsed += CREDITS["image-reading"];
					if (!imageReadingRes.ok || !imageReadingData.success) {
						return {
							taskLabel: task.label,
							success: false,
							error: imageReadingData?.error || `HTTP ${imageReadingRes.status}`,
						};
					}
					const markdown = imageReadingData.markdown || "";
					if (markdown && state.imageReadingSources) {
						state.imageReadingSources.push({
							url: "image-reading",
							title: "Image content",
							markdown,
							links: [],
						});
					}
					return {
						taskLabel: task.label,
						success: true,
						executed: {
							type: "image-reading",
							label: task.label,
							results: imageReadingData.results || [],
							markdown,
							result: {
								results: imageReadingData.results,
								markdown,
							},
						},
					};
				}

				if (task.type === "github-trending") {
					const since = params.since || "weekly";
					const language = params.language || "";
					const category = params.category || "";
					const per_page = Math.min(Number(params.per_page) || 25, 100);
					const query = new URLSearchParams();
					if (since) query.set("since", since);
					if (language) query.set("language", language);
					if (category) query.set("category", category);
					query.set("per_page", String(per_page));
					const trendingRes = await fetch(
						`${apiBase}/github-trending?${query.toString()}`,
						{ signal: AbortSignal.timeout(30_000) },
					);
					const trendingData = await trendingRes.json().catch(() => ({}));
					state.creditsDistribution.push({
						task: "github-trending",
						label: task.label,
						credits: CREDITS["github-trending"],
					});
					state.creditsUsed += CREDITS["github-trending"];
					if (!trendingRes.ok || !trendingData.ok) {
						return {
							taskLabel: task.label,
							success: false,
							error: trendingData?.error || `HTTP ${trendingRes.status}`,
						};
					}
					return {
						taskLabel: task.label,
						success: true,
						executed: {
							type: "github-trending",
							label: task.label,
							meta: trendingData.meta ?? {},
							data: trendingData.data ?? [],
							result: {
								meta: trendingData.meta,
								data: trendingData.data,
							},
						},
					};
				}

				const skill = SKILLS[task.type];
				if (!skill || task.type === "scrape") {
					return {
						taskLabel: task.label,
						success: false,
						error: "Unknown task type",
					};
				}

				const useCrawlResult =
					params.useCrawlResult === true && state.crawlUrlSources?.length > 0;
				let preSources = useCrawlResult
					? state.crawlUrlSources
					: urls.map((u) => sourceByUrl[u]).filter(Boolean);
				if (state.imageReadingSources?.length > 0) {
					preSources = [...preSources, ...state.imageReadingSources];
				}

				// Scrape API uses aiSummary: true — returns condensed summary + links/images, no extra LLM needed

				// CRITICAL: Do NOT create content when URLs were provided but scrape failed.
				if (
					urls.length > 0 &&
					!useCrawlResult &&
					state.imageReadingSources?.length === 0 &&
					preSources.length === 0
				) {
					const errMsg =
						"Scraping failed for provided URLs. Cannot create content without source data.";
					console.error(
						"[inkgest-agent] Content task aborted (no scraped sources):",
						task.type,
						task.label,
						"urls:",
						urls,
					);
					return {
						taskLabel: task.label,
						success: false,
						error: errMsg,
					};
				}

				const format = params.format || "substack";
				const style = params.style || "casual";
				const system = skill.buildSystemPrompt(
					format,
					style,
					preSources.length > 0,
				);
				const user = skill.buildUserContent(
					params.prompt || userPrompt,
					preSources,
				);

				const { content: rawContent, usage: skillUsage } =
					await openRouterChatMessages(
						openRouterKey,
						[
							{ role: "system", content: system },
							{ role: "user", content: user },
						],
						skill.maxTokens,
						task.type === "infographics-svg-generator"
							? { response_format: { type: "json_object" } }
							: {},
					);
				addTokenUsage(skillUsage);
				state.tokenUsage.prompt_tokens += skillUsage?.prompt_tokens || 0;
				state.tokenUsage.completion_tokens +=
					skillUsage?.completion_tokens || 0;
				state.tokenUsage.total_tokens += skillUsage?.total_tokens || 0;

				const taskCredits = CREDITS[task.type] ?? 1;
				state.creditsDistribution.push({
					task: task.type,
					label: task.label,
					credits: taskCredits,
				});
				state.creditsUsed += taskCredits;

				// Any skill with parseResponse: merge parsed data into executed so client always gets structured payload (infographics, images, table, etc.)
				if (skill.parseResponse) {
					const parsedData = skill.parseResponse(rawContent);
					const executed = {
						type: task.type,
						label: task.label,
						...parsedData,
						result: parsedData,
					};
					if (task.type === "table") executed.sourceUrls = urls;
					// Ensure client has content for rendering: infographics and image-gallery need structured data
					if (
						task.type === "infographics-svg-generator" &&
						Array.isArray(executed.infographics)
					) {
						executed.content = JSON.stringify(executed.infographics);
					}
					if (task.type === "image-gallery-creator") {
						executed.content = Array.isArray(executed.images)
							? JSON.stringify(executed.images)
							: "[]";
						executed.result = {
							images: executed.images || [],
							content: executed.content,
						};
					}
					return {
						taskLabel: task.label,
						success: true,
						executed,
					};
				}

				// Default: content-based skills (newsletter, blog, article, landing-page-generator, etc.)
				let content = rawContent.trim();
				// Strip markdown code fences from HTML so client can render (LLMs often wrap in ```html ... ```)
				if (task.type === "landing-page-generator") {
					const m = content.match(/^\s*```(?:html)?\s*\n?([\s\S]*?)\n?```\s*$/);
					content = m
						? m[1].trim()
						: content
								.replace(/^```(?:html)?\s*\n?/, "")
								.replace(/\n?```\s*$/, "")
								.trim();
				}
				const executed = {
					type: task.type,
					label: task.label,
					content,
					format: task.type === "newsletter" ? format : undefined,
					sources: preSources.map((s) => ({ url: s.url, title: s.title })),
					params: { urls, prompt: params.prompt, format, style },
				};
				// So client can render: landing page HTML, raw content (flat + nested for task.html / task.result?.html)
				if (task.type === "landing-page-generator") {
					executed.html = content;
					executed.result = {
						html: content,
						content,
						sources: executed.sources,
					};
				}
				return {
					taskLabel: task.label,
					success: true,
					executed,
				};
			} catch (e) {
				return {
					taskLabel: task.label,
					success: false,
					error: e?.message || "Task failed",
				};
			}
		}

		const encoder = new TextEncoder();
		const send = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

		const stream = new ReadableStream({
			async start(controller) {
				controller.enqueue(
					encoder.encode(
						send({
							type: "start",
							success: true,
							thinking: parsed.thinking || "",
							message: hasExecuteTasks
								? `Running ${validTasks.length} task(s) in parallel.`
								: parsed.message || "Here's what I suggest.",
							suggestedTasks,
						}),
					),
				);

				if (validTasks.length === 0) {
					controller.enqueue(
						encoder.encode(
							send({
								type: "end",
								executed: [],
								errors: undefined,
								scrapeErrors:
									scrapeErrors.length > 0 ? scrapeErrors : undefined,
								// Top-level list of all source references (empty when no URLs)
								references: state.references || [],
								creditsUsed,
								creditsDistribution,
								tokenUsage,
							}),
						),
					);
					controller.close();
					return;
				}

				const crawlUrlTasks = validTasks.filter((t) => t.type === "crawl-url");
				const imageReadingTasks = validTasks.filter(
					(t) => t.type === "image-reading",
				);
				const otherTasks = validTasks.filter(
					(t) => t.type !== "crawl-url" && t.type !== "image-reading",
				);

				(async () => {
					const executed = [];
					const errors = [];

					// Phase 1a: run crawl-url tasks first so we have crawlUrlSources for useCrawlResult content tasks
					if (crawlUrlTasks.length > 0) {
						const results = await Promise.all(
							crawlUrlTasks.map((t) => runOneTask(t)),
						);
						results.forEach((r, i) => {
							controller.enqueue(
								encoder.encode(
									send({
										type: "task",
										index: validTasks.indexOf(crawlUrlTasks[i]),
										...r,
									}),
								),
							);
							if (r.success && r.executed) {
								executed.push(r.executed);
								if (
									r.executed.homePageData ||
									(r.executed.nestedResults && r.executed.nestedResults.length)
								) {
									state.crawlUrlSources.push(
										...buildSourcesFromCrawlResult(r.executed),
									);
								}
							} else {
								console.error(
									"[inkgest-agent] Task failed:",
									r.taskLabel,
									"error:",
									r.error,
								);
								errors.push({ task: r.taskLabel, error: r.error });
							}
						});
					}

					// Phase 1b: run image-reading so we have imageReadingSources for blog/article/newsletter etc.
					if (imageReadingTasks.length > 0) {
						const results = await Promise.all(
							imageReadingTasks.map((t) => runOneTask(t)),
						);
						results.forEach((r, i) => {
							controller.enqueue(
								encoder.encode(
									send({
										type: "task",
										index: validTasks.indexOf(imageReadingTasks[i]),
										...r,
									}),
								),
							);
							if (r.success && r.executed) executed.push(r.executed);
							else if (r.error) {
								console.error(
									"[inkgest-agent] Task failed:",
									r.taskLabel,
									"error:",
									r.error,
								);
								errors.push({ task: r.taskLabel, error: r.error });
							}
						});
					}

					// Phase 2: run remaining tasks (blog/article/table will use state.crawlUrlSources and/or state.imageReadingSources)
					if (otherTasks.length > 0) {
						const results = await Promise.all(
							otherTasks.map((t) => runOneTask(t)),
						);
						results.forEach((r, i) => {
							controller.enqueue(
								encoder.encode(
									send({
										type: "task",
										index: validTasks.indexOf(otherTasks[i]),
										...r,
									}),
								),
							);
							if (r.success && r.executed) executed.push(r.executed);
							else if (r.error) {
								console.error(
									"[inkgest-agent] Task failed:",
									r.taskLabel,
									"error:",
									r.error,
								);
								errors.push({ task: r.taskLabel, error: r.error });
							}
						});
					}

					controller.enqueue(
						encoder.encode(
							send({
								type: "end",
								executed,
								// Top-level list of all source references (empty when no URLs)
								references: state.references || [],
								errors: errors.length > 0 ? errors : undefined,
								scrapeErrors:
									scrapeErrors.length > 0 ? scrapeErrors : undefined,
								creditsUsed: state.creditsUsed,
								creditsDistribution: state.creditsDistribution,
								tokenUsage: state.tokenUsage,
							}),
						),
					);
					controller.close();
				})();
			},
		});

		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("[inkgest-agent]", error);
		const message = error?.message || "Agent failed";
		const cause = error?.cause;
		const isAbort =
			error?.name === "AbortError" || cause?.name === "AbortError";
		const isAuthError =
			/missing authentication|missing auth|invalid api key|unauthorized/i.test(
				message,
			);
		const code = isAbort
			? "TIMEOUT"
			: isAuthError
				? "MISSING_API_KEY"
				: cause?.code === "UND_ERR_HEADERS_TIMEOUT"
					? "SCRAPE_HEADERS_TIMEOUT"
					: cause?.code === "UND_ERR_BODY_TIMEOUT"
						? "SCRAPE_BODY_TIMEOUT"
						: message.includes("fetch failed") || cause
							? "NETWORK_ERROR"
							: "AGENT_ERROR";
		const userMessage = isAuthError
			? "OpenRouter API key is missing or invalid. Set OPENROUTER_API_KEY in your production environment."
			: isAbort
				? "Request timed out. The LLM or scrape service took too long to respond."
				: message;
		return c.json(
			{
				error: userMessage,
				code,
				details: cause?.message || (cause ? String(cause) : undefined),
			},
			500,
		);
	}
});

// give me simple git repo

const SCREENSHOT_VIEWPORT_MAP = {
	desktop: { width: 1920, height: 1080, scale: 1 },
	tablet: { width: 1024, height: 768, scale: 1 },
	mobile: { width: 375, height: 667, scale: 1 },
};

/**
 * Capture one URL with a pooled page: viewport, goto (with waitUntil for SSR/SPA), optional waitForSelector,
 * inject block-distractions CSS (ads, cookie banners, chat widgets), take screenshot. Returns buffer + metadata + markdown.
 * Used by /take-screenshot and /take-screenshot-multiple.
 */
async function captureOneScreenshotWithPage(page, options) {
	const {
		url,
		device = "desktop",
		waitUntil = "domcontentloaded",
		waitForSelector,
		timeout = 50000,
		fullPage = false,
		coords,
		blockDistractions = true,
	} = options;

	const viewport =
		SCREENSHOT_VIEWPORT_MAP[device] || SCREENSHOT_VIEWPORT_MAP.desktop;
	await page.setViewport(viewport);
	await page.setUserAgent(userAgents.random().toString());
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
		} catch {}
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
	} catch {}

	return {
		buffer,
		metadata,
		markdown,
		dimensions: { width: viewport.width, height: viewport.height },
	};
}

// Take Screenshot API Endpoint (uses browser pool)
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
			return c.json(
				{
					success: false,
					error: "URL is required",
				},
				400,
			);
		}

		// Validate URL format
		try {
			new URL(url);
		} catch (error) {
			return c.json(
				{
					success: false,
					error: "Invalid URL format",
				},
				400,
			);
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

		const uniqueFileName = `screenshots/${Date.now()}-${uuidv4().replace(/[^a-zA-Z0-9]/g, "")}.png`;
		const bucket = storage.bucket(process.env.FIREBASE_BUCKET);
		const file = bucket.file(`ihr-website-screenshot/${uniqueFileName}`);
		await file.save(buffer, {
			metadata: {
				contentType: "image/png",
				cacheControl: "public, max-age=3600",
			},
		});
		await file.makePublic();
		const screenshotUrl = `https://storage.googleapis.com/${process.env.FIREBASE_BUCKET}/${file.name}`;

		return c.json({
			success: true,
			url,
			markdown,
			metadata,
			screenshot: screenshotUrl,
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

// Take Screenshot Multiple — parallel screenshots via browser pool (fast for crawl-url)
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
					.then(async ({ buffer, metadata, markdown, dimensions }) => {
						const uniqueFileName = `screenshots/${Date.now()}-${uuidv4().replace(/[^a-zA-Z0-9]/g, "")}.png`;
						const bucket = storage.bucket(process.env.FIREBASE_BUCKET);
						const file = bucket.file(
							`ihr-website-screenshot/${uniqueFileName}`,
						);
						await file.save(buffer, {
							metadata: {
								contentType: "image/png",
								cacheControl: "public, max-age=3600",
							},
						});
						await file.makePublic();
						const screenshotUrl = `https://storage.googleapis.com/${process.env.FIREBASE_BUCKET}/${file.name}`;
						return {
							url,
							screenshot: screenshotUrl,
							metadata,
							markdown,
							success: true,
							dimensions,
						};
					})
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

app.post("/take-metadata", async (c) => {
	try {
		const { url } = await c.req.json();

		if (!url) {
			return c.json(
				{
					success: false,
					error: "URL is required",
				},
				400,
			);
		}

		// Validate URL format
		try {
			new URL(url);
		} catch (error) {
			return c.json(
				{
					success: false,
					error: "Invalid URL format",
				},
				400,
			);
		}

		try {
			// Fetch the webpage content
			const response = await axios.get(url, {
				headers: {
					"User-Agent": userAgents.random().toString(),
					Accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.9",
					"Accept-Encoding": "gzip, deflate, br",
					DNT: "1",
					Connection: "keep-alive",
					"Upgrade-Insecure-Requests": "1",
				},
				timeout: 30000,
				maxRedirects: 5,
			});

			// Load HTML content with Cheerio
			const $ = load(response.data);

			// Extract basic metadata
			const metadata = {
				url: url,
				title: $("title").text().trim() || $("h1").first().text().trim(),
				description: "",
				author: "",
				pubDate: "",
				image: "",
				robots: "",
				keywords: "",
				language: "",
				viewport: "",
				favicon: "",
				openGraph: {},
				twitterCard: {},
				allMetaTags: {},
			};

			// Extract description from various meta tags
			metadata.description =
				$('meta[name="description"]').attr("content") ||
				$('meta[property="og:description"]').attr("content") ||
				$('meta[name="twitter:description"]').attr("content") ||
				$('meta[name="summary"]').attr("content") ||
				"";

			// Extract author
			metadata.author =
				$('meta[name="author"]').attr("content") ||
				$('meta[property="article:author"]').attr("content") ||
				$('meta[name="twitter:creator"]').attr("content") ||
				$('link[rel="author"]').attr("href") ||
				"";

			// Extract publication date
			metadata.pubDate =
				$('meta[property="article:published_time"]').attr("content") ||
				$('meta[name="date"]').attr("content") ||
				$('meta[name="pubdate"]').attr("content") ||
				$('meta[name="DC.date.issued"]').attr("content") ||
				$("time[datetime]").first().attr("datetime") ||
				"";

			// Extract main image
			metadata.image =
				$('meta[property="og:image"]').attr("content") ||
				$('meta[name="twitter:image"]').attr("content") ||
				$('meta[name="image"]').attr("content") ||
				$("img").first().attr("src") ||
				"";

			if (
				metadata.image.startsWith("http") ||
				metadata.image.startsWith("//") ||
				metadata.image.startsWith("data:image/") ||
				metadata.image.startsWith("blob:") ||
				metadata.image.startsWith("file:") ||
				metadata.image.startsWith("mailto:")
			) {
				metadata.image = "";
			}
			// Extract robots meta
			metadata.robots = $('meta[name="robots"]').attr("content") || "";

			// Extract keywords
			metadata.keywords = $('meta[name="keywords"]').attr("content") || "";

			// Extract language
			metadata.language =
				$("html").attr("lang") ||
				$('meta[http-equiv="content-language"]').attr("content") ||
				$('meta[name="language"]').attr("content") ||
				"";

			// Extract viewport
			metadata.viewport = $('meta[name="viewport"]').attr("content") || "";

			// Extract charset
			metadata.charset =
				$("meta[charset]").attr("charset") ||
				$('meta[http-equiv="content-type"]').attr("content") ||
				"";

			// Extract theme color
			metadata.themeColor = $('meta[name="theme-color"]').attr("content") || "";

			// Extract all meta tags
			$("meta").each((i, element) => {
				const $meta = $(element);
				const name =
					$meta.attr("name") ||
					$meta.attr("property") ||
					$meta.attr("http-equiv");
				const content = $meta.attr("content");
				if (name && content) {
					metadata.allMetaTags[name] = content;
				}
			});

			// Extract Open Graph tags
			$('meta[property^="og:"]').each((i, element) => {
				const $meta = $(element);
				const property = $meta.attr("property");
				const content = $meta.attr("content");
				if (property && content) {
					// If the content starts with "http", "blob:", "image:", or "data:", set the value to an empty string
					if (
						content.startsWith("http") ||
						content.startsWith("blob:") ||
						content.startsWith("image:") ||
						content.startsWith("data:")
					) {
						return;
					} else {
						metadata.openGraph[property] = content;
					}
				}
			});

			// Extract Twitter Card tags
			$('meta[name^="twitter:"]').each((i, element) => {
				const $meta = $(element);
				const name = $meta.attr("name");
				const content = $meta.attr("content");
				if (name && content) {
					if (
						content.startsWith("http") ||
						content.startsWith("blob:") ||
						content.startsWith("image:") ||
						content.startsWith("data:")
					) {
						return;
					} else {
						metadata.twitterCard[name] = content;
					}
				}
			});

			// Extract favicon
			metadata.favicon =
				$('link[rel="icon"]').attr("href") ||
				$('link[rel="shortcut icon"]').attr("href") ||
				$('link[rel="favicon"]').attr("href") ||
				"";

			removeEmptyKeys(metadata);
			return c.json({
				success: true,
				metadata: metadata,
				timestamp: new Date().toISOString(),
			});
		} catch (fetchError) {
			console.error("❌ Error fetching URL:", fetchError);

			// Handle specific HTTP status codes
			if (fetchError.response) {
				const status = fetchError.response.status;

				// Handle page not found (404) and other client errors
				if (status === 404) {
					return c.json(
						{
							success: true,
							metadata: null,
							message: "Page not found - the requested URL does not exist",
							status: 404,
							timestamp: new Date().toISOString(),
						},
						200,
					);
				}

				// Handle other client errors (4xx)
				if (status >= 400 && status < 500) {
					return c.json(
						{
							success: true,
							metadata: null,
							message: `Client error - the server returned status ${status}`,
							status: status,
							timestamp: new Date().toISOString(),
						},
						200,
					);
				}

				// Handle server errors (5xx)
				if (status >= 500) {
					return c.json(
						{
							success: true,
							metadata: null,
							message: `Server error - the target server returned status ${status}`,
							status: status,
							timestamp: new Date().toISOString(),
						},
						200,
					);
				}
			}

			// Handle network errors (DNS, connection issues, etc.)
			if (
				fetchError.code === "ENOTFOUND" ||
				fetchError.code === "ECONNREFUSED" ||
				fetchError.code === "ETIMEDOUT"
			) {
				return c.json(
					{
						success: true,
						metadata: null,
						message: "Network error - unable to reach the requested URL",
						error: fetchError.code,
						timestamp: new Date().toISOString(),
					},
					200,
				);
			}

			// Handle timeout errors
			if (fetchError.code === "ECONNABORTED") {
				return c.json(
					{
						success: true,
						metadata: null,
						message: "Request timeout - the server took too long to respond",
						timestamp: new Date().toISOString(),
					},
					200,
				);
			}

			// Handle other errors
			return c.json(
				{
					success: true,
					metadata: null,
					message: "Unable to fetch metadata from the requested URL",
					error: fetchError.message,
					timestamp: new Date().toISOString(),
				},
				200,
			);
		}
	} catch (error) {
		console.error("❌ Metadata API error:", error);
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

app.post("/crawl-take-screenshots", async (c) => {
	// Wrapper: forwards to /crawl-url with takeScreenshot: true and maps to legacy response shape
	try {
		const body = await c.req.json().catch(() => ({}));
		const { url, maxUrls = 10, waitForSelector, timeout = 30000 } = body;
		if (!url) {
			return c.json({ success: false, error: "URL is required" }, 400);
		}
		// Build fake request for getScrapeBaseUrl by using current request
		const crawlBody = {
			url,
			maxUrls,
			waitForSelector,
			timeout,
			useSitemap: true,
			scrapeContent: false,
			takeScreenshot: true,
			screenshotDevice: "desktop",
		};
		const scrapeBase = getScrapeBaseUrl(c);
		const res = await fetch(`${scrapeBase}/crawl-url`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(crawlBody),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			return c.json(data, res.status);
		}
		// Map to legacy shape: crawledUrls, results (screenshots)
		return c.json({
			success: data.success,
			seedUrl: data.seedUrl,
			domain: data.domain,
			crawledUrls: data.allUrls || [],
			totalUrls: data.totalUrls || 0,
			results: (data.screenshots || []).map((s) => ({
				url: s.url,
				screenshot: s.screenshot,
				metadata: s.metadata,
				markdown: s.markdown,
				success: s.success,
				error: s.error,
				dimensions: s.dimensions,
			})),
			timestamp: data.timestamp,
		});
	} catch (err) {
		return c.json(
			{ success: false, error: err?.message || "Internal server error" },
			500,
		);
	}
});

// Base URL for /scrape and /scrape-multiple (same server or env)
function getScrapeBaseUrl(c) {
	try {
		const u = new URL(c.req.url);
		if (u.origin && u.origin !== "null") return u.origin;
	} catch {}
	return (
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://localhost:${process.env.PORT || 3001}`
	);
}

/** Fetch sitemap XML and extract same-domain <loc> URLs. Tries sitemap index (first 3 child sitemaps). */
async function fetchSitemapUrls(origin, domain, maxUrls = 500) {
	const urls = new Set();
	const tried = new Set();

	async function parseSitemapXml(xmlUrl) {
		if (tried.has(xmlUrl) || urls.size >= maxUrls) return;
		tried.add(xmlUrl);
		let text;
		try {
			const res = await fetch(xmlUrl, {
				signal: AbortSignal.timeout(15000),
				headers: { "User-Agent": "Mozilla/5.0 (compatible; CrawlBot/1.0)" },
			});
			if (!res.ok) return;
			text = await res.text();
		} catch {
			return;
		}
		const locRegex = /<loc>\s*([^<]+)\s*<\/loc>/gi;
		let match;
		const locs = [];
		while ((match = locRegex.exec(text)) !== null) locs.push(match[1].trim());
		const isIndex = /<sitemap\s/i.test(text);
		if (isIndex && locs.length > 0) {
			for (const loc of locs.slice(0, 3)) {
				try {
					const u = new URL(loc);
					if (u.hostname === domain || u.origin === origin)
						await parseSitemapXml(loc);
				} catch {}
			}
			return;
		}
		for (const loc of locs) {
			try {
				const u = new URL(loc);
				if (u.hostname !== domain && u.origin !== origin) continue;
				urls.add(loc);
				if (urls.size >= maxUrls) return;
			} catch {}
		}
	}

	await parseSitemapXml(`${origin}/sitemap.xml`);
	if (urls.size === 0) await parseSitemapXml(`${origin}/sitemap_index.xml`);
	if (urls.size === 0) await parseSitemapXml(`${origin}/sitemap/sitemap.xml`);
	return urls;
}

/** Normalize and filter same-domain links from scrape data.links (array of { href } or string). */
function extractSameDomainLinks(links, origin, domain) {
	const out = new Set();
	if (!Array.isArray(links)) return out;
	for (const item of links) {
		const href = typeof item === "string" ? item : item?.href || item?.url;
		if (!href || typeof href !== "string") continue;
		try {
			const u = new URL(href, origin);
			if (u.protocol !== "http:" && u.protocol !== "https:") continue;
			if (u.hostname !== domain) continue;
			out.add(u.href);
		} catch {}
	}
	return out;
}

/** True if URL is a sitemap (e.g. /sitemap.xml, /sitemap/, /sitemap_index.xml). Exclude these from crawl output. */
function isSitemapUrl(urlString) {
	try {
		const u = new URL(urlString);
		const path = u.pathname.toLowerCase();
		if (path.endsWith(".xml") && /sitemap|rss|feed/.test(path)) return true;
		if (/\/sitemap(\/|_|$)/.test(path)) return true;
		return false;
	} catch {
		return false;
	}
}

app.post("/crawl-url", async (c) => {
	try {
		const {
			url,
			maxUrls = 100,
			timeout = 60000,
			useSitemap = true,
			scrapeContent = false,
			takeScreenshot = false,
			waitForSelector,
			screenshotDevice = "desktop",
			// Screenshot fanout can be expensive; cap by default to stay fast.
			screenshotMaxUrls = 10,
			screenshotWaitUntil = "domcontentloaded",
			screenshotTimeout = 20000,
		} = await c.req.json();

		// Desktop dimensions by default (same as /take-screenshot)
		const SCREENSHOT_DIMENSIONS = {
			desktop: { width: 1920, height: 1080 },
			tablet: { width: 1024, height: 768 },
			mobile: { width: 375, height: 667 },
		};
		const dimensions =
			SCREENSHOT_DIMENSIONS[screenshotDevice] || SCREENSHOT_DIMENSIONS.desktop;

		if (!url) {
			return c.json({ success: false, error: "URL is required" }, 400);
		}

		let seedUrl;
		try {
			seedUrl = new URL(url);
		} catch {
			return c.json({ success: false, error: "Invalid URL format" }, 400);
		}

		const domain = seedUrl.hostname;
		const origin = seedUrl.origin;
		const homePage = seedUrl.href;
		const scrapeBase = getScrapeBaseUrl(c);
		const SCRAPE_MULTIPLE_BATCH = 20; // scrape-multiple max per request
		const maxNested = Math.min(Number(maxUrls) || 100, 500);

		const allUrlsSet = new Set();
		allUrlsSet.add(homePage);
		let homeResult = null;

		// 1) Always scrape home page first for link discovery (and homePageData)
		try {
			const scrapeRes = await fetch(`${scrapeBase}/scrape`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				signal: AbortSignal.timeout(timeout),
				body: JSON.stringify({
					url: homePage,
					timeout: Math.min(timeout, 30000),
					includeLinks: true,
					// NOTE: in /scrape implementation, links are extracted inside the
					// semanticContent evaluate block. So we must enable it here even when
					// scrapeContent is false, otherwise we only discover the homepage URL.
					includeSemanticContent: true,
					includeImages: false,
					extractMetadata: false,
					takeScreenshot: false,
				}),
			});
			const scrapeData = await scrapeRes.json().catch(() => ({}));
			if (scrapeData.success) {
				homeResult = scrapeData;
				if (scrapeData.data?.links) {
					const nested = extractSameDomainLinks(
						scrapeData.data.links,
						origin,
						domain,
					);
					nested.forEach((u) => allUrlsSet.add(u));
				}
			}
		} catch (err) {
			console.warn("[crawl-url] Home scrape failed:", err?.message);
		}

		// 2) Optionally add sitemap URLs (supplement; sitemap often only has updated URLs)
		if (useSitemap) {
			const sitemapUrls = await fetchSitemapUrls(origin, domain, maxNested);
			sitemapUrls.forEach((u) => allUrlsSet.add(u));
		}

		// 3) Remove sitemap URLs from output (no domain/sitemap/ or *.xml sitemap links)
		for (const u of Array.from(allUrlsSet)) {
			if (isSitemapUrl(u)) allUrlsSet.delete(u);
		}

		const allUrls = Array.from(allUrlsSet).slice(0, maxNested + 1);
		const nestedUrls = allUrls.filter((u) => u !== homePage);

		// Optional: take screenshots (browser pool, parallel, capped)
		let screenshots = [];
		if (takeScreenshot && allUrls.length > 0) {
			const screenshotUrls = allUrls.slice(
				0,
				Math.max(1, Math.min(Number(screenshotMaxUrls) || 10, allUrls.length)),
			);
			try {
				const res = await fetch(`${scrapeBase}/take-screenshot-multiple`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					// NOTE: /take-screenshot-multiple is limited by browserPool throughput,
					// so the total wall time can exceed the per-page timeout. Don't abort
					// the whole request at 60s when many URLs are queued.
					signal: AbortSignal.timeout(Math.max(timeout, 5 * 60 * 1000)),
					body: JSON.stringify({
						urls: screenshotUrls,
						device: screenshotDevice,
						waitForSelector: waitForSelector || undefined,
						timeout: Math.min(Number(screenshotTimeout) || 20000, 60000),
						waitUntil: screenshotWaitUntil || "domcontentloaded",
						blockDistractions: true,
					}),
				});
				const data = await res.json().catch(() => ({}));
				if (data.success && Array.isArray(data.results)) {
					screenshots = data.results.map((r) => ({
						url: r.url,
						screenshot: r.screenshot || null,
						metadata: r.metadata || null,
						markdown: r.markdown || null,
						success: !!r.success,
						error: r.error || null,
						dimensions: r.dimensions || { ...dimensions },
					}));
				}
			} catch (err) {
				screenshots = screenshotUrls.map((u) => ({
					url: u,
					screenshot: null,
					metadata: null,
					markdown: null,
					success: false,
					error: err?.message || "Screenshot failed",
					dimensions: { ...dimensions },
				}));
			}
		}

		const payload = {
			success: true,
			seedUrl: homePage,
			domain,
			allUrls,
			totalUrls: allUrls.length,
			usedSitemap: useSitemap,
			homePageData: homeResult
				? {
						success: homeResult.success,
						markdown: homeResult.markdown,
						data: homeResult.data,
						url: homePage,
					}
				: null,
			screenshots: takeScreenshot ? screenshots : undefined,
			timestamp: new Date().toISOString(),
		};

		if (!scrapeContent) {
			return c.json({ ...payload, nestedResults: [] });
		}

		// scrapeContent: true — normal JSON response (can take minutes)
		const chunks = [];
		for (let i = 0; i < nestedUrls.length; i += SCRAPE_MULTIPLE_BATCH) {
			chunks.push(nestedUrls.slice(i, i + SCRAPE_MULTIPLE_BATCH));
		}

		// Batch requests in parallel; pool/puppeteer will backpressure internally.
		const nestedTimeoutMs = Math.max(Number(timeout) || 60000, 5 * 60 * 1000);
		const settled = await Promise.allSettled(
			chunks.map(async (chunk) => {
				const res = await fetch(`${scrapeBase}/scrape-multiple`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					signal: AbortSignal.timeout(nestedTimeoutMs),
					body: JSON.stringify({
						urls: chunk,
						// Per-URL scrape timeout inside /scrape-multiple
						timeout: Math.min(nestedTimeoutMs, 60000),
						includeLinks: false,
						includeSemanticContent: true,
						includeImages: false,
						extractMetadata: true,
					}),
				});
				const data = await res.json().catch(() => ({}));
				return data.results || [];
			}),
		);

		const nestedResults = settled.flatMap((r, idx) => {
			if (r.status === "fulfilled") return r.value;
			const chunk = chunks[idx] || [];
			return chunk.map((u) => ({
				url: u,
				success: false,
				error: r.reason?.message || "Scrape failed",
			}));
		});

		return c.json({
			...payload,
			nestedResults,
		});
	} catch (error) {
		console.error("❌ crawl-url API error:", error);
		return c.json(
			{
				success: false,
				error: "Internal server error",
				details: error?.message,
			},
			500,
		);
	}
});

const parseRedditData = (data, url) => {
	// Reddit comments page returns array [postListing, commentsListing]; subreddit returns single object
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

			// Extract key information
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

			// Create markdown section for this post
			markdown += `## Post ${index + 1}: ${postData.title}\n\n`;

			// Basic info
			markdown += `**Author:** u/${postData.author}\n`;
			markdown += `**Subreddit:** r/${postData.subreddit}\n`;
			markdown += `**Score:** ${postData.score} (${Math.round(
				postData.upvoteRatio * 100,
			)}% upvoted)\n`;
			markdown += `**Comments:** ${postData.numComments}\n`;
			markdown += `**Posted:** ${postData.created}\n`;

			// Post status indicators
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

			if (status.length > 0) {
				markdown += `**Status:** ${status.join(", ")}\n`;
			}

			// Flair
			if (postData.linkFlairText) {
				markdown += `**Flair:** ${postData.linkFlairText}\n`;
			}

			// Content
			if (postData.selftext) {
				markdown += `\n**Content:**\n${postData.selftext}\n`;
			}

			// External link
			if (!postData.isSelf && postData.url) {
				markdown += `\n**External Link:** ${postData.url}\n`;
			}

			// Links
			markdown += `\n**Reddit Link:** ${postData.permalink}\n`;

			markdown += `\n---\n\n`;
		}
	});

	// Add summary
	markdown += `## Summary\n\n`;
	markdown += `- **Total Posts:** ${posts.length}\n`;
	markdown += `- **Subreddit:** r/${posts[0]?.subreddit || "Unknown"}\n`;
	markdown += `- **Total Score:** ${posts.reduce(
		(sum, post) => sum + post.score,
		0,
	)}\n`;
	markdown += `- **Total Comments:** ${posts.reduce(
		(sum, post) => sum + post.numComments,
		0,
	)}\n`;
	markdown += `- **Average Score:** ${Math.round(
		posts.reduce((sum, post) => sum + post.score, 0) / posts.length,
	)}\n`;
	markdown += `- **Average Upvote Ratio:** ${Math.round(
		(posts.reduce((sum, post) => sum + post.upvoteRatio, 0) / posts.length) *
			100,
	)}%\n`;

	return { markdown, posts };
};

/** Extract comments from Reddit JSON. Comments page returns [postListing, commentsListing]. */
function parseRedditComments(data) {
	const comments = [];
	if (!data) return comments;

	// Comments page: data is array, comments are in data[1]
	let commentsListing = null;
	if (Array.isArray(data) && data.length > 1) {
		commentsListing = data[1];
	} else if (data?.data?.children) {
		// Subreddit listing has no separate comments
		return comments;
	}

	if (!commentsListing?.data?.children) return comments;

	function extractFromChild(child, depth = 0) {
		if (!child?.data) return;
		if (child.kind === "t1") {
			return {
				id: child.data.id,
				author: child.data.author || "[deleted]",
				body: child.data.body || "",
				score: child.data.score ?? 0,
				created: child.data.created_utc
					? new Date(child.data.created_utc * 1000).toISOString()
					: "",
				depth,
				permalink: child.data.permalink
					? `https://reddit.com${child.data.permalink}`
					: "",
			};
		}
		return null;
	}

	function walkReplies(children, depth = 0) {
		if (!Array.isArray(children)) return;
		for (const child of children) {
			if (child.kind === "t1" && child.data) {
				const c = extractFromChild(child, depth);
				if (c) comments.push(c);
				const replies = child.data.replies;
				if (replies?.data?.children) {
					walkReplies(replies.data.children, depth + 1);
				}
			} else if (child.kind === "more") {
				// "load more" placeholder - skip
			}
		}
	}

	walkReplies(commentsListing.data.children, 0);
	return comments;
}

app.post("/scrape-reddit", async (c) => {
	try {
		const { url } = await c.req.json();

		console.log(url);
		if (!url) {
			return c.json({ success: false, error: "Reddit URL is required" }, 400);
		}

		// Validate that it's a Reddit URL
		if (!url.includes("reddit.com")) {
			return c.json({ success: false, error: "URL must be a Reddit URL" }, 400);
		}

		// Convert Reddit URL to JSON API URL
		let jsonUrl = url;
		if (!url.endsWith(".json")) {
			jsonUrl = url.endsWith("/") ? url.slice(0, -1) + ".json" : url + "/.json";
		}

		try {
			// Fetch Reddit JSON — minimal headers (no User-Agent) to avoid bot blocking
			const response = await axios.get(jsonUrl, {
				headers: {
					Accept: "application/json",
				},
				timeout: 30000,
				maxRedirects: 5,
			});

			const redditData = response.data;

			// Extract metadata from the original Reddit URL (without .json)
			let redditMetadata = null;
			// Fetch the webpage content
			const newUrl = new URL(url.replace(".json", ""));
			const hostname = newUrl.hostname;
			const metadataResponse = await axios.get(`https://${hostname}`, {
				headers: {
					"User-Agent": userAgents.random().toString(),
					Accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.9",
					"Accept-Encoding": "gzip, deflate, br",
					DNT: "1",
					Connection: "keep-alive",
					"Upgrade-Insecure-Requests": "1",
				},
				timeout: 30000,
				maxRedirects: 5,
			});

			// Load HTML content with Cheerio
			const $ = load(metadataResponse.data);

			// Extract basic metadata
			const metadata = {
				url: url,
				title: $("title").text().trim() || $("h1").first().text().trim(),
				description: "",
				author: "",
				pubDate: "",
				image: "",
				robots: "",
				keywords: "",
				language: "",
				viewport: "",
				favicon: "",
				openGraph: {},
				twitterCard: {},
				allMetaTags: {},
			};

			// Extract description from various meta tags
			metadata.description =
				$('meta[name="description"]').attr("content") ||
				$('meta[property="og:description"]').attr("content") ||
				$('meta[name="twitter:description"]').attr("content") ||
				$('meta[name="summary"]').attr("content") ||
				"";

			// Extract author
			metadata.author =
				$('meta[name="author"]').attr("content") ||
				$('meta[property="article:author"]').attr("content") ||
				$('meta[name="twitter:creator"]').attr("content") ||
				$('link[rel="author"]').attr("href") ||
				"";

			// Extract publication date
			metadata.pubDate =
				$('meta[property="article:published_time"]').attr("content") ||
				$('meta[name="date"]').attr("content") ||
				$('meta[name="pubdate"]').attr("content") ||
				$('meta[name="DC.date.issued"]').attr("content") ||
				$("time[datetime]").first().attr("datetime") ||
				"";

			// Extract main image
			metadata.image =
				$('meta[property="og:image"]').attr("content") ||
				$('meta[name="twitter:image"]').attr("content") ||
				$('meta[name="image"]').attr("content") ||
				$("img").first().attr("src") ||
				"";

			if (
				metadata.image.startsWith("http") ||
				metadata.image.startsWith("//") ||
				metadata.image.startsWith("data:image/") ||
				metadata.image.startsWith("blob:") ||
				metadata.image.startsWith("file:") ||
				metadata.image.startsWith("mailto:")
			) {
				metadata.image = "";
			}
			// Extract robots meta
			metadata.robots = $('meta[name="robots"]').attr("content") || "";

			// Extract keywords
			metadata.keywords = $('meta[name="keywords"]').attr("content") || "";

			// Extract language
			metadata.language =
				$("html").attr("lang") ||
				$('meta[http-equiv="content-language"]').attr("content") ||
				$('meta[name="language"]').attr("content") ||
				"";

			// Extract viewport
			metadata.viewport = $('meta[name="viewport"]').attr("content") || "";

			// Extract charset
			metadata.charset =
				$("meta[charset]").attr("charset") ||
				$('meta[http-equiv="content-type"]').attr("content") ||
				"";

			// Extract theme color
			metadata.themeColor = $('meta[name="theme-color"]').attr("content") || "";

			// Extract all meta tags
			$("meta").each((i, element) => {
				const $meta = $(element);
				const name =
					$meta.attr("name") ||
					$meta.attr("property") ||
					$meta.attr("http-equiv");
				const content = $meta.attr("content");
				if (name && content) {
					metadata.allMetaTags[name] = content;
				}
			});

			// Extract Open Graph tags
			$('meta[property^="og:"]').each((i, element) => {
				const $meta = $(element);
				const property = $meta.attr("property");
				const content = $meta.attr("content");
				if (property && content) {
					// If the content starts with "http", "blob:", "image:", or "data:", set the value to an empty string
					if (
						content.startsWith("http") ||
						content.startsWith("blob:") ||
						content.startsWith("image:") ||
						content.startsWith("data:")
					) {
						return;
					} else {
						metadata.openGraph[property] = content;
					}
				}
			});

			// Extract Twitter Card tags
			$('meta[name^="twitter:"]').each((i, element) => {
				const $meta = $(element);
				const name = $meta.attr("name");
				const content = $meta.attr("content");
				if (name && content) {
					if (
						content.startsWith("http") ||
						content.startsWith("blob:") ||
						content.startsWith("image:") ||
						content.startsWith("data:")
					) {
						return;
					} else {
						metadata.twitterCard[name] = content;
					}
				}
			});

			// Extract favicon
			metadata.favicon =
				$('link[rel="icon"]').attr("href") ||
				$('link[rel="shortcut icon"]').attr("href") ||
				$('link[rel="favicon"]').attr("href") ||
				"";

			removeEmptyKeys(metadata);

			redditMetadata = metadata.allMetaTags;
			const { markdown, posts } = parseRedditData(redditData, url);
			const comments = parseRedditComments(redditData);
			const commentsMarkdown =
				comments.length > 0
					? `\n\n## Comments\n\n${comments.map((c) => `**u/${c.author}** (${c.score} pts):\n${c.body}\n`).join("\n")}`
					: "";
			const allLinks = posts.map((post) => post.url).filter(Boolean);
			const allImages = posts.map((post) => post.image).filter(Boolean);

			return c.json({
				success: true,
				markdown: markdown + commentsMarkdown,
				rawJson: redditData,
				data: {
					url: url,
					posts: posts,
					comments: comments,
					title: metadata.title,
					links: allLinks,
					images: allImages,
					metadata: redditMetadata,
				},
				timestamp: new Date().toISOString(),
			});
		} catch (fetchError) {
			console.error("❌ Error fetching Reddit JSON:", fetchError);

			// If JSON API is blocked, try alternative approach
			if (fetchError.response?.status === 403) {
				try {
					console.log("🔄 JSON API blocked, trying alternative approach...");

					// Fallback: retry with minimal headers (no User-Agent)
					const fallbackResponse = await axios.get(jsonUrl, {
						headers: { Accept: "application/json" },
						timeout: 30000,
					});

					const redditData = fallbackResponse.data;
					const { markdown, posts } = parseRedditData(redditData, url);
					const comments = parseRedditComments(redditData);
					const commentsMarkdown =
						comments.length > 0
							? `\n\n## Comments\n\n${comments.map((c) => `**u/${c.author}** (${c.score} pts):\n${c.body}\n`).join("\n")}`
							: "";

					return c.json({
						success: true,
						markdown: markdown + commentsMarkdown,
						rawJson: redditData,
						data: {
							url: url,
							posts: posts,
							comments: comments,
							metadata: null,
						},
						timestamp: new Date().toISOString(),
					});
				} catch (fallbackError) {
					console.error("❌ Fallback also failed:", fallbackError);

					return c.json(
						{
							success: false,
							error:
								"Reddit API is currently blocking requests. Please try again later or use a different approach.",
							details: `Primary error: ${fetchError.message}, Fallback error: ${fallbackError.message}`,
							url: url,
							status: "blocked",
						},
						503,
					);
				}
			}

			return c.json(
				{
					success: false,
					error: "Failed to fetch Reddit data",
					details: fetchError.message,
					url: url,
				},
				500,
			);
		}
	} catch (error) {
		console.error("❌ Reddit scraper error:", error);
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

function extractYouTubeVideoId(idOrUrl) {
	if (!idOrUrl || typeof idOrUrl !== "string") return null;
	const s = idOrUrl.trim();
	const youtuBe = /^(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})(?:\?|$)/;
	const watch = /(?:v=)([a-zA-Z0-9_-]{11})(?:&|$)/;
	const m = s.match(youtuBe) || s.match(watch);
	if (m) return m[1];
	if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
	return null;
}

const YOUTUBE_BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BROWSER_HEADERS = {
	"User-Agent": YOUTUBE_BROWSER_UA,
	"Accept-Language": "en-US,en;q=0.9",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	Referer: "https://www.youtube.com/",
};

function browserLikeFetchOptions(dispatcher) {
	const headers = { ...BROWSER_HEADERS };
	const fetchOpts = (opts) => (dispatcher ? { ...opts, dispatcher } : opts);
	return {
		userAgent: YOUTUBE_BROWSER_UA,
		videoFetch: (params) =>
			fetch(
				params.url,
				fetchOpts({
					method: params.method || "GET",
					headers: { ...headers, ...params.headers },
					body: params.body,
				}),
			),
		playerFetch: (params) =>
			fetch(
				params.url,
				fetchOpts({
					method: params.method || "POST",
					headers: {
						...headers,
						"Content-Type": "application/json",
						...params.headers,
					},
					body: params.body,
				}),
			),
		transcriptFetch: (params) =>
			fetch(
				params.url,
				fetchOpts({
					method: params.method || "GET",
					headers: { ...headers, ...params.headers },
					body: params.body,
				}),
			),
	};
}

function getScrapeYoutubeFetchOptions() {
	if (process.env.VERCEL !== "1") return {};
	try {
		const proxy = proxyManager.getNextProxy();
		const proxyUrl = `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`;
		const dispatcher = new ProxyAgent(proxyUrl);
		return browserLikeFetchOptions(dispatcher);
	} catch {
		return browserLikeFetchOptions();
	}
}

app.post("/scrape-youtube", async (c) => {
	const { id } = await c.req.json();
	if (!id) {
		return c.json(
			{ success: false, error: "Video id or URL is required" },
			400,
		);
	}
	const baseOpts = getScrapeYoutubeFetchOptions();
	try {
		let transcript = [];
		try {
			transcript = await fetchTranscript(id, { lang: "en", ...baseOpts });
		} catch (langError) {
			if (langError instanceof YoutubeTranscriptNotAvailableLanguageError) {
				transcript = await fetchTranscript(id, baseOpts);
			} else {
				throw langError;
			}
		}
		return c.json({
			success: true,
			data: {
				transcript,
			},
		});
	} catch (error) {
		console.error("❌ Youtube scraper error:", error);
		const details = error?.message || String(error);
		return c.json(
			{
				success: false,
				error: "Failed to fetch YouTube transcript",
				details,
			},
			500,
		);
	}
});

// POST /repo/analyze — full AST analysis (public repos, no token)
app.post("/repo/analyze", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const {
			repoUrl,
			branch = "main",
			includeFullAST = false,
			fileExtensions,
			maxFiles = 200,
		} = body;

		const match = repoUrl?.match(/github\.com\/([^/]+)\/([^/]+)/);
		if (!match) return c.json({ error: "Invalid GitHub repo URL" }, 400);

		const [, owner, repo] = match;
		const ast = await analyzeRepo(owner, repo, branch, {
			includeFullAST,
			fileExtensions,
			maxFiles,
		});
		return c.json(ast);
	} catch (err) {
		return c.json({ error: err?.message ?? String(err) }, 500);
	}
});

// GET /repo/tree — lightweight file tree only (public repos, no token)
app.get("/repo/tree", async (c) => {
	try {
		const repoUrl = c.req.query("url");
		const branch = c.req.query("branch") ?? "main";

		if (!repoUrl) return c.json({ error: "url query param required" }, 400);

		const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
		if (!match) return c.json({ error: "Invalid GitHub repo URL" }, 400);

		const [, owner, repo] = match;
		const tree = await fetchRepoTree(owner, repo, branch);
		return c.json({
			repo: `${owner}/${repo}`,
			branch,
			totalItems: tree.length,
			tree: tree.map((i) => ({ path: i.path, type: i.type, size: i.size })),
		});
	} catch (err) {
		return c.json({ error: err?.message ?? String(err) }, 500);
	}
});

app.post("/scrape-git", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const { url, includePullRequests = false, includeIssues = false } = body;

	if (!url || typeof url !== "string") {
		return c.json({ success: false, error: "URL is required" }, 400);
	}
	const newUrl = new URL(url);
	if (!newUrl || newUrl.hostname !== "github.com") {
		return c.json(
			{
				success: false,
				error: "URL is required and must be a github URL",
			},
			400,
		);
	}

	const repoMatch = url.match(/github\.com\/([^/]+)\/([^/]+)/);
	const owner = repoMatch?.[1];
	const repo = repoMatch?.[2]?.replace(/\.git$/i, "");

	try {
		const response = await axios.get(newUrl.toString());

		const $ = load(response.data);
		const metadata = {
			title: $("title").text().trim(),
			description: $("meta[name='description']").attr("content"),
			image: $("meta[name='image']").attr("content"),
			author: $("meta[name='author']").attr("content"),
			pubDate: $("meta[name='pubdate']").attr("content"),
		};

		const article = $("article");
		const dom = new JSDOM(article.html());
		const content = dom.window.document;
		const { markdown } = extractSemanticContentWithFormattedMarkdown(
			content.body,
		);

		let ast = null;
		const parsed = parseRepoUrl(url);
		if (parsed) {
			try {
				if (parsed.isBlob && parsed.path) {
					ast = await analyzeSingleFile(
						parsed.owner,
						parsed.repo,
						parsed.branch,
						parsed.path,
					);
				} else {
					ast = await analyzeRepo(parsed.owner, parsed.repo, parsed.branch);
				}
			} catch (astError) {
				console.error("❌ Repo AST error:", astError);
				ast = null;
			}
		}

		const links = [];
		let stars = null;
		let pullRequests = null;
		let issues = null;

		const ghApi = "https://api.github.com";
		const ghHeaders = {
			Accept: "application/vnd.github.v3+json",
			"User-Agent": "scrape-git-agent/1.0",
		};

		if (owner && repo) {
			try {
				const res = await fetch(`${ghApi}/repos/${owner}/${repo}`, {
					headers: ghHeaders,
					signal: AbortSignal.timeout(10_000),
				});
				if (res.ok) {
					const data = await res.json();
					stars = {
						count: data.stargazers_count ?? 0,
						forks: data.forks_count ?? 0,
						url: data.html_url || `https://github.com/${owner}/${repo}`,
					};
					links.push({ label: "Repository", url: stars.url });
				}
			} catch (e) {
				console.warn("❌ GitHub stars fetch failed:", e?.message);
			}

			if (includePullRequests) {
				try {
					const res = await fetch(
						`${ghApi}/repos/${owner}/${repo}/pulls?state=open&per_page=30`,
						{ headers: ghHeaders, signal: AbortSignal.timeout(10_000) },
					);
					if (res.ok) {
						const list = await res.json();
						pullRequests = list.map((pr) => ({
							number: pr.number,
							title: pr.title,
							url: pr.html_url,
							state: pr.state,
							user: pr.user?.login,
							created_at: pr.created_at,
						}));
						pullRequests.forEach((pr) => {
							links.push({
								label: `PR #${pr.number}: ${pr.title}`,
								url: pr.url,
							});
						});
					}
				} catch (e) {
					console.warn("❌ GitHub pull requests fetch failed:", e?.message);
				}
			}

			if (includeIssues) {
				try {
					const res = await fetch(
						`${ghApi}/repos/${owner}/${repo}/issues?state=open&per_page=30`,
						{ headers: ghHeaders, signal: AbortSignal.timeout(10_000) },
					);
					if (res.ok) {
						const list = await res.json();
						const issuesOnly = list.filter((i) => !i.pull_request);
						issues = issuesOnly.map((iss) => ({
							number: iss.number,
							title: iss.title,
							url: iss.html_url,
							state: iss.state,
							user: iss.user?.login,
							created_at: iss.created_at,
						}));
						issues.forEach((iss) => {
							links.push({
								label: `Issue #${iss.number}: ${iss.title}`,
								url: iss.url,
							});
						});
					}
				} catch (e) {
					console.warn("❌ GitHub issues fetch failed:", e?.message);
				}
			}
		}

		const payload = {
			success: true,
			data: {
				url: url,
				title: metadata.title,
				content: content,
				metadata: metadata,
			},
			markdown: markdown,
			ast,
		};
		if (stars != null) payload.stars = stars;
		if (pullRequests != null) payload.pullRequests = pullRequests;
		if (issues != null) payload.issues = issues;
		if (links.length > 0) payload.links = links;

		return c.json(payload);
	} catch (error) {
		console.error("❌ Github scraper error:", error);
		return c.json(
			{
				success: false,
				error: "Internal server error",
			},
			500,
		);
	}
});

export default app;

app.post("/image-to-code", async (c) => {
	const contentType = c.req.header("content-type") || "";
	let imageUrl;
	let prompt;
	let base64Data;
	let mimeType;

	if (contentType.includes("application/json")) {
		const body = await c.req.json();
		imageUrl = body.imageUrl;
		prompt = body.prompt;
	} else if (contentType.includes("multipart/form-data")) {
		try {
			const formData = await c.req.formData();
			// Accept either a file (field: image or file) or a URL (field: imageUrl)
			const fileField = formData.get("image") || formData.get("file");
			if (
				fileField &&
				typeof fileField === "object" &&
				"arrayBuffer" in fileField
			) {
				mimeType = fileField.type || "application/octet-stream";
				const ab = await fileField.arrayBuffer();
				base64Data = Buffer.from(ab).toString("base64");
			}
			imageUrl = formData.get("imageUrl");
			prompt = formData.get("prompt");
		} catch (err) {
			return c.json(
				{
					error:
						"Invalid multipart/form-data payload. Use proper multipart encoding (-F in curl) or send JSON.",
					detail:
						"When Content-Type is multipart/form-data, the body must include correct CRLF and boundary formatting.",
				},
				400,
			);
		}
	} else if (contentType.includes("application/x-www-form-urlencoded")) {
		const bodyText = await c.req.text();
		const params = new URLSearchParams(bodyText);
		imageUrl = params.get("imageUrl");
		prompt = params.get("prompt");
	} else {
		return c.json(
			{ error: "Unsupported Content-Type. Use JSON or multipart/form-data." },
			415,
		);
	}

	if (!prompt) {
		return c.json({ error: "Prompt is required" }, 400);
	}

	// Resolve image content: prefer uploaded file if present, else fetch from URL
	if (!base64Data) {
		if (!imageUrl) {
			return c.json(
				{ error: "Provide either an image file (field: image) or imageUrl" },
				400,
			);
		}
		const res = await fetch(imageUrl);
		if (!res.ok) {
			return c.json({ error: "Failed to fetch image from imageUrl" }, 400);
		}
		mimeType = res.headers.get("content-type") || "image/png";
		const arrayBuffer = await res.arrayBuffer();
		base64Data = Buffer.from(arrayBuffer).toString("base64");
	}

	const aiResponse = await genai.models.generateContent({
		model: "gemini-2.0-flash",
		contents: [
			{
				role: "model",
				parts: [
					{
						text: `You are an expert React developer. Your task is to generate a single, complete React component based on the provided image and user prompt. 

Strict requirements:
- Output only a single React component, in a string with react code block with language set to \`jsx\`.
- Use **Tailwind CSS** for all styling.
- Use **lucide-react** and **react-icons** for any icons (import from these libraries as needed).
- Do not use any other CSS frameworks or icon libraries.
- The component should be self-contained and ready to use.
- Do not include any explanations, comments, or extra text outside the code block.
- If the image contains text, use placeholder text in English.
- If the image contains interactive elements, implement them as functional React code.
- Do not include any import for Tailwind CSS (assume it is globally available).
- Only output the code block with the component, nothing else.`,
					},
				],
			},
			{
				role: "user",
				parts: [
					{ text: prompt },
					{ inlineData: { mimeType, data: base64Data } },
				],
			},
		],
	});
	let text = aiResponse?.candidates?.[0]?.content?.parts?.[0]?.text || "";

	// If wrapped in a code fence, extract inner content
	const fenceMatch = text.match(/```(?:jsx|tsx|javascript)?\n([\s\S]*?)```/i);
	if (fenceMatch && fenceMatch[1]) {
		text = fenceMatch[1];
	}

	// Convert literal escape sequences to actual characters
	const code = text
		.replace(/\\r/g, "")
		.replace(/\\t/g, "\t")
		.replace(/\\n/g, "\n");

	// Flat version for detectors that cannot handle newlines
	const code_flat = code
		.replace(/\r?\n/g, " ")
		.replace(/\t/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();

	return c.json({
		success: true,
		code,
		code_flat,
		inputTokens: aiResponse.usageMetadata.promptTokenCount,
		outputTokens: aiResponse.usageMetadata.candidatesTokenCount,
	});
});

/** Normalize image input to { base64, mimeType }. Fetches from URL if needed. */
async function normalizeImageInput(img) {
	if (!img || typeof img !== "object") return null;
	if (img.base64 && typeof img.base64 === "string") {
		return {
			base64: img.base64.replace(/^data:image\/\w+;base64,/, ""),
			mimeType: img.mimeType || "image/png",
		};
	}
	if (img.url && typeof img.url === "string") {
		const res = await fetch(img.url, { signal: AbortSignal.timeout(15_000) });
		if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
		const buf = await res.arrayBuffer();
		const base64 = Buffer.from(buf).toString("base64");
		const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
		return { base64, mimeType };
	}
	return null;
}

/**
 * POST /image-reading
 * Body: { images: [{ url } | { base64, mimeType }], convertToCode?: boolean, extractContent?: boolean }
 * Uses Gemini 2.0 to extract content (markdown) and optionally convert to code.
 */
app.post("/image-reading", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const {
			images = [],
			convertToCode = false,
			extractContent = true,
		} = body;

		if (!Array.isArray(images) || images.length === 0) {
			return c.json(
				{ success: false, error: "images array is required and must not be empty" },
				400,
			);
		}

		const normalized = [];
		for (let i = 0; i < images.length; i++) {
			try {
				const n = await normalizeImageInput(images[i]);
				if (n) normalized.push(n);
			} catch (e) {
				console.warn("[image-reading] Skip image", i, e?.message);
			}
		}
		if (normalized.length === 0) {
			return c.json(
				{ success: false, error: "No valid image could be loaded from images array" },
				400,
			);
		}

		const results = [];
		const markdownParts = [];

		for (let idx = 0; idx < normalized.length; idx++) {
			const { base64, mimeType } = normalized[idx];
			const result = { index: idx, content: null, code: null };

			if (extractContent) {
				try {
					const contentRes = await genai.models.generateContent({
						model: "gemini-2.0-flash",
						contents: [
							{
								role: "user",
								parts: [
									{
										text: "Extract and describe all text and meaningful content from this image. Return only markdown: headings, paragraphs, lists, and any text you see. No preamble or explanation.",
									},
									{ inlineData: { mimeType, data: base64 } },
								],
							},
						],
					});
					const text =
						contentRes?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
					result.content = text || "(No text extracted)";
					markdownParts.push(`--- Image ${idx + 1} ---\n\n${result.content}`);
				} catch (e) {
					console.warn("[image-reading] Extract content failed:", e?.message);
					result.content = "(Content extraction failed)";
					markdownParts.push(`--- Image ${idx + 1} ---\n\n${result.content}`);
				}
			}

			if (convertToCode) {
				try {
					const codeRes = await genai.models.generateContent({
						model: "gemini-2.0-flash",
						contents: [
							{
								role: "user",
								parts: [
									{
										text: "Convert this image (screenshot, mockup, or UI) into clean HTML and CSS code. Output only a single HTML document with embedded <style>. No explanations.",
									},
									{ inlineData: { mimeType, data: base64 } },
								],
							},
						],
					});
					let code =
						codeRes?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
					const fence = code.match(/```(?:html)?\s*\n?([\s\S]*?)\n?```/);
					if (fence && fence[1]) code = fence[1].trim();
					result.code = code || null;
				} catch (e) {
					console.warn("[image-reading] Convert to code failed:", e?.message);
				}
			}

			results.push(result);
		}

		const markdown = markdownParts.join("\n\n");

		return c.json({
			success: true,
			results,
			markdown: markdown || "(No content extracted)",
		});
	} catch (err) {
		console.error("❌ image-reading error:", err);
		return c.json(
			{ success: false, error: err?.message || "Image reading failed" },
			500,
		);
	}
});

// Helper to parse repo input (either "owner/repo" or full GitHub URL)
const parseGithubRepoInput = (input) => {
	if (!input || typeof input !== "string") return null;
	try {
		if (input.includes("github.com")) {
			const u = new URL(input);
			const parts = u.pathname.replace(/^\//, "").split("/");
			if (parts.length >= 2) {
				return { owner: parts[0], repo: parts[1] };
			}
		} else if (input.includes("/")) {
			const [owner, repo] = input.split("/");
			if (owner && repo) return { owner, repo };
		}
		return null;
	} catch (_e) {
		return null;
	}
};

// Extract JSON from LLM text output (handles ```json fences)
const extractJsonFromText = (text) => {
	if (!text) return null;
	const fenced =
		text.match(/```json\s*([\s\S]*?)\s*```/i) ||
		text.match(/```\s*([\s\S]*?)\s*```/i);
	const candidate = fenced ? fenced[1] : text;
	const tryParse = (s) => {
		try {
			return JSON.parse(s);
		} catch (_e) {
			return null;
		}
	};
	const direct = tryParse(candidate);
	if (direct) return direct;
	// Heuristic: grab the largest JSON-looking substring between first { and last }
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start !== -1 && end !== -1 && end > start) {
		const slice = candidate.slice(start, end + 1);
		const sliced = tryParse(slice);
		if (sliced) return sliced;
	}
	return null;
};

// Combine all text parts from the first candidate
const getGeminiText = (response) => {
	const parts = response?.candidates?.[0]?.content?.parts || [];
	return parts
		.map((p) => (typeof p?.text === "string" ? p.text : ""))
		.join("\n")
		.trim();
};

// Minimal fallback doc if JSON parsing fails
const buildFallbackDocs = (repoBundle) => {
	const title = repoBundle?.metadata?.name || repoBundle?.repo || "Project";
	const description = repoBundle?.metadata?.description || "unknown";
	const readme = repoBundle?.readme || "";
	const readmeSnippet = readme ? readme.slice(0, 2000) : "unknown";
	return {
		title: title,
		description: description,
		chapters: [
			{
				title: "Overview",
				pages: [
					{
						title: "Introduction",
						markdown:
							description && description !== "unknown"
								? description
								: "unknown",
					},
				],
			},
			{
				title: "README",
				pages: [
					{
						title: "Root README excerpt",
						markdown: readmeSnippet,
					},
				],
			},
		],
		missing_docs: ["LLM returned non-parseable JSON; using fallback"],
	};
};

app.post("/generate-repo-docs", async (c) => {
	const { repo, url } = await c.req.json();
	const input = repo || url;
	if (!input) {
		return c.json(
			{ success: false, error: "Provide 'repo' (owner/name) or 'url'" },
			400,
		);
	}
	if (!process.env.GITHUB_TOKEN) {
		return c.json(
			{ success: false, error: "GITHUB_TOKEN not configured" },
			500,
		);
	}

	const parsed = parseGithubRepoInput(input);
	if (!parsed) {
		return c.json(
			{ success: false, error: "Invalid GitHub repo identifier" },
			400,
		);
	}

	const { owner, repo: repoName } = parsed;
	const ghHeaders = {
		Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
		Accept: "application/vnd.github+json",
		"User-Agent": "ihatereading-api",
	};

	try {
		// Fetch repo metadata
		const repoRes = await fetch(
			`https://api.github.com/repos/${owner}/${repoName}`,
			{
				headers: ghHeaders,
			},
		);
		if (!repoRes.ok) {
			const details = await repoRes.text();
			return c.json(
				{
					success: false,
					error: "Failed to fetch repo",
					status: repoRes.status,
					details,
				},
				repoRes.status,
			);
		}
		const repoJson = await repoRes.json();

		// Languages
		const langRes = await fetch(
			`https://api.github.com/repos/${owner}/${repoName}/languages`,
			{
				headers: ghHeaders,
			},
		);
		const languages = langRes.ok ? await langRes.json() : {};

		// README raw text
		const readmeRes = await fetch(
			`https://api.github.com/repos/${owner}/${repoName}/readme`,
			{
				headers: { ...ghHeaders, Accept: "application/vnd.github.raw" },
			},
		);
		const readme = readmeRes.ok ? await readmeRes.text() : "";

		// Top-level files/directories
		const contentsRes = await fetch(
			`https://api.github.com/repos/${owner}/${repoName}/contents?ref=${encodeURIComponent(
				repoJson.default_branch || "main",
			)}`,
			{ headers: ghHeaders },
		);
		const contents = contentsRes.ok ? await contentsRes.json() : [];
		const keyFiles = Array.isArray(contents)
			? contents.map((e) => ({
					name: e.name,
					path: e.path,
					type: e.type,
					size: e.size,
				}))
			: [];

		const repoBundle = {
			repo: `${owner}/${repoName}`,
			metadata: {
				name: repoJson.name,
				full_name: repoJson.full_name,
				description: repoJson.description,
				visibility: repoJson.visibility,
				license: repoJson.license?.spdx_id || repoJson.license?.key || null,
				default_branch: repoJson.default_branch,
				homepage: repoJson.homepage,
				topics: repoJson.topics || [],
				stargazers_count: repoJson.stargazers_count,
				forks_count: repoJson.forks_count,
				open_issues: repoJson.open_issues,
				archived: repoJson.archived,
				language: repoJson.language,
			},
			languages,
			readme,
			key_files: keyFiles,
		};

		const systemPrompt = `You are an expert technical writer and senior developer. Using ONLY the provided GitHub repository data (metadata, languages, README, key files), produce structured documentation that is easy to read, understand, and grasp.

Strictly output a SINGLE JSON object with this schema (no extra commentary):
{
  "title": string,                      // Human-friendly project title
  "description": string,                // One-paragraph overview and primary use-cases
  "chapters": [                         // Top-level chapters
    {
      "title": string,
      "pages": [                        // Each page holds Markdown content
        { "title": string, "markdown": string }
      ],
      "subchapters"?: [                 // OPTIONAL second-level chapters (max depth = 2)
        {
          "title": string,
          "pages": [ { "title": string, "markdown": string } ]
        }
      ]
    }
  ],
  "missing_docs": [ string ]            // Items that require maintainer input
}

Authoring rules:
- MAX DEPTH: Chapters may contain subchapters only one level deep (2 levels total).
- PAGES: Each chapter and subchapter should include one or more pages. Page content MUST be valid Markdown.
- CODE SAMPLES: Include fenced code blocks in page Markdown when helpful (derive from README, key files, or plausible usage based on metadata/languages). Mark unknowns explicitly as "unknown".
- BREVITY & CLARITY: Prefer concise explanations with practical examples. Avoid fluff.

Recommended chapter order (adapt as appropriate):
1) Overview
2) Getting Started
3) Installation & Setup
4) Usage
5) API Reference (if applicable)
6) Architecture
7) Key Files
8) Examples
9) Limitations
10) FAQ

Return ONLY the JSON object above.`;

		const userPrompt = `Repository data:\n${JSON.stringify(
			repoBundle,
			null,
			2,
		)}\n\nReturn only the JSON.`;

		const aiResponse = await genai.models.generateContent({
			model: "gemini-1.5-flash",
			contents: [
				{ role: "model", parts: [{ text: systemPrompt }] },
				{ role: "user", parts: [{ text: userPrompt }] },
			],
		});

		const rawText = getGeminiText(aiResponse);
		let docsJson = extractJsonFromText(rawText);
		if (!docsJson) {
			docsJson = buildFallbackDocs(repoBundle);
		}

		return c.json({
			success: true,
			repo: `${owner}/${repoName}`,
			docs: docsJson,
			raw: rawText,
			totalTokenCount: aiResponse.usageMetadata?.totalTokenCount,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error("❌ generate-repo-docs error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to generate repository docs",
				details: error.message,
			},
			500,
		);
	}
});

app.post("/generate-repo-changelog", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const {
		repo,
		url,
		from,
		to,
		includeCommits = true,
		includePRs = true,
	} = body || {};
	const input = repo || url;
	if (!input) {
		return c.json(
			{ success: false, error: "Provide 'repo' (owner/name) or 'url'" },
			400,
		);
	}
	if (!process.env.GITHUB_TOKEN) {
		return c.json(
			{ success: false, error: "GITHUB_TOKEN not configured" },
			500,
		);
	}

	const parsed = parseGithubRepoInput(input);
	if (!parsed) {
		return c.json(
			{ success: false, error: "Invalid GitHub repo identifier" },
			400,
		);
	}

	const { owner, repo: repoName } = parsed;
	const ghHeaders = {
		Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
		Accept: "application/vnd.github+json",
		"User-Agent": "ihatereading-api",
	};

	const buildQueryParams = (params) =>
		Object.entries(params)
			.filter(([, v]) => v !== undefined && v !== null && v !== "")
			.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
			.join("&");

	try {
		// Resolve default branch and repo info
		const repoRes = await fetch(
			`https://api.github.com/repos/${owner}/${repoName}`,
			{ headers: ghHeaders },
		);
		if (!repoRes.ok) {
			const details = await repoRes.text();
			return c.json(
				{
					success: false,
					error: "Failed to fetch repo",
					status: repoRes.status,
					details,
				},
				repoRes.status,
			);
		}
		const repoJson = await repoRes.json();
		const defaultBranch = repoJson.default_branch || "main";

		// Time window normalization (ISO dates only for GitHub list endpoints)
		const since = from && /\d{4}-\d{2}-\d{2}/.test(from) ? from : undefined;
		const until = to && /\d{4}-\d{2}-\d{2}/.test(to) ? to : undefined;

		// Collect commits
		let commits = [];
		if (includeCommits) {
			const commitQP = buildQueryParams({
				sha: defaultBranch,
				since,
				until,
				per_page: 100,
			});
			const commitsUrl = `https://api.github.com/repos/${owner}/${repoName}/commits${
				commitQP ? `?${commitQP}` : ""
			}`;
			const commitsRes = await fetch(commitsUrl, { headers: ghHeaders });
			commits = commitsRes.ok ? await commitsRes.json() : [];
		}

		// Collect PRs (merged and/or closed in the window)
		let pullRequests = [];
		if (includePRs) {
			// Use issues list with state=closed to get PRs with closed dates; filter to PRs
			const prsQP = buildQueryParams({
				state: "closed",
				per_page: 100,
				sort: "updated",
				direction: "desc",
			});
			const issuesUrl = `https://api.github.com/repos/${owner}/${repoName}/issues${
				prsQP ? `?${prsQP}` : ""
			}`;
			const issuesRes = await fetch(issuesUrl, { headers: ghHeaders });
			const issues = issuesRes.ok ? await issuesRes.json() : [];
			const isWithin = (dateStr) => {
				if (!dateStr) return true;
				const d = new Date(dateStr).getTime();
				if (since && d < new Date(since).getTime()) return false;
				if (until && d > new Date(until).getTime()) return false;
				return true;
			};
			const issuePRs = (issues || []).filter(
				(i) => i.pull_request && isWithin(i.closed_at || i.updated_at),
			);

			// Hydrate PR details for those issues
			pullRequests = [];
			for (const item of issuePRs) {
				const prNumber = item.number;
				const prRes = await fetch(
					`https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}`,
					{ headers: ghHeaders },
				);
				if (!prRes.ok) continue;
				const pr = await prRes.json();
				pullRequests.push(pr);
			}
		}

		const changelogBundle = {
			repo: `${owner}/${repoName}`,
			window: { from: since || null, to: until || null, branch: defaultBranch },
			counts: {
				commits: Array.isArray(commits) ? commits.length : 0,
				prs: Array.isArray(pullRequests) ? pullRequests.length : 0,
			},
			commits: (commits || []).map((c) => ({
				sha: c.sha,
				message: c.commit?.message,
				author: c.commit?.author?.name || c.author?.login,
				date: c.commit?.author?.date,
				html_url: c.html_url,
				files_url: c.url,
			})),
			pull_requests: (pullRequests || []).map((p) => ({
				number: p.number,
				title: p.title,
				state: p.state,
				merged: Boolean(p.merged_at),
				user: p.user?.login,
				created_at: p.created_at,
				closed_at: p.closed_at,
				merged_at: p.merged_at,
				html_url: p.html_url,
				base: p.base?.ref,
				head: p.head?.ref,
			})),
		};

		const systemPrompt = `You are an expert release manager and technical writer. Using ONLY the provided commits and pull requests, produce a clear, developer-focused changelog.

Output a SINGLE JSON object:
{
  "title": string,                  // e.g., "Changelog for repo@version or date range"
  "summary": string,                // one-paragraph high-level summary
  "sections": [                     // categorize by type
    { "title": "Features", "items": [string] },
    { "title": "Improvements", "items": [string] },
    { "title": "Bug Fixes", "items": [string] },
    { "title": "Documentation", "items": [string] },
    { "title": "Breaking Changes", "items": [string] }
  ],
  "contributors": [string],         // unique authors/usernames
  "release_notes_markdown": string  // well-formatted Markdown release notes, including bullet points and links when available
}

Rules:
- Derive items from commit messages and PR titles/bodies only.
- Prefer PRs over individual commits if both exist.
- Include PR numbers and links when known, e.g., "Add X (#123)".
- Keep it factual, concise, and useful for developers.
- If information is missing, omit rather than speculate.`;

		const userPrompt = `Repository: ${owner}/${repoName}\nWindow: from=${
			since || "unknown"
		} to=${until || "unknown"}\n\nData:\n${JSON.stringify(
			changelogBundle,
			null,
			2,
		)}\n\nReturn only the JSON.`;

		const aiResponse = await genai.models.generateContent({
			model: "gemini-1.5-flash",
			contents: [
				{ role: "model", parts: [{ text: systemPrompt }] },
				{ role: "user", parts: [{ text: userPrompt }] },
			],
		});

		const rawText = getGeminiText(aiResponse);
		let changelogJson = extractJsonFromText(rawText);
		if (!changelogJson) {
			// Fallback: minimal changelog
			const contributors = Array.from(
				new Set([
					...(changelogBundle.commits || [])
						.map((c) => c.author)
						.filter(Boolean),
					...(changelogBundle.pull_requests || [])
						.map((p) => p.user)
						.filter(Boolean),
				]),
			);
			changelogJson = {
				title: `Changelog for ${owner}/${repoName}`,
				summary: "Auto-generated summary unavailable; using fallback.",
				sections: [
					{
						title: "Changes",
						items: (changelogBundle.commits || [])
							.slice(0, 20)
							.map((c) => c.message)
							.filter(Boolean),
					},
				],
				contributors,
				release_notes_markdown: `# Changelog\n\n- Fallback generated from commits (${
					(changelogBundle.commits || []).length
				}) and PRs (${(changelogBundle.pull_requests || []).length}).`,
			};
		}

		return c.json({
			success: true,
			repo: `${owner}/${repoName}`,
			window: { from: since || null, to: until || null },
			changelog: changelogJson,
			raw: rawText,
			totalTokenCount: aiResponse.usageMetadata?.totalTokenCount,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error("❌ generate-repo-changelog error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to generate changelog",
				details: error.message,
			},
			500,
		);
	}
});

// Google News Scraping Endpoint
app.post("/scrap-google-news", async (c) => {
	const operationId = performanceMonitor.startOperation("scrap_google_news");

	try {
		const { city, state, limit = 20 } = await c.req.json();

		if (!city || !state) {
			performanceMonitor.endOperation(operationId);
			return c.json(
				{
					success: false,
					error: "City and state are required",
				},
				400,
			);
		}

		// Validate limit parameter
		const articleLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 50); // Between 1 and 50 articles

		// Construct Google News search URL
		const searchQuery = encodeURIComponent(`${city} ${state}`);
		const googleNewsUrl = `https://news.google.com/search?q=${searchQuery}&hl=en&gl=US&ceid=US%3Aen`;

		console.log(`Scraping Google News for: ${city}, ${state}`);
		console.log(`URL: ${googleNewsUrl}`);

		// Use axios to fetch the page
		const response = await axios.get(googleNewsUrl, {
			headers: {
				"User-Agent": userAgents.toString(),
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.5",
				"Accept-Encoding": "gzip, deflate, br",
				DNT: "1",
				Connection: "keep-alive",
				"Upgrade-Insecure-Requests": "1",
			},
			timeout: 30000,
		});

		const $ = load(response.data);
		const newsArticles = [];

		// Parse Google News articles
		$("article").each((index, element) => {
			if (index >= articleLimit) return false; // Limit to specified number of articles

			const $article = $(element);

			// Extract article data
			const titleElement = $article.find("h3 a, h4 a").first();
			const title = titleElement.text().trim();
			const link = titleElement.attr("href");

			const sourceElement = $article.find(
				'[data-testid="source-name"], .wEwyrc, .NUnG9d',
			);
			const source = sourceElement.text().trim();

			const timeElement = $article.find("time, .OSrXXb");
			const timeText = timeElement.text().trim();

			const snippetElement = $article.find(".GI74Re, .Y3v8qd");
			const snippet = snippetElement.text().trim();

			// Check for image presence
			const imageElement = $article.find("img").first();
			const hasImage = imageElement.length > 0;
			let imageUrl = null;

			if (hasImage) {
				const src = imageElement.attr("src");
				if (src) {
					// Convert relative URLs to absolute URLs
					if (src.startsWith("//")) {
						imageUrl = `https:${src}`;
					} else if (src.startsWith("/")) {
						imageUrl = `https://news.google.com${src}`;
					} else if (src.startsWith("./")) {
						imageUrl = `https://news.google.com${src.substring(1)}`;
					} else if (!src.startsWith("http")) {
						imageUrl = `https://news.google.com/${src}`;
					} else {
						imageUrl = src;
					}
				}
			}

			if (title && link) {
				newsArticles.push({
					title,
					link: link.startsWith("./")
						? `https://news.google.com${link.substring(1)}`
						: link,
					source: source || "Unknown",
					time: timeText || "Unknown",
					snippet: snippet || "",
					imageUrl: imageUrl || null,
					index: index + 1,
				});
			}
		});

		// If no articles found with the above selectors, try alternative selectors
		if (newsArticles.length === 0) {
			$(".JtKRv").each((index, element) => {
				if (index >= articleLimit) return false;

				const $item = $(element);
				const titleElement = $item.find("h3 a, h4 a").first();
				const title = titleElement.text().trim();
				const link = titleElement.attr("href");

				const sourceElement = $item.find(".wEwyrc, .NUnG9d");
				const source = sourceElement.text().trim();

				const timeElement = $item.find("time, .OSrXXb");
				const timeText = timeElement.text().trim();

				const snippetElement = $item.find(".GI74Re, .Y3v8qd");
				const snippet = snippetElement.text().trim();

				// Check for image presence
				const imageElement = $item.find("img").first();
				const hasImage = imageElement.length > 0;
				let imageUrl = null;

				if (hasImage) {
					const src = imageElement.attr("src");
					if (src) {
						// Convert relative URLs to absolute URLs
						if (src.startsWith("//")) {
							imageUrl = `https:${src}`;
						} else if (src.startsWith("/")) {
							imageUrl = `https://news.google.com${src}`;
						} else if (src.startsWith("./")) {
							imageUrl = `https://news.google.com${src.substring(1)}`;
						} else if (!src.startsWith("http")) {
							imageUrl = `https://news.google.com/${src}`;
						} else {
							imageUrl = src;
						}
					}
				}

				if (title && link) {
					newsArticles.push({
						title,
						link: link.startsWith("./")
							? `https://news.google.com${link.substring(1)}`
							: link,
						source: source || "Unknown",
						time: timeText || "Unknown",
						snippet: snippet || "",
						hasImage,
						imageUrl: imageUrl || null,
						index: index + 1,
					});
				}
			});
		}

		performanceMonitor.endOperation(operationId);

		return c.json({
			success: true,
			query: `${city}, ${state}`,
			limit: articleLimit,
			totalArticles: newsArticles.length,
			articles: newsArticles,
			scrapedAt: new Date().toISOString(),
			url: googleNewsUrl,
		});
	} catch (error) {
		console.error("Error in /scrap-google-news endpoint:", error);
		performanceMonitor.endOperation(operationId);

		return c.json(
			{
				success: false,
				error: "Failed to scrape Google News",
				details: error.message,
			},
			500,
		);
	}
});

app.post("/fetch-metadata", async (c) => {
	try {
		const { url } = await c.req.json();

		if (!url) {
			return c.json(
				{
					success: false,
					error: "URL is required",
				},
				400,
			);
		}

		// Validate URL format
		try {
			new URL(url);
		} catch (error) {
			return c.json(
				{
					success: false,
					error: "Invalid URL format",
				},
				400,
			);
		}

		try {
			// Fetch the webpage content
			const response = await axios.get(url, {
				headers: {
					"User-Agent": userAgents.random().toString(),
					Accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.9",
					"Accept-Encoding": "gzip, deflate, br",
					DNT: "1",
					Connection: "keep-alive",
					"Upgrade-Insecure-Requests": "1",
				},
				timeout: 30000,
				maxRedirects: 5,
			});

			// Load HTML content with Cheerio
			const $ = load(response.data);

			// Extract basic metadata
			const metadata = {
				url: url,
				title: $("title").text().trim() || $("h1").first().text().trim(),
				description: "",
				author: "",
				pubDate: "",
				image: "",
				robots: "",
				keywords: "",
				language: "",
				viewport: "",
				favicon: "",
				openGraph: {},
				twitterCard: {},
				allMetaTags: {},
			};

			// Extract description from various meta tags
			metadata.description =
				$('meta[name="description"]').attr("content") ||
				$('meta[property="og:description"]').attr("content") ||
				$('meta[name="twitter:description"]').attr("content") ||
				$('meta[name="summary"]').attr("content") ||
				"";

			// Extract author
			metadata.author =
				$('meta[name="author"]').attr("content") ||
				$('meta[property="article:author"]').attr("content") ||
				$('meta[name="twitter:creator"]').attr("content") ||
				$('link[rel="author"]').attr("href") ||
				"";

			// Extract publication date
			metadata.pubDate =
				$('meta[property="article:published_time"]').attr("content") ||
				$('meta[name="date"]').attr("content") ||
				$('meta[name="pubdate"]').attr("content") ||
				$('meta[name="DC.date.issued"]').attr("content") ||
				$("time[datetime]").first().attr("datetime") ||
				"";

			// Extract main image
			metadata.image =
				$('meta[property="og:image"]').attr("content") ||
				$('meta[name="twitter:image"]').attr("content") ||
				$('meta[name="image"]').attr("content") ||
				$("img").first().attr("src") ||
				"";

			if (
				metadata.image.startsWith("http") ||
				metadata.image.startsWith("//") ||
				metadata.image.startsWith("data:image/") ||
				metadata.image.startsWith("blob:") ||
				metadata.image.startsWith("file:") ||
				metadata.image.startsWith("mailto:")
			) {
				metadata.image = "";
			}
			// Extract robots meta
			metadata.robots = $('meta[name="robots"]').attr("content") || "";

			// Extract keywords
			metadata.keywords = $('meta[name="keywords"]').attr("content") || "";

			// Extract language
			metadata.language =
				$("html").attr("lang") ||
				$('meta[http-equiv="content-language"]').attr("content") ||
				$('meta[name="language"]').attr("content") ||
				"";

			// Extract viewport
			metadata.viewport = $('meta[name="viewport"]').attr("content") || "";

			// Extract charset
			metadata.charset =
				$("meta[charset]").attr("charset") ||
				$('meta[http-equiv="content-type"]').attr("content") ||
				"";

			// Extract theme color
			metadata.themeColor = $('meta[name="theme-color"]').attr("content") || "";

			// Extract all meta tags
			$("meta").each((i, element) => {
				const $meta = $(element);
				const name =
					$meta.attr("name") ||
					$meta.attr("property") ||
					$meta.attr("http-equiv");
				const content = $meta.attr("content");
				if (name && content) {
					metadata.allMetaTags[name] = content;
				}
			});

			// Extract Open Graph tags
			$('meta[property^="og:"]').each((i, element) => {
				const $meta = $(element);
				const property = $meta.attr("property");
				const content = $meta.attr("content");
				if (property && content) {
					// If the content starts with "http", "blob:", "image:", or "data:", set the value to an empty string
					if (
						content.startsWith("http") ||
						content.startsWith("blob:") ||
						content.startsWith("image:") ||
						content.startsWith("data:")
					) {
						return;
					} else {
						metadata.openGraph[property] = content;
					}
				}
			});

			// Extract Twitter Card tags
			$('meta[name^="twitter:"]').each((i, element) => {
				const $meta = $(element);
				const name = $meta.attr("name");
				const content = $meta.attr("content");
				if (name && content) {
					if (
						content.startsWith("http") ||
						content.startsWith("blob:") ||
						content.startsWith("image:") ||
						content.startsWith("data:")
					) {
						return;
					} else {
						metadata.twitterCard[name] = content;
					}
				}
			});

			// Extract favicon
			metadata.favicon =
				$('link[rel="icon"]').attr("href") ||
				$('link[rel="shortcut icon"]').attr("href") ||
				$('link[rel="favicon"]').attr("href") ||
				"";

			return c.json({
				success: true,
				metadata: metadata,
				timestamp: new Date().toISOString(),
			});
		} catch (fetchError) {
			console.error("❌ Error fetching URL:", fetchError);

			// Handle specific HTTP status codes
			if (fetchError.response) {
				const status = fetchError.response.status;

				// Handle page not found (404) and other client errors
				if (status === 404) {
					return c.json(
						{
							success: true,
							metadata: null,
							message: "Page not found - the requested URL does not exist",
							status: 404,
							timestamp: new Date().toISOString(),
						},
						200,
					);
				}

				// Handle other client errors (4xx)
				if (status >= 400 && status < 500) {
					return c.json(
						{
							success: true,
							metadata: null,
							message: `Client error - the server returned status ${status}`,
							status: status,
							timestamp: new Date().toISOString(),
						},
						200,
					);
				}

				// Handle server errors (5xx)
				if (status >= 500) {
					return c.json(
						{
							success: true,
							metadata: null,
							message: `Server error - the target server returned status ${status}`,
							status: status,
							timestamp: new Date().toISOString(),
						},
						200,
					);
				}
			}

			// Handle network errors (DNS, connection issues, etc.)
			if (
				fetchError.code === "ENOTFOUND" ||
				fetchError.code === "ECONNREFUSED" ||
				fetchError.code === "ETIMEDOUT"
			) {
				return c.json(
					{
						success: true,
						metadata: null,
						message: "Network error - unable to reach the requested URL",
						error: fetchError.code,
						timestamp: new Date().toISOString(),
					},
					200,
				);
			}

			// Handle timeout errors
			if (fetchError.code === "ECONNABORTED") {
				return c.json(
					{
						success: true,
						metadata: null,
						message: "Request timeout - the server took too long to respond",
						timestamp: new Date().toISOString(),
					},
					200,
				);
			}

			// Handle other errors
			return c.json(
				{
					success: true,
					metadata: null,
					message: "Unable to fetch metadata from the requested URL",
					error: fetchError.message,
					timestamp: new Date().toISOString(),
				},
				200,
			);
		}
	} catch (error) {
		console.error("❌ Metadata API error:", error);
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

app.get("/scrap-grokipedia", async (c) => {
	try {
		const city = await c.req.query("city");
		const state = await c.req.query("state");

		if (!city || !state) {
			return c.json({ error: "City and State parameters are required" }, 400);
		}

		// Construct Grokipedia URL: page/Kota%2C_Rajasthan format
		// Format: city and state, separated by %2C_ (comma and underscore)
		const toTitleCase = (s) =>
			String(s || "")
				.trim()
				.replace(/\s+/g, " ")
				.split(" ")
				.filter(Boolean)
				.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
				.join(" ");

		const formattedCity = toTitleCase(city).replace(/\s+/g, "_");
		const formattedState = toTitleCase(state).replace(/\s+/g, "_");
		const url = `https://grokipedia.com/page/${formattedCity}%2C_${formattedState}`;

		console.log("Grokipedia URL:", url);

		// Fetch HTML
		const response = await axios.get(url, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
			},
		});

		const $ = load(response.data);

		// Extract metadata
		const title =
			$("h1").first().text().trim() || $("article h1").first().text().trim();
		const description = $('meta[name="description"]').attr("content") || "";

		// Find and extract content from article tag
		const article = $("article").first();
		let structuredContent = null;

		if (article.length > 0) {
			// Extract structured content from article tag
			const content = {
				headings: [],
				paragraphs: [],
				lists: [],
				images: [],
				links: [],
			};

			// Extract headings (h1-h6) in order
			article.find("h1, h2, h3, h4, h5, h6").each((_, el) => {
				const heading = {
					level: el.tagName.toLowerCase(),
					text: $(el).text().trim(),
				};
				if (heading.text) {
					content.headings.push(heading);
				}
			});

			// Extract paragraphs
			article.find("p").each((_, el) => {
				const text = $(el).text().trim();
				if (text) {
					content.paragraphs.push(text);
				}
			});

			// Extract lists (both ul and ol)
			article.find("ul, ol").each((_, el) => {
				const listItems = [];
				$(el)
					.find("li")
					.each((_, li) => {
						const itemText = $(li).text().trim();
						if (itemText) {
							listItems.push(itemText);
						}
					});
				if (listItems.length > 0) {
					content.lists.push({
						type: el.tagName.toLowerCase(),
						items: listItems,
					});
				}
			});

			// Extract images
			article.find("img").each((_, el) => {
				const imgSrc = $(el).attr("src");
				const imgAlt = $(el).attr("alt") || "";
				if (imgSrc) {
					content.images.push({
						src: imgSrc.startsWith("http")
							? imgSrc
							: `https://grokipedia.com${imgSrc}`,
						alt: imgAlt,
					});
				}
			});

			// Extract links
			article.find("a[href]").each((_, el) => {
				const href = $(el).attr("href");
				const linkText = $(el).text().trim();
				if (href && linkText) {
					content.links.push({
						text: linkText,
						href: href.startsWith("http")
							? href
							: `https://grokipedia.com${href}`,
					});
				}
			});

			// Get raw HTML of article (trimmed)
			const articleHtml = article.html();

			// Also extract markdown format using existing utility
			let markdown = "";
			try {
				const dom = new JSDOM(articleHtml);
				const articleDoc = dom.window.document;
				const { markdown: articleMarkdown } =
					extractSemanticContentWithFormattedMarkdown(articleDoc.body);
				markdown = articleMarkdown || "";
			} catch (mdError) {
				console.warn("Failed to generate markdown:", mdError);
			}

			structuredContent = {
				html: articleHtml,
				markdown: markdown,
				structure: content,
			};
		}

		// Extract references section (outside article tag) - fetch all child links from element with id="references"
		const referencesSection = $("#references");
		const references = [];
		if (referencesSection.length > 0) {
			referencesSection.find("a[href]").each((_, el) => {
				const href = $(el).attr("href");
				const linkText = $(el).text().trim();
				if (href) {
					references.push({
						text: linkText || $(el).attr("title") || href,
						href: href.startsWith("http")
							? href
							: `https://grokipedia.com${href}`,
					});
				}
			});
		}

		const data = {
			url,
			title,
			description,
			content: structuredContent || {
				html: "",
				markdown: "",
				structure: {
					headings: [],
					paragraphs: [],
					lists: [],
					images: [],
					links: [],
				},
			},
			references: references,
		};

		return c.json(data);
	} catch (error) {
		console.error(error.message);
		return c.json({ error: "Failed to scrape Grokipedia data" }, 500);
	}
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.post("/generate-launch-kit", async (c) => {
	const { url, tone = "bold" } = await c.req.json();

	/* ---------------------------------- */
	/* 1️⃣ Crawl Website via Firecrawl   */
	/* ---------------------------------- */
	async function crawlWebsite(targetUrl) {
		const res = await fetch("https://api.inkgest.com/scrape", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				url: targetUrl,
			}),
		});

		const data = await res.json();

		return {
			title: data.metadata?.title || "",
			description: data.metadata?.description || "",
			content: data.markdown || "",
		};
	}

	/* ---------------------------------- */
	/* 2️⃣ Structure SaaS Data            */
	/* ---------------------------------- */
	async function extractStructuredData(siteData) {
		const prompt = `Extract SaaS structured data from this website content.

Return JSON only:
{
  "product_name": "",
  "target_audience": "",
  "core_problem": "",
  "solution_summary": "",
  "features": [],
  "benefits": [],
  "pricing_model": ""
}

Website Content:
${siteData.content.slice(0, 12000)}`;

		return openRouterChat({
			prompt,
			temperature: 0.4,
			label: "extractStructuredData",
		});
	}

	/* ---------------------------------- */
	/* 3️⃣ Generate LinkedIn Pack         */
	/* ---------------------------------- */
	async function generateLinkedInPack(structured) {
		const prompt = `You are a SaaS founder writing on LinkedIn.
Tone: ${tone}
Generate 8 LinkedIn posts for launch.

Each post:
- Strong hook
- Short lines
- Clear CTA

Return JSON:
{
  "posts": [
    { "type": "launch", "content": "" }
  ]
}

Product Info:
${JSON.stringify(structured)}`;

		return openRouterChat({
			prompt,
			temperature: 0.7,
			label: "generateLinkedInPack",
		});
	}

	/* ---------------------------------- */
	/* 4️⃣ Generate Product Hunt Kit      */
	/* ---------------------------------- */
	async function generateProductHuntKit(structured) {
		const prompt = `Generate Product Hunt launch content.

Return JSON:
{
  "tagline": "",
  "short_description": "",
  "full_description": "",
  "first_comment": "",
  "features": [],
  "faqs": []
}

Product Info:
${JSON.stringify(structured)}`;

		return openRouterChat({
			prompt,
			temperature: 0.6,
			label: "generateProductHuntKit",
		});
	}

	/* ---------------------------------- */
	/* 5️⃣ Generate Email Sequence        */
	/* ---------------------------------- */
	async function generateEmailSequence(structured) {
		const prompt = `Create 5 onboarding emails for this SaaS.

Return JSON:
{
  "emails": [
    { "subject": "", "body": "" }
  ]
}

Product Info:
${JSON.stringify(structured)}`;

		return openRouterChat({
			prompt,
			temperature: 0.7,
			label: "generateEmailSequence",
		});
	}

	try {
		const siteData = await crawlWebsite(url);
		const structured = await extractStructuredData(siteData);
		const linkedin = await generateLinkedInPack(structured);
		const productHunt = await generateProductHuntKit(structured);
		const emails = await generateEmailSequence(structured);

		return c.json({
			success: true,
			structured,
			linkedin,
			productHunt,
			emails,
		});
	} catch (err) {
		console.error(err);
		return c.json({ success: false, error: "Generation failed" }, 500);
	}
});

const port = 3002;
console.log(`Server is running on port ${port}`);

// Start the server
serve({
	fetch: app.fetch,
	port,
});

const isDevelopment = process.env.NODE_ENV === "development";
const origin = isDevelopment
	? "http://localhost:3001"
	: "https://ihatereading-ai.vercel.app";
