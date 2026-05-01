import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { firestore, storage } from "./config/firebase.js";
import { FieldValue } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import chromium from "@sparticuz/chromium";
import { performance } from "perf_hooks";
import { cpus } from "os";
import UserAgent from "user-agents";
import { v4 as uuidv4 } from "uuid";
import { JSDOM } from "jsdom";
import { load } from "cheerio";
import { extractSemanticContentWithFormattedMarkdown } from "./lib/extractSemanticContent.js";
import {
	runKeywordAnalysis,
	runCompetitorAudit,
	runG2CompetitorDeepResearch,
} from "./lib/seoApis.js";
import {
	getVideoTranslateLanguagesResponse,
	getVideoTranslateCaptionResponse,
	subscribeVideoTranslateCaptionUpdates,
	VIDEO_TRANSLATE_CAPTION_SSE_MAX_MS,
	createVideoTranslateJobs,
	getVideoTranslateJobStatus,
} from "./lib/videoTranslateOpenRouter.js";
import {
	runVoiceTranslateText,
	guessAudioFormatFromFilename,
	uploadVoiceTranslateTtsToUploadThing,
} from "./lib/voiceTranslateText.js";
import {
	runGroqVoiceTranslateText,
	uploadGroqVoiceTranslateTtsToUploadThing,
} from "./lib/groqVoiceTranslateText.js";
import {
	createGroqVideoTranslateJobs,
	getGroqVideoTranslateJobStatus,
} from "./lib/groqVideoTranslate.js";
import {
	parseRepoUrl,
	analyzeRepo,
	analyzeSingleFile,
	fetchRepoTree,
} from "./lib/repoAst.js";
import {
	extractUrlsFromText,
	collectHttpUrlsFromTasks,
	scrapeUrlsViaApi,
	scrapeYoutubeViaApi,
	scrapeRedditViaApi,
	isYoutubeUrl,
	isRedditUrl,
	ROUTER_SYSTEM_PROMPT,
	parseAgentResponse,
	fastRouter,
	SKILLS,
	TASK_TYPES,
	CREDITS,
	MAX_SOURCE_CHARS_TOTAL_THRESHOLD,
	MAX_SUMMARY_INPUT_CHARS,
	MAX_SUMMARY_OUTPUT_CHARS,
} from "./lib/inkgestAgent.js";
import { browserAgentRouter } from "./lib/inkgestBrowserAgent.js";
import { logger } from "hono/logger";
import UserAgents from "user-agents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { GoogleGenAI } from "@google/genai";
import browserPool from "./browser-pool.js";
import fs from "fs";
import fsp from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";
import { UTApi, UTFile } from "uploadthing/server";
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
import { openRouterTranslateAuthMiddleware } from "./lib/translateFirebaseAuth.js";

// Load .env from project root (same dir as this file) so it works regardless of cwd or platform
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

/** Firestore collection for scraped URL cache (replaces Supabase `universo` for this path). */
const UNIVERSO_CACHE_COLLECTION = "universo";

function universoCacheDocId(url) {
	return createHash("sha256").update(String(url)).digest("hex");
}

const utapi = new UTApi({ token: process.env.UPLOADTHING_TOKEN });

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

/** Max chars per message when echoing `aiPrompt` on API responses (avoid huge JSON). */
const OPENROUTER_PROMPT_SNIPPET_MAX = Math.min(
	32000,
	Math.max(
		4000,
		Number.parseInt(process.env.OPENROUTER_PROMPT_SNIPPET_MAX || "12000", 10) ||
			12000,
	),
);

const OPENROUTER_TIMEOUT_MS = 90_000;

function normalizeOpenRouterUsageFromApi(data) {
	const u = data?.usage;
	return {
		prompt_tokens: u?.prompt_tokens ?? 0,
		completion_tokens: u?.completion_tokens ?? 0,
		total_tokens: u?.total_tokens ?? 0,
	};
}

function toTokenUsageCamel(usage) {
	if (!usage) return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	return {
		promptTokens: usage.prompt_tokens ?? 0,
		completionTokens: usage.completion_tokens ?? 0,
		totalTokens: usage.total_tokens ?? 0,
	};
}

/** Truncate chat messages for JSON responses (same shape as OpenRouter `messages`). */
function truncateMessagesForApiResponse(
	messages,
	maxPerPart = OPENROUTER_PROMPT_SNIPPET_MAX,
) {
	if (!Array.isArray(messages)) return [];
	return messages.map((m) => {
		const raw =
			typeof m.content === "string"
				? m.content
				: JSON.stringify(m.content ?? "");
		const truncated = raw.length > maxPerPart;
		return {
			role: m.role,
			content: truncated ? `${raw.slice(0, maxPerPart)}…` : raw,
			...(truncated && { truncated: true }),
		};
	});
}

function mergeOpenRouterUsageSnake(a, b) {
	const x = a || {
		prompt_tokens: 0,
		completion_tokens: 0,
		total_tokens: 0,
	};
	const y = b || {
		prompt_tokens: 0,
		completion_tokens: 0,
		total_tokens: 0,
	};
	return {
		prompt_tokens: x.prompt_tokens + y.prompt_tokens,
		completion_tokens: x.completion_tokens + y.completion_tokens,
		total_tokens: x.total_tokens + y.total_tokens,
	};
}

function openRouterResolvedModel(options = {}) {
	return (
		options.model ||
		process.env.OPENROUTER_AGENT_MODEL ||
		process.env.OPENROUTER_MODEL ||
		"openai/gpt-4o-mini"
	);
}

function buildOpenRouterAiMeta({ model, messages, usage }) {
	const u = normalizeOpenRouterUsageFromApi({ usage });
	return {
		model,
		usage: u,
		tokenUsage: toTokenUsageCamel(u),
		aiPrompt: truncateMessagesForApiResponse(messages),
	};
}

/** Aggregate snake_case usage for API responses (usage + camelCase tokenUsage). */
function usageFieldsFromSnake(usage) {
	const u = normalizeOpenRouterUsageFromApi({ usage });
	return {
		usage: u,
		tokenUsage: toTokenUsageCamel(u),
	};
}

/** Last SSE chunk before [DONE] for OpenRouter streaming — echoes prompt + usage. */
function buildOpenRouterStreamClientMeta(messages, usageRaw, modelId) {
	const u = usageRaw
		? normalizeOpenRouterUsageFromApi({ usage: usageRaw })
		: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
	return {
		type: "openrouter_meta",
		usage: u,
		tokenUsage: toTokenUsageCamel(u),
		model: modelId || openRouterResolvedModel({}),
		aiPrompt: truncateMessagesForApiResponse(messages),
	};
}

/** Append to inkgest-agent state for observability. */
function pushOpenRouterCall(state, label, meta) {
	if (!state || typeof state !== "object") return;
	if (!Array.isArray(state.openRouterCalls)) state.openRouterCalls = [];
	state.openRouterCalls.push({ label, ...meta, at: new Date().toISOString() });
}

// Wrapper around OpenRouter chat completions with error checking
async function openRouterChat({
	model = "openai/gpt-4o-mini",
	prompt,
	temperature = 0.7,
	label = "AI",
}) {
	const messages = [
		{
			role: "system",
			content:
				"You are a JSON-only API. You MUST respond with valid JSON and nothing else. Never ask clarifying questions. Never add explanations. If information seems missing, use reasonable placeholder values.",
		},
		{ role: "user", content: prompt },
	];
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
		},
		body: JSON.stringify({
			model,
			messages,
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

	const usage = normalizeOpenRouterUsageFromApi(data);
	return {
		result: parseAIJson(content),
		...buildOpenRouterAiMeta({ model, messages, usage }),
		label,
	};
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
		let browser;
		try {
			const puppeteer = (await import("puppeteer-core")).default;
			const proxyArg = `--proxy-server=http://${proxy.host}:${proxy.port}`;
			const SYSTEM_CHROME_ARGS = [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
				proxyArg,
			];
			try {
				const executablePath = await chromium.executablePath();
				browser = await puppeteer.launch({
					headless: true,
					executablePath,
					args: [...chromium.args, ...SYSTEM_CHROME_ARGS],
					ignoreDefaultArgs: ["--disable-extensions"],
				});
			} catch {
				browser = await puppeteer.launch({
					headless: true,
					executablePath:
						"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					args: SYSTEM_CHROME_ARGS,
				});
			}

			const page = await browser.newPage();
			await page.setUserAgent(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			);
			if (proxy.username && proxy.password) {
				await page.authenticate({
					username: proxy.username,
					password: proxy.password,
				});
			}
			await page.goto("https://httpbin.org/ip", { timeout: 10000 });
			const content = await page.$eval("body", (el) => el.textContent);

			await page.close();
			await browser.close();

			if (content.includes("origin")) {
				this.markProxySuccess(proxy.host);
				return true;
			} else {
				this.markProxyFailed(proxy.host);
				return false;
			}
		} catch (error) {
			if (browser) await browser.close().catch(() => {});
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
			"https://aantraa.vercel.app",
			"https://aantraa.site",
			"https://gettemplate.website/",
			"https://swipe-emails.vercel.app",
		], // Allow specific origins
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		// Do not set allowHeaders to a fixed list: browsers send Access-Control-Request-Headers
		// (e.g. authorization, sentry-trace, baggage). Hono mirrors those when allowHeaders is empty.
		exposeHeaders: [
			"X-Video-Translate-Id",
			"X-Caption-Url",
			"X-Audio-Input-Url",
			"X-Content-Type-Options",
			"Cache-Control",
		],
		credentials: true,
		maxAge: 86_400,
	}),
);

/** OpenRouter-only video/voice translate: Firebase ID token + Firestore credits (see lib/translateFirebaseAuth.js). Set TRANSLATE_FIREBASE_AUTH_ENABLED=1 to enable. Remove this line to disable the plugin. */
app.use("*", openRouterTranslateAuthMiddleware);

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

// ─── Google Maps helpers ──────────────────────────────────────────────────────

async function callOpenRouter(
	messages,
	{
		model = "google/gemini-2.0-flash-001",
		jsonMode = false,
		maxTokens = null,
	} = {},
) {
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
		headers: {
			Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://ihatereading.in",
			"X-Title": "IHateReading Maps Agent",
		},
		body: JSON.stringify({
			model,
			messages,
			...(jsonMode ? { response_format: { type: "json_object" } } : {}),
			...(maxTokens != null ? { max_tokens: maxTokens } : {}),
		}),
	});
	const data = await res.json();
	// Surface API-level errors immediately instead of silently returning empty text
	if (!res.ok || data.error) {
		const msg = data.error?.message || data.error || `HTTP ${res.status}`;
		throw new Error(`OpenRouter error: ${msg}`);
	}
	const text = data.choices?.[0]?.message?.content ?? "";
	if (!text) {
		const reason = data.choices?.[0]?.finish_reason || "unknown";
		throw new Error(
			`OpenRouter returned empty content (finish_reason: ${reason})`,
		);
	}
	const usageSnake = normalizeOpenRouterUsageFromApi(data);
	return {
		text,
		usage: usageSnake,
		tokenUsage: toTokenUsageCamel(usageSnake),
		model,
		aiPrompt: truncateMessagesForApiResponse(messages),
	};
}

function parseJsonFromLLM(text) {
	let s = text.trim();
	const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
	if (fence) s = fence[1].trim();
	const first = s.indexOf("{");
	const last = s.lastIndexOf("}");
	if (first !== -1 && last > first) s = s.slice(first, last + 1);
	return JSON.parse(s);
}

/**
 * Scrapes a single Google Maps query using an existing puppeteer browser instance.
 * Returns an array of enriched place objects.
 */
async function runMapsQuery(browser, query) {
	const page = await browser.newPage();
	try {
		await page.setUserAgent(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		);
		await page.setRequestInterception(true);
		page.on("request", (req) => {
			if (["image", "font", "stylesheet", "media"].includes(req.resourceType()))
				req.abort();
			else req.continue();
		});

		await page.goto(
			`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`,
			{ waitUntil: "networkidle0", timeout: 30000 },
		);
		await new Promise((r) => setTimeout(r, 5000));

		await page.evaluate(async () => {
			const feed = document.querySelector('div[role="feed"]');
			if (!feed) return;
			for (let i = 0; i < 5; i++) {
				feed.scrollBy(0, 1000);
				await new Promise((r) => setTimeout(r, 1000));
			}
		});

		// Pass 1: names + URLs + coordinates (from URL params)
		const feedEntries = await page.evaluate(() => {
			const feed = document.querySelector('div[role="feed"]');
			if (!feed) return [];
			return Array.from(feed.querySelectorAll('a[href*="/maps/place/"]'))
				.slice(0, 10)
				.map((card) => {
					const url = card.href || "";
					const latMatch = url.match(/[!,]3d(-?[\d.]+)/);
					const lngMatch = url.match(/[!,]4d(-?[\d.]+)/);
					return {
						name: card.getAttribute("aria-label")?.trim() || "",
						url,
						coordinates:
							latMatch && lngMatch
								? { lat: parseFloat(latMatch[1]), lng: parseFloat(lngMatch[1]) }
								: null,
					};
				})
				.filter((item) => item.name.length > 0);
		});

		// Pass 2: visit each place page for rating, reviews, address, phone, website
		const places = await Promise.all(
			feedEntries.map(async (entry) => {
				const detailPage = await browser.newPage();
				try {
					await detailPage.setRequestInterception(true);
					detailPage.on("request", (req) => {
						if (
							["image", "font", "stylesheet", "media"].includes(
								req.resourceType(),
							)
						)
							req.abort();
						else req.continue();
					});
					await detailPage.goto(entry.url, {
						waitUntil: "domcontentloaded",
						timeout: 15000,
					});
					await new Promise((r) => setTimeout(r, 2000));

					const details = await detailPage.evaluate(() => {
						let rating = null;
						for (const el of document.querySelectorAll("[aria-label]")) {
							const al = el.getAttribute("aria-label");
							const m =
								al.match(/([1-5]\.[0-9])\s*stars?/i) ||
								al.match(/rated\s+([1-5]\.[0-9])/i);
							if (m) {
								rating = parseFloat(m[1]);
								break;
							}
						}
						let reviews = null;
						for (const el of document.querySelectorAll("[aria-label]")) {
							const al = el.getAttribute("aria-label");
							const m = al.match(/([\d,]+)\s*reviews?/i);
							if (m) {
								reviews = m[1].replace(/,/g, "");
								break;
							}
						}
						const addrEl =
							document.querySelector('button[data-item-id="address"]') ||
							document.querySelector('[data-tooltip="Copy address"]');
						const address =
							addrEl
								?.getAttribute("aria-label")
								?.replace(/^Address:\s*/i, "")
								?.trim() || "";
						const phoneEl =
							document.querySelector('[data-item-id^="phone"]') ||
							document.querySelector('[data-tooltip="Copy phone number"]');
						const phone =
							phoneEl
								?.getAttribute("aria-label")
								?.replace(/^Phone:\s*/i, "")
								?.trim() ||
							phoneEl?.textContent?.trim() ||
							"";
						const websiteEl = document.querySelector(
							'a[data-item-id="authority"]',
						);
						const rawWebsite = websiteEl?.href || "";
						let website = rawWebsite;
						try {
							const u = new URL(rawWebsite);
							const q = u.searchParams.get("q");
							if (q) website = q;
						} catch {
							/* keep rawWebsite */
						}
						const category =
							document
								.querySelector('button[jsaction*="category"]')
								?.textContent?.trim() || "";
						const image =
							document
								.querySelector('meta[property="og:image"]')
								?.getAttribute("content") || "";
						return {
							rating,
							reviews,
							address,
							phone,
							website,
							category,
							image,
						};
					});

					return { ...entry, ...details };
				} catch {
					return {
						...entry,
						rating: null,
						reviews: null,
						address: "",
						phone: "",
						website: "",
						category: "",
						image: "",
					};
				} finally {
					await detailPage.close().catch(() => {});
				}
			}),
		);

		return places;
	} finally {
		await page.close().catch(() => {});
	}
}


// Google Maps scraping endpoint using headless Chrome
app.post("/scrape-google-maps", async (c) => {
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
			const puppeteer = (await import("puppeteer-core")).default;
			const ARGS = [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-accelerated-2d-canvas",
				"--no-first-run",
				"--no-zygote",
				"--single-process",
				"--disable-gpu",
			];
			try {
				const executablePath = await chromium.executablePath();
				browser = await puppeteer.launch({
					headless: true,
					executablePath,
					args: [...chromium.args, ...ARGS],
					ignoreDefaultArgs: ["--disable-extensions"],
				});
			} catch {
				browser = await puppeteer.launch({
					headless: true,
					executablePath:
						"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					args: ARGS,
				});
			}

			const results = await Promise.all(
				queryArray.map(async (query) => {
					try {
						const places = await runMapsQuery(browser, query);
						return { query, results: places };
					} catch (error) {
						console.error(`Error processing query "${query}":`, error);
						return { query, results: [], error: error.message };
					}
				}),
			);

			if (!Array.isArray(queries)) {
				const result = results[0];
				if (!result.results || result.results.length === 0) {
					return c.json(
						{
							success: false,
							error: "No results found for the given query",
							data: result,
						},
						404,
					);
				}
				return c.json({ success: true, data: result });
			}

			return c.json({
				success: true,
				data: {
					totalQueries: queryArray.length,
					results,
					generatedAt: new Date().toISOString(),
				},
			});
		} finally {
			if (browser) await browser.close();
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

// ─── Google Maps scraping via Lightpanda (Zig-based headless browser) ─────────
// Faster and lighter than Chromium — uses CDP WebSocket, same Puppeteer page API
app.post("/scrape-google-maps-lightpanda", async (c) => {
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

		const queryArray = Array.isArray(queries)
			? queries
			: [queries || singleQuery];

		if (!queryArray.length || queryArray.some((q) => !q)) {
			return c.json(
				{ success: false, error: "At least one valid query is needed" },
				400,
			);
		}

		let lp = null;
		try {
			lp = await startLightpanda(9222);

			// Lightpanda: single context — run queries sequentially to avoid conflicts
			const results = [];
			for (const query of queryArray) {
				try {
					const places = await runMapsQueryLightpanda(lp.browser, query);
					results.push({ query, results: places });
				} catch (error) {
					console.error(`[Lightpanda] Query "${query}" failed:`, error.message);
					results.push({ query, results: [], error: error.message });
				}
			}

			if (!Array.isArray(queries)) {
				const result = results[0];
				if (!result.results || result.results.length === 0) {
					return c.json(
						{
							success: false,
							error: "No results found for the given query",
							data: result,
						},
						404,
					);
				}
				return c.json({ success: true, browser: "lightpanda", data: result });
			}

			return c.json({
				success: true,
				browser: "lightpanda",
				data: {
					totalQueries: queryArray.length,
					results,
					generatedAt: new Date().toISOString(),
				},
			});
		} finally {
			if (lp) stopLightpanda(lp);
		}
	} catch (error) {
		console.error("[Lightpanda] Google Maps Scraping Error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to scrape Google Maps via Lightpanda",
				details: error.message,
			},
			500,
		);
	}
});

// ─── Google Maps Agentic Search ───────────────────────────────────────────────
// 1. OpenRouter generates 2–5 targeted Maps search queries from the user prompt
// 2. All queries scraped in parallel (shared browser, deduped by URL)
// 3. OpenRouter synthesizes a final structured answer
app.post("/google-maps-agent", async (c) => {
	const { prompt } = await c.req.json();
	if (!prompt) {
		return c.json({ success: false, error: "prompt is required" }, 400);
	}

	// Track token usage across both LLM calls
	const tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	const addUsage = (u) => {
		if (!u) return;
		tokenUsage.promptTokens += u.promptTokens ?? 0;
		tokenUsage.completionTokens += u.completionTokens ?? 0;
		tokenUsage.totalTokens += u.totalTokens ?? 0;
	};
	const openRouterCalls = [];
	let aggUsageSnake = {
		prompt_tokens: 0,
		completion_tokens: 0,
		total_tokens: 0,
	};
	const recordOpenRouter = (r, step) => {
		if (!r) return;
		addUsage(r.tokenUsage);
		aggUsageSnake = mergeOpenRouterUsageSnake(aggUsageSnake, r.usage);
		openRouterCalls.push({
			step,
			model: r.model,
			usage: r.usage,
			tokenUsage: r.tokenUsage,
			aiPrompt: r.aiPrompt,
		});
	};

	// ── Step 1: Generate search queries ───────────────────────────────────────
	let queries = [];
	try {
		const rQuery = await callOpenRouter(
			[
				{
					role: "system",
					content: `You are a Google Maps search query expert. Given a user prompt, generate 2 to 5 specific, targeted Google Maps search queries that together will find the best results. Each query should be short and direct (like a user would type into Google Maps). Return ONLY a JSON object: { "queries": ["query1", "query2", ...] }`,
				},
				{ role: "user", content: prompt },
			],
			{ jsonMode: true },
		);
		recordOpenRouter(rQuery, "query_generation");
		const parsed = parseJsonFromLLM(rQuery.text);
		queries = Array.isArray(parsed.queries)
			? parsed.queries.slice(0, 5).filter(Boolean)
			: [];
	} catch (err) {
		console.error("Maps agent — query generation failed:", err.message);
	}
	if (queries.length === 0) queries = [prompt];

	// ── Step 2: Scrape all queries in parallel (one shared browser) ───────────
	let browser;
	let allPlaces = [];
	try {
		const puppeteer = (await import("puppeteer-core")).default;
		const ARGS = [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-accelerated-2d-canvas",
			"--no-first-run",
			"--no-zygote",
			"--single-process",
			"--disable-gpu",
		];
		try {
			const executablePath = await chromium.executablePath();
			browser = await puppeteer.launch({
				headless: true,
				executablePath,
				args: [...chromium.args, ...ARGS],
				ignoreDefaultArgs: ["--disable-extensions"],
			});
		} catch {
			browser = await puppeteer.launch({
				headless: true,
				executablePath:
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				args: ARGS,
			});
		}

		const queryResults = await Promise.all(
			queries.map(async (query) => {
				try {
					const places = await runMapsQuery(browser, query);
					return places.map((p) => ({ ...p, sourceQuery: query }));
				} catch (err) {
					console.error(`Maps agent — query "${query}" failed:`, err.message);
					return [];
				}
			}),
		);
		allPlaces = queryResults.flat();
	} finally {
		if (browser) await browser.close().catch(() => {});
	}

	// ── Step 3: Deduplicate by Maps URL ───────────────────────────────────────
	const seen = new Set();
	const uniquePlaces = allPlaces.filter((p) => {
		if (!p.url || seen.has(p.url)) return false;
		seen.add(p.url);
		return true;
	});

	if (uniquePlaces.length === 0) {
		return c.json(
			{ success: false, error: "No results found", queriesUsed: queries },
			404,
		);
	}

	// ── Step 4: Synthesize final answer with OpenRouter ───────────────────────
	const placesContext = uniquePlaces
		.map((p, i) =>
			[
				`### ${i + 1}. ${p.name}`,
				`- Rating: ${p.rating != null ? `${p.rating} ⭐` : "N/A"}`,
				`- Reviews: ${p.reviews ?? "N/A"}`,
				`- Category: ${p.category || "N/A"}`,
				`- Address: ${p.address || "N/A"}`,
				`- Phone: ${p.phone || "N/A"}`,
				`- Website: ${p.website || "N/A"}`,
				`- Coordinates: ${p.coordinates ? `${p.coordinates.lat}, ${p.coordinates.lng}` : "N/A"}`,
				`- Found via: "${p.sourceQuery}"`,
				`- Maps URL: ${p.url}`,
			].join("\n"),
		)
		.join("\n\n");

	// All URLs visited: Maps search pages + individual place detail pages
	const mapsSearchUrls = queries.map(
		(q) => `https://www.google.com/maps/search/${encodeURIComponent(q)}?hl=en`,
	);
	const placeDetailUrls = uniquePlaces.map((p) => p.url).filter(Boolean);
	const scrapedUrls = [...mapsSearchUrls, ...placeDetailUrls];

	let parsed;
	try {
		const rSynth = await callOpenRouter(
			[
				{
					role: "system",
					content: `You are a helpful local search assistant. The user asked: "${prompt}". You searched Google Maps with ${queries.length} targeted queries and found ${uniquePlaces.length} unique places. Analyze ALL the results and return ONLY a valid JSON object (no markdown fences, no explanation):
{
  "answer": "A clear, direct answer to the user's prompt in 2-4 sentences",
  "topPicks": [
    {
      "name": "",
      "rating": null,
      "reviews": null,
      "category": "",
      "address": "",
      "phone": "",
      "website": "",
      "coordinates": { "lat": null, "lng": null },
      "mapsUrl": "",
      "whyRecommended": "1-2 sentence reason"
    }
  ],
  "insights": "Patterns, tips or observations about these results (e.g. price range, best time to visit, area clusters)",
  "queriesUsed": [],
  "totalFound": 0
}`,
				},
				{
					role: "user",
					content: `User prompt: "${prompt}"\n\nSearch queries used: ${JSON.stringify(queries)}\n\nAll places found:\n\n${placesContext}`,
				},
			],
			{ jsonMode: true },
		);
		recordOpenRouter(rSynth, "synthesis");
		parsed = parseJsonFromLLM(rSynth.text);
	} catch {
		parsed = {
			answer: `Found ${uniquePlaces.length} results across ${queries.length} searches.`,
			topPicks: uniquePlaces.slice(0, 5).map((p) => ({
				name: p.name,
				rating: p.rating,
				reviews: p.reviews,
				category: p.category,
				address: p.address,
				phone: p.phone,
				website: p.website,
				coordinates: p.coordinates,
				mapsUrl: p.url,
				whyRecommended: "",
			})),
			insights: null,
			queriesUsed: queries,
			totalFound: uniquePlaces.length,
		};
	}

	return c.json({
		success: true,
		prompt,
		...parsed,
		queriesUsed: queries,
		allPlaces: uniquePlaces,
		scrapedUrls,
		scrapedUrlsCount: scrapedUrls.length,
		tokenUsage,
		usage: aggUsageSnake,
		openRouterCalls,
		timestamp: new Date().toISOString(),
	});
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
		const parsed = parseDuckDuckGoSerpHtml(html, 100);
		results.push(...parsed);

		return c.json({ query, results, timestamp: new Date().toISOString() });
	} catch (err) {
		console.error("DuckDuckGo scraper error:", err.message);
		return c.json({ error: err.message }, 500);
	} finally {
		if (browser) await browser.close();
	}
});

function cleanGoogleUrl(url) {
	if (!url || typeof url !== "string") return "";
	try {
		let s = url.trim();
		if (s.startsWith("/url?")) {
			s = "https://www.google.com" + s;
		}
		const parsedUrl = new URL(s);
		const q = parsedUrl.searchParams.get("q");
		if (q) return decodeURIComponent(q);
		const u = parsedUrl.searchParams.get("url");
		if (u) return decodeURIComponent(u);
		return s;
	} catch {
		return typeof url === "string" ? url : "";
	}
}

function parseGoogleResults(html) {
	const results = [];
	const $ = load(html);
	const seen = new Set();

	function pushResult(title, href, description) {
		const t = (title || "").trim();
		if (!t) return;
		const rawHref = href || "";
		let link = cleanGoogleUrl(rawHref);
		if (!link.startsWith("http")) return;
		if (
			link.includes("google.com/preferences") ||
			link.startsWith("https://support.google.com") ||
			link.startsWith("https://policies.google.com")
		) {
			return;
		}
		if (seen.has(link)) return;
		seen.add(link);
		results.push({
			title: t,
			link,
			description: (description || "").trim(),
		});
	}

	// Current desktop SERPs: one organic result per div.g (or nested)
	$("div.g").each((_, el) => {
		const block = $(el);
		const h3 = block.find("h3").first();
		if (!h3.length) return;
		const title = h3.text().trim();
		let a = h3.parent("a");
		if (!a.length) a = h3.closest("a");
		if (!a.length) {
			a = block
				.find("a[href]")
				.filter((i, e) => {
					const h = ($(e).attr("href") || "").trim();
					return (
						h.startsWith("http") || h.startsWith("/url?") || h.startsWith("//")
					);
				})
				.first();
		}
		let href = (a.attr("href") || "").trim();
		if (href.startsWith("//")) href = "https:" + href;
		let description = block
			.find(
				"div.VwiC3b, div[style*='webkit-line-clamp'], div[data-sncf], span.aCOpRe",
			)
			.first()
			.text()
			.trim();
		if (!description) {
			description = block
				.find("div")
				.not(block.find("div div"))
				.last()
				.text()
				.trim();
		}
		pushResult(title, href, description);
	});

	// Fallback: older #rso layout (single column of blocks)
	if (results.length === 0) {
		$("div#rso > div").each((_, el) => {
			const block = $(el);
			const h3 = block.find("h3").first();
			if (!h3.length) return;
			const title = h3.text().trim();
			const a = block.find("a[href]").first();
			const href = (a.attr("href") || "").trim();
			const description = block
				.find("div")
				.filter((i, e) => {
					const t = $(e).text();
					return t.length > 20 && !$(e).find("h3").length;
				})
				.first()
				.text()
				.trim();
			pushResult(title, href, description);
		});
	}

	return results;
}

function buildGoogleSearchUrl({ query, language, country, num, gbv = false }) {
	const params = new URLSearchParams({
		q: query,
		hl: language,
		gl: country,
		num: String(num),
		pws: "0",
	});
	if (gbv) params.set("gbv", "1");
	return `https://www.google.com/search?${params.toString()}`;
}

/** Dismiss EU / privacy interstitials so SERP can render (same issue as "empty" + About this page). */
async function dismissGoogleConsent(page) {
	const pause = (ms) => new Promise((r) => setTimeout(r, ms));
	const selectors = [
		"#L2AGLb",
		"button#L2AGLb",
		'button[aria-label="Accept all"]',
		'[aria-label="Accept all"]',
		"[data-testid='uc-accept-all-button']",
	];
	for (const sel of selectors) {
		try {
			const el = await page.$(sel);
			if (el) {
				await el.click();
				await pause(900);
				return;
			}
		} catch {
			/* try next */
		}
	}
	try {
		const clicked = await page.evaluate(() => {
			const byId = document.getElementById("L2AGLb");
			if (byId && byId.offsetParent !== null) {
				byId.click();
				return true;
			}
			const t = document.querySelector("[data-testid='uc-accept-all-button']");
			if (t) {
				t.click();
				return true;
			}
			return false;
		});
		if (clicked) await pause(900);
	} catch {
		/* ignore */
	}
}

function detectGoogleSerpBlocked(html) {
	const h = (html || "").toLowerCase();
	if (h.includes("unusual traffic from your computer network"))
		return "captcha";
	if (
		h.includes("before you continue") ||
		(h.includes("about this page") && h.includes("terms of service"))
	) {
		return "consent_or_interstitial";
	}
	return null;
}

function extractDuckDuckGoRedirectUrl(href) {
	if (!href || typeof href !== "string") return null;
	try {
		const u = href.startsWith("//") ? `https:${href}` : href;
		if (u.startsWith("http")) {
			const p = new URL(u);
			const uddg = p.searchParams.get("uddg");
			if (uddg) return decodeURIComponent(uddg);
		}
	} catch {
		/* fall through */
	}
	const m = href.match(/uddg=([^&]+)/);
	if (m) {
		try {
			return decodeURIComponent(m[1]);
		} catch {
			return m[1];
		}
	}
	return null;
}

/** Parse DuckDuckGo HTML SERP (shared with /ddg-search). */
function parseDuckDuckGoSerpHtml(html, maxResults = 50) {
	const results = [];
	const $ = load(html);
	$("div.result").each((_, el) => {
		if (results.length >= maxResults) return false;
		const linkTag = $(el).find(".result__a");
		const href = linkTag.attr("href") || "";
		const title = linkTag.text().trim();
		const description = $(el).find(".result__snippet").text().trim();
		const link = extractDuckDuckGoRedirectUrl(href);
		if (link && title) {
			results.push({ title, link, description });
		}
	});
	return results;
}

function webSearchResultsToMarkdown(results) {
	return results
		.map((r) => `## ${r.title}\n${r.description}\n\n${r.link}`)
		.join("\n\n---\n\n");
}

/**
 * When Google returns CAPTCHA / empty SERP, fetch DDG HTML without a browser.
 * (Cannot "fix" Google captcha in Puppeteer — use Custom Search API or this fallback.)
 */
async function fetchWebResultsViaDuckDuckGo(query, maxResults = 10) {
	const endpoints = [
		`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
		`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
	];
	const headers = {
		"User-Agent":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.9",
	};
	for (const searchUrl of endpoints) {
		try {
			const res = await fetch(searchUrl, { headers, redirect: "follow" });
			if (!res.ok) continue;
			const html = await res.text();
			const results = parseDuckDuckGoSerpHtml(html, maxResults);
			if (results.length > 0) {
				return {
					results,
					searchUrl,
					markdown: webSearchResultsToMarkdown(results),
				};
			}
		} catch {
			continue;
		}
	}
	return { results: [], searchUrl: null, markdown: "" };
}

/** Official Google Custom Search JSON API (same family as Maps/Places APIs). */
async function fetchGoogleCustomSearchApi({
	query,
	num = 10,
	language = "en",
	country = "us",
}) {
	const apiKey = process.env.GOOGLE_CSE_API_KEY || process.env.GOOGLE_API_KEY;
	const cx = process.env.GOOGLE_CSE_ID;
	if (!apiKey || !cx) {
		return null;
	}
	const capped = Math.min(Math.max(Number(num) || 10, 1), 10);
	const params = new URLSearchParams({
		key: apiKey,
		cx,
		q: query,
		num: String(capped),
		hl: language,
		gl: country,
	});
	const url = `https://www.googleapis.com/customsearch/v1?${params}`;
	const res = await fetch(url);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const msg =
			data?.error?.message ||
			`Custom Search API ${res.status}: ${JSON.stringify(data).slice(0, 200)}`;
		throw new Error(msg);
	}
	const items = Array.isArray(data.items) ? data.items : [];
	const results = items.map((it) => ({
		title: it.title || "",
		link: it.link || "",
		description: it.snippet || "",
	}));
	const markdown = results
		.map((r) => `## ${r.title}\n${r.description}\n\n${r.link}`)
		.join("\n\n---\n\n");
	return {
		results,
		markdown,
		searchUrl: url.replace(apiKey, "REDACTED"),
		source: "google-custom-search-api",
	};
}

app.post("/google-search", async (c) => {
	const {
		query,
		num = 10,
		language = "en",
		country = "us",
		timeout = 30000,
		/** When true, route Chrome through rotating proxies (Bright Data). Default false — direct connection, same idea as /scrape-google-maps. */
		useProxy = false,
		/** When true, skip Custom Search API and use headless browser only. */
		forceBrowser = false,
		/** When true, do not use DuckDuckGo HTML if Google shows CAPTCHA / empty SERP. */
		skipDdgFallback = false,
	} = await c.req.json();

	if (!query || typeof query !== "string") {
		return c.json({ error: "Query parameter is required" }, 400);
	}

	try {
		if (!forceBrowser) {
			const apiResult = await fetchGoogleCustomSearchApi({
				query,
				num,
				language,
				country,
			});
			if (apiResult) {
				return c.json({
					query,
					...apiResult,
				});
			}
		}

		const puppeteer = (await import("puppeteer-core")).default;
		const ARGS = [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-gpu",
			"--no-zygote",
			"--single-process",
		];
		let selectedProxy = null;
		if (useProxy) {
			selectedProxy = proxyManager.getNextProxy();
			ARGS.push(
				`--proxy-server=http://${selectedProxy.host}:${selectedProxy.port}`,
			);
		}

		let browser;
		try {
			try {
				const executablePath = await chromium.executablePath();
				browser = await puppeteer.launch({
					headless: true,
					executablePath,
					args: [...chromium.args, ...ARGS],
					ignoreDefaultArgs: ["--disable-extensions"],
				});
			} catch {
				browser = await puppeteer.launch({
					headless: true,
					executablePath:
						"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					args: ARGS,
				});
			}

			const page = await browser.newPage();
			await page.setViewport({
				width: 1366,
				height: 768,
				deviceScaleFactor: 1,
			});

			await page.setUserAgent(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
					"Chrome/131.0.0.0 Safari/537.36",
			);

			await page.setExtraHTTPHeaders({
				"Accept-Language": `${language}-${country.toUpperCase()},${language};q=0.9,en;q=0.8`,
			});

			if (useProxy && selectedProxy?.username && selectedProxy?.password) {
				await page.authenticate({
					username: selectedProxy.username,
					password: selectedProxy.password,
				});
			}

			let searchUrl = buildGoogleSearchUrl({
				query,
				language,
				country,
				num,
				gbv: false,
			});
			let usedGbvFallback = false;

			const loadSerp = async (url) => {
				await page.goto(url, {
					waitUntil: "domcontentloaded",
					timeout: timeout,
				});
				await dismissGoogleConsent(page);
				await page
					.waitForSelector("#rso, div.g, div.MjjYud", {
						timeout: Math.min(12000, timeout),
					})
					.catch(() => {});
				await new Promise((r) => setTimeout(r, 500));
				const html = await page.evaluate(
					() => document.documentElement.outerHTML,
				);
				return html;
			};

			let html = await loadSerp(searchUrl);
			let results = parseGoogleResults(html);

			if (results.length === 0) {
				searchUrl = buildGoogleSearchUrl({
					query,
					language,
					country,
					num,
					gbv: true,
				});
				usedGbvFallback = true;
				html = await loadSerp(searchUrl);
				results = parseGoogleResults(html);
			}

			const blockedReason = detectGoogleSerpBlocked(html);
			const googleSearchUrl = searchUrl;

			let finalResults = results;
			let finalMarkdown;
			let finalSearchUrl = searchUrl;
			let sourceTag = useProxy ? "puppeteer-proxy" : "puppeteer-direct";

			const dom = new JSDOM(html, {
				contentType: "text/html",
				includeNodeLocations: false,
				storageQuota: 10000000,
			});
			const document = dom.window.document;
			const { markdown: googleMarkdown } =
				await extractSemanticContentWithFormattedMarkdown(document.body);
			finalMarkdown = googleMarkdown;

			const needsDdgFallback =
				!skipDdgFallback &&
				(finalResults.length === 0 ||
					blockedReason === "captcha" ||
					blockedReason === "consent_or_interstitial");

			if (needsDdgFallback) {
				const ddg = await fetchWebResultsViaDuckDuckGo(query, num);
				if (ddg.results.length > 0) {
					finalResults = ddg.results;
					finalMarkdown = ddg.markdown;
					finalSearchUrl = ddg.searchUrl;
					sourceTag = "duckduckgo-html-fallback";
				}
			}

			return c.json({
				query,
				results: finalResults,
				searchUrl: finalSearchUrl,
				markdown: finalMarkdown,
				source: sourceTag,
				...(usedGbvFallback && { gbvFallback: true }),
				...(blockedReason && {
					googleBlockedReason: blockedReason,
					googleSearchUrl: googleSearchUrl,
				}),
				...(sourceTag === "duckduckgo-html-fallback" && {
					note: "Google showed a CAPTCHA or blocked automated access; results are from DuckDuckGo HTML search. For real Google results use GOOGLE_CSE_ID + GOOGLE_CSE_API_KEY (Custom Search API) or set useProxy: true with a working residential proxy.",
				}),
				...(finalResults.length === 0 && blockedReason && { blockedReason }),
			});
		} finally {
			if (browser) await browser.close();
		}
	} catch (error) {
		console.error("Google search error:", error);
		return c.json({ error: error.message }, 500);
	}
});

// ─── SEO: keyword analysis & competitor discovery (Google Suggest, Trends, DDG; optional OpenRouter) ──
app.post("/seo-keyword-analysis", async (c) => {
	try {
		const body = await c.req.json();
		const data = await runKeywordAnalysis(body);
		return c.json({ success: true, ...data });
	} catch (err) {
		console.error("seo-keyword-analysis:", err?.message || err);
		return c.json(
			{ success: false, error: err?.message || "Request failed" },
			400,
		);
	}
});

app.post("/seo-competitor-audit", async (c) => {
	try {
		const body = await c.req.json();
		const data = await runCompetitorAudit(body);
		return c.json({ success: true, ...data });
	} catch (err) {
		console.error("seo-competitor-audit:", err?.message || err);
		return c.json(
			{ success: false, error: err?.message || "Request failed" },
			400,
		);
	}
});


app.post("/seo-g2-competitor-deep-research", async (c) => {
	try {
		const body = await c.req.json();
		const deepScrape = body.deepScrape !== false;
		const useProxy = body.useProxy === true || body.useProxy === "true";

		const base = await runG2CompetitorDeepResearch({
			url: body.url,
			query: body.query,
			maxCompetitors: body.maxCompetitors,
			useAi: body.useAi !== false,
			geo: body.geo,
		});

		if (!deepScrape || !process.env.OPENROUTER_API_KEY) {
			return c.json({
				success: true,
				...base,
				deepScrape: deepScrape
					? {
							skipped: !process.env.OPENROUTER_API_KEY,
							reason: "OPENROUTER_API_KEY missing",
						}
					: { skipped: true, reason: "deepScrape disabled" },
			});
		}

		const urls = [];
		if (base.anchorProduct?.url) urls.push(base.anchorProduct.url);
		for (const comp of base.competitors || []) {
			if (comp.url) urls.push(comp.url);
		}
		const unique = [...new Set(urls)].slice(0, 15);

		const scrapeSamples = [];
		for (const u of unique) {
			try {
				const r = await scrapeSingleUrlWithPuppeteer(u, {
					includeSemanticContent: true,
					includeLinks: true,
					includeImages: false,
					extractMetadata: true,
					timeout: 55_000,
					useProxy,
				});
				const md = r.markdown || "";
				scrapeSamples.push({
					url: u,
					markdownChars: md.length,
					markdownSample: md.slice(0, 12_000),
					structuredFromLinks: g2ProductsFromScrapeData(r.data),
				});
			} catch (e) {
				scrapeSamples.push({
					url: u,
					error: e?.message || String(e),
				});
			}
		}

		let structuredProblems = null;
		let g2DeepOpenRouter = null;
		const hasText = scrapeSamples.some((s) => s.markdownSample);
		if (hasText) {
			try {
				const payload = JSON.stringify({
					productLabel: base.productLabel,
					anchorUrl: base.anchorProduct?.url,
					pages: scrapeSamples,
				}).slice(0, MAX_SUMMARY_INPUT_CHARS);
				const orG2Deep = await openRouterChatMessages(
					process.env.OPENROUTER_API_KEY,
					[
						{
							role: "system",
							content: `You analyze G2 product page excerpts (may be partial). Return ONLY valid JSON:
{"items":[{"url":"string","productName":"string or null","problems":["short cons from text"],"strengths":["short pros"],"notes":"optional"}]}
Rules: no invented star ratings or review counts; use null or empty arrays if unknown.`,
						},
						{ role: "user", content: payload },
					],
					Math.min(4096, INKGEST_SKILL_MAX_OUTPUT_TOKENS),
					{
						temperature: 0.2,
						response_format: { type: "json_object" },
					},
				);
				g2DeepOpenRouter = {
					usage: orG2Deep.usage,
					tokenUsage: orG2Deep.tokenUsage,
					model: orG2Deep.model,
					aiPrompt: orG2Deep.aiPrompt,
				};
				const { content } = orG2Deep;
				structuredProblems = JSON.parse(
					String(content || "")
						.replace(/```json|```/gi, "")
						.trim(),
				);
			} catch (e) {
				structuredProblems = {
					error: e?.message || "parse_failed",
				};
			}
		}

		return c.json({
			success: true,
			...base,
			...(g2DeepOpenRouter && {
				...usageFieldsFromSnake(g2DeepOpenRouter.usage),
				model: g2DeepOpenRouter.model,
				aiPrompt: g2DeepOpenRouter.aiPrompt,
				openRouterCalls: [
					{
						label: "g2_deep_structured",
						usage: g2DeepOpenRouter.usage,
						tokenUsage: g2DeepOpenRouter.tokenUsage,
						model: g2DeepOpenRouter.model,
						aiPrompt: g2DeepOpenRouter.aiPrompt,
						at: new Date().toISOString(),
					},
				],
			}),
			deepScrape: {
				scrapeSamples,
				structuredProblems,
			},
		});
	} catch (err) {
		console.error("seo-g2-competitor-deep-research:", err?.message || err);
		return c.json(
			{ success: false, error: err?.message || "Request failed" },
			400,
		);
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
 * G2 pages are React SPAs; networkidle can settle on the empty shell before
 * listings hydrate. Cookie banners also block innerText. Scroll + consent + wait for product links.
 */
async function runG2PostLoadActions(page) {
	const consentSelectors = [
		"#onetrust-accept-btn-handler",
		"button#onetrust-accept-btn-handler",
		"[aria-label='Accept All Cookies']",
		"button[aria-label*='Accept All']",
		"button[aria-label*='Accept']",
		".osano-cm-accept-all",
		"button[data-testid='cookie-accept']",
	];
	for (const sel of consentSelectors) {
		try {
			const el = await page.$(sel);
			if (el) {
				await el.click({ delay: 40 });
				await new Promise((r) => setTimeout(r, 700));
				break;
			}
		} catch {
			/* ignore */
		}
	}
	await page.evaluate(async () => {
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		await sleep(400);
		for (let i = 0; i < 5; i++) {
			window.scrollBy(0, Math.min(1000, window.innerHeight * 0.9));
			await sleep(450);
		}
		window.scrollTo(0, document.body.scrollHeight);
		await sleep(1200);
	});
}

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

	if (includeCache) {
		const snap = await firestore
			.collection(UNIVERSO_CACHE_COLLECTION)
			.doc(universoCacheDocId(targetUrl))
			.get();
		if (!snap.exists) {
			throw new Error("Cache miss or fetch error");
		}
		const existingData = snap.data();
		const raw = existingData?.scraped_data;
		if (raw == null) {
			throw new Error("Cache miss or fetch error");
		}
		let parsedData;
		if (typeof raw === "string") {
			parsedData = JSON.parse(raw);
		} else {
			parsedData = raw;
		}
		return {
			success: true,
			data: parsedData,
			markdown: existingData?.markdown ?? null,
			summary: null,
			screenshot: existingData?.screenshot ?? null,
		};
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
				const isG2Host =
					/\bg2\.com\b/i.test(targetUrl) || /\bg2crowd\.com\b/i.test(targetUrl);

				await page.setRequestInterception(true);
				page.on("request", (request) => {
					// G2 (and similar SPAs) need real CSS/JS/CDN — empty stylesheets leave UI
					// display:none / invisible, so markdown + innerText stay empty.
					if (isG2Host) {
						request.continue();
						return;
					}
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

				if (isG2Host) {
					const g2NavTimeout = Math.min(
						Math.max(Math.max(timeout, 55_000), 45_000),
						120_000,
					);
					await page.goto(targetUrl, {
						waitUntil: "load",
						timeout: g2NavTimeout,
					});
					await new Promise((r) => setTimeout(r, 1500));
					await runG2PostLoadActions(page);
					try {
						await page.waitForFunction(
							() => {
								function countG2ProductAnchors(node) {
									if (!node) return 0;
									let n = 0;
									if (node.nodeType === 1 && node.shadowRoot) {
										n += countG2ProductAnchors(node.shadowRoot);
									}
									if (node.nodeType === 1) {
										if (
											node.tagName === "A" &&
											node.href &&
											node.href.includes("/products/")
										) {
											n += 1;
										}
										for (const c of node.children) {
											n += countG2ProductAnchors(c);
										}
									} else if (node.nodeType === 11) {
										for (const c of node.children) {
											n += countG2ProductAnchors(c);
										}
									}
									return n;
								}
								const n = countG2ProductAnchors(document.body);
								const title = (document.title || "").trim();
								const titleOk = title.length > 8 && !/^g2\.com$/i.test(title);
								return n >= 2 || titleOk;
							},
							{ timeout: 35_000, polling: 500 },
						);
					} catch {
						/* keep shell; fallbacks below may still recover text */
					}
					await runG2PostLoadActions(page);
					await new Promise((r) => setTimeout(r, 1500));
				} else {
					await page.goto(targetUrl, {
						waitUntil: "domcontentloaded",
						timeout,
					});
				}
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
										try {
											if (new URL(link.href).hostname !== seedDomain)
												return false;
										} catch {
											return false;
										}
										if (opts.isG2Host && /\/products\//i.test(link.href)) {
											let label = link.text || link.title;
											if (!label) {
												const m = link.href.match(/\/products\/([^/?#]+)/);
												label = m
													? decodeURIComponent(m[1].replace(/-/g, " "))
													: "Product";
											}
											link.text = label;
											const key = link.href.split("#")[0];
											if (seen.has(key)) return false;
											seen.add(key);
											return true;
										}
										if (!(link?.text?.length > 0 || link?.title?.length > 0))
											return false;
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
							isG2Host,
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
				let { markdown } = extractSemanticContentWithFormattedMarkdown(
					doc.body,
				);

				if (isG2Host && (!markdown || String(markdown).trim().length < 80)) {
					try {
						const linkMd = await page.evaluate(() => {
							const seen = new Set();
							const lines = [];
							function walk(node) {
								if (!node) return;
								if (node.nodeType === 1 && node.shadowRoot)
									walk(node.shadowRoot);
								if (node.nodeType === 1) {
									if (node.tagName === "A") {
										const href = (node.href || "").split("#")[0];
										if (href.includes("/products/")) {
											let t = (node.textContent || "")
												.replace(/\s+/g, " ")
												.trim();
											if (!t)
												t = (node.getAttribute("aria-label") || "").trim();
											if (!t) {
												const img = node.querySelector("img[alt]");
												if (img) t = (img.getAttribute("alt") || "").trim();
											}
											if (!t) {
												const m = href.match(/\/products\/([^/?#]+)/);
												t = m
													? decodeURIComponent(m[1].replace(/-/g, " "))
													: "Product";
											}
											if (!href || t.length > 400) return;
											const key = href;
											if (seen.has(key)) return;
											seen.add(key);
											lines.push(`- [${t}](${href})`);
										}
									}
									for (const ch of node.children) walk(ch);
								} else if (node.nodeType === 11) {
									for (const ch of node.children) walk(ch);
								}
							}
							walk(document.body);
							return lines.join("\n");
						});
						if (
							linkMd &&
							linkMd.length > String(markdown || "").trim().length
						) {
							markdown = linkMd;
						}
					} catch (e) {
						console.warn(
							"[scrape] G2 product-link fallback failed:",
							e?.message,
						);
					}
					try {
						const plain = await page.evaluate(() => {
							const root =
								document.querySelector("main") ||
								document.querySelector('[role="main"]') ||
								document.querySelector("#content") ||
								document.body;
							if (!root) return "";
							return String(root.innerText || "")
								.replace(/\n{3,}/g, "\n\n")
								.trim();
						});
						if (plain && plain.length > String(markdown || "").trim().length) {
							markdown = plain;
						}
					} catch (e) {
						console.warn("[scrape] G2 innerText fallback failed:", e?.message);
					}
				}

				let screenshotUrl = null;
				if (takeScreenshot) {
					try {
						const buf = await page.screenshot({ fullPage: true });
						screenshotUrl = await uploadScreenshotBuffer(buf);
					} catch (err) {
						console.error("[scrape] Screenshot upload failed:", err?.message);
					}
				}

				if (useProxy && selectedProxy)
					proxyManager.recordProxyResult(selectedProxy.host, true, navLatency);

				if (!includeCache) {
					try {
						const docRef = firestore
							.collection(UNIVERSO_CACHE_COLLECTION)
							.doc(universoCacheDocId(targetUrl));
						const existingSnap = await docRef.get();
						if (!existingSnap.exists) {
							await docRef.set({
								title: scrapedData?.title || "No Title",
								url: targetUrl,
								markdown,
								scraped_at: FieldValue.serverTimestamp(),
								scraped_data: scrapedData,
							});
						}
					} catch (cacheErr) {
						console.warn(
							"[scrape] Firestore universo cache write failed:",
							cacheErr?.message,
						);
					}
				}

				if (includeSemanticContent && scrapedData?.content)
					removeEmptyKeys(scrapedData.content);

				let summary = null;
				let openRouterSummary = null;
				if (aiSummary && markdown && process.env.OPENROUTER_API_KEY) {
					try {
						const truncated = markdown.slice(0, 12000);
						const or = await openRouterChatMessages(
							process.env.OPENROUTER_API_KEY,
							[
								{
									role: "system",
									content:
										"You summarize web page content concisely. Respond with plain text only—no markdown code fences.",
								},
								{
									role: "user",
									content: `Summarize the following content concisely. Target length: roughly 100–1000 tokens depending on content length.\n\n${truncated}`,
								},
							],
							2048,
							{ temperature: 0.3 },
						);
						summary = String(or.content || "").trim() || null;
						openRouterSummary = {
							tokenUsage: or.tokenUsage,
							usage: or.usage,
							model: or.model,
							aiPrompt: or.aiPrompt,
						};
					} catch (err) {
						console.error("[scrape] AI summary failed:", err?.message);
					}
				}

				return {
					summary,
					scrapedData,
					markdown,
					screenshotUrl,
					openRouterSummary,
				};
			});

			return {
				success: true,
				data: poolResult.scrapedData,
				markdown: poolResult.markdown,
				summary: poolResult.summary,
				screenshot: poolResult.screenshotUrl,
				...(poolResult.openRouterSummary && {
					openRouterSummary: poolResult.openRouterSummary,
				}),
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
					...(result.openRouterSummary && {
						openRouterSummary: result.openRouterSummary,
					}),
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
	});
});

// ─── Inkgest Agent: one LLM + scrape endpoints + extensible skills ────────
const INKGEST_SCRAPE_BASE =
	process.env.INKGEST_SCRAPE_BASE_URL ||
	process.env.SCRAPE_API_BASE_URL ||
	"http://localhost:3002";

async function openRouterChatMessages(
	apiKey,
	messages,
	maxTokens = 1200,
	options = {},
) {
	const model = openRouterResolvedModel(options);
	const body = {
		model,
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
	const usage = normalizeOpenRouterUsageFromApi(data);
	return {
		content,
		usage,
		tokenUsage: toTokenUsageCamel(usage),
		model,
		aiPrompt: truncateMessagesForApiResponse(messages),
	};
}

/** Caps skill completion tokens (OpenRouter rejects high max_tokens vs account credits). Override via INKGEST_SKILL_MAX_OUTPUT_TOKENS. */
const INKGEST_SKILL_MAX_OUTPUT_TOKENS = Math.min(
	8192,
	Math.max(
		256,
		Number.parseInt(
			process.env.INKGEST_SKILL_MAX_OUTPUT_TOKENS || "4096",
			10,
		) || 4096,
	),
);

const INKGEST_CONTENT_SKILLS_CONDENSE = new Set([
	"blog",
	"article",
	"newsletter",
	"substack",
	"linkedin",
	"twitter",
	"landing-page-generator",
]);

/**
 * When combined source markdown is large, one cheap condense call shrinks context before blog/newsletter/etc.
 * Scrapes already use aiSummary when possible; this handles many URLs, long transcripts, or crawl blobs.
 */
async function condenseSourcesIfOverBudget(
	apiKey,
	taskType,
	preSources,
	addTokenUsage,
	state,
) {
	if (!preSources?.length || !INKGEST_CONTENT_SKILLS_CONDENSE.has(taskType)) {
		return preSources;
	}
	const totalMd = preSources.reduce(
		(n, s) => n + String(s.markdown || "").length,
		0,
	);
	if (totalMd <= MAX_SOURCE_CHARS_TOTAL_THRESHOLD) return preSources;

	const perSlice = Math.floor(
		MAX_SUMMARY_INPUT_CHARS / Math.max(preSources.length, 1),
	);
	const chunks = preSources.map((s, i) => {
		const md = String(s.markdown || "").slice(0, perSlice);
		return `--- ${s.url || `Source ${i + 1}`} | ${s.title || ""} ---\n${md}`;
	});
	const body = chunks.join("\n\n").slice(0, MAX_SUMMARY_INPUT_CHARS);

	const condenseMaxOut = Math.min(
		2800,
		INKGEST_SKILL_MAX_OUTPUT_TOKENS,
		Math.max(800, Math.ceil(MAX_SUMMARY_OUTPUT_CHARS / 3)),
	);

	const orCondense = await openRouterChatMessages(
		apiKey,
		[
			{
				role: "system",
				content: `You merge multiple scraped sources into one factual research brief for a writer creating ${taskType} output.
Preserve each source URL (markdown headings or a bullet list of links). Keep key facts, quotes, numbers, and image URLs; omit boilerplate and navigation. Do not invent. Markdown only. Stay under ${MAX_SUMMARY_OUTPUT_CHARS} characters.`,
			},
			{ role: "user", content: body },
		],
		condenseMaxOut,
		{ temperature: 0.2 },
	);
	const { content, usage } = orCondense;
	addTokenUsage(usage);
	if (state?.tokenUsage) {
		state.tokenUsage.prompt_tokens += usage.prompt_tokens || 0;
		state.tokenUsage.completion_tokens += usage.completion_tokens || 0;
		state.tokenUsage.total_tokens += usage.total_tokens || 0;
	}
	pushOpenRouterCall(state, "source-condense", {
		usage: orCondense.usage,
		tokenUsage: orCondense.tokenUsage,
		model: orCondense.model,
		aiPrompt: orCondense.aiPrompt,
	});
	const credit = CREDITS["source-condense"] ?? 0.25;
	state.creditsDistribution.push({
		task: "source-condense",
		label: `Condense sources for ${taskType}`,
		credits: credit,
	});
	state.creditsUsed += credit;

	const condensedMd = String(content || "").slice(0, MAX_SUMMARY_OUTPUT_CHARS);
	const mergedLinks = preSources
		.flatMap((s) => s.links || [])
		.filter(Boolean)
		.slice(0, 50);
	return [
		{
			url: preSources[0]?.url || "condensed-sources",
			title: "Condensed source brief",
			markdown: condensedMd,
			links: mergedLinks,
		},
	];
}

const openRouterKey = process.env.OPENROUTER_API_KEY;

app.post("/inkgest-agent", async (c) => {
	try {
		const authHeader =
			c.req.header("Authorization") || c.req.header("authorization");
		const authToken = authHeader?.startsWith("Bearer ")
			? authHeader.slice(7).trim()
			: authHeader?.trim();
		if (!authToken) {
			return c.json(
				{
					error: "Authentication required",
					code: "MISSING_AUTH_TOKEN",
					details:
						"Provide a Bearer token in the Authorization header: Authorization: Bearer <token>",
				},
				401,
			);
		}

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
		const hasImages = Array.isArray(bodyImages) && bodyImages.length > 0;

		if (!userPrompt && !hasExecuteTasks) {
			return c.json({ error: "Prompt or executeTasks required" }, 400);
		}

		const encoder = new TextEncoder();
		const send = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(": stream-open\n\n"));
				void (async () => {
					let state = null;
					let creditsUsed = 0;
					const creditsDistribution = [];
					const tokenUsage = {
						prompt_tokens: 0,
						completion_tokens: 0,
						total_tokens: 0,
					};
					const pendingOpenRouterCalls = [];
					try {
						const extractedUrls = hasExecuteTasks
							? [
									...new Set(
										executeTasks.flatMap((t) => {
											const fromParams = (
												Array.isArray(t.params?.urls) ? t.params.urls : []
											).filter((u) => /^https?:\/\/\S+$/i.test(String(u)));
											const fromPrompt = extractUrlsFromText(
												t.params?.prompt || "",
											);
											return [...fromParams, ...fromPrompt];
										}),
									),
								]
							: extractUrlsFromText(userPrompt);

						let urlsToScrape = extractedUrls.slice(0, 10);
						let redditUrls = urlsToScrape.filter(isRedditUrl);
						let youtubeUrls = urlsToScrape.filter(isYoutubeUrl);
						let regularUrls = urlsToScrape.filter(
							(u) => !isRedditUrl(u) && !isYoutubeUrl(u),
						);
						const apiBase =
							process.env.API_BASE_URL || new URL(c.req.url).origin;
						// In production, INKGEST_SCRAPE_BASE defaults to localhost:3002 which is unreachable.
						// Use apiBase when env vars are unset so /scrape and /scrape-multiple (same app) work.
						const scrapeBase =
							process.env.INKGEST_SCRAPE_BASE_URL ||
							process.env.SCRAPE_API_BASE_URL
								? INKGEST_SCRAPE_BASE
								: apiBase;
						let scrapedSources = [];
						let scrapeErrors = [];
						let parsed = {};
						let suggestedTasks = [];

						function addTokenUsage(usage) {
							if (usage && typeof usage === "object") {
								tokenUsage.prompt_tokens += usage.prompt_tokens || 0;
								tokenUsage.completion_tokens += usage.completion_tokens || 0;
								tokenUsage.total_tokens += usage.total_tokens || 0;
							}
						}

						if (!hasExecuteTasks) {
							// 1. Snapshot prompt URLs (already populated from extractedUrls above)
							const promptUrls = [...urlsToScrape];

							const urlLine = promptUrls.length
								? `URLs found: ${promptUrls.join(", ")}`
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

							// Scrape helper: explicit URL lists so it can be re-used for
							// prompt URLs (parallel with router) and router-inferred URLs.
							async function scrapeClassifiedUrls(regular, youtube, reddit) {
								const [regularScraped, youtubeScraped, redditScraped] =
									await Promise.all([
										regular.length > 0
											? scrapeUrlsViaApi(scrapeBase, regular, {
													includeImages: true,
													aiSummary: true,
												})
											: { sources: [], errors: [] },
										youtube.length > 0
											? scrapeYoutubeViaApi(apiBase, youtube)
											: { sources: [], errors: [] },
										reddit.length > 0
											? scrapeRedditViaApi(apiBase, reddit)
											: { sources: [], errors: [] },
									]);
								let redditFinal = redditScraped;
								if (
									reddit.length > 0 &&
									redditScraped.sources?.length === 0 &&
									redditScraped.errors?.length > 0
								) {
									redditFinal = await scrapeUrlsViaApi(scrapeBase, reddit, {
										includeImages: true,
										aiSummary: true,
									});
									if (redditFinal.sources?.length > 0) {
										console.log(
											"[inkgest-agent] Reddit fallback (Puppeteer) succeeded for",
											reddit.length,
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

							// 2. PARALLEL: LLM/fast router + scrape prompt URLs simultaneously.
							//    By the time the router resolves, scraping is already done.
							const routerPromise = (async () => {
								const fastResult = fastRouter(userPrompt, hasImages);
								if (fastResult.confidence >= 0.85) {
									console.log(
										"[inkgest-agent] Fast router used — skipped LLM (confidence:",
										fastResult.confidence,
										")",
									);
									return {
										parsed: fastResult,
										fast: true,
										usage: null,
										openRouterMeta: null,
										parseError: false,
									};
								}
								const routerResult = await openRouterChatMessages(
									openRouterKey,
									messages,
								);
								const openRouterMeta = {
									usage: routerResult.usage,
									tokenUsage: routerResult.tokenUsage,
									model: routerResult.model,
									aiPrompt: routerResult.aiPrompt,
								};
								try {
									return {
										parsed: parseAgentResponse(routerResult.content),
										fast: false,
										usage: routerResult.usage,
										openRouterMeta,
										raw: routerResult.content,
										parseError: false,
									};
								} catch (e) {
									return {
										parsed: null,
										fast: false,
										usage: routerResult.usage,
										openRouterMeta,
										raw: routerResult.content,
										parseError: true,
									};
								}
							})();

							const [routerOutcome, initialScrape] = await Promise.all([
								routerPromise,
								promptUrls.length > 0
									? scrapeClassifiedUrls(regularUrls, youtubeUrls, redditUrls)
									: Promise.resolve({ sources: [], errors: [] }),
							]);

							if (!routerOutcome.fast && routerOutcome.openRouterMeta) {
								pendingOpenRouterCalls.push({
									label: "router",
									...routerOutcome.openRouterMeta,
									at: new Date().toISOString(),
								});
							}

							// Apply LLM router credits (fast router has no LLM cost)
							if (!routerOutcome.fast && routerOutcome.usage) {
								addTokenUsage(routerOutcome.usage);
								creditsDistribution.push({
									task: "thinking",
									credits: CREDITS.thinking,
								});
								creditsUsed += CREDITS.thinking;
							}

							// Router parse failure → stream error and bail
							if (routerOutcome.parseError) {
								controller.enqueue(
									encoder.encode(
										send({
											type: "end",
											error:
												"Agent could not parse your request. Try being more specific.",
											raw: routerOutcome.raw?.slice(0, 500),
											executed: [],
											references: [],
											creditsUsed,
											creditsDistribution,
											...usageFieldsFromSnake(tokenUsage),
											openRouterCalls: pendingOpenRouterCalls,
										}),
									),
								);
								controller.close();
								return;
							}

							parsed = routerOutcome.parsed;

							// 3. Collect initial (parallel) scrape results
							scrapedSources = initialScrape.sources || [];
							if (initialScrape.errors?.length) {
								scrapeErrors.push(...initialScrape.errors);
								console.error(
									"[inkgest-agent] Scrape errors (parallel with router):",
									initialScrape.errors,
								);
							}

							// 4. Build suggested tasks from router output
							suggestedTasks = (
								Array.isArray(parsed.suggestedTasks)
									? parsed.suggestedTasks
									: []
							).map((t) => {
								const taskUrls =
									Array.isArray(t.params?.urls) && t.params.urls.length > 0
										? t.params.urls.filter((u) =>
												/^https?:\/\/\S+$/i.test(String(u)),
											)
										: promptUrls;
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

							// 5. Merge prompt URLs + any URLs the router inferred
							urlsToScrape = [
								...new Set([
									...promptUrls,
									...collectHttpUrlsFromTasks(suggestedTasks),
								]),
							].slice(0, 10);
							redditUrls = urlsToScrape.filter(isRedditUrl);
							youtubeUrls = urlsToScrape.filter(isYoutubeUrl);
							regularUrls = urlsToScrape.filter(
								(u) => !isRedditUrl(u) && !isYoutubeUrl(u),
							);

							// 6. Stream plan immediately — prompt URLs already scraped above
							controller.enqueue(
								encoder.encode(
									send({
										type: "plan",
										thinking: parsed.thinking || "",
										message:
											parsed.message || "Starting scrape and task execution.",
										suggestedTasks,
										urlsToScrape,
									}),
								),
							);

							// 7. Scrape only NEW URLs the router inferred (not from the prompt)
							const alreadyScrapedSet = new Set(
								scrapedSources.map((s) => s.url),
							);
							const newUrls = urlsToScrape.filter(
								(u) => !alreadyScrapedSet.has(u),
							);
							if (newUrls.length > 0) {
								const newReddit = newUrls.filter(isRedditUrl);
								const newYoutube = newUrls.filter(isYoutubeUrl);
								const newRegular = newUrls.filter(
									(u) => !isRedditUrl(u) && !isYoutubeUrl(u),
								);
								const additional = await scrapeClassifiedUrls(
									newRegular,
									newYoutube,
									newReddit,
								);
								scrapedSources = [
									...scrapedSources,
									...(additional.sources || []),
								];
								if (additional.errors?.length) {
									scrapeErrors.push(...additional.errors);
									console.error(
										"[inkgest-agent] Scrape errors (router-inferred URLs):",
										additional.errors,
									);
								}
							}
						} else {
							if (urlsToScrape.length > 0) {
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
								if (
									redditFinal.sources?.length === 0 &&
									redditScraped.errors?.length
								) {
									scrapeErrors.push(...redditScraped.errors);
									console.error(
										"[inkgest-agent] Reddit scrape errors:",
										redditScraped.errors,
									);
								}
							}
						}

						// Stream scrape outcome — client shows per-URL success/failure before tasks start.
						controller.enqueue(
							encoder.encode(
								send({
									type: "scrape_status",
									urlsToScrape,
									scraped: scrapedSources.map((s) => ({
										url: s.url,
										title: s.title || "",
										success: true,
									})),
									failed: scrapeErrors.map((e) =>
										typeof e === "string"
											? { url: "unknown", error: e }
											: {
													url: e?.url || "unknown",
													error: e?.error || String(e),
												},
									),
								}),
							),
						);

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
									const multi = Array.isArray(t.params?.urls)
										? t.params.urls
										: [];
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
								...(single && /^https?:\/\/\S+$/i.test(String(single))
									? [single]
									: []),
								...multi.filter((u) => /^https?:\/\/\S+$/i.test(String(u))),
							];
							const hasUrls = fromTask.length > 0;
							const taskUrls = hasUrls ? fromTask : fallbackUrls;
							return { ...t, params: { ...t.params, urls: taskUrls } };
						});

						if (hasImages) {
							tasksToRun = tasksToRun.map((t) =>
								t.type === "image-reading" &&
								(!Array.isArray(t.params?.images) ||
									t.params.images.length === 0)
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
								lateRedditFinal = await scrapeUrlsViaApi(
									scrapeBase,
									lateReddit,
									{
										includeImages: true,
										aiSummary: true,
									},
								);
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
							controller.enqueue(
								encoder.encode(
									send({
										type: "end",
										error: errPayload.error,
										executed: [],
										references: allSourceReferences,
										scrapeErrors: errPayload.scrapeErrors,
										creditsUsed: errPayload.creditsUsed,
										creditsDistribution: errPayload.creditsDistribution,
										...usageFieldsFromSnake(errPayload.tokenUsage),
										openRouterCalls: pendingOpenRouterCalls,
									}),
								),
							);
							controller.close();
							return;
						}

						state = {
							tokenUsage: { ...tokenUsage },
							creditsUsed,
							creditsDistribution: [...creditsDistribution],
							openRouterCalls: [...pendingOpenRouterCalls],
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
							if (
								executed.homePageData &&
								executed.homePageData.markdown != null
							) {
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
							const urls = (
								Array.isArray(params.urls) ? params.urls : []
							).filter((u) => /^https?:\/\/\S+$/i.test(String(u)));
							try {
								if (task.type === "scrape") {
									if (urls.length === 0) {
										return {
											taskLabel: task.label,
											success: false,
											error: "No valid URLs",
										};
									}
									const preScraped = urls
										.map((u) => sourceByUrl[u])
										.filter(Boolean);
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
											redditTask = await scrapeUrlsViaApi(
												scrapeBase,
												missingReddit,
												{
													includeImages: true,
													aiSummary: true,
												},
											);
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
											result: {
												content,
												images,
												urls: sources.map((s) => s.url),
											},
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
									const timeoutMs = scrapeContent
										? 10 * 60 * 1000
										: 5 * 60 * 1000;
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
									const crawlSources =
										buildSourcesFromCrawlResult(crawlExecuted);
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
										crawlExecuted.result = {
											content: "",
											images: [],
											sources: [],
										};
									}
									return {
										taskLabel: task.label,
										success: true,
										executed: crawlExecuted,
									};
								}

								if (task.type === "image-reading") {
									const imgs = Array.isArray(params.images)
										? params.images
										: [];
									if (imgs.length === 0) {
										return {
											taskLabel: task.label,
											success: false,
											error:
												"image-reading requires params.images (array of { url } or { base64, mimeType })",
										};
									}
									const imageReadingRes = await fetch(
										`${apiBase}/image-reading`,
										{
											method: "POST",
											headers: { "Content-Type": "application/json" },
											body: JSON.stringify({
												images: imgs,
												extractContent: true,
												convertToCode: params.convertToCode === true,
											}),
											signal: AbortSignal.timeout(120_000),
										},
									);
									const imageReadingData = await imageReadingRes
										.json()
										.catch(() => ({}));
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
											error:
												imageReadingData?.error ||
												`HTTP ${imageReadingRes.status}`,
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
									const trendingData = await trendingRes
										.json()
										.catch(() => ({}));
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
											error:
												trendingData?.error || `HTTP ${trendingRes.status}`,
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
									params.useCrawlResult === true &&
									state.crawlUrlSources?.length > 0;
								let preSources = useCrawlResult
									? state.crawlUrlSources
									: urls.map((u) => sourceByUrl[u]).filter(Boolean);
								if (state.imageReadingSources?.length > 0) {
									preSources = [...preSources, ...state.imageReadingSources];
								}

								// Scrape path uses aiSummary: true where possible; condense step below if sources are still huge.

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

								const sourcesForSkill = await condenseSourcesIfOverBudget(
									openRouterKey,
									task.type,
									preSources,
									addTokenUsage,
									state,
								);

								const format = params.format || "substack";
								const style = params.style || "casual";
								const system = skill.buildSystemPrompt(
									format,
									style,
									sourcesForSkill.length > 0,
								);
								const user = skill.buildUserContent(
									params.prompt || userPrompt,
									sourcesForSkill,
								);

								const cappedMaxTokens = Math.min(
									skill.maxTokens,
									INKGEST_SKILL_MAX_OUTPUT_TOKENS,
								);

								const orSkill = await openRouterChatMessages(
									openRouterKey,
									[
										{ role: "system", content: system },
										{ role: "user", content: user },
									],
									cappedMaxTokens,
									task.type === "infographics-svg-generator"
										? { response_format: { type: "json_object" } }
										: {},
								);
								const rawContent = orSkill.content;
								const skillUsage = orSkill.usage;
								addTokenUsage(skillUsage);
								state.tokenUsage.prompt_tokens +=
									skillUsage?.prompt_tokens || 0;
								state.tokenUsage.completion_tokens +=
									skillUsage?.completion_tokens || 0;
								state.tokenUsage.total_tokens += skillUsage?.total_tokens || 0;
								pushOpenRouterCall(state, `skill:${task.type}`, {
									usage: orSkill.usage,
									tokenUsage: orSkill.tokenUsage,
									model: orSkill.model,
									aiPrompt: orSkill.aiPrompt,
								});

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
									const m = content.match(
										/^\s*```(?:html)?\s*\n?([\s\S]*?)\n?```\s*$/,
									);
									content = m
										? m[1].trim()
										: content
												.replace(/^```(?:html)?\s*\n?/, "")
												.replace(/\n?```\s*$/, "")
												.trim();
								}
								const usedCondensedBrief =
									sourcesForSkill.length === 1 &&
									sourcesForSkill[0]?.title === "Condensed source brief";
								const executed = {
									type: task.type,
									label: task.label,
									content,
									format: task.type === "newsletter" ? format : undefined,
									sources: preSources.map((s) => ({
										url: s.url,
										title: s.title,
									})),
									...(usedCondensedBrief ? { condensedSources: true } : {}),
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

						controller.enqueue(
							encoder.encode(
								send({
									type: "start",
									success: true,
									taskCount: validTasks.length,
									message: hasExecuteTasks
										? `Running ${validTasks.length} task(s).`
										: validTasks.length > 0
											? `Executing ${validTasks.length} task(s).`
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
										...usageFieldsFromSnake(state.tokenUsage),
										openRouterCalls: state.openRouterCalls || [],
									}),
								),
							);
							controller.close();
							return;
						}

						// Normalise a URL for dedup comparison: lowercase hostname, strip trailing slash.
						const normalizeUrl = (u) => {
							if (!u || typeof u !== "string") return u;
							try {
								const parsed = new URL(u);
								parsed.hostname = parsed.hostname.toLowerCase();
								if (parsed.pathname === "/") parsed.pathname = "";
								return (
									parsed.origin + parsed.pathname + parsed.search + parsed.hash
								);
							} catch {
								return u.replace(/\/+$/, "");
							}
						};

						// Build a normalised lookup so URL variants (trailing slash, case) still match.
						const sourceByUrlNorm = Object.fromEntries(
							Object.entries(sourceByUrl).map(([k, v]) => [normalizeUrl(k), v]),
						);

						// Deduplicate task list:
						// 1. Skip crawl-url when its target URL was already scraped globally —
						//    seed crawlUrlSources so useCrawlResult content tasks still get data.
						// 2. Skip redundant explicit scrape tasks whose ALL URLs are already in
						//    sourceByUrl — the content task will use the pre-scraped data directly.
						const deduplicatedTasks = validTasks.filter((t) => {
							if (t.type === "crawl-url") {
								const targetUrl =
									t.params?.url ||
									(Array.isArray(t.params?.urls) ? t.params.urls[0] : null);
								const existing = targetUrl
									? sourceByUrlNorm[normalizeUrl(targetUrl)]
									: null;
								if (existing) {
									if (
										!state.crawlUrlSources.some((s) => s.url === existing.url)
									) {
										state.crawlUrlSources.push(existing);
									}
									console.log(
										"[inkgest-agent] Skipping redundant crawl-url (already scraped):",
										targetUrl,
									);
									return false;
								}
							}

							if (t.type === "scrape") {
								const taskUrls = (
									Array.isArray(t.params?.urls) ? t.params.urls : []
								).filter((u) => /^https?:\/\/\S+$/i.test(String(u)));
								if (
									taskUrls.length > 0 &&
									taskUrls.every((u) => sourceByUrlNorm[normalizeUrl(u)])
								) {
									console.log(
										"[inkgest-agent] Skipping redundant scrape task (all URLs already scraped):",
										taskUrls,
									);
									return false;
								}
							}

							return true;
						});

						const crawlUrlTasks = deduplicatedTasks.filter(
							(t) => t.type === "crawl-url",
						);
						const imageReadingTasks = deduplicatedTasks.filter(
							(t) => t.type === "image-reading",
						);
						const otherTasks = deduplicatedTasks.filter(
							(t) => t.type !== "crawl-url" && t.type !== "image-reading",
						);
						const prefetchTaskTypes = new Set(["scrape", "github-trending"]);
						const prefetchTasks = otherTasks.filter((t) =>
							prefetchTaskTypes.has(t.type),
						);
						const contentTasks = otherTasks.filter(
							(t) => !prefetchTaskTypes.has(t.type),
						);

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
											index: deduplicatedTasks.indexOf(crawlUrlTasks[i]),
											...r,
										}),
									),
								);
								if (r.success && r.executed) {
									executed.push(r.executed);
									if (
										r.executed.homePageData ||
										(r.executed.nestedResults &&
											r.executed.nestedResults.length)
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
											index: deduplicatedTasks.indexOf(imageReadingTasks[i]),
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

						// Phase 2a: data-fetch tasks (scrape / github-trending) in parallel
						if (prefetchTasks.length > 0) {
							const results = await Promise.all(
								prefetchTasks.map((t) => runOneTask(t)),
							);
							results.forEach((r, i) => {
								controller.enqueue(
									encoder.encode(
										send({
											type: "task",
											index: deduplicatedTasks.indexOf(prefetchTasks[i]),
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

						// Phase 2b: content / LLM tasks in parallel (after global scrape + prefetch)
						if (contentTasks.length > 0) {
							const results = await Promise.all(
								contentTasks.map((t) => runOneTask(t)),
							);
							results.forEach((r, i) => {
								controller.enqueue(
									encoder.encode(
										send({
											type: "task",
											index: deduplicatedTasks.indexOf(contentTasks[i]),
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
									...usageFieldsFromSnake(state.tokenUsage),
									openRouterCalls: state.openRouterCalls || [],
								}),
							),
						);
						controller.close();
					} catch (innerErr) {
						console.error("[inkgest-agent] stream pipeline", innerErr);
						try {
							controller.enqueue(
								encoder.encode(
									send({
										type: "end",
										error: innerErr?.message || "Agent failed",
										executed: [],
										references: state?.references ?? [],
										creditsUsed: state?.creditsUsed ?? creditsUsed,
										creditsDistribution:
											state?.creditsDistribution ?? creditsDistribution,
										...usageFieldsFromSnake(state?.tokenUsage ?? tokenUsage),
										openRouterCalls:
											state?.openRouterCalls ?? pendingOpenRouterCalls ?? [],
									}),
								),
							);
						} catch (_) {
							/* ignore */
						}
						try {
							controller.close();
						} catch (_) {
							/* ignore */
						}
					}
				})();
			},
		});

		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			},
		});
	} catch (error) {
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
		contentReadyTimeout = 12000,
		postLoadWaitMs = 1200,
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

	// Guard against blank screenshots: wait until DOM has meaningful content.
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
	} catch {}

	// Give SPAs/lazy sections one extra beat to render.
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

function normalizeWebsiteUrl(input) {
	if (!input || typeof input !== "string") return null;
	const raw = input.trim();
	if (!raw) return null;
	const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
	try {
		return new URL(withProtocol).toString();
	} catch {
		return null;
	}
}

async function isLikelyStaticSite(url) {
	try {
		const resp = await fetch(url, {
			signal: AbortSignal.timeout(12000),
			redirect: "follow",
			headers: {
				"User-Agent": userAgents.random().toString(),
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
			},
		});
		if (!resp.ok) return false;
		const html = await resp.text();
		if (!html) return false;
		const scriptTags = (html.match(/<script[\s>]/gi) || []).length;
		const inlineHydrationHints =
			/__NEXT_DATA__|__NUXT__|window\.__INITIAL_STATE__|id="root"|id="__next"|data-reactroot|sveltekit|astro-island/i.test(
				html,
			);
		// Simple heuristic: fewer scripts and no framework hydration hints => likely static.
		return scriptTags <= 3 && !inlineHydrationHints;
	} catch {
		return false;
	}
}

async function uploadScreenshotBuffer(buffer) {
	const fileName = `screenshot-${Date.now()}-${uuidv4().replace(/[^a-zA-Z0-9]/g, "")}.png`;
	const utFile = new UTFile([buffer], fileName, { type: "image/png" });
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(`UploadThing upload failed: ${response.error.message}`);
	}
	return response.data.ufsUrl;
}

async function uploadVideoBufferToUploadThing(buffer, originalName) {
	const ext = path.extname(originalName || "").toLowerCase() || ".mp4";
	const allowed = [".mp4", ".mov", ".webm", ".mkv"];
	const useExt = allowed.includes(ext) ? ext : ".mp4";
	const fileName = `video-${Date.now()}-${uuidv4().replace(/[^a-zA-Z0-9]/g, "")}${useExt}`;
	const mimeByExt = {
		".mp4": "video/mp4",
		".mov": "video/quicktime",
		".webm": "video/webm",
		".mkv": "video/x-matroska",
	};
	const mime = mimeByExt[useExt] || "application/octet-stream";
	const utFile = new UTFile([buffer], fileName, { type: mime });
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(`UploadThing upload failed: ${response.error.message}`);
	}
	return response.data.ufsUrl;
}

async function uploadAudioBufferToUploadThing(buffer, originalName) {
	const ext = path.extname(originalName || "").toLowerCase() || ".mp3";
	const allowed = [
		".mp3",
		".wav",
		".m4a",
		".aac",
		".ogg",
		".oga",
		".webm",
		".flac",
		".aiff",
		".aif",
		".mp4",
	];
	const useExt = allowed.includes(ext) ? ext : ".mp3";
	const fileName = `audio-${Date.now()}-${uuidv4().replace(/[^a-zA-Z0-9]/g, "")}${useExt}`;
	const mimeByExt = {
		".mp3": "audio/mpeg",
		".wav": "audio/wav",
		".m4a": "audio/mp4",
		".aac": "audio/aac",
		".ogg": "audio/ogg",
		".oga": "audio/ogg",
		".webm": "audio/webm",
		".flac": "audio/flac",
		".aiff": "audio/aiff",
		".aif": "audio/aiff",
		".mp4": "audio/mp4",
	};
	const mime = mimeByExt[useExt] || "application/octet-stream";
	const utFile = new UTFile([buffer], fileName, { type: mime });
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(`UploadThing audio upload failed: ${response.error.message}`);
	}
	return response.data.ufsUrl;
}

async function smartCaptureScreenshot(url, options = {}) {
	const {
		device = "desktop",
		waitForSelector,
		timeout = 45000,
		waitUntil = "domcontentloaded",
		contentReadyTimeout = 12000,
		postLoadWaitMs = 1200,
		blockDistractions = true,
		fullPage = true,
		coords,
		forceMode,
		useProxy = true,
	} = options;

	const staticSite =
		forceMode === "static"
			? true
			: forceMode === "dynamic"
				? false
				: await isLikelyStaticSite(url);

	if (staticSite) {
		const { buffer, metadata, markdown, dimensions } =
			await browserPool.withPage((page) =>
				captureOneScreenshotWithPage(page, {
					url,
					device,
					waitUntil,
					waitForSelector,
					timeout,
					contentReadyTimeout,
					postLoadWaitMs,
					fullPage,
					coords,
					blockDistractions,
				}),
			);
		const screenshot = await uploadScreenshotBuffer(buffer);
		return {
			success: true,
			mode: "static",
			url,
			screenshot,
			metadata,
			markdown,
			dimensions,
		};
	}

	const result = await scrapeSingleUrlWithPuppeteer(url, {
		waitForSelector: waitForSelector || null,
		timeout,
		useProxy,
		takeScreenshot: true,
		includeSemanticContent: false,
		includeImages: false,
		includeLinks: false,
		extractMetadata: true,
		aiSummary: false,
		includeCache: false,
	});

	if (!result?.success || !result?.screenshot) {
		// If dynamic path fails, fallback to direct screenshot capture to avoid hard failure.
		const { buffer, metadata, markdown, dimensions } =
			await browserPool.withPage((page) =>
				captureOneScreenshotWithPage(page, {
					url,
					device,
					waitUntil,
					waitForSelector,
					timeout,
					contentReadyTimeout,
					postLoadWaitMs,
					fullPage,
					coords,
					blockDistractions,
				}),
			);
		const screenshot = await uploadScreenshotBuffer(buffer);
		return {
			success: true,
			mode: "dynamic-fallback",
			url,
			screenshot,
			metadata,
			markdown,
			dimensions,
		};
	}

	return {
		success: true,
		mode: "dynamic",
		url,
		screenshot: result.screenshot,
		metadata: result?.data?.metadata || null,
		markdown: result?.markdown || null,
		dimensions:
			SCREENSHOT_VIEWPORT_MAP[device] || SCREENSHOT_VIEWPORT_MAP.desktop,
	};
}

app.post("/screenshot", async (c) => {
	try {
		const {
			url,
			device = "desktop",
			waitForSelector,
			timeout = 45000,
			waitUntil = "domcontentloaded",
			contentReadyTimeout = 12000,
			postLoadWaitMs = 1200,
			blockDistractions = true,
			fullPage = true,
			coords,
			forceMode,
			useProxy = true,
		} = await c.req.json();

		const normalizedUrl = normalizeWebsiteUrl(url);
		if (!normalizedUrl) {
			return c.json({ success: false, error: "Invalid URL format" }, 400);
		}

		const result = await smartCaptureScreenshot(normalizedUrl, {
			device,
			waitForSelector,
			timeout,
			waitUntil,
			contentReadyTimeout,
			postLoadWaitMs,
			blockDistractions,
			fullPage,
			coords,
			forceMode,
			useProxy,
		});

		return c.json({
			success: true,
			...result,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error("❌ screenshot error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to capture screenshot",
				details: error?.message || String(error),
			},
			500,
		);
	}
});

app.post("/screenshot-multiple", async (c) => {
	try {
		const {
			urls,
			device = "desktop",
			waitForSelector,
			timeout = 45000,
			waitUntil = "domcontentloaded",
			contentReadyTimeout = 12000,
			postLoadWaitMs = 1200,
			blockDistractions = true,
			fullPage = true,
			coords,
			forceMode,
			useProxy = true,
		} = await c.req.json();

		if (!Array.isArray(urls) || urls.length === 0) {
			return c.json(
				{ success: false, error: "urls must be a non-empty array" },
				400,
			);
		}

		const MAX_URLS = 50;
		const normalized = urls
			.slice(0, MAX_URLS)
			.map((u) => normalizeWebsiteUrl(u))
			.filter(Boolean);
		if (normalized.length === 0) {
			return c.json({ success: false, error: "No valid URLs" }, 400);
		}

		const results = await Promise.all(
			normalized.map((url) =>
				smartCaptureScreenshot(url, {
					device,
					waitForSelector,
					timeout,
					waitUntil,
					contentReadyTimeout,
					postLoadWaitMs,
					blockDistractions,
					fullPage,
					coords,
					forceMode,
					useProxy,
				}).catch((err) => ({
					success: false,
					url,
					screenshot: null,
					metadata: null,
					markdown: null,
					mode: forceMode || "auto",
					error: err?.message || "Screenshot failed",
					dimensions:
						SCREENSHOT_VIEWPORT_MAP[device] || SCREENSHOT_VIEWPORT_MAP.desktop,
				})),
			),
		);

		return c.json({
			success: true,
			results,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error("❌ screenshot-multiple error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to capture screenshots",
				details: error?.message || String(error),
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
			const response = await fetch(jsonUrl, {
				headers: {
					Accept: "application/json",
				},
				signal: AbortSignal.timeout(30000),
				redirect: "follow",
			});
			if (!response.ok) {
				const err = new Error(`HTTP ${response.status}`);
				err.response = { status: response.status };
				throw err;
			}

			const redditData = await response.json();

			// Extract metadata from the original Reddit URL (without .json)
			let redditMetadata = null;
			// Fetch the webpage content
			const newUrl = new URL(url.replace(".json", ""));
			const hostname = newUrl.hostname;
			const metadataResponse = await fetch(`https://${hostname}`, {
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
				signal: AbortSignal.timeout(30000),
				redirect: "follow",
			});
			const metadataHtml = await metadataResponse.text();

			// Load HTML content with Cheerio
			const $ = load(metadataHtml);

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
				$('meta[nbrd.superproxy.ioame="description"]').attr("content") ||
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
					const fallbackResp = await fetch(jsonUrl, {
						headers: { Accept: "application/json" },
						signal: AbortSignal.timeout(30000),
					});
					if (!fallbackResp.ok) throw new Error(`HTTP ${fallbackResp.status}`);

					const redditData = await fallbackResp.json();
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
		const response = await fetch(newUrl.toString(), {
			signal: AbortSignal.timeout(30000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const responseHtml = await response.text();

		const $ = load(responseHtml);
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
	// ── Auth ──────────────────────────────────────────────────────────────────
	const imgAuthHeader =
		c.req.header("Authorization") || c.req.header("authorization");
	const imgAuthToken = imgAuthHeader?.startsWith("Bearer ")
		? imgAuthHeader.slice(7).trim()
		: imgAuthHeader?.trim();
	if (!imgAuthToken) {
		return c.json(
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details:
					"Provide a Bearer token in the Authorization header: Authorization: Bearer <token>",
			},
			401,
		);
	}

	// ── Rate limit (20 req / 10 min per IP) ──────────────────────────────────
	const IMG_RATE_LIMIT = 20;
	const IMG_RATE_WINDOW_MS = 10 * 60 * 1000;
	const imgClientIp =
		c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";

	const imgRl = rateLimit(imgClientIp, IMG_RATE_LIMIT, IMG_RATE_WINDOW_MS);
	if (!imgRl.allowed) {
		c.header("Retry-After", String(imgRl.retryAfter));
		c.header("X-RateLimit-Limit", String(IMG_RATE_LIMIT));
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Window", "10 minutes");
		return c.json(
			{
				success: false,
				error: "Rate limit exceeded",
				message: `You have exceeded ${IMG_RATE_LIMIT} requests per 10 minutes. Please retry after ${imgRl.retryAfter}s.`,
				retryAfter: imgRl.retryAfter,
				ip: imgClientIp,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(IMG_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(imgRl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");

	// ── Parse request body ────────────────────────────────────────────────────
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
		} catch {
			return c.json(
				{
					error:
						"Invalid multipart/form-data payload. Use proper multipart encoding (-F in curl) or send JSON.",
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
		return c.json({ error: "prompt is required" }, 400);
	}

	// ── Resolve image → base64 ────────────────────────────────────────────────
	if (!base64Data) {
		if (!imageUrl) {
			return c.json(
				{ error: "Provide either an image file (field: image) or imageUrl" },
				400,
			);
		}
		const imgFetchRes = await fetch(imageUrl);
		if (!imgFetchRes.ok) {
			return c.json({ error: "Failed to fetch image from imageUrl" }, 400);
		}
		mimeType = imgFetchRes.headers.get("content-type") || "image/png";
		base64Data = Buffer.from(await imgFetchRes.arrayBuffer()).toString(
			"base64",
		);
	}

	const openRouterApiKey = process.env.OPENROUTER_API_KEY;
	if (!openRouterApiKey) {
		return c.json(
			{
				error: "OpenRouter API key not configured",
				code: "MISSING_API_KEY",
			},
			503,
		);
	}

	const imgToCodeModel = "anthropic/claude-sonnet-4-5";
	const imgToCodeMessages = [
		{
			role: "system",
			content: `You are an expert React developer. Your task is to generate a single, complete React component based on the provided image and user prompt.

Strict requirements:
- Output only a single React component as raw JSX — no markdown fences, no explanations.
- Use **Tailwind CSS** for all styling.
- Use **lucide-react** and **react-icons** for any icons (import from these libraries as needed).
- Do not use any other CSS frameworks or icon libraries.
- The component must be self-contained, default-exported, and ready to render.
- If the image contains interactive elements, implement them as functional React code.
- Do not include any import for Tailwind CSS (assume it is globally available).
- Only output the raw JSX component code, nothing else.`,
		},
		{
			role: "user",
			content: [
				{ type: "text", text: prompt },
				{
					type: "image_url",
					image_url: { url: `data:${mimeType};base64,${base64Data}` },
				},
			],
		},
	];

	// ── Stream from OpenRouter ────────────────────────────────────────────────
	let imgCodeUpstreamRes;
	try {
		imgCodeUpstreamRes = await fetch(
			"https://openrouter.ai/api/v1/chat/completions",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${openRouterApiKey}`,
					"HTTP-Referer": "https://ihatereading.in",
					"X-Title": "IHateReading Image-to-Code",
				},
				body: JSON.stringify({
					model: imgToCodeModel,
					stream: true,
					messages: imgToCodeMessages,
					temperature: 0.2,
				}),
			},
		);
	} catch (fetchErr) {
		return c.json(
			{ error: `Failed to reach OpenRouter: ${fetchErr.message}` },
			502,
		);
	}

	if (!imgCodeUpstreamRes.ok) {
		let detail = `OpenRouter ${imgCodeUpstreamRes.status}`;
		try {
			const errJson = await imgCodeUpstreamRes.json();
			detail = errJson?.error?.message || detail;
		} catch {}
		return c.json({ error: detail }, imgCodeUpstreamRes.status);
	}

	// ── Pipe OpenRouter SSE → client SSE ─────────────────────────────────────
	const imgEncoder = new TextEncoder();
	const imgUpstreamReader = imgCodeUpstreamRes.body.getReader();
	const imgUpstreamDecoder = new TextDecoder();

	const imgOutputStream = new ReadableStream({
		async start(controller) {
			let sseBuffer = "";
			let streamUsageRaw = null;
			let streamModel = imgToCodeModel;
			const sendMetaAndDone = () => {
				controller.enqueue(
					imgEncoder.encode(
						`data: ${JSON.stringify(
							buildOpenRouterStreamClientMeta(
								imgToCodeMessages,
								streamUsageRaw,
								streamModel,
							),
						)}\n\n`,
					),
				);
				controller.enqueue(imgEncoder.encode("data: [DONE]\n\n"));
				controller.close();
			};
			try {
				while (true) {
					const { done, value } = await imgUpstreamReader.read();
					if (done) break;

					sseBuffer += imgUpstreamDecoder.decode(value, { stream: true });
					const lines = sseBuffer.split("\n");
					sseBuffer = lines.pop();

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed.startsWith("data: ")) continue;

						const payload = trimmed.slice(6);
						if (payload === "[DONE]") {
							sendMetaAndDone();
							return;
						}

						let parsed;
						try {
							parsed = JSON.parse(payload);
						} catch {
							continue;
						}

						if (parsed?.error) {
							controller.enqueue(
								imgEncoder.encode(
									`data: ${JSON.stringify({ error: parsed.error.message || "OpenRouter error" })}\n\n`,
								),
							);
							controller.close();
							return;
						}

						if (parsed?.usage) streamUsageRaw = parsed.usage;
						if (parsed?.model) streamModel = parsed.model;

						const delta = parsed?.choices?.[0]?.delta?.content ?? null;
						if (delta) {
							controller.enqueue(
								imgEncoder.encode(`data: ${JSON.stringify({ delta })}\n\n`),
							);
						}
					}
				}

				sendMetaAndDone();
			} catch (err) {
				try {
					controller.enqueue(
						imgEncoder.encode(
							`data: ${JSON.stringify({ error: err.message })}\n\n`,
						),
					);
					controller.close();
				} catch {}
			} finally {
				imgUpstreamReader.releaseLock();
			}
		},
	});

	return new Response(imgOutputStream, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
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
		const mimeType =
			res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
		return { base64, mimeType };
	}
	return null;
}

/**
 * Shared image-reading pipeline (Gemini). Used by POST /image-reading and POST /generate/image-reading.
 * Body: { images: [{ url } | { base64, mimeType }], convertToCode?: boolean, extractContent?: boolean }
 */
async function runImageReadingService(body) {
	const {
		images = [],
		convertToCode = false,
		extractContent = true,
	} = body || {};

	if (!Array.isArray(images) || images.length === 0) {
		return {
			success: false,
			error: "images array is required and must not be empty",
			status: 400,
		};
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
		return {
			success: false,
			error: "No valid image could be loaded from images array",
			status: 400,
		};
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

	return {
		success: true,
		results,
		markdown: markdown || "(No content extracted)",
	};
}

/**
 * POST /image-reading
 * Body: { images: [{ url } | { base64, mimeType }], convertToCode?: boolean, extractContent?: boolean }
 * Uses Gemini 2.0 to extract content (markdown) and optionally convert to code.
 */
app.post("/image-reading", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const out = await runImageReadingService(body);
		if (!out.success) {
			return c.json({ success: false, error: out.error }, out.status || 400);
		}
		return c.json({
			success: true,
			results: out.results,
			markdown: out.markdown,
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
app.post("/scrape-google-news", async (c) => {
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

		const articleLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 50);

		const searchQuery = encodeURIComponent(`${city} ${state}`);
		const googleNewsUrl = `https://news.google.com/search?q=${searchQuery}&hl=en&gl=US&ceid=US%3Aen`;

		console.log(`Scraping Google News for: ${city}, ${state}`);

		const scrapeResult = await scrapeSingleUrlWithPuppeteer(googleNewsUrl, {
			includeSemanticContent: true,
			includeLinks: true,
			includeImages: false,
			extractMetadata: true,
			timeout: 30000,
		});

		const scrapedData = scrapeResult?.data ?? scrapeResult?.scrapedData ?? {};
		const rawLinks = scrapedData?.links ?? [];
		const headings = [
			...(scrapedData?.content?.h3 ?? []),
			...(scrapedData?.content?.h4 ?? []),
		];

		// Google News article links contain "/articles/" or "/read/" in the path
		const articleLinks = rawLinks.filter((link) => {
			const href = link?.href ?? "";
			return (
				href.includes("/articles/") ||
				href.includes("/read/") ||
				href.includes("news.google.com/stories")
			);
		});

		const news = articleLinks.slice(0, articleLimit).map((link, index) => {
			const title =
				link.text?.trim() ||
				headings[index] ||
				link.title?.trim() ||
				"Untitled";
			const url = link.href;
			let source = "Unknown";
			try {
				source = new URL(url).hostname.replace(/^www\./, "");
			} catch {}
			return {
				title,
				url,
				source,
				snippet: link.title?.trim() || "",
				metadata: {
					ogTitle: scrapedData?.metadata?.["og:title"] ?? null,
					ogDescription: scrapedData?.metadata?.["og:description"] ?? null,
					pageTitle: scrapedData?.title ?? null,
				},
				index: index + 1,
			};
		});

		performanceMonitor.endOperation(operationId);

		return c.json({
			success: true,
			query: `${city}, ${state}`,
			limit: articleLimit,
			total: news.length,
			news,
			scrapedAt: new Date().toISOString(),
			url: googleNewsUrl,
		});
	} catch (error) {
		console.error("Error in /scrape-google-news endpoint:", error);
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
			const response = await fetch(url, {
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
				signal: AbortSignal.timeout(30000),
				redirect: "follow",
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const responseHtml = await response.text();

			// Load HTML content with Cheerio
			const $ = load(responseHtml);

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
		const response = await fetch(url, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
			},
			signal: AbortSignal.timeout(30000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const responseHtml = await response.text();

		const $ = load(responseHtml);

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
		const extractRes = await extractStructuredData(siteData);
		const structured = extractRes.result;
		const linkedInRes = await generateLinkedInPack(structured);
		const linkedin = linkedInRes.result;
		const phRes = await generateProductHuntKit(structured);
		const productHunt = phRes.result;
		const emRes = await generateEmailSequence(structured);
		const emails = emRes.result;

		let aggUsage = mergeOpenRouterUsageSnake(null, null);
		const openRouterCalls = [];
		for (const r of [extractRes, linkedInRes, phRes, emRes]) {
			aggUsage = mergeOpenRouterUsageSnake(aggUsage, r.usage);
			openRouterCalls.push({
				label: r.label,
				model: r.model,
				usage: r.usage,
				tokenUsage: r.tokenUsage,
				aiPrompt: r.aiPrompt,
			});
		}

		return c.json({
			success: true,
			structured,
			linkedin,
			productHunt,
			emails,
			usage: aggUsage,
			tokenUsage: toTokenUsageCamel(aggUsage),
			openRouterCalls,
		});
	} catch (err) {
		console.error(err);
		return c.json({ success: false, error: "Generation failed" }, 500);
	}
});

// ─── agent-browser helpers ───────────────────────────────────────────────────

const execAsync = promisify(exec);
const AGENT_BROWSER_BIN = new URL(
	"./node_modules/.bin/agent-browser",
	import.meta.url,
).pathname;

/**
 * Navigate to a URL and return the accessibility-tree markdown via agent-browser.
 * The `open` command keeps browser state alive so `snapshot` sees the navigated page.
 */
async function agentBrowserScrape(url, { timeout = 30000 } = {}) {
	const { stdout } = await execAsync(
		`"${AGENT_BROWSER_BIN}" open ${JSON.stringify(url)} && "${AGENT_BROWSER_BIN}" snapshot`,
		{ timeout, shell: true },
	);
	return stdout.trim();
}

/**
 * Navigate to a URL, take a screenshot, upload it to UploadThing, and return the public URL.
 */
async function agentBrowserScreenshot(
	url,
	{ timeout = 50000, fullPage = false } = {},
) {
	const tmpPath = path.join(os.tmpdir(), `ab-screenshot-${uuidv4()}.png`);
	const fullPageFlag = fullPage ? " --full" : "";
	await execAsync(
		`"${AGENT_BROWSER_BIN}" open ${JSON.stringify(url)} && "${AGENT_BROWSER_BIN}" screenshot${fullPageFlag} ${JSON.stringify(tmpPath)}`,
		{ timeout, shell: true },
	);
	const buffer = await fsp.readFile(tmpPath);
	await fsp.unlink(tmpPath).catch(() => {});

	const fileName = `screenshot-${Date.now()}-${uuidv4().replace(/[^a-zA-Z0-9]/g, "")}.png`;
	const utFile = new UTFile([buffer], fileName, { type: "image/png" });
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(`UploadThing upload failed: ${response.error.message}`);
	}
	return response.data.ufsUrl;
}

// ─── API Token Layer ──────────────────────────────────────────────────────────
//
// Step 1 — Token creation:   POST /api-token/create   { userId }
// Step 2 — JWT middleware:   apiTokenMiddleware  (applied to 4 agent routes below)
// Step 3 — Credit check:     verifyApiToken checks users/{userId}.credits > 0
// Step 4 — Credit deduction: middleware deducts 1 credit after each successful call

const JWT_SECRET = process.env.JWT_SECRET || "ihatereading-api-jwt-secret";
const API_TOKENS_COLL = "apiTokens";
const USERS_COLL = "users";
const API_CREDIT_COST = 1;

/** Create and persist a JWT API token for a given userId. */
async function createApiToken(userId) {
	const token = jwt.sign({ userId, type: "api_token" }, JWT_SECRET, {
		expiresIn: "1y",
	});
	await firestore
		.collection(API_TOKENS_COLL)
		.doc(userId)
		.set(
			{ token, userId, createdAt: new Date().toISOString(), isActive: true },
			{ merge: true },
		);
	return token;
}

/**
 * Verify a raw JWT token string end-to-end:
 *   1. Decode + verify JWT signature
 *   2. Confirm record in Firestore and token is active (not revoked)
 *   3. Confirm user exists and has enough credits
 */
async function verifyApiToken(token) {
	let payload;
	try {
		payload = jwt.verify(token, JWT_SECRET);
	} catch (e) {
		return {
			valid: false,
			error: "Invalid or expired API token",
			code: "INVALID_TOKEN",
		};
	}

	const { userId } = payload;
	if (!userId)
		return {
			valid: false,
			error: "Token payload missing userId",
			code: "INVALID_TOKEN",
		};

	const [tokenSnap, userSnap] = await Promise.all([
		firestore.collection(API_TOKENS_COLL).doc(userId).get(),
		firestore.collection(USERS_COLL).doc(userId).get(),
	]);

	if (!tokenSnap.exists) {
		return {
			valid: false,
			error: "API token not found — generate one via /api-token/create",
			code: "TOKEN_NOT_FOUND",
		};
	}
	const tokenData = tokenSnap.data();
	if (!tokenData.isActive) {
		return {
			valid: false,
			error: "API token has been revoked",
			code: "TOKEN_REVOKED",
		};
	}
	if (tokenData.token !== token) {
		return {
			valid: false,
			error: "Token does not match the active token for this user",
			code: "TOKEN_MISMATCH",
		};
	}
	if (!userSnap.exists) {
		return { valid: false, error: "User not found", code: "USER_NOT_FOUND" };
	}

	const { credits = 0 } = userSnap.data();
	if (credits < API_CREDIT_COST) {
		return {
			valid: false,
			error: "Insufficient credits",
			code: "NO_CREDITS",
			credits,
		};
	}

	return { valid: true, userId, credits };
}

/** Decrement the user's credit balance by API_CREDIT_COST (fire-and-forget safe). */
async function deductCredit(userId) {
	await firestore
		.collection(USERS_COLL)
		.doc(userId)
		.update({
			credits: FieldValue.increment(-API_CREDIT_COST),
			updatedAt: new Date().toISOString(),
		});
}

/**
 * Hono middleware — validates API token, attaches userId to context, and
 * deducts one credit after the downstream handler returns a 2xx response.
 */
async function apiTokenMiddleware(c, next) {
	const authHdr =
		c.req.header("Authorization") || c.req.header("authorization");
	const rawToken = authHdr?.startsWith("Bearer ")
		? authHdr.slice(7).trim()
		: authHdr?.trim();

	if (!rawToken) {
		return c.json(
			{
				error: "API token required",
				code: "MISSING_TOKEN",
				details:
					"Set Authorization: Bearer <token>. Create one via POST /api-token/create.",
			},
			401,
		);
	}

	const result = await verifyApiToken(rawToken);
	if (!result.valid) {
		return c.json(
			{
				error: result.error,
				code: result.code,
				credits: result.credits ?? undefined,
			},
			result.code === "NO_CREDITS" ? 402 : 401,
		);
	}

	c.set("userId", result.userId);
	c.set("apiCredits", result.credits);

	await next();

	// Deduct one credit after a successful (2xx) response
	if (c.res.ok) {
		deductCredit(result.userId).catch((e) =>
			console.error(
				"[api-token] credit deduction failed for",
				result.userId,
				e?.message,
			),
		);
	}
}

// ── Step 1: Token management endpoints ───────────────────────────────────────

/** POST /api-token/create — generate (or regenerate) an API token for a user. */
app.post("/api-token/create", async (c) => {
	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}
	const { userId } = body;
	if (!userId || typeof userId !== "string") {
		return c.json({ error: "userId (string) is required" }, 400);
	}
	try {
		const token = await createApiToken(userId);
		return c.json({ success: true, token, userId, expiresIn: "1 year" });
	} catch (err) {
		console.error("[api-token/create]", err?.message);
		return c.json({ error: err?.message || "Failed to create token" }, 500);
	}
});

/** POST /api-token/revoke — invalidate the active token for a user. */
app.post("/api-token/revoke", async (c) => {
	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}
	const { userId } = body;
	if (!userId || typeof userId !== "string") {
		return c.json({ error: "userId (string) is required" }, 400);
	}
	try {
		await firestore
			.collection(API_TOKENS_COLL)
			.doc(userId)
			.update({ isActive: false });
		return c.json({ success: true, message: "API token revoked" });
	} catch (err) {
		console.error("[api-token/revoke]", err?.message);
		return c.json({ error: err?.message || "Failed to revoke token" }, 500);
	}
});

/** GET /api-token/credits/:userId — check remaining credits for a user. */
app.get("/api-token/credits/:userId", async (c) => {
	const userId = c.req.param("userId");
	try {
		const snap = await firestore.collection(USERS_COLL).doc(userId).get();
		if (!snap.exists) return c.json({ error: "User not found" }, 404);
		const { credits = 0 } = snap.data();
		return c.json({ success: true, userId, credits });
	} catch (err) {
		return c.json({ error: err?.message || "Failed to fetch credits" }, 500);
	}
});

// ── Step 2: Apply apiTokenMiddleware to the 4 agent routes ───────────────────
app.use("/agent-scrape", apiTokenMiddleware);
app.use("/agent-scrape-multiple", apiTokenMiddleware);
app.use("/agent-screenshot", apiTokenMiddleware);
app.use("/agent-screenshot-multiple", apiTokenMiddleware);

// ─── agent-browser endpoints ─────────────────────────────────────────────────
app.post("/agent-scrape", async (c) => {
	const { url, timeout = 30000 } = await c.req.json();

	if (!url || !isValidURL(url)) {
		return c.json({ success: false, error: "URL is required or invalid" }, 400);
	}

	try {
		const markdown = await agentBrowserScrape(url, { timeout });
		return c.json({
			success: true,
			url,
			markdown,
			data: {},
			summary: null,
			screenshot: null,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error("❌ agent-browser scrape error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to scrape URL using agent-browser",
				details: error?.message || String(error),
				url,
			},
			500,
		);
	}
});

app.post("/agent-scrape-multiple", async (c) => {
	const { urls, timeout = 30000 } = await c.req.json();
	const MAX_URLS = 20;

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

	const results = await Promise.all(
		urls.map(async (u) => {
			const inputUrl = typeof u === "string" ? u : (u?.url ?? u);
			if (!inputUrl || !isValidURL(inputUrl)) {
				return {
					url: inputUrl || "invalid",
					success: false,
					error: "Invalid or missing URL",
					markdown: null,
					data: {},
					summary: null,
					screenshot: null,
				};
			}
			try {
				const markdown = await agentBrowserScrape(inputUrl, { timeout });
				return {
					url: inputUrl,
					success: true,
					markdown,
					data: {},
					summary: null,
					screenshot: null,
				};
			} catch (err) {
				return {
					url: inputUrl,
					success: false,
					error: err?.message || "Scraping failed",
					markdown: null,
					data: {},
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
	});
});

app.post("/agent-screenshot", async (c) => {
	const { url, timeout = 50000, fullPage = false } = await c.req.json();

	if (!url || !isValidURL(url)) {
		return c.json({ success: false, error: "URL is required or invalid" }, 400);
	}

	try {
		const screenshotUrl = await agentBrowserScreenshot(url, {
			timeout,
			fullPage,
		});
		return c.json({
			success: true,
			url,
			screenshot: screenshotUrl,
			markdown: null,
			metadata: {},
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error("❌ agent-browser screenshot error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to take screenshot using agent-browser",
				details: error?.message || String(error),
				url,
			},
			500,
		);
	}
});

app.post("/agent-screenshot-multiple", async (c) => {
	const { urls, timeout = 50000, fullPage = false } = await c.req.json();
	const MAX_URLS = 20;

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

	const list = urls.filter(
		(u) => typeof u === "string" && /^https?:\/\//i.test(u),
	);
	if (list.length === 0) {
		return c.json({ success: false, error: "No valid URLs" }, 400);
	}

	const results = await Promise.all(
		list.map(async (url) => {
			try {
				const screenshotUrl = await agentBrowserScreenshot(url, {
					timeout,
					fullPage,
				});
				return {
					url,
					success: true,
					screenshot: screenshotUrl,
					markdown: null,
					metadata: {},
				};
			} catch (err) {
				return {
					url,
					success: false,
					screenshot: null,
					markdown: null,
					metadata: null,
					error: err?.message || "Screenshot failed",
				};
			}
		}),
	);

	return c.json({
		success: true,
		results,
		timestamp: new Date().toISOString(),
	});
});

// ─── /api/codegen — URL → React / Tailwind HTML streamed codegen ─────────────
//
// POST /api/codegen?format=react|html&model=<openrouter-model-id>&outputType=reproduce|landing|app|page|mobile
// Body: { url?: string, prompt?: string, context?: string, outputType?: string, format?: "react"|"html" }
// `format` is read from the query string first, then from JSON body (use body if your client strips query params on POST).
//
// outputType:
//   reproduce (default) — clone a page; requires `url`
//   landing — full marketing landing (navbar, hero, logos, features, how-it-works, pricing, FAQ, footer + social)
//   app — single app shell: sidebar + main; React: lucide-react + framer-motion + Tailwind
//   page — lighter marketing page (hero + sections + CTA + footer)
//   mobile — mobile-first app/marketing UI (touch targets, sm/md breakpoints)
// For non-reproduce: provide `prompt` (≥10 chars) and/or `url` for optional reference scrape.
//
// Scrapes URL when present, then streams generated code as SSE:
//   data: {"delta":"..."}   — incremental chunk
//   data: [DONE]            — stream finished
//   data: {"error":"..."}   — on failure

const CODEGEN_LIGHT_THEME_RULE = `Theme: ALWAYS use a light, modern UI — white or soft gray backgrounds (bg-white, bg-slate-50), dark readable text (text-slate-900), subtle borders (border-slate-200), restrained accent colours. Do NOT ship dark mode or black page backgrounds unless the user explicitly demands it.`;

/** Prepended so the model cannot mix formats (HTML requests were returning JSX). */
const CODEGEN_CRITICAL_HTML = `CRITICAL OUTPUT FORMAT — HTML ONLY:
- Your ENTIRE response must be ONE complete HTML5 document. First line MUST be <!DOCTYPE html> (or start with <html).
- Put <script src="https://cdn.tailwindcss.com"></script> in <head> before </head>.
- FORBIDDEN: React, JSX, TypeScript, import/export, export default, function components, lucide-react, framer-motion, \`use client\`, or .tsx syntax.
- Use semantic HTML, Tailwind utility classes only, and inline SVG for icons (or Unicode symbols). Use <details>/<summary> or minimal inline <script> for interactivity if needed.

`;

const CODEGEN_CRITICAL_REACT = `CRITICAL OUTPUT FORMAT — REACT / JSX ONLY:
- Your ENTIRE response must be ONE file: a default-exported React functional component (JSX).
- FORBIDDEN: <!DOCTYPE html>, a full HTML document as the only output, or raw HTML pages without JSX/React.
- Use Tailwind utility classes. You may import from "lucide-react" and "framer-motion" when the task allows.

`;

const CODEGEN_REPRODUCE_PROMPT_REACT = `You are an expert frontend engineer specialising in pixel-accurate UI reproduction.
You are given rich data about a reference web page: its title, structured headings, paragraphs,
list items, images, OG/meta tags, CSS colour palette, font families, CSS custom properties,
and the full set of CSS/Tailwind class names used on the page.
Your job is to reproduce that page's UI as clean, production-ready React code.

${CODEGEN_LIGHT_THEME_RULE}
When the reference is light, match it. If the reference is dark, still prefer reproducing as a light-themed equivalent unless that would misrepresent the brand — then match the reference.

Rules:
- Output ONLY the raw code — no markdown fences, no explanations, no comments.
- Return a single default-exported React functional component.
- Use Tailwind CSS utility classes for all styling — no inline styles, no separate CSS files.
- Import React at the top. The component must be self-contained and renderable.
- Use the exact colours from the "Colour palette" section (convert hex/rgb to the nearest Tailwind colour or arbitrary values).
- Use the font families listed; load from Google Fonts via a <style> tag in the component if needed.
- Reproduce every major section visible in the headings/content data.
- Use the image src URLs provided — do not make up or substitute image URLs.
- Match the colour palette, spacing rhythm, and typography hierarchy as closely as possible.
- Do NOT include placeholder lorem-ipsum text — use the actual content from the page data.
- Do NOT output anything except the code itself.`;

const CODEGEN_REPRODUCE_PROMPT_HTML = `You are an expert frontend engineer specialising in pixel-accurate UI reproduction.
You are given rich data about a reference web page: its title, structured headings, paragraphs,
list items, images, OG/meta tags, CSS colour palette, font families, CSS custom properties,
and the full set of CSS/Tailwind class names used on the page.
Your job is to reproduce that page's UI as one complete HTML document with Tailwind CDN.

${CODEGEN_LIGHT_THEME_RULE}
When the reference is light, match it. If the reference is dark, still prefer a light-themed equivalent unless that would misrepresent the brand.

Rules:
- Output ONLY the raw code — no markdown fences, no explanations, no comments.
- Return a complete HTML document with <script src="https://cdn.tailwindcss.com"></script> in <head>.
- All styling must use Tailwind utility classes only.
- Reproduce every major section visible in the headings/content data.
- Use the image src URLs provided — do not make up or substitute image URLs.
- Match the colour palette, spacing rhythm, and typography hierarchy as closely as possible.
- Do NOT include placeholder lorem-ipsum text — use the actual content from the page data.
- Do NOT output anything except the code itself.`;

const CODEGEN_FORMAT_RULES = (format) =>
	format === "react"
		? `- Return ONE default-exported React functional component only.
- Tailwind CSS for all styling (no inline styles, no extra CSS files).
- import React from "react" if needed.`
		: `- Return ONE complete HTML document with <script src="https://cdn.tailwindcss.com"></script>.
- Tailwind utility classes only for styling.`;

function buildCodegenSystemPrompt(format, outputType) {
	const isHtml = format === "html";
	const critical = isHtml ? CODEGEN_CRITICAL_HTML : CODEGEN_CRITICAL_REACT;
	const fmt = CODEGEN_FORMAT_RULES(format);

	if (outputType === "reproduce") {
		return (
			critical +
			(isHtml ? CODEGEN_REPRODUCE_PROMPT_HTML : CODEGEN_REPRODUCE_PROMPT_REACT)
		);
	}
	if (outputType === "landing") {
		const stack = isHtml
			? `Stack: HTML + Tailwind CDN only. Icons: inline SVG or simple shapes. Motion: CSS transitions or @keyframes in a single <style> block if needed.`
			: `Stack: React + Tailwind. Icons: import from "lucide-react". Motion: import from "framer-motion" for subtle section animations.`;
		return `${critical}You are an expert frontend engineer building modern marketing landing pages.

${CODEGEN_LIGHT_THEME_RULE}

Output type: FULL LANDING PAGE (not a pixel clone). Build a polished, conversion-focused page using the user's instructions and any scraped reference below.

Required sections (use real-sounding copy grounded in the prompt/scrape; avoid lorem ipsum):
1. Sticky navbar — logo area, primary nav links, CTA button
2. Hero — headline, subheadline, primary + optional secondary CTA, optional hero visual area
3. Social proof — "Trusted by" / logos strip or testimonial strip
4. Features — responsive grid or bento of feature cards with icons
5. How it works — 3–4 clear steps
6. Pricing — at least two tiers or a simple comparison
7. FAQ — accordion (details/summary or simple toggles)
8. Footer — sitemap-style links, legal placeholders, social icons

${fmt}
${stack}

Rules:
- Output ONLY raw code — no markdown fences, no explanations, no comments before/after the code.
- Do NOT output anything except the code itself.`;
	}
	if (outputType === "app") {
		const stack = isHtml
			? `Stack: ONE .html file — semantic HTML, Tailwind CDN, inline SVG icons, CSS transitions for motion. Build sidebar + main layout with flex/grid. No React, no npm imports.`
			: `Stack: React + Tailwind. MUST import icons from "lucide-react". MUST import "framer-motion" for subtle motion (layout, stagger, panel transitions). One default-exported component.`;
		return `${critical}You are an expert frontend engineer building a single-screen app UI (dashboard / SaaS product shell).

${CODEGEN_LIGHT_THEME_RULE}

Output type: APP SHELL — one cohesive screen with:
- A sidebar (fixed or collapsible) with navigation items and optional user/org footer area
- Main column: top bar (title, actions) + scrollable content area
- Use clear visual hierarchy and spacing suitable for a real product

${fmt}
${stack}

Rules:
- Output ONLY raw code — no markdown fences, no explanations.
- Do NOT output anything except the code itself.`;
	}
	if (outputType === "page") {
		const stack = isHtml
			? `Stack: HTML + Tailwind CDN. Inline SVG icons. No React.`
			: `Stack: React + Tailwind. Optional lucide-react and framer-motion.`;
		return `${critical}You are an expert frontend engineer building a marketing or content page (lighter than a full landing).

${CODEGEN_LIGHT_THEME_RULE}

Output type: MARKETING PAGE — include hero, 2–3 supporting sections, strong CTA block, and a compact footer. Fewer sections than a full landing; still professional.

${fmt}
${stack}

Rules:
- Output ONLY raw code — no markdown fences, no explanations.
- Do NOT output anything except the code itself.`;
	}
	if (outputType === "mobile") {
		const stack = isHtml
			? `Stack: HTML + Tailwind CDN, mobile-first responsive classes (sm:, md:). Touch-friendly spacing. No React.`
			: `Stack: React + Tailwind + lucide-react + framer-motion; mobile-first breakpoints.`;
		return `${critical}You are an expert frontend engineer building a mobile-first UI (app or marketing).

${CODEGEN_LIGHT_THEME_RULE}

Output type: MOBILE-FIRST — prioritize max-w-md / sm breakpoints, large tap targets, readable type, bottom navigation OR slide-over menu pattern where appropriate.

${fmt}
${stack}

Rules:
- Output ONLY raw code — no markdown fences, no explanations.
- Do NOT output anything except the code itself.`;
	}
	return (
		critical +
		(isHtml ? CODEGEN_REPRODUCE_PROMPT_HTML : CODEGEN_REPRODUCE_PROMPT_REACT)
	);
}

app.post("/api/codegen", async (c) => {
	// ── Auth ──────────────────────────────────────────────────────────────────
	const authHeader =
		c.req.header("Authorization") || c.req.header("authorization");
	const authToken = authHeader?.startsWith("Bearer ")
		? authHeader.slice(7).trim()
		: authHeader?.trim();
	if (!authToken) {
		return c.json(
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details:
					"Provide a Bearer token in the Authorization header: Authorization: Bearer <token>",
			},
			401,
		);
	}

	// ── Rate limit (20 req / 10 min per IP) ──────────────────────────────────
	const CODEGEN_RATE_LIMIT = 20;
	const CODEGEN_RATE_WINDOW_MS = 10 * 60 * 1000;
	const clientIp =
		c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";

	const rl = rateLimit(clientIp, CODEGEN_RATE_LIMIT, CODEGEN_RATE_WINDOW_MS);
	if (!rl.allowed) {
		c.header("Retry-After", String(rl.retryAfter));
		c.header("X-RateLimit-Limit", String(CODEGEN_RATE_LIMIT));
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Window", "10 minutes");
		return c.json(
			{
				success: false,
				error: "Rate limit exceeded",
				message: `You have exceeded ${CODEGEN_RATE_LIMIT} requests per 10 minutes. Please retry after ${rl.retryAfter}s.`,
				retryAfter: rl.retryAfter,
				ip: clientIp,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(CODEGEN_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(rl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	// format: query string wins, then JSON body (clients often send format in body only)
	const formatRaw =
		c.req.query("format") ||
		(typeof body?.format === "string" ? body.format : "") ||
		"react";
	const format = String(formatRaw).toLowerCase().trim();
	const modelOverride = c.req.query("model") || "";

	if (format !== "react" && format !== "html") {
		return c.json({ error: 'format must be "react" or "html"' }, 400);
	}

	const {
		url: bodyUrl,
		prompt: extraPrompt = "",
		context = "",
		outputType: bodyOutputType,
	} = body;

	const outputTypeRaw =
		c.req.query("outputType") || bodyOutputType || "reproduce";
	const outputType = String(outputTypeRaw).toLowerCase().trim();
	const VALID_CODEGEN_OUTPUT_TYPES = new Set([
		"reproduce",
		"landing",
		"app",
		"page",
		"mobile",
	]);
	if (!VALID_CODEGEN_OUTPUT_TYPES.has(outputType)) {
		return c.json(
			{
				error: "Invalid outputType",
				allowed: [...VALID_CODEGEN_OUTPUT_TYPES],
				details:
					"Use reproduce (default, needs url), or landing | app | page | mobile (prompt-led; url optional).",
			},
			400,
		);
	}

	const url =
		typeof bodyUrl === "string" && bodyUrl.trim() ? bodyUrl.trim() : "";
	const promptLen = String(extraPrompt).trim().length;

	if (outputType === "reproduce") {
		if (!url || !/^https?:\/\//i.test(url)) {
			return c.json(
				{
					error:
						"A valid `url` (https://...) is required when outputType is reproduce",
				},
				400,
			);
		}
	} else if (!url && promptLen < 10) {
		return c.json(
			{
				error:
					"For outputType landing | app | page | mobile, provide a `prompt` with at least 10 characters and/or a valid `url` for optional reference scraping",
			},
			400,
		);
	} else if (url && !/^https?:\/\//i.test(url)) {
		return c.json(
			{ error: "Invalid `url` — must start with http:// or https://" },
			400,
		);
	}

	const openRouterApiKey = process.env.OPENROUTER_API_KEY;
	if (!openRouterApiKey) {
		return c.json(
			{
				error: "OpenRouter API key not configured",
				code: "MISSING_API_KEY",
				details:
					"Set OPENROUTER_API_KEY in your environment for codegen to work.",
			},
			503,
		);
	}

	// ── 1. Scrape the URL (optional for outputType !== reproduce) ───────────────
	let scrapeData = null;
	let scrapeMarkdown = "";
	let cssHints = "";

	if (url) {
		// 1a. Puppeteer scrape — semantic content, metadata, images, headings
		try {
			const scrapeResult = await scrapeSingleUrlWithPuppeteer(url, {
				includeSemanticContent: true,
				extractMetadata: true,
				includeImages: true,
				includeLinks: false,
				timeout: 30_000,
			});
			scrapeData = scrapeResult.data ?? null;
			scrapeMarkdown = scrapeResult.markdown ?? "";
		} catch (scrapeErr) {
			console.warn("[codegen] puppeteer scrape failed:", scrapeErr?.message);
		}

		// 1b. Raw HTML fetch — extract inline styles, <style> blocks, CSS variables,
		//     Tailwind/utility class names, and computed colour/font hints.
		try {
			const rawRes = await fetch(url, {
				headers: {
					"User-Agent":
						"Mozilla/5.0 (compatible; CodegenBot/1.0; +https://ihatereading.in)",
					Accept: "text/html,application/xhtml+xml",
				},
				signal: AbortSignal.timeout(15_000),
			});
			if (rawRes.ok) {
				const html = await rawRes.text();
				const dom = new JSDOM(html);
				const doc = dom.window.document;

				// Inline <style> blocks — grab first 8 KB
				const styleText = Array.from(doc.querySelectorAll("style"))
					.map((s) => s.textContent || "")
					.join("\n")
					.slice(0, 8_000);

				// CSS custom property declarations (--color-*, --font-*, etc.)
				const cssVarMatches = [
					...styleText.matchAll(/--([\w-]+)\s*:\s*([^;}{]+)/g),
				]
					.slice(0, 60)
					.map(([, name, val]) => `--${name}: ${val.trim()}`);

				// Inline style attributes on elements — capture colours & fonts
				const inlineStyles = Array.from(doc.querySelectorAll("[style]"))
					.map((el) => el.getAttribute("style") || "")
					.filter(Boolean)
					.slice(0, 50)
					.join("; ");

				// Collect all class names — useful when Tailwind/utility classes are used
				const allClasses = [
					...new Set(
						Array.from(doc.querySelectorAll("[class]")).flatMap((el) =>
							(el.getAttribute("class") || "").split(/\s+/).filter(Boolean),
						),
					),
				]
					.slice(0, 300)
					.join(" ");

				// Background / text colours declared in stylesheets
				const colourRe = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsl[a]?\([^)]+\))/g;
				const colours = [...new Set(styleText.match(colourRe) ?? [])].slice(
					0,
					30,
				);

				// Font families from CSS
				const fontRe = /font-family\s*:\s*([^;}{]+)/g;
				const fonts = [
					...new Set([...styleText.matchAll(fontRe)].map(([, f]) => f.trim())),
				].slice(0, 10);

				cssHints = [
					colours.length && `Colour palette: ${colours.join(", ")}`,
					fonts.length && `Font families: ${fonts.join(", ")}`,
					cssVarMatches.length &&
						`CSS custom properties:\n${cssVarMatches.join("\n")}`,
					allClasses && `CSS/Tailwind class names used: ${allClasses}`,
					inlineStyles &&
						`Inline styles sample: ${inlineStyles.slice(0, 1_000)}`,
				]
					.filter(Boolean)
					.join("\n\n");
			}
		} catch (cssErr) {
			console.warn("[codegen] CSS fetch failed:", cssErr?.message);
		}
	}

	// ── 2. Build the user prompt ───────────────────────────────────────────────
	const sc = scrapeData?.content?.semanticContent ?? {};

	// Structured content sections
	const headings = ["h1", "h2", "h3", "h4", "h5", "h6"]
		.flatMap((tag) =>
			(scrapeData?.content?.[tag] ?? []).map(
				(t) => `${tag.toUpperCase()}: ${t}`,
			),
		)
		.join("\n");

	const paragraphs = (sc.paragraphs ?? [])
		.filter(Boolean)
		.slice(0, 80)
		.join("\n");

	const listItems = [
		...(sc.unorderedLists ?? []).flat(),
		...(sc.orderedLists ?? []).flat(),
	]
		.filter(Boolean)
		.slice(0, 60)
		.join("\n");

	const images = (scrapeData?.images ?? [])
		.slice(0, 20)
		.map(
			(img) => `src="${img.src}" alt="${img.alt}" (${img.width}x${img.height})`,
		)
		.join("\n");

	const metadata = scrapeData?.metadata
		? Object.entries(scrapeData.metadata)
				.slice(0, 30)
				.map(([k, v]) => `${k}: ${v}`)
				.join("\n")
		: "";

	const pageContext = [
		scrapeData?.title && `Page title: ${scrapeData.title}`,
		url && `URL: ${url}`,
		metadata && `## Metadata (OG / Twitter / meta)\n${metadata}`,
		headings && `## Headings\n${headings}`,
		paragraphs && `## Paragraphs\n${paragraphs}`,
		listItems && `## List items\n${listItems}`,
		images && `## Images\n${images}`,
		scrapeMarkdown &&
			`## Full page markdown\n${scrapeMarkdown.slice(0, 6_000)}`,
		cssHints && `## CSS / Design tokens\n${cssHints}`,
	]
		.filter(Boolean)
		.join("\n\n");

	const fmtLabel =
		format === "react"
			? "a React + Tailwind CSS component"
			: "a complete Tailwind CSS HTML page";
	const taskLine =
		outputType === "reproduce"
			? `Reproduce the UI of the following web page as ${fmtLabel}.`
			: `Generate a ${outputType} experience as ${fmtLabel}. Obey the system prompt section list and stack requirements.`;
	const guideLine =
		outputType === "reproduce"
			? `Use ALL the information below — headings, content, images, colours, fonts, and class names — to make the reproduction as accurate as possible.`
			: `Ground layout and copy in the user prompt and any scraped reference below. Use coherent, professional copy (no lorem ipsum).`;

	const userMessage = [
		taskLine,
		guideLine,
		format === "html" &&
			`Reminder: respond with HTML only — <!DOCTYPE html>, Tailwind CDN in <head>, no React/JSX.`,
		pageContext || null,
		extraPrompt && `Additional instructions: ${extraPrompt}`,
		context && `Extra context: ${context}`,
	]
		.filter(Boolean)
		.join("\n\n");

	const systemPrompt = buildCodegenSystemPrompt(format, outputType);

	const model =
		modelOverride || process.env.CODEGEN_MODEL || "anthropic/claude-sonnet-4-5";

	const codegenMessages = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userMessage },
	];

	// ── 3. Stream from OpenRouter ──────────────────────────────────────────────
	let openRouterRes;
	try {
		openRouterRes = await fetch(
			"https://openrouter.ai/api/v1/chat/completions",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${openRouterApiKey}`,
					"HTTP-Referer": "https://ihatereading.in",
					"X-Title": "IHateReading Codegen",
				},
				body: JSON.stringify({
					model,
					stream: true,
					messages: codegenMessages,
					temperature: outputType === "reproduce" ? 0.2 : 0.35,
				}),
			},
		);
	} catch (fetchErr) {
		return c.json(
			{ error: `Failed to reach OpenRouter: ${fetchErr.message}` },
			502,
		);
	}

	if (!openRouterRes.ok) {
		let detail = `OpenRouter ${openRouterRes.status}`;
		try {
			const errJson = await openRouterRes.json();
			detail = errJson?.error?.message || detail;
		} catch {}
		return c.json({ error: detail }, openRouterRes.status);
	}

	// ── 4. Pipe OpenRouter SSE → client SSE ───────────────────────────────────
	const encoder = new TextEncoder();
	const upstreamReader = openRouterRes.body.getReader();
	const upstreamDecoder = new TextDecoder();

	const outputStream = new ReadableStream({
		async start(controller) {
			let sseBuffer = "";
			let streamUsageRaw = null;
			let streamModel = model;
			const sendMetaAndDone = () => {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify(
							buildOpenRouterStreamClientMeta(
								codegenMessages,
								streamUsageRaw,
								streamModel,
							),
						)}\n\n`,
					),
				);
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			};
			try {
				while (true) {
					const { done, value } = await upstreamReader.read();
					if (done) break;

					sseBuffer += upstreamDecoder.decode(value, { stream: true });
					const lines = sseBuffer.split("\n");
					sseBuffer = lines.pop(); // hold incomplete line

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed.startsWith("data: ")) continue;

						const payload = trimmed.slice(6);
						if (payload === "[DONE]") {
							sendMetaAndDone();
							return;
						}

						let parsed;
						try {
							parsed = JSON.parse(payload);
						} catch {
							continue;
						}

						// OpenRouter streams error objects inside data payloads
						if (parsed?.error) {
							controller.enqueue(
								encoder.encode(
									`data: ${JSON.stringify({ error: parsed.error.message || "OpenRouter error" })}\n\n`,
								),
							);
							controller.close();
							return;
						}

						if (parsed?.usage) streamUsageRaw = parsed.usage;
						if (parsed?.model) streamModel = parsed.model;

						const delta = parsed?.choices?.[0]?.delta?.content ?? null;
						if (delta) {
							controller.enqueue(
								encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`),
							);
						}
					}
				}

				// Stream ended without [DONE] — still signal completion
				sendMetaAndDone();
			} catch (err) {
				try {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ error: err.message })}\n\n`,
						),
					);
					controller.close();
				} catch {}
			} finally {
				upstreamReader.releaseLock();
			}
		},
	});

	return new Response(outputStream, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
			"X-Codegen-Output-Type": outputType,
			"X-Codegen-Format": format,
		},
	});
});


// ─── G2 product search — multi-page scrape + chunked LLM extraction ───────────
// POST /g2-product-search-research
// Builds URLs like: https://www.g2.com/search?page=N&query=...&product_id=...
// Scrapes each page with Puppeteer, splits markdown into LLM-sized chunks, merges & dedupes.

const G2_SEARCH_HOST = "https://www.g2.com";
const G2_PRODUCT_SEARCH_DEFAULT_PAGES = 5;
const G2_PRODUCT_SEARCH_MAX_PAGES = 50;
/** Per-chunk markdown sent to extraction model (leave room for system + instructions). */
const G2_MARKDOWN_CHUNK_CHARS = Math.min(
	26000,
	Math.max(8000, MAX_SUMMARY_INPUT_CHARS - 8000),
);
const G2_EXTRACT_MAX_TOKENS = Math.min(8192, INKGEST_SKILL_MAX_OUTPUT_TOKENS);

function buildG2SearchUrl(query, page, productId) {
	const u = new URL("/search", G2_SEARCH_HOST);
	u.searchParams.set("query", String(query).trim());
	u.searchParams.set(
		"page",
		String(Math.max(1, Math.floor(Number(page)) || 1)),
	);
	if (productId != null && String(productId).trim() !== "") {
		u.searchParams.set("product_id", String(productId).trim());
	}
	return u.toString();
}

function sliceMarkdownIntoChunks(markdown, maxChars) {
	const md = String(markdown || "");
	if (md.length <= maxChars) return md.trim() ? [md] : [];
	const chunks = [];
	let i = 0;
	while (i < md.length) {
		let end = Math.min(i + maxChars, md.length);
		if (end < md.length) {
			const cut = md.lastIndexOf("\n\n", end);
			if (cut > i + maxChars * 0.45) end = cut;
		}
		const slice = md.slice(i, end).trim();
		if (slice) chunks.push(slice);
		i = end;
	}
	return chunks.length ? chunks : [md.slice(0, maxChars)];
}

function g2ProductDedupeKey(p) {
	const url = String(p?.g2_url || p?.url || "")
		.trim()
		.toLowerCase()
		.replace(/\/$/, "");
	if (url && /^https?:\/\/(www\.)?g2\.com\//i.test(url)) return `u:${url}`;
	const name = String(p?.name || "")
		.trim()
		.toLowerCase();
	const vendor = String(p?.vendor || "")
		.trim()
		.toLowerCase();
	if (name) return `n:${vendor}|${name}`;
	return "";
}

function mergeG2ProductLists(existing, incoming) {
	const map = new Map();
	for (const p of existing) {
		const k = g2ProductDedupeKey(p);
		if (k) map.set(k, { ...p, g2_url: p.g2_url || p.url || "" });
	}
	for (const p of incoming) {
		const k = g2ProductDedupeKey(p);
		if (!k) continue;
		if (!map.has(k)) {
			map.set(k, { ...p, g2_url: p.g2_url || p.url || "" });
		}
	}
	return [...map.values()];
}

/** When markdown is empty, build rows from scrape `data.links` (same host + /products/). */
function g2NameFromProductUrl(href) {
	try {
		const m = String(href).match(/\/products\/([^/?#]+)/);
		return m ? decodeURIComponent(m[1].replace(/-/g, " ")) : "";
	} catch {
		return "";
	}
}

function g2ProductsFromScrapeData(data) {
	const links = data?.links;
	if (!Array.isArray(links)) return [];
	const out = [];
	for (const l of links) {
		const href = String(l.href || "")
			.split("#")[0]
			.trim();
		if (!/\/products\//i.test(href)) continue;
		const name =
			String(l.text || l.title || "").trim() ||
			g2NameFromProductUrl(href) ||
			"Product";
		out.push({
			name,
			g2_url: href,
			vendor: null,
			rating: null,
			review_count: null,
			description: null,
		});
	}
	return out;
}

async function g2ExtractProductsFromMarkdownChunk(
	apiKey,
	{ searchQuery, userPrompt, page, chunkIndex, totalChunks, markdown },
) {
	const system = `You extract software product listings from G2.com search results given as markdown/HTML-derived text.
Return ONLY valid JSON with shape: {"products":[...]}.
Each product object may include: name (string), vendor (string), g2_url (string, only if a full https://www.g2.com/... URL appears in the text), rating (number|null), review_count (number|null), description (string), category (string), badges (string[]), rank_on_page (number|null).
Use null for unknown numeric fields. Do not invent URLs or ratings — only what the excerpt supports. If the excerpt has no products, return {"products":[]}.`;

	const user = `Search query: ${JSON.stringify(searchQuery)}
Research focus: ${userPrompt || "List every product with available details."}
Results page index: ${page}, text part ${chunkIndex + 1} of ${totalChunks}.

--- scraped text ---
${markdown}
--- end ---`;

	const capped = user.slice(0, MAX_SUMMARY_INPUT_CHARS);
	const orExtract = await openRouterChatMessages(
		apiKey,
		[
			{ role: "system", content: system },
			{ role: "user", content: capped },
		],
		G2_EXTRACT_MAX_TOKENS,
		{ temperature: 0.15, response_format: { type: "json_object" } },
	);
	const { content } = orExtract;
	let parsed;
	try {
		parsed = JSON.parse(
			String(content || "")
				.replace(/```json|```/gi, "")
				.trim(),
		);
	} catch {
		return {
			products: [],
			usage: orExtract.usage,
			tokenUsage: orExtract.tokenUsage,
			model: orExtract.model,
			aiPrompt: orExtract.aiPrompt,
		};
	}
	const arr = parsed?.products;
	const products = Array.isArray(arr) ? arr : [];
	return {
		products,
		usage: orExtract.usage,
		tokenUsage: orExtract.tokenUsage,
		model: orExtract.model,
		aiPrompt: orExtract.aiPrompt,
	};
}

async function g2SynthesizeResearchBrief(apiKey, products, userPrompt) {
	const slim = products.map((p) => ({
		name: p.name,
		vendor: p.vendor,
		rating: p.rating,
		review_count: p.review_count,
		g2_url: p.g2_url || p.url,
	}));
	let payload = JSON.stringify(slim);
	if (payload.length > 100_000) {
		payload = payload.slice(0, 100_000) + "…";
	}
	const orSyn = await openRouterChatMessages(
		apiKey,
		[
			{
				role: "system",
				content: `You write a structured G2 market research brief in Markdown from product listing data.
Sections: ## Executive summary, ## Product landscape, ## Ratings & review volume (high level), ## Notable segments / categories, ## Research notes.
Be factual; do not invent vendors or scores not present in the data. Keep the brief readable; tables optional.`,
			},
			{
				role: "user",
				content: `User focus:\n${userPrompt || "General market overview."}\n\nProduct data (JSON):\n${payload}`,
			},
		],
		Math.min(4096, INKGEST_SKILL_MAX_OUTPUT_TOKENS),
		{ temperature: 0.25 },
	);
	return {
		brief: String(orSyn.content || "").trim(),
		usage: orSyn.usage,
		tokenUsage: orSyn.tokenUsage,
		model: orSyn.model,
		aiPrompt: orSyn.aiPrompt,
	};
}

/**
 * @param {object} opts
 * @param {(ev: object) => void} [opts.onEvent]
 */
async function runG2ProductSearchResearchPipeline(opts) {
	const {
		apiKey,
		searchQuery,
		productId,
		maxPages,
		userPrompt,
		useProxy,
		deepResearch,
		onEvent,
	} = opts;
	const emit = typeof onEvent === "function" ? onEvent : () => {};
	const pagesMeta = [];
	let allProducts = [];
	let aggUsageSnake = mergeOpenRouterUsageSnake(null, null);
	const openRouterCalls = [];

	for (let page = 1; page <= maxPages; page++) {
		const url = buildG2SearchUrl(searchQuery, page, productId);
		emit({ type: "page_start", page, url });
		let markdown = "";
		let g2Structured = [];
		try {
			const r = await scrapeSingleUrlWithPuppeteer(url, {
				includeSemanticContent: true,
				extractMetadata: true,
				includeImages: true,
				includeLinks: true,
				timeout: 55_000,
				useProxy: Boolean(useProxy),
			});
			markdown = r.markdown || "";
			g2Structured = g2ProductsFromScrapeData(r.data);
		} catch (err) {
			emit({
				type: "page_scrape_error",
				page,
				url,
				error: err?.message || String(err),
			});
			pagesMeta.push({
				page,
				url,
				scraped: false,
				error: err?.message || String(err),
				productsOnPage: 0,
			});
			continue;
		}

		const mdLen = markdown.length;
		emit({
			type: "page_scraped",
			page,
			url,
			markdownChars: mdLen,
			structuredFromLinks: g2Structured.length,
		});
		const chunks = sliceMarkdownIntoChunks(markdown, G2_MARKDOWN_CHUNK_CHARS);
		let pageProducts = mergeG2ProductLists([], g2Structured);

		for (let ci = 0; ci < chunks.length; ci++) {
			emit({
				type: "chunk_start",
				page,
				chunkIndex: ci,
				totalChunks: chunks.length,
			});
			const extracted = await g2ExtractProductsFromMarkdownChunk(apiKey, {
				searchQuery,
				userPrompt,
				page,
				chunkIndex: ci,
				totalChunks: chunks.length,
				markdown: chunks[ci],
			});
			aggUsageSnake = mergeOpenRouterUsageSnake(aggUsageSnake, extracted.usage);
			openRouterCalls.push({
				label: `g2_extract_p${page}_c${ci}`,
				usage: extracted.usage,
				tokenUsage: extracted.tokenUsage,
				model: extracted.model,
				aiPrompt: extracted.aiPrompt,
				at: new Date().toISOString(),
			});
			pageProducts = mergeG2ProductLists(pageProducts, extracted.products);
			emit({
				type: "chunk_extracted",
				page,
				chunkIndex: ci,
				extractedCount: extracted.products.length,
				runningPageTotal: pageProducts.length,
			});
		}

		allProducts = mergeG2ProductLists(allProducts, pageProducts);
		emit({
			type: "page_complete",
			page,
			url,
			products: pageProducts,
			pageProductCount: pageProducts.length,
			cumulativeUniqueCount: allProducts.length,
		});
		pagesMeta.push({
			page,
			url,
			scraped: true,
			markdownChars: mdLen,
			chunks: chunks.length,
			productsOnPage: pageProducts.length,
		});
	}

	let researchBrief = null;
	if (deepResearch && allProducts.length > 0) {
		emit({ type: "synthesis_start", productCount: allProducts.length });
		const syn = await g2SynthesizeResearchBrief(
			apiKey,
			allProducts,
			userPrompt,
		);
		researchBrief = syn.brief;
		aggUsageSnake = mergeOpenRouterUsageSnake(aggUsageSnake, syn.usage);
		openRouterCalls.push({
			label: "g2_synthesis",
			usage: syn.usage,
			tokenUsage: syn.tokenUsage,
			model: syn.model,
			aiPrompt: syn.aiPrompt,
			at: new Date().toISOString(),
		});
		emit({
			type: "synthesis_complete",
			briefChars: researchBrief?.length ?? 0,
		});
	}

	return {
		success: true,
		query: searchQuery,
		productId: productId ?? null,
		maxPages,
		pages: pagesMeta,
		products: allProducts,
		totalProducts: allProducts.length,
		researchBrief,
		...usageFieldsFromSnake(aggUsageSnake),
		openRouterCalls,
		timestamp: new Date().toISOString(),
	};
}

// POST /g2-product-search-research
// Body: {
//   query?: string,           // G2 search string (required if prompt empty)
//   prompt?: string,        // research angle; also used as query if query omitted
//   product_id?: string|number, // optional G2 filter (e.g. 23340)
//   maxPages?: number,       // 1–50, default 5
//   stream?: boolean,        // SSE: page/chunk events + final
//   deepResearch?: boolean,  // final Markdown brief from all products
//   useProxy?: boolean       // pass through to Puppeteer scrape
// }
// Auth: Bearer token (same as POST /generate/*). Requires OPENROUTER_API_KEY.
app.post("/g2-product-search-research", async (c) => {
	const authHdr =
		c.req.header("Authorization") || c.req.header("authorization");
	const authToken = authHdr?.startsWith("Bearer ")
		? authHdr.slice(7).trim()
		: authHdr?.trim();
	if (!authToken) {
		return c.json(
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details: "Provide a Bearer token in the Authorization header",
			},
			401,
		);
	}

	const G2_RATE_LIMIT = 15;
	const G2_RATE_WINDOW_MS = 10 * 60 * 1000;
	const g2Ip =
		c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";
	const g2Rl = rateLimit(g2Ip, G2_RATE_LIMIT, G2_RATE_WINDOW_MS);
	if (!g2Rl.allowed) {
		c.header("Retry-After", String(g2Rl.retryAfter));
		c.header("X-RateLimit-Limit", String(G2_RATE_LIMIT));
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Window", "10 minutes");
		return c.json(
			{
				success: false,
				error: "Rate limit exceeded",
				retryAfter: g2Rl.retryAfter,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(G2_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(g2Rl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");

	if (!process.env.OPENROUTER_API_KEY) {
		return c.json(
			{ error: "OPENROUTER_API_KEY not configured", code: "MISSING_API_KEY" },
			503,
		);
	}

	let body = {};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const queryRaw = body.query ?? body.q;
	const promptRaw = body.prompt;
	const searchQuery = String(
		(queryRaw != null && String(queryRaw).trim() !== ""
			? queryRaw
			: promptRaw) || "",
	).trim();
	if (!searchQuery) {
		return c.json(
			{ error: "Provide query or prompt with the search terms" },
			400,
		);
	}

	const userPrompt = String(promptRaw || "").trim();
	const productId = body.product_id ?? body.productId;
	let maxPages = Number(body.maxPages ?? body.pages);
	if (!Number.isFinite(maxPages) || maxPages < 1) {
		maxPages = G2_PRODUCT_SEARCH_DEFAULT_PAGES;
	}
	maxPages = Math.min(
		G2_PRODUCT_SEARCH_MAX_PAGES,
		Math.max(1, Math.floor(maxPages)),
	);

	const stream = body.stream === true || body.stream === "true";
	const deepResearch =
		body.deepResearch === true || body.deepResearch === "true";
	const useProxy = body.useProxy === true || body.useProxy === "true";

	if (stream) {
		const encoder = new TextEncoder();
		const outputStream = new ReadableStream({
			async start(controller) {
				const send = (obj) => {
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(obj)}\n\n`),
					);
				};
				try {
					send({
						type: "start",
						query: searchQuery,
						productId: productId ?? null,
						maxPages,
						deepResearch,
						chunkBudgetChars: G2_MARKDOWN_CHUNK_CHARS,
					});
					const result = await runG2ProductSearchResearchPipeline({
						apiKey: process.env.OPENROUTER_API_KEY,
						searchQuery,
						productId,
						maxPages,
						userPrompt: userPrompt || searchQuery,
						useProxy,
						deepResearch,
						onEvent: (ev) => send(ev),
					});
					send({ type: "final", ...result });
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				} catch (err) {
					try {
						send({
							type: "error",
							error: err?.message || String(err),
						});
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					} catch {}
					controller.close();
				}
			},
		});

		return new Response(outputStream, {
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			},
		});
	}

	try {
		const result = await runG2ProductSearchResearchPipeline({
			apiKey: process.env.OPENROUTER_API_KEY,
			searchQuery,
			productId,
			maxPages,
			userPrompt: userPrompt || searchQuery,
			useProxy,
			deepResearch,
		});
		return c.json(result);
	} catch (err) {
		console.error("[/g2-product-search-research]", err?.message);
		return c.json(
			{ success: false, error: err?.message || "G2 research failed" },
			500,
		);
	}
});

// ─── Asset Generation — shared skill runner ───────────────────────────────────
//
// Maps URL-friendly route :type param → SKILLS key
const ASSET_SKILL_MAP = {
	blog: "blog",
	article: "article",
	email: "newsletter",
	newsletter: "newsletter",
	linkedin: "linkedin",
	twitter: "twitter",
	substack: "substack",
	scrape: "scrape",
	invoice: "invoice",
	infographics: "infographics-svg-generator",
	table: "table",
	landing: "landing-page-generator",
	"landing-page": "landing-page-generator",
	gallery: "image-gallery-creator",
	"image-gallery": "image-gallery-creator",
};

/**
 * Scrape a list of URLs, then run the requested SKILL against the scraped sources.
 * Returns the parsed result object (content string or structured JSON depending on skill).
 */
function clampGalleryMaxImages(n) {
	const x = Number(n);
	if (!Number.isFinite(x)) return 6;
	return Math.min(10, Math.max(1, Math.floor(x)));
}

async function runSkillAsset(
	skillType,
	{
		urls = [],
		prompt = "",
		format = "substack",
		style = "casual",
		maxImages: maxImagesRaw,
	} = {},
) {
	const skill = SKILLS[skillType];
	if (!skill || skill.maxTokens <= 1) {
		throw new Error(`"${skillType}" is not a content-generation skill`);
	}

	const maxImages =
		skillType === "image-gallery-creator"
			? clampGalleryMaxImages(maxImagesRaw)
			: undefined;

	// Scrape each URL in parallel; silently drop failures
	const sources = [];
	if (urls.length > 0) {
		const settled = await Promise.allSettled(
			urls.slice(0, 10).map(async (url) => {
				const r = await scrapeSingleUrlWithPuppeteer(url, {
					includeSemanticContent: true,
					extractMetadata: true,
					includeImages: true,
					includeLinks: true,
					timeout: 30_000,
				});
				return {
					url,
					markdown: r.markdown || "",
					title: r.data?.title || "",
					links: r.data?.links || [],
					images: r.data?.images || [],
				};
			}),
		);
		for (const r of settled) {
			if (r.status !== "fulfilled") continue;
			const v = r.value;
			const hasText = Boolean(v.markdown && String(v.markdown).trim());
			const hasImgs = Array.isArray(v.images) && v.images.length > 0;
			if (hasText || hasImgs) sources.push(v);
		}
	}

	const skillOpts = skillType === "image-gallery-creator" ? { maxImages } : {};
	const system = skill.buildSystemPrompt(
		format,
		style,
		sources.length > 0,
		skillOpts,
	);
	const user = skill.buildUserContent(
		String(prompt).trim(),
		sources,
		skillOpts,
	);
	const fmt = String(format || "")
		.trim()
		.toLowerCase();
	const isJson =
		skillType === "infographics-svg-generator" ||
		skillType === "image-gallery-creator" ||
		skillType === "table" ||
		(skillType === "scrape" && fmt === "json") ||
		(skillType === "invoice" && fmt === "json");
	const maxOut = Math.min(skill.maxTokens, INKGEST_SKILL_MAX_OUTPUT_TOKENS);

	const or = await openRouterChatMessages(
		process.env.OPENROUTER_API_KEY,
		[
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		maxOut,
		isJson ? { response_format: { type: "json_object" } } : {},
	);
	const content = or.content;

	const attachOpenRouterMeta = (out) => ({
		...out,
		tokenUsage: or.tokenUsage,
		usage: or.usage,
		model: or.model,
		aiPrompt: or.aiPrompt,
	});

	if (skill.parseResponse) {
		const parsed = skill.parseResponse(content);
		if (
			skillType === "image-gallery-creator" &&
			parsed &&
			Array.isArray(parsed.images)
		) {
			parsed.images = parsed.images.slice(0, maxImages);
			parsed.maxImages = maxImages;
		}
		return attachOpenRouterMeta(parsed);
	}

	// Table: try to parse as JSON, fall back to raw string
	if (skillType === "table") {
		try {
			const j = JSON.parse(content.replace(/```json|```/gi, "").trim());
			return attachOpenRouterMeta({
				columns: j.columns || [],
				rows: j.rows || [],
			});
		} catch {
			return attachOpenRouterMeta({ content: content.trim() });
		}
	}

	// Scrape + JSON: return parsed value (json_object mode returns a JSON string)
	if (skillType === "scrape" && fmt === "json") {
		try {
			const raw = String(content || "")
				.trim()
				.replace(/```json|```/gi, "")
				.trim();
			return attachOpenRouterMeta({ content: JSON.parse(raw) });
		} catch {
			return attachOpenRouterMeta({ content: content.trim() });
		}
	}

	return attachOpenRouterMeta({ content: content.trim() });
}

// ─── POST /generate/:type ─────────────────────────────────────────────────────
// Supported :type values (see ASSET_SKILL_MAP):
//   blog | article | email | newsletter | linkedin | twitter | substack | scrape | invoice | infographics | table |
//   landing | landing-page | gallery | image-gallery |
//   image-reading | images — body: { images: [...] } (Gemini vision; same as POST /image-reading)
//
// Request body: { urls?: string[], prompt?: string, format?: string, style?: string, maxImages?: number (1–10, gallery only) }
//   scrape: format defaults to "markdown"; use markdown | html | plain | text | json (output shape follows format)
//   invoice: format defaults to "json"; use json | markdown | react | html (structured invoice + optional scraped URLs)
// Response: { success, type, skillType, urls, content|infographics|columns/rows|images|markdown, timestamp }
app.post("/generate/:type", async (c) => {
	// ── Auth ──────────────────────────────────────────────────────────────────
	const genAuthHdr =
		c.req.header("Authorization") || c.req.header("authorization");
	const genAuthToken = genAuthHdr?.startsWith("Bearer ")
		? genAuthHdr.slice(7).trim()
		: genAuthHdr?.trim();
	if (!genAuthToken) {
		return c.json(
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details: "Provide a Bearer token in the Authorization header",
			},
			401,
		);
	}

	// ── Rate limit (20 req / 10 min per IP) ──────────────────────────────────
	const GEN_RATE_LIMIT = 20;
	const GEN_RATE_WINDOW_MS = 10 * 60 * 1000;
	const genIp =
		c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";
	const genRl = rateLimit(genIp, GEN_RATE_LIMIT, GEN_RATE_WINDOW_MS);
	if (!genRl.allowed) {
		c.header("Retry-After", String(genRl.retryAfter));
		c.header("X-RateLimit-Limit", String(GEN_RATE_LIMIT));
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Window", "10 minutes");
		return c.json(
			{
				success: false,
				error: "Rate limit exceeded",
				retryAfter: genRl.retryAfter,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(GEN_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(genRl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const typeName = c.req.param("type").toLowerCase();

	// image-reading uses Gemini vision, not OpenRouter (same pipeline as POST /image-reading)
	if (typeName === "image-reading" || typeName === "images") {
		const out = await runImageReadingService(body);
		if (!out.success) {
			return c.json({ success: false, error: out.error }, out.status || 400);
		}
		return c.json({
			success: true,
			type: typeName,
			skillType: "image-reading",
			results: out.results,
			markdown: out.markdown,
			timestamp: new Date().toISOString(),
		});
	}

	const skillType = ASSET_SKILL_MAP[typeName];
	if (!skillType) {
		return c.json(
			{
				error: `Unknown type "${typeName}". Supported: image-reading, images, ${Object.keys(ASSET_SKILL_MAP).join(", ")}`,
			},
			400,
		);
	}

	if (!process.env.OPENROUTER_API_KEY) {
		return c.json(
			{ error: "OPENROUTER_API_KEY not configured", code: "MISSING_API_KEY" },
			503,
		);
	}

	const {
		urls = [],
		prompt = "",
		format: formatRaw,
		style = "casual",
		maxImages: maxImagesBody,
	} = body;
	const format =
		formatRaw != null && String(formatRaw).trim() !== ""
			? formatRaw
			: typeName === "scrape"
				? "markdown"
				: typeName === "invoice"
					? "json"
					: "substack";

	const urlList = (Array.isArray(urls) ? urls : [urls]).filter(
		(u) => typeof u === "string" && /^https?:\/\//i.test(u),
	);

	if (urlList.length === 0 && !String(prompt).trim()) {
		return c.json({ error: "Provide at least one URL or a prompt" }, 400);
	}

	try {
		const result = await runSkillAsset(skillType, {
			urls: urlList,
			prompt,
			format,
			style,
			maxImages: maxImagesBody,
		});
		return c.json({
			success: true,
			type: typeName,
			skillType,
			urls: urlList,
			...result,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		console.error(`[/generate/${typeName}]`, err?.message);
		return c.json(
			{ success: false, error: err?.message || "Generation failed" },
			500,
		);
	}
});

// ─── /ai-resume-builder — LinkedIn + GitHub + projects → streamed resume code ──
//
// POST /ai-resume-builder
// Body: {
//   linkedinUrl?:  string,        // LinkedIn profile page
//   githubUrl?:    string,        // GitHub profile (github.com/user) OR repo URL
//   projectUrls?:  string[],      // portfolio / project pages (up to 5)
//   prompt?:       string,        // extra style/colour/layout instructions
//   format?:       "react"|"html" // default "react"
// }
//
// Streams generated resume code as SSE:
//   data: {"delta":"..."}   — incremental code chunk
//   data: [DONE]            — stream complete
//   data: {"error":"..."}   — on failure

const RESUME_SYSTEM_PROMPT = `You are an elite frontend engineer specialising in beautiful, modern personal resumes and portfolio websites.
You receive structured data scraped from a person's LinkedIn profile, GitHub account, and portfolio/project pages.
Your task is to generate a stunning, fully self-contained personal resume page that showcases the person's real background.

Output rules:
- Output ONLY the raw code — no markdown fences, no explanations, no comments.
- For "react" format: a single default-exported React functional component.
  • Use Tailwind CSS utility classes for ALL styling — no inline styles, no separate CSS files.
  • Import React at the top. The component must be renderable without any props.
  • Add a Google Fonts <style> tag inside the component for any custom fonts used.
- For "html" format: a complete HTML5 document with <script src="https://cdn.tailwindcss.com"></script>.
  All styling must use Tailwind utility classes only.

Design requirements:
- Create a premium, visually distinctive layout — NOT a generic white paper resume.
- Use a bold typographic hierarchy, generous spacing, and a coherent colour palette.
- Sections to include (only if data is available): Hero/header with name + title,
  About/Summary, Work Experience (company, role, dates, description), Education,
  Skills (as visual tags or a grid), Projects (with links if available), GitHub stats
  (repos, stars, top languages), and Contact links.
- Use the person's ACTUAL data from the sources — do not invent or placeholder anything.
- Make links (<a> tags) functional using the real URLs provided.
- Do NOT output anything except the code itself.`;

/** Detect whether a GitHub URL is a user profile or a repo, returning structured info. */
function parseGitHubUrl(url) {
	try {
		const u = new URL(url);
		if (u.hostname !== "github.com") return null;
		const parts = u.pathname.replace(/^\//, "").split("/").filter(Boolean);
		if (parts.length === 1) return { type: "user", username: parts[0] };
		if (parts.length >= 2)
			return { type: "repo", owner: parts[0], repo: parts[1] };
		return null;
	} catch {
		return null;
	}
}

app.post("/ai-resume-builder", async (c) => {
	// ── Auth ──────────────────────────────────────────────────────────────────
	const resumeAuthHdr =
		c.req.header("Authorization") || c.req.header("authorization");
	const resumeAuthToken = resumeAuthHdr?.startsWith("Bearer ")
		? resumeAuthHdr.slice(7).trim()
		: resumeAuthHdr?.trim();
	if (!resumeAuthToken) {
		return c.json(
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details: "Provide a Bearer token in the Authorization header",
			},
			401,
		);
	}

	// ── Rate limit (10 req / 10 min per IP) ──────────────────────────────────
	const RESUME_RATE_LIMIT = 10;
	const RESUME_RATE_WINDOW_MS = 10 * 60 * 1000;
	const resumeIp =
		c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";
	const resumeRl = rateLimit(
		resumeIp,
		RESUME_RATE_LIMIT,
		RESUME_RATE_WINDOW_MS,
	);
	if (!resumeRl.allowed) {
		c.header("Retry-After", String(resumeRl.retryAfter));
		c.header("X-RateLimit-Limit", String(RESUME_RATE_LIMIT));
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Window", "10 minutes");
		return c.json(
			{
				success: false,
				error: "Rate limit exceeded",
				retryAfter: resumeRl.retryAfter,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(RESUME_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(resumeRl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");

	if (!process.env.OPENROUTER_API_KEY) {
		return c.json(
			{ error: "OPENROUTER_API_KEY not configured", code: "MISSING_API_KEY" },
			503,
		);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const {
		linkedinUrl = "",
		githubUrl = "",
		projectUrls = [],
		prompt: extraPrompt = "",
		format: rawFormat = "react",
	} = body;

	const format = rawFormat === "html" ? "html" : "react";

	const isValidUrl = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

	if (
		!isValidUrl(linkedinUrl) &&
		!isValidUrl(githubUrl) &&
		!projectUrls.some(isValidUrl)
	) {
		return c.json(
			{
				error: "Provide at least one of linkedinUrl, githubUrl, or projectUrls",
			},
			400,
		);
	}

	// ── 1. Scrape all sources in parallel ────────────────────────────────────
	const scrapeOpts = {
		includeSemanticContent: true,
		extractMetadata: true,
		includeImages: true,
		includeLinks: true,
		timeout: 35_000,
	};

	const contextSections = [];

	/** Scrape a URL with Puppeteer and return a formatted context block. */
	async function scrapeToContext(url, label) {
		try {
			const result = await scrapeSingleUrlWithPuppeteer(url, scrapeOpts);
			const d = result.data ?? {};
			const md = result.markdown ?? "";
			const sc = d.content?.semanticContent ?? {};

			const headings = ["h1", "h2", "h3", "h4"]
				.flatMap((t) =>
					(d.content?.[t] ?? []).map((v) => `${t.toUpperCase()}: ${v}`),
				)
				.join("\n");

			const paragraphs = (sc.paragraphs ?? [])
				.filter(Boolean)
				.slice(0, 60)
				.join("\n");
			const listItems = [
				...(sc.unorderedLists ?? []).flat(),
				...(sc.orderedLists ?? []).flat(),
			]
				.filter(Boolean)
				.slice(0, 40)
				.join("\n");

			return [
				`## ${label} — ${url}`,
				d.title && `Title: ${d.title}`,
				headings && `### Headings\n${headings}`,
				paragraphs && `### Paragraphs\n${paragraphs}`,
				listItems && `### List items\n${listItems}`,
				md && `### Full markdown (truncated)\n${md.slice(0, 5_000)}`,
			]
				.filter(Boolean)
				.join("\n\n");
		} catch (err) {
			console.warn(`[resume-builder] scrape failed for ${url}:`, err?.message);
			return `## ${label} — ${url}\n(scrape failed: ${err?.message})`;
		}
	}

	/** Fetch GitHub user data + top repos via GitHub API. */
	async function fetchGitHubUserContext(username) {
		const ghHeaders = {
			Accept: "application/vnd.github.v3+json",
			"User-Agent": "ai-resume-builder/1.0",
			...(process.env.GITHUB_TOKEN
				? { Authorization: `token ${process.env.GITHUB_TOKEN}` }
				: {}),
		};
		const lines = [`## GitHub Profile — https://github.com/${username}`];
		try {
			const userRes = await fetch(`https://api.github.com/users/${username}`, {
				headers: ghHeaders,
				signal: AbortSignal.timeout(10_000),
			});
			if (userRes.ok) {
				const u = await userRes.json();
				if (u.name) lines.push(`Name: ${u.name}`);
				if (u.bio) lines.push(`Bio: ${u.bio}`);
				if (u.company) lines.push(`Company: ${u.company}`);
				if (u.location) lines.push(`Location: ${u.location}`);
				if (u.blog) lines.push(`Website: ${u.blog}`);
				if (u.email) lines.push(`Email: ${u.email}`);
				lines.push(
					`Followers: ${u.followers ?? 0} | Following: ${u.following ?? 0} | Public repos: ${u.public_repos ?? 0}`,
				);
			}
		} catch (e) {
			lines.push(`(GitHub user API unavailable: ${e?.message})`);
		}
		try {
			const reposRes = await fetch(
				`https://api.github.com/users/${username}/repos?sort=stargazers&per_page=10&type=owner`,
				{ headers: ghHeaders, signal: AbortSignal.timeout(10_000) },
			);
			if (reposRes.ok) {
				const repos = await reposRes.json();
				if (Array.isArray(repos) && repos.length > 0) {
					lines.push("\n### Top Repositories");
					for (const r of repos.slice(0, 8)) {
						const desc = r.description ? ` — ${r.description}` : "";
						const lang = r.language ? ` [${r.language}]` : "";
						lines.push(
							`- **${r.name}**${lang}${desc} | ⭐ ${r.stargazers_count ?? 0} | ${r.html_url}`,
						);
					}
					// Collect unique languages
					const langs = [
						...new Set(repos.map((r) => r.language).filter(Boolean)),
					];
					if (langs.length > 0)
						lines.push(`\n### Languages: ${langs.join(", ")}`);
				}
			}
		} catch (e) {
			lines.push(`(GitHub repos API unavailable: ${e?.message})`);
		}
		return lines.join("\n");
	}

	/** Fetch a GitHub repo and build context via analyzeRepo. */
	async function fetchGitHubRepoContext(owner, repo) {
		const lines = [`## GitHub Repo — https://github.com/${owner}/${repo}`];
		try {
			const ast = await analyzeRepo(owner, repo, undefined, {
				maxFiles: 20,
				maxDepth: 2,
			});
			if (ast) {
				if (ast.description) lines.push(`Description: ${ast.description}`);
				if (ast.language) lines.push(`Primary language: ${ast.language}`);
				if (ast.stars) lines.push(`Stars: ${ast.stars}`);
				if (ast.topics?.length) lines.push(`Topics: ${ast.topics.join(", ")}`);
				if (ast.readme)
					lines.push(
						`\n### README (truncated)\n${String(ast.readme).slice(0, 3_000)}`,
					);
			}
		} catch (e) {
			lines.push(`(repo analysis failed: ${e?.message})`);
		}
		return lines.join("\n");
	}

	// Gather all async scrape tasks
	const tasks = [];

	if (isValidUrl(linkedinUrl)) {
		tasks.push(scrapeToContext(linkedinUrl, "LinkedIn Profile"));
	}

	if (isValidUrl(githubUrl)) {
		const parsed = parseGitHubUrl(githubUrl);
		if (parsed?.type === "user") {
			tasks.push(fetchGitHubUserContext(parsed.username));
		} else if (parsed?.type === "repo") {
			tasks.push(fetchGitHubRepoContext(parsed.owner, parsed.repo));
		} else {
			tasks.push(scrapeToContext(githubUrl, "GitHub"));
		}
	}

	const validProjects = projectUrls.filter(isValidUrl).slice(0, 5);
	for (const [i, pUrl] of validProjects.entries()) {
		tasks.push(scrapeToContext(pUrl, `Project ${i + 1}`));
	}

	const settled = await Promise.allSettled(tasks);
	for (const r of settled) {
		if (r.status === "fulfilled" && r.value) contextSections.push(r.value);
	}

	if (contextSections.length === 0) {
		return c.json(
			{
				error:
					"All scraping attempts failed — no source data to build a resume from.",
			},
			422,
		);
	}

	// ── 2. Build the full user message ───────────────────────────────────────
	const userMessage = [
		`Generate a ${format === "react" ? "React + Tailwind CSS component" : "complete Tailwind CSS HTML page"} for a personal resume/portfolio website.`,
		"Use ALL the real data provided below. Do not use placeholder or lorem-ipsum text.",
		"",
		...contextSections,
		extraPrompt && `\nExtra instructions from user: ${extraPrompt}`,
	]
		.filter((x) => x !== false && x !== undefined)
		.join("\n\n");

	const model =
		process.env.RESUME_MODEL ||
		process.env.CODEGEN_MODEL ||
		"anthropic/claude-sonnet-4-5";

	const resumeMessages = [
		{ role: "system", content: RESUME_SYSTEM_PROMPT },
		{ role: "user", content: userMessage },
	];

	// ── 3. Stream from OpenRouter ────────────────────────────────────────────
	let openRouterRes;
	try {
		openRouterRes = await fetch(
			"https://openrouter.ai/api/v1/chat/completions",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
					"HTTP-Referer": "https://ihatereading.in",
					"X-Title": "IHateReading AI Resume Builder",
				},
				body: JSON.stringify({
					model,
					stream: true,
					messages: resumeMessages,
					temperature: 0.25,
					max_tokens: 8000,
				}),
			},
		);
	} catch (fetchErr) {
		return c.json(
			{ error: `Failed to reach OpenRouter: ${fetchErr.message}` },
			502,
		);
	}

	if (!openRouterRes.ok) {
		let detail = `OpenRouter ${openRouterRes.status}`;
		try {
			const e = await openRouterRes.json();
			detail = e?.error?.message || detail;
		} catch {}
		return c.json({ error: detail }, openRouterRes.status);
	}

	// ── 4. Pipe SSE stream back to client ────────────────────────────────────
	const encoder = new TextEncoder();
	const upstreamReader = openRouterRes.body.getReader();
	const upstreamDecoder = new TextDecoder();

	const outputStream = new ReadableStream({
		async start(controller) {
			let sseBuffer = "";
			let streamUsageRaw = null;
			let streamModel = model;
			const sendMetaAndDone = () => {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify(
							buildOpenRouterStreamClientMeta(
								resumeMessages,
								streamUsageRaw,
								streamModel,
							),
						)}\n\n`,
					),
				);
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			};
			try {
				while (true) {
					const { done, value } = await upstreamReader.read();
					if (done) break;

					sseBuffer += upstreamDecoder.decode(value, { stream: true });
					const lines = sseBuffer.split("\n");
					sseBuffer = lines.pop();

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed.startsWith("data: ")) continue;
						const payload = trimmed.slice(6);
						if (payload === "[DONE]") {
							sendMetaAndDone();
							return;
						}
						let parsed;
						try {
							parsed = JSON.parse(payload);
						} catch {
							continue;
						}
						if (parsed?.error) {
							controller.enqueue(
								encoder.encode(
									`data: ${JSON.stringify({ error: parsed.error.message || "OpenRouter error" })}\n\n`,
								),
							);
							controller.close();
							return;
						}
						if (parsed?.usage) streamUsageRaw = parsed.usage;
						if (parsed?.model) streamModel = parsed.model;
						const delta = parsed?.choices?.[0]?.delta?.content ?? null;
						if (delta) {
							controller.enqueue(
								encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`),
							);
						}
					}
				}
				sendMetaAndDone();
			} catch (err) {
				try {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ error: err?.message || "Stream error" })}\n\n`,
						),
					);
					controller.close();
				} catch {}
			} finally {
				try {
					upstreamReader.releaseLock();
				} catch {}
			}
		},
	});

	return new Response(outputStream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
});

/** Response headers for /api/video-translate/* (IDs + caption URL for clients that read headers). */
function applyVideoTranslateApiHeaders(c, opts = {}) {
	const { videoTranslateId, captionUrl, cacheLanguages } = opts;
	c.header("X-Content-Type-Options", "nosniff");
	if (cacheLanguages) {
		c.header("Cache-Control", "public, max-age=86400");
	} else {
		c.header("Cache-Control", "no-store, private, max-age=0");
	}
	if (videoTranslateId) {
		c.header("X-Video-Translate-Id", String(videoTranslateId));
	}
	if (captionUrl) {
		c.header("X-Caption-Url", String(captionUrl));
	}
}

/** GET /api/video-translate/languages — supported output_language labels (OpenRouter path) */
app.get("/api/video-translate/languages", async (c) => {
	applyVideoTranslateApiHeaders(c, { cacheLanguages: true });
	return c.json(getVideoTranslateLanguagesResponse());
});

/**
 * GET /api/video-translate/caption — caption text + caption URL (VTT on UploadThing) when job is complete.
 * Default: JSON snapshot (404 until ready).
 * SSE: ?stream=1 or Accept: text/event-stream — Firestore-backed progress + final caption (or error).
 */
app.get("/api/video-translate/caption", async (c) => {
	const videoTranslateId = c.req.query("video_translate_id");
	const accept = (c.req.header("accept") || "").toLowerCase();
	const wantSse =
		c.req.query("stream") === "1" ||
		c.req.query("stream") === "true" ||
		accept.includes("text/event-stream");

	if (wantSse) {
		if (!videoTranslateId || !String(videoTranslateId).trim()) {
			return c.json(
				{
					error: "Query video_translate_id is required",
					code: "BAD_REQUEST",
				},
				400,
			);
		}
		const id = String(videoTranslateId).trim();
		applyVideoTranslateApiHeaders(c, { videoTranslateId: id });

		return streamSSE(c, async (stream) => {
			let finished = false;
			let unsubscribe = () => {};
			const finish = () => {
				if (finished) return;
				finished = true;
				try {
					unsubscribe();
				} catch {}
			};

			const timer = setTimeout(async () => {
				if (finished) return;
				finished = true;
				try {
					unsubscribe();
				} catch {}
				try {
					await stream.writeSSE({
						event: "error",
						data: JSON.stringify({
							error: "Caption wait exceeded max duration",
							code: "TIMEOUT",
						}),
					});
					await stream.writeSSE({
						event: "done",
						data: JSON.stringify({ ok: false }),
					});
				} catch {}
			}, VIDEO_TRANSLATE_CAPTION_SSE_MAX_MS);

			unsubscribe = subscribeVideoTranslateCaptionUpdates(id, (evt) => {
				void (async () => {
					try {
						if (evt.kind === "progress") {
							await stream.writeSSE({
								event: "progress",
								data: JSON.stringify({ status: evt.status }),
							});
							return;
						}
						clearTimeout(timer);
						if (evt.kind === "ready") {
							await stream.writeSSE({
								event: "caption",
								data: JSON.stringify({
									error: null,
									data: evt.data,
								}),
							});
							await stream.writeSSE({
								event: "done",
								data: JSON.stringify({ ok: true }),
							});
							finish();
							return;
						}
						if (evt.kind === "not_found") {
							await stream.writeSSE({
								event: "error",
								data: JSON.stringify({
									error: "Unknown video_translate_id",
									code: "NOT_FOUND",
								}),
							});
						} else if (evt.kind === "failed") {
							await stream.writeSSE({
								event: "error",
								data: JSON.stringify({
									error: evt.message || "Job failed",
									code: "FAILED",
								}),
							});
						} else if (evt.kind === "listener_error") {
							await stream.writeSSE({
								event: "error",
								data: JSON.stringify({
									error: evt.message || "Listener error",
									code: "LISTENER_ERROR",
								}),
							});
						}
						await stream.writeSSE({
							event: "done",
							data: JSON.stringify({ ok: false }),
						});
						finish();
					} catch (e) {
						try {
							await stream.writeSSE({
								event: "error",
								data: JSON.stringify({
									error: e?.message || "Stream error",
									code: "STREAM_ERROR",
								}),
							});
						} catch {}
						finish();
					}
				})();
			});
		});
	}

	const out = await getVideoTranslateCaptionResponse(videoTranslateId);
	const status = out.httpStatus ?? 200;
	const { httpStatus: _h, ...rest } = out;
	const capUrl = rest?.data?.caption_url;
	applyVideoTranslateApiHeaders(c, {
		videoTranslateId,
		captionUrl: capUrl,
	});
	return c.json(rest, status);
});

/** Headers for POST /api/voice-translate/text */
function applyVoiceTranslateTextHeaders(c) {
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Cache-Control", "no-store, private, max-age=0");
}

const VOICE_TRANSLATE_TEXT_POST_RATE_LIMIT = 20;
const VOICE_TRANSLATE_TEXT_POST_RATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * POST /api/voice-translate/text (and alias POST /api/video-translate/text — same handler)
 * JSON: { text | source_text, audio_url | audioUrl, languages | output_languages, include_audio?, model | llm_model, translation_engine?, tts_engine?, glossary_refinement?, piper_model?, source_nllb?, transcript_language?, source_language?, glossary_refine_model? }
 * Cost options (OpenRouter): translation_engine: llm (default) | nllb; tts_engine: openrouter (default) | piper; glossary_refinement; same hints as /api/video-translate.
 * multipart: as above; optional form fields for the same keys.
 * LLM preset (optional; default Gemini): gemini | gpt-4o-mini | sonnet | kimi | grok — see lib/translateLlmModels.js
 * Source: text only, audio URL only, or audio file (file wins over text when both sent).
 * Auth: Bearer token. `usage` / `tokenUsage` include prompt token counts only (no cost or price).
 * Flow: (1) Optional file → UploadThing. (2) translate + TTS. (3) `uploadVoiceTranslateTtsToUploadThing` → `results[].audio_url` (no base64).
 */


const handleVoiceTranslateTextPost = async (c) => {
	const vtReqId = uuidv4();
	const authHdr =
		c.req.header("Authorization") || c.req.header("authorization");
	const authToken = authHdr?.startsWith("Bearer ")
		? authHdr.slice(7).trim()
		: authHdr?.trim();
	if (!authToken) {
		return c.json(
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details: "Provide a Bearer token in the Authorization header",
			},
			401,
		);
	}

	const xff = c.req.header("x-forwarded-for");
	const vtIp =
		xff?.split(",")?.[0]?.trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";
	const rl = rateLimit(
		vtIp,
		VOICE_TRANSLATE_TEXT_POST_RATE_LIMIT,
		VOICE_TRANSLATE_TEXT_POST_RATE_WINDOW_MS,
	);
	if (!rl.allowed) {
		c.header("Retry-After", String(rl.retryAfter));
		c.header("X-RateLimit-Limit", String(VOICE_TRANSLATE_TEXT_POST_RATE_LIMIT));
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Window", "10 minutes");
		return c.json(
			{
				success: false,
				error: "Rate limit exceeded",
				retryAfter: rl.retryAfter,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(VOICE_TRANSLATE_TEXT_POST_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(rl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");
	c.header("X-Voice-Translate-Request-Id", vtReqId);

	const parseBool = (v) => v === true || v === "true" || v === "1";
	const parseLanguages = (raw) => {
		if (raw == null || raw === "") return undefined;
		if (Array.isArray(raw)) return raw;
		if (typeof raw === "string") {
			const s = raw.trim();
			if (s.startsWith("[")) {
				try {
					return JSON.parse(s);
				} catch {
					return undefined;
				}
			}
			return s.split(",").map((x) => x.trim()).filter(Boolean);
		}
		return raw;
	};

	let text;
	let audioUrl;
	let audioBuffer;
	let audioFormat;
	let languages;
	let includeAudio = true;
	let modelOpt;
	let llmModelOpt;
	let translationEngineOpt;
	let ttsEngineOpt;
	let glossaryRefinementOpt;
	let piperModelOpt;
	let sourceNllbOpt;
	let transcriptLanguageOpt;
	let sourceLanguageOpt;
	let glossaryRefineModelOpt;

	const contentType = c.req.header("content-type") || "";

	if (contentType.includes("multipart/form-data")) {
		let form;
		try {
			form = await c.req.formData();
		} catch {
			return c.json(
				{ error: "Invalid multipart/form-data payload" },
				400,
			);
		}
		const fileField = form.get("audio") || form.get("file");
		if (
			fileField &&
			typeof fileField === "object" &&
			"arrayBuffer" in fileField
		) {
			if (!process.env.UPLOADTHING_TOKEN) {
				return c.json(
					{
						error:
							"UPLOADTHING_TOKEN not configured (required to upload audio files)",
						code: "MISSING_UPLOAD_TOKEN",
					},
					503,
				);
			}
			try {
				const ab = await fileField.arrayBuffer();
				audioBuffer = Buffer.from(ab);
				const origName =
					typeof fileField.name === "string" ? fileField.name : "audio.mp3";
				audioFormat = guessAudioFormatFromFilename(origName);
				const uploadedUrl = await uploadAudioBufferToUploadThing(
					audioBuffer,
					origName,
				);
				audioUrl = uploadedUrl;
			} catch (e) {
				return c.json(
					{ error: e?.message || "Audio upload failed" },
					502,
				);
			}
		}
		if (!audioUrl) {
			audioUrl = pickAudioSourceUrlFromVoiceFormFields(form);
		}
		const tf = form.get("text");
		const sf = form.get("source_text");
		if (tf != null && String(tf).trim() !== "") text = String(tf);
		else if (sf != null) text = String(sf);
		languages = parseLanguages(form.get("languages") ?? form.get("output_languages"));
		if (form.has("include_audio")) {
			includeAudio = parseBool(form.get("include_audio"));
		}
		const mf = form.get("model");
		const lmf = form.get("llm_model");
		if (mf != null && String(mf).trim() !== "") modelOpt = String(mf).trim();
		if (lmf != null && String(lmf).trim() !== "") llmModelOpt = String(lmf).trim();
		if (form.has("translation_engine")) {
			translationEngineOpt = String(form.get("translation_engine") ?? "");
		}
		if (form.has("tts_engine")) ttsEngineOpt = String(form.get("tts_engine") ?? "");
		if (form.has("glossary_refinement")) {
			glossaryRefinementOpt = parseBool(form.get("glossary_refinement"));
		}
		if (form.has("piper_model")) {
			piperModelOpt = String(form.get("piper_model") ?? "");
		}
		if (form.has("source_nllb")) {
			sourceNllbOpt = String(form.get("source_nllb") ?? "");
		}
		if (form.has("transcript_language")) {
			transcriptLanguageOpt = String(form.get("transcript_language") ?? "");
		}
		if (form.has("source_language")) {
			sourceLanguageOpt = String(form.get("source_language") ?? "");
		}
		if (form.has("glossary_refine_model")) {
			glossaryRefineModelOpt = String(form.get("glossary_refine_model") ?? "");
		}
	} else if (contentType.includes("application/json")) {
		let body = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		text = body.text ?? body.source_text;
		audioUrl = pickAudioSourceUrlFromVoiceJsonBody(body);
		languages = body.languages ?? body.output_languages;
		if (body.include_audio != null) includeAudio = parseBool(body.include_audio);
		modelOpt = body.model;
		llmModelOpt = body.llm_model;
		translationEngineOpt = body.translation_engine;
		ttsEngineOpt = body.tts_engine;
		glossaryRefinementOpt = body.glossary_refinement;
		piperModelOpt = body.piper_model;
		sourceNllbOpt = body.source_nllb;
		transcriptLanguageOpt = body.transcript_language;
		sourceLanguageOpt = body.source_language;
		glossaryRefineModelOpt = body.glossary_refine_model;
	} else {
		return c.json(
			{
				error:
					"Unsupported Content-Type. Use application/json or multipart/form-data.",
			},
			415,
		);
	}

	const utTok = process.env.UPLOADTHING_TOKEN?.trim();
	const out = await runVoiceTranslateText({
		text,
		audioUrl: audioUrl ? String(audioUrl).trim() : undefined,
		audioBuffer,
		audioFormat,
		languages,
		includeAudio,
		model: modelOpt,
		llmModel: llmModelOpt,
		translation_engine: translationEngineOpt,
		tts_engine: ttsEngineOpt,
		glossary_refinement: glossaryRefinementOpt,
		piper_model: piperModelOpt,
		source_nllb: sourceNllbOpt,
		transcript_language: transcriptLanguageOpt,
		source_language: sourceLanguageOpt,
		glossary_refine_model: glossaryRefineModelOpt,
		afterTranslatedTts:
			includeAudio && utTok
				? (results) =>
						uploadVoiceTranslateTtsToUploadThing(
							results,
							uploadAudioBufferToUploadThing,
							vtReqId,
						)
				: undefined,
	});
	const status = out.httpStatus ?? 200;
	const { httpStatus: _h, ...rest } = out;

	applyVoiceTranslateTextHeaders(c);
	if (audioUrl && rest?.data && typeof rest.data === "object") {
		c.header("X-Audio-Input-Url", String(audioUrl).slice(0, 2048));
	}
	return c.json(rest, status);
};

app.post("/api/voice-translate/text", handleVoiceTranslateTextPost);
/** Same as /api/voice-translate/text — avoids 404 when clients use "video" instead of "voice". */
app.post("/api/video-translate/text", handleVoiceTranslateTextPost);

/**
 * POST /api/groq/voice-translate/text (alias: /api/groq/video-translate/text)
 * Same request shape as /api/voice-translate/text; uses Groq (Whisper + chat + TTS) only — no OpenRouter.
 * JSON: text or remote media URL as `audio_url` | `audioUrl` | `url` | `link` | `media_url` | `video_url`, plus `languages`.
 * Optional `model` / `llm_model` = Groq chat model id (default from GROQ_CHAT_MODEL).
 */
const handleGroqVoiceTranslateTextPost = async (c) => {
	const vtReqId = uuidv4();
	const authHdr =
		c.req.header("Authorization") || c.req.header("authorization");
	const authToken = authHdr?.startsWith("Bearer ")
		? authHdr.slice(7).trim()
		: authHdr?.trim();
	if (!authToken) {
		return c.json(
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details: "Provide a Bearer token in the Authorization header",
			},
			401,
		);
	}

	const xff = c.req.header("x-forwarded-for");
	const vtIp =
		xff?.split(",")?.[0]?.trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";
	const rl = rateLimit(
		vtIp,
		VOICE_TRANSLATE_TEXT_POST_RATE_LIMIT,
		VOICE_TRANSLATE_TEXT_POST_RATE_WINDOW_MS,
	);
	if (!rl.allowed) {
		c.header("Retry-After", String(rl.retryAfter));
		c.header("X-RateLimit-Limit", String(VOICE_TRANSLATE_TEXT_POST_RATE_LIMIT));
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Window", "10 minutes");
		return c.json(
			{
				success: false,
				error: "Rate limit exceeded",
				retryAfter: rl.retryAfter,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(VOICE_TRANSLATE_TEXT_POST_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(rl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");
	c.header("X-Voice-Translate-Request-Id", vtReqId);
	c.header("X-Translate-Engine", "groq");

	const parseLanguages = (raw) => {
		if (raw == null || raw === "") return undefined;
		if (Array.isArray(raw)) return raw;
		if (typeof raw === "string") {
			const s = raw.trim();
			if (s.startsWith("[")) {
				try {
					return JSON.parse(s);
				} catch {
					return undefined;
				}
			}
			return s.split(",").map((x) => x.trim()).filter(Boolean);
		}
		return raw;
	};

	let text;
	let audioUrl;
	let audioBuffer;
	let audioFormat;
	let languages;
	let includeAudio = true;
	let modelOpt;
	let llmModelOpt;

	const contentType = c.req.header("content-type") || "";

	if (contentType.includes("multipart/form-data")) {
		let form;
		try {
			form = await c.req.formData();
		} catch {
			return c.json(
				{ error: "Invalid multipart/form-data payload" },
				400,
			);
		}
		const fileField = form.get("audio") || form.get("file");
		if (
			fileField &&
			typeof fileField === "object" &&
			"arrayBuffer" in fileField
		) {
			if (!process.env.UPLOADTHING_TOKEN) {
				return c.json(
					{
						error:
							"UPLOADTHING_TOKEN not configured (required to upload audio files)",
						code: "MISSING_UPLOAD_TOKEN",
					},
					503,
				);
			}
			try {
				const ab = await fileField.arrayBuffer();
				audioBuffer = Buffer.from(ab);
				const origName =
					typeof fileField.name === "string" ? fileField.name : "audio.mp3";
				audioFormat = guessAudioFormatFromFilename(origName);
				const uploadedUrl = await uploadAudioBufferToUploadThing(
					audioBuffer,
					origName,
				);
				audioUrl = uploadedUrl;
			} catch (e) {
				return c.json(
					{ error: e?.message || "Audio upload failed" },
					502,
				);
			}
		}
		if (!audioUrl) {
			audioUrl = pickAudioSourceUrlFromVoiceFormFields(form);
		}
		const tf = form.get("text");
		const sf = form.get("source_text");
		if (tf != null && String(tf).trim() !== "") text = String(tf);
		else if (sf != null) text = String(sf);
		languages = parseLanguages(form.get("languages") ?? form.get("output_languages"));
		includeAudio = true;
		const mf = form.get("model");
		const lmf = form.get("llm_model");
		if (mf != null && String(mf).trim() !== "") modelOpt = String(mf).trim();
		if (lmf != null && String(lmf).trim() !== "") llmModelOpt = String(lmf).trim();
	} else if (contentType.includes("application/json")) {
		let body = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		text = body.text ?? body.source_text;
		audioUrl = pickAudioSourceUrlFromVoiceJsonBody(body);
		languages = body.languages ?? body.output_languages;
		includeAudio = true;
		modelOpt = body.model;
		llmModelOpt = body.llm_model;
	} else {
		return c.json(
			{
				error:
					"Unsupported Content-Type. Use application/json or multipart/form-data.",
			},
			415,
		);
	}

	const utTok = process.env.UPLOADTHING_TOKEN?.trim();
	const out = await runGroqVoiceTranslateText({
		text,
		audioUrl: audioUrl ? String(audioUrl).trim() : undefined,
		audioBuffer,
		audioFormat,
		languages,
		includeAudio,
		model: modelOpt,
		llmModel: llmModelOpt,
		afterTranslatedTts:
			includeAudio && utTok
				? (results) =>
						uploadGroqVoiceTranslateTtsToUploadThing(
							results,
							uploadAudioBufferToUploadThing,
							vtReqId,
						)
				: undefined,
	});
	const status = out.httpStatus ?? 200;
	const { httpStatus: _gh, ...rest } = out;

	applyVoiceTranslateTextHeaders(c);
	if (audioUrl && rest?.data && typeof rest.data === "object") {
		c.header("X-Audio-Input-Url", String(audioUrl).slice(0, 2048));
	}
	return c.json(rest, status);
};

app.post("/api/groq/voice-translate/text", handleGroqVoiceTranslateTextPost);
app.post("/api/groq/video-translate/text", handleGroqVoiceTranslateTextPost);

/** POST /api/video-translate only: per-IP sliding window (same mechanism as /generate/:type). */
const VIDEO_TRANSLATE_POST_RATE_LIMIT = 10;
const VIDEO_TRANSLATE_POST_RATE_WINDOW_MS = 10 * 60 * 1000;

function normalizeVideoUrlString(v) {
	if (v == null) return "";
	const s = String(v).trim();
	return s;
}

/** JSON body keys for a remote video URL (same for /api/video-translate and /api/groq/video-translate). */
function pickVideoUrlFromJsonBody(body) {
	if (!body || typeof body !== "object") return "";
	const keys = [
		"video_url",
		"videoUrl",
		"url",
		"video",
		"source_url",
		"sourceUrl",
		"link",
	];
	for (const k of keys) {
		if (!(k in body)) continue;
		const s = normalizeVideoUrlString(body[k]);
		if (s) return s;
	}
	return "";
}

/**
 * Multipart text fields for a video URL. `video` is only used when the value is a string
 * (file upload uses file + video fields via arrayBuffer branch above).
 */
function pickVideoUrlFromFormFields(form) {
	const keys = [
		"video_url",
		"videoUrl",
		"url",
		"source_url",
		"sourceUrl",
		"link",
	];
	for (const k of keys) {
		const raw = form.get(k);
		if (typeof raw === "string") {
			const s = normalizeVideoUrlString(raw);
			if (s) return s;
		}
	}
	const v = form.get("video");
	if (typeof v === "string") {
		const s = normalizeVideoUrlString(v);
		if (s) return s;
	}
	return "";
}

/** Remote audio (or media) URL for /api/*voice-translate/text — JSON fields. */
function pickAudioSourceUrlFromVoiceJsonBody(body) {
	if (!body || typeof body !== "object") return undefined;
	const v =
		body.audio_url ??
		body.audioUrl ??
		body.url ??
		body.link ??
		body.media_url ??
		body.mediaUrl ??
		body.video_url ??
		body.videoUrl;
	if (v == null) return undefined;
	const s = String(v).trim();
	return s || undefined;
}

function pickAudioSourceUrlFromVoiceFormFields(form) {
	const keys = [
		"audio_url",
		"audioUrl",
		"url",
		"link",
		"media_url",
		"mediaUrl",
		"video_url",
		"videoUrl",
	];
	for (const k of keys) {
		const raw = form.get(k);
		if (typeof raw === "string") {
			const s = normalizeVideoUrlString(raw);
			if (s) return s;
		}
	}
	return undefined;
}

/**
 * POST /api/video-translate
 * JSON: { video_url | videoUrl | url | video | source_url | link, output_language | output_languages, ... }
 * multipart: file or video (upload), or string URL fields above, optional output_language, etc.
 * LLM preset (optional; default Gemini): gemini | gpt-4o-mini | sonnet | kimi | grok — see lib/translateLlmModels.js
 * Cost controls: translation_engine: llm (default) | nllb; tts_engine: openrouter (default) | piper; glossary_refinement: bool;
 *   source_nllb (FLORES) or transcript_language / source_language (ISO) for NLLB source; piper_model; glossary_refine_model (OpenRouter id for glossary pass).
 * Auth: non-empty Authorization (Bearer &lt;token&gt; or raw token string). Rate limited per IP.
 */
app.post("/api/video-translate", async (c) => {
	const vtAuthHdr =
		c.req.header("Authorization") || c.req.header("authorization");
	const vtAuthToken = vtAuthHdr?.startsWith("Bearer ")
		? vtAuthHdr.slice(7).trim()
		: vtAuthHdr?.trim();
	if (!vtAuthToken) {
		return c.json(
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details: "Provide a Bearer token in the Authorization header",
			},
			401,
		);
	}

	const xff = c.req.header("x-forwarded-for");
	const vtIp =
		xff?.split(",")?.[0]?.trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";
	const vtRl = rateLimit(
		vtIp,
		VIDEO_TRANSLATE_POST_RATE_LIMIT,
		VIDEO_TRANSLATE_POST_RATE_WINDOW_MS,
	);
	if (!vtRl.allowed) {
		c.header("Retry-After", String(vtRl.retryAfter));
		c.header("X-RateLimit-Limit", String(VIDEO_TRANSLATE_POST_RATE_LIMIT));
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Window", "10 minutes");
		return c.json(
			{
				success: false,
				error: "Rate limit exceeded",
				retryAfter: vtRl.retryAfter,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(VIDEO_TRANSLATE_POST_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(vtRl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");

	const contentType = c.req.header("content-type") || "";
	let videoUrl;
	let body = {};

	const parseBool = (v) => v === true || v === "true" || v === "1";

	if (contentType.includes("multipart/form-data")) {
		let form;
		try {
			form = await c.req.formData();
		} catch {
			return c.json(
				{
					error:
						"Invalid multipart/form-data payload. Use proper multipart encoding (-F in curl) or send JSON.",
				},
				400,
			);
		}
		const fileField = form.get("file") || form.get("video");
		if (
			fileField &&
			typeof fileField === "object" &&
			"arrayBuffer" in fileField
		) {
			if (!process.env.UPLOADTHING_TOKEN) {
				return c.json(
					{
						error:
							"UPLOADTHING_TOKEN not configured (required to upload video files)",
						code: "MISSING_UPLOAD_TOKEN",
					},
					503,
				);
			}
			try {
				const ab = await fileField.arrayBuffer();
				const buf = Buffer.from(ab);
				const origName =
					typeof fileField.name === "string" ? fileField.name : "upload.mp4";
				videoUrl = await uploadVideoBufferToUploadThing(buf, origName);
			} catch (e) {
				return c.json(
					{ error: e?.message || "Video upload failed" },
					502,
				);
			}
		}
		if (!videoUrl) {
			videoUrl = pickVideoUrlFromFormFields(form);
		}
		const ol = form.get("output_language");
		const ols = form.get("output_languages");
		if (ol) body.output_language = String(ol);
		if (ols) {
			try {
				body.output_languages =
					typeof ols === "string" ? JSON.parse(ols) : ols;
			} catch {
				return c.json(
					{
						error:
							"output_languages must be a JSON array string (e.g. [\"Spanish\",\"French\"])",
					},
					400,
				);
			}
		}
		if (form.has("title")) body.title = String(form.get("title") ?? "");
		if (form.has("translate_audio_only")) {
			body.translate_audio_only = parseBool(form.get("translate_audio_only"));
		}
		if (form.has("keep_the_same_format")) {
			body.keep_the_same_format = parseBool(form.get("keep_the_same_format"));
		}
		if (form.has("mode")) body.mode = String(form.get("mode") ?? "fast");
		if (form.has("speaker_num")) {
			const n = Number(form.get("speaker_num"));
			if (!Number.isNaN(n)) body.speaker_num = n;
		}
		if (form.has("callback_id")) body.callback_id = String(form.get("callback_id") ?? "");
		if (form.has("enable_dynamic_duration")) {
			body.enable_dynamic_duration = String(
				form.get("enable_dynamic_duration") ?? "",
			);
		}
		if (form.has("brand_voice_id")) {
			body.brand_voice_id = String(form.get("brand_voice_id") ?? "");
		}
		if (form.has("callback_url")) {
			body.callback_url = String(form.get("callback_url") ?? "");
		}
		if (form.has("plan")) body.plan = String(form.get("plan") ?? "");
		if (form.has("user_plan")) body.user_plan = String(form.get("user_plan") ?? "");
		if (form.has("subscription_plan")) {
			body.subscription_plan = String(form.get("subscription_plan") ?? "");
		}
		if (form.has("tier")) body.tier = String(form.get("tier") ?? "");
		const modelField = form.get("model");
		if (modelField != null && String(modelField).trim() !== "") {
			body.model = String(modelField).trim();
		}
		const llmModelField = form.get("llm_model");
		if (llmModelField != null && String(llmModelField).trim() !== "") {
			body.llm_model = String(llmModelField).trim();
		}
		if (form.has("translation_engine")) {
			body.translation_engine = String(form.get("translation_engine") ?? "");
		}
		if (form.has("tts_engine")) {
			body.tts_engine = String(form.get("tts_engine") ?? "");
		}
		if (form.has("glossary_refinement")) {
			body.glossary_refinement = parseBool(form.get("glossary_refinement"));
		}
		if (form.has("piper_model")) {
			body.piper_model = String(form.get("piper_model") ?? "");
		}
		if (form.has("source_nllb")) {
			body.source_nllb = String(form.get("source_nllb") ?? "");
		}
		if (form.has("transcript_language")) {
			body.transcript_language = String(form.get("transcript_language") ?? "");
		}
		if (form.has("source_language")) {
			body.source_language = String(form.get("source_language") ?? "");
		}
		if (form.has("glossary_refine_model")) {
			body.glossary_refine_model = String(form.get("glossary_refine_model") ?? "");
		}
	} else if (contentType.includes("application/json")) {
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		videoUrl = pickVideoUrlFromJsonBody(body);
	} else {
		return c.json(
			{
				error: "Unsupported Content-Type. Use application/json or multipart/form-data.",
			},
			415,
		);
	}

	if (!videoUrl || !String(videoUrl).trim()) {
		return c.json(
			{
				error:
					"Provide video_url, videoUrl, url, or video (string URL), or upload a file (field: file or video)",
			},
			400,
		);
	}

	if (!body.output_language && !body.output_languages) {
		return c.json(
			{ error: "Provide output_language or output_languages" },
			400,
		);
	}
	if (body.output_language && body.output_languages) {
		return c.json(
			{ error: "Use only one of output_language or output_languages" },
			400,
		);
	}

	const payload = {
		video_url: String(videoUrl).trim(),
		translate_audio_only: body.translate_audio_only ?? false,
		keep_the_same_format: body.keep_the_same_format ?? false,
		mode: body.mode ?? "fast",
	};
	if (body.output_language) {
		payload.output_language = body.output_language;
	} else {
		payload.output_languages = body.output_languages;
	}
	if (body.title) payload.title = body.title;
	if (body.speaker_num != null && !Number.isNaN(Number(body.speaker_num))) {
		payload.speaker_num = Number(body.speaker_num);
	}
	if (body.callback_id) payload.callback_id = body.callback_id;
	if (body.enable_dynamic_duration) {
		payload.enable_dynamic_duration = body.enable_dynamic_duration;
	}
	if (body.brand_voice_id) payload.brand_voice_id = body.brand_voice_id;
	if (body.callback_url) payload.callback_url = body.callback_url;

	const out = await createVideoTranslateJobs({
		videoUrl: payload.video_url,
		body: {
			output_language: payload.output_language,
			output_languages: payload.output_languages,
			title: payload.title,
			callback_id: payload.callback_id,
			plan: body.plan,
			user_plan: body.user_plan,
			subscription_plan: body.subscription_plan,
			tier: body.tier,
			model: body.model,
			llm_model: body.llm_model,
			translation_engine: body.translation_engine,
			tts_engine: body.tts_engine,
			glossary_refinement: body.glossary_refinement,
			piper_model: body.piper_model,
			source_nllb: body.source_nllb,
			transcript_language: body.transcript_language,
			source_language: body.source_language,
			glossary_refine_model: body.glossary_refine_model,
		},
	});
	const status = out.httpStatus ?? 200;
	const { httpStatus: _h, ...rest } = out;
	const createdId =
		rest?.data?.video_translate_id ??
		(Array.isArray(rest?.data?.video_translate_ids)
			? rest.data.video_translate_ids[0]
			: null);
	applyVideoTranslateApiHeaders(c, {
		videoTranslateId: createdId,
		captionUrl: rest?.data?.caption_url,
	});
	return c.json(rest, status);
});

/**
 * POST /api/groq/video-translate
 * Same URL / output_language shape as POST /api/video-translate; jobs in `groqVideoTranslateJobs`.
 * Cost options: translation_engine: llm (default) | nllb; tts_engine: groq (default) | piper; glossary_refinement; source_nllb or transcript_language.
 */
app.post("/api/groq/video-translate", async (c) => {
	const vtAuthHdr =
		c.req.header("Authorization") || c.req.header("authorization");
	const vtAuthToken = vtAuthHdr?.startsWith("Bearer ")
		? vtAuthHdr.slice(7).trim()
		: vtAuthHdr?.trim();
	if (!vtAuthToken) {
		return c.json(
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details: "Provide a Bearer token in the Authorization header",
			},
			401,
		);
	}

	const xff = c.req.header("x-forwarded-for");
	const vtIp =
		xff?.split(",")?.[0]?.trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";
	const vtRl = rateLimit(
		vtIp,
		VIDEO_TRANSLATE_POST_RATE_LIMIT,
		VIDEO_TRANSLATE_POST_RATE_WINDOW_MS,
	);
	if (!vtRl.allowed) {
		c.header("Retry-After", String(vtRl.retryAfter));
		c.header("X-RateLimit-Limit", String(VIDEO_TRANSLATE_POST_RATE_LIMIT));
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Window", "10 minutes");
		return c.json(
			{
				success: false,
				error: "Rate limit exceeded",
				retryAfter: vtRl.retryAfter,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(VIDEO_TRANSLATE_POST_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(vtRl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");
	c.header("X-Translate-Engine", "groq");

	const contentType = c.req.header("content-type") || "";
	let videoUrl;
	let body = {};

	const parseBool = (v) => v === true || v === "true" || v === "1";

	if (contentType.includes("multipart/form-data")) {
		let form;
		try {
			form = await c.req.formData();
		} catch {
			return c.json(
				{
					error:
						"Invalid multipart/form-data payload. Use proper multipart encoding (-F in curl) or send JSON.",
				},
				400,
			);
		}
		const fileField = form.get("file") || form.get("video");
		if (
			fileField &&
			typeof fileField === "object" &&
			"arrayBuffer" in fileField
		) {
			if (!process.env.UPLOADTHING_TOKEN) {
				return c.json(
					{
						error:
							"UPLOADTHING_TOKEN not configured (required to upload video files)",
						code: "MISSING_UPLOAD_TOKEN",
					},
					503,
				);
			}
			try {
				const ab = await fileField.arrayBuffer();
				const buf = Buffer.from(ab);
				const origName =
					typeof fileField.name === "string" ? fileField.name : "upload.mp4";
				videoUrl = await uploadVideoBufferToUploadThing(buf, origName);
			} catch (e) {
				return c.json(
					{ error: e?.message || "Video upload failed" },
					502,
				);
			}
		}
		if (!videoUrl) {
			videoUrl = pickVideoUrlFromFormFields(form);
		}
		const ol = form.get("output_language");
		const ols = form.get("output_languages");
		if (ol) body.output_language = String(ol);
		if (ols) {
			try {
				body.output_languages =
					typeof ols === "string" ? JSON.parse(ols) : ols;
			} catch {
				return c.json(
					{
						error:
							"output_languages must be a JSON array string (e.g. [\"Spanish\",\"French\"])",
					},
					400,
				);
			}
		}
		if (form.has("title")) body.title = String(form.get("title") ?? "");
		if (form.has("translate_audio_only")) {
			body.translate_audio_only = parseBool(form.get("translate_audio_only"));
		}
		if (form.has("keep_the_same_format")) {
			body.keep_the_same_format = parseBool(form.get("keep_the_same_format"));
		}
		if (form.has("mode")) body.mode = String(form.get("mode") ?? "fast");
		if (form.has("speaker_num")) {
			const n = Number(form.get("speaker_num"));
			if (!Number.isNaN(n)) body.speaker_num = n;
		}
		if (form.has("callback_id")) body.callback_id = String(form.get("callback_id") ?? "");
		if (form.has("enable_dynamic_duration")) {
			body.enable_dynamic_duration = String(
				form.get("enable_dynamic_duration") ?? "",
			);
		}
		if (form.has("brand_voice_id")) {
			body.brand_voice_id = String(form.get("brand_voice_id") ?? "");
		}
		if (form.has("callback_url")) {
			body.callback_url = String(form.get("callback_url") ?? "");
		}
		if (form.has("plan")) body.plan = String(form.get("plan") ?? "");
		if (form.has("user_plan")) body.user_plan = String(form.get("user_plan") ?? "");
		if (form.has("subscription_plan")) {
			body.subscription_plan = String(form.get("subscription_plan") ?? "");
		}
		if (form.has("tier")) body.tier = String(form.get("tier") ?? "");
		const modelField = form.get("model");
		if (modelField != null && String(modelField).trim() !== "") {
			body.model = String(modelField).trim();
		}
		const llmModelField = form.get("llm_model");
		if (llmModelField != null && String(llmModelField).trim() !== "") {
			body.llm_model = String(llmModelField).trim();
		}
		if (form.has("translation_engine")) {
			body.translation_engine = String(form.get("translation_engine") ?? "");
		}
		if (form.has("tts_engine")) {
			body.tts_engine = String(form.get("tts_engine") ?? "");
		}
		if (form.has("glossary_refinement")) {
			body.glossary_refinement = parseBool(form.get("glossary_refinement"));
		}
		if (form.has("piper_model")) {
			body.piper_model = String(form.get("piper_model") ?? "");
		}
		if (form.has("source_nllb")) {
			body.source_nllb = String(form.get("source_nllb") ?? "");
		}
		if (form.has("transcript_language")) {
			body.transcript_language = String(form.get("transcript_language") ?? "");
		}
		if (form.has("source_language")) {
			body.source_language = String(form.get("source_language") ?? "");
		}
	} else if (contentType.includes("application/json")) {
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		videoUrl = pickVideoUrlFromJsonBody(body);
	} else {
		return c.json(
			{
				error: "Unsupported Content-Type. Use application/json or multipart/form-data.",
			},
			415,
		);
	}

	if (!videoUrl || !String(videoUrl).trim()) {
		return c.json(
			{
				error:
					"Provide video_url, videoUrl, url, or video (string URL), or upload a file (field: file or video)",
			},
			400,
		);
	}

	if (!body.output_language && !body.output_languages) {
		return c.json(
			{ error: "Provide output_language or output_languages" },
			400,
		);
	}
	if (body.output_language && body.output_languages) {
		return c.json(
			{ error: "Use only one of output_language or output_languages" },
			400,
		);
	}

	const payload = {
		video_url: String(videoUrl).trim(),
		translate_audio_only: body.translate_audio_only ?? false,
		keep_the_same_format: body.keep_the_same_format ?? false,
		mode: body.mode ?? "fast",
	};
	if (body.output_language) {
		payload.output_language = body.output_language;
	} else {
		payload.output_languages = body.output_languages;
	}
	if (body.title) payload.title = body.title;
	if (body.speaker_num != null && !Number.isNaN(Number(body.speaker_num))) {
		payload.speaker_num = Number(body.speaker_num);
	}
	if (body.callback_id) payload.callback_id = body.callback_id;
	if (body.enable_dynamic_duration) {
		payload.enable_dynamic_duration = body.enable_dynamic_duration;
	}
	if (body.brand_voice_id) payload.brand_voice_id = body.brand_voice_id;
	if (body.callback_url) payload.callback_url = body.callback_url;

	const out = await createGroqVideoTranslateJobs({
		videoUrl: payload.video_url,
		body: {
			output_language: payload.output_language,
			output_languages: payload.output_languages,
			title: payload.title,
			callback_id: payload.callback_id,
			plan: body.plan,
			user_plan: body.user_plan,
			subscription_plan: body.subscription_plan,
			tier: body.tier,
			model: body.model,
			llm_model: body.llm_model,
			translation_engine: body.translation_engine,
			tts_engine: body.tts_engine,
			glossary_refinement: body.glossary_refinement,
			piper_model: body.piper_model,
			source_nllb: body.source_nllb,
			transcript_language: body.transcript_language,
			source_language: body.source_language,
		},
	});
	const status = out.httpStatus ?? 200;
	const { httpStatus: _gqh, ...rest } = out;
	const createdId =
		rest?.data?.video_translate_id ??
		(Array.isArray(rest?.data?.video_translate_ids)
			? rest.data.video_translate_ids[0]
			: null);
	applyVideoTranslateApiHeaders(c, {
		videoTranslateId: createdId,
		captionUrl: rest?.data?.caption_url,
	});
	return c.json(rest, status);
});

/** GET /api/groq/video-translate/:id — Groq job status (collection groqVideoTranslateJobs) */
app.get("/api/groq/video-translate/:id", async (c) => {
	const id = c.req.param("id");
	const out = await getGroqVideoTranslateJobStatus(id);
	const status = out.httpStatus ?? 200;
	const { httpStatus: _gqh2, ...rest } = out;
	const d = rest?.data;
	applyVideoTranslateApiHeaders(c, {
		videoTranslateId: id,
		captionUrl: d?.caption_url,
	});
	return c.json(rest, status);
});

/** GET /api/video-translate/:id — job status (Firestore); transcript, caption string, caption_url when success */
app.get("/api/video-translate/:id", async (c) => {
	const id = c.req.param("id");
	const out = await getVideoTranslateJobStatus(id);
	const status = out.httpStatus ?? 200;
	const { httpStatus: _h, ...rest } = out;
	const d = rest?.data;
	applyVideoTranslateApiHeaders(c, {
		videoTranslateId: id,
		captionUrl: d?.caption_url,
	});
	return c.json(rest, status);
});

const port = 3002;
console.log(`Server is running on port ${port}`);

// Start the server
serve({
	fetch: app.fetch,
	port,
});