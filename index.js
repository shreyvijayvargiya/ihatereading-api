import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { firestore, storage } from "./firebase.js";
import dotenv from "dotenv";
import chromium from "@sparticuz/chromium";
import { createClient } from "@supabase/supabase-js";
import { performance } from "perf_hooks";
import { cpus } from "os";
import UserAgent from "user-agents";
import { v4 as uuidv4 } from "uuid";
import { JSDOM } from "jsdom";
import axios from "axios";
import { load } from "cheerio";
import { extractSemanticContentWithFormattedMarkdown } from "./lib/extractSemanticContent.js";
import { logger } from "hono/logger";
import UserAgents from "user-agents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { GoogleGenAI } from "@google/genai";
import { Resend } from "resend";
import { promises as fs } from "fs";
import NodeCache from "node-cache";
import { fetch } from "undici";

const userAgents = new UserAgent();

// Add the Imports before StealthPlugin
import("puppeteer-extra-plugin-stealth/evasions/chrome.app/index.js");
import("puppeteer-extra-plugin-stealth/evasions/chrome.csi/index.js");
import("puppeteer-extra-plugin-stealth/evasions/chrome.loadTimes/index.js");
import("puppeteer-extra-plugin-stealth/evasions/chrome.runtime/index.js");
import("puppeteer-extra-plugin-stealth/evasions/defaultArgs/index.js"); // pkg warned me this one was missing
import("puppeteer-extra-plugin-stealth/evasions/iframe.contentWindow/index.js");
import("puppeteer-extra-plugin-stealth/evasions/media.codecs/index.js");
import(
	"puppeteer-extra-plugin-stealth/evasions/navigator.hardwareConcurrency/index.js"
);
import("puppeteer-extra-plugin-stealth/evasions/navigator.languages/index.js");
import(
	"puppeteer-extra-plugin-stealth/evasions/navigator.permissions/index.js"
);
import("puppeteer-extra-plugin-stealth/evasions/navigator.plugins/index.js");
import("puppeteer-extra-plugin-stealth/evasions/navigator.vendor/index.js");
import("puppeteer-extra-plugin-stealth/evasions/navigator.webdriver/index.js");
import("puppeteer-extra-plugin-stealth/evasions/sourceurl/index.js");
import("puppeteer-extra-plugin-stealth/evasions/user-agent-override/index.js");
import("puppeteer-extra-plugin-stealth/evasions/webgl.vendor/index.js");
import(
	"puppeteer-extra-plugin-stealth/evasions/window.outerdimensions/index.js"
);

dotenv.config();

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
					(m) => m.status === "completed"
				).length,
				running: Array.from(this.metrics.values()).filter(
					(m) => m.status === "running"
				).length,
			},
		};
	}

	// Get performance summary for a specific operation type
	getOperationSummary(operationName) {
		const operations = Array.from(this.metrics.values()).filter(
			(m) => m.name === operationName && m.status === "completed"
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
					2
				)}ms`
			);
			console.log(
				`   💻 CPU: ${(metrics.cpuUsage.total / 1000000).toFixed(2)}s`
			);
			console.log(
				`   🧠 Memory: ${(metrics.memoryUsage.heapUsed / 1024 / 1024).toFixed(
					2
				)} MB`
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
			(proxy) => proxy.isHealthy && now - proxy.lastUsed > cooldownPeriod
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
					`⚠️ Proxy ${proxyHost} marked as unhealthy after ${proxy.failCount} failures`
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
		this.healthCheckInterval = setInterval(async () => {
			console.log("🔍 Running proxy health check...");
			const healthChecks = this.proxies.map((proxy) =>
				this.checkProxyHealth(proxy)
			);
			await Promise.allSettled(healthChecks);

			const healthyCount = this.proxies.filter((p) => p.isHealthy).length;
			console.log(
				`✅ Proxy health check complete: ${healthyCount}/${this.proxies.length} proxies healthy`
			);
		}, 5 * 60 * 1000); // Check every 5 minutes
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

const supabase = createClient(
	process.env.SUPABASE_URL,
	process.env.SUPABASE_KEY
);

const app = new Hono();
export const customLogger = (message, ...rest) => {
	console.log(message, ...rest);
};
app.use(logger(customLogger));

const randomDelay = async (minMs = 150, maxMs = 650) => {
	const jitter = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
	return new Promise((resolve) => setTimeout(resolve, jitter));
};

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

// Add CORS middleware
app.use(
	"*",
	cors({
		origin: [
			"http://localhost:4001",
			"http://localhost:3000",
			"http://localhost:3001",
			"https://ihatereading.in",
		], // Allow specific origins
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
		credentials: true,
	})
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
			200
		);
	} catch (err) {
		console.error(err);
		const errorMessage = err?.message ?? String(err);
		return c.json({ ok: false, error: errorMessage }, 500);
	}
});

// Health check endpoint
app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

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
				400
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
			title.replace(/\s+/g, "-")
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
				Object.fromEntries(devtoResponse.headers.entries())
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
		"-"
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
		const response = await fetch(`http://localhost:3001/scrap-url`, {
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
					listingUrl.startsWith("https://www.airbnb.co.in/rooms")
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

		// Get page info from scrap-url response
		const pageInfo = {
			title:
				scrapData.data?.pageInfo?.title ||
				scrapData.data?.title ||
				scrapData.title ||
				"Airbnb Search Results",
			url: fullUrl,
			description:
				scrapData.data?.pageInfo?.description ||
				scrapData.data?.description ||
				scrapData.description ||
				"",
		};

		scrapedData = {
			success: true,
			url: fullUrl,
			searchQuery: searchQuery,
			checkin: checkin || null,
			checkout: checkout || null,
			listings: listings,
			totalListings: listings.length,
			pageInfo: pageInfo,
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
				400
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
				400
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
							}
						);

						// Wait a bit for the location to be fully loaded
						await page.waitForTimeout(5000);

						const locationResults = await page.evaluate(() => {
							// Select the results container with role feed and aria-label with Results for ...
							const resultsContainer = Array.from(
								document.querySelectorAll('div[role="feed"]')
							).find((el) =>
								el.getAttribute("aria-label")?.includes("Results for")
							);

							if (!resultsContainer) return [];

							// Each child div under feed represents a location card
							const cards = Array.from(
								resultsContainer.querySelectorAll("div")
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
										'a[href*="https://lh3.googleusercontent.com/gps-cs-s"]'
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
				})
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
						404
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
			500
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
			`--proxy-server=http://${selectedProxy.host}:${selectedProxy.port}`
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
				"Chrome/123.0.0.0 Safari/537.36"
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
				query
			)}&setLang=${language}&count=${num}&pws=0`,
			{
				waitUntil: "domcontentloaded",
				timeout: timeout,
			}
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
			document.body
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
			500
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
			400
		);
	}

	// Define platform configurations
	const platforms = {
		google: {
			url: `https://www.google.com/search?q=${encodeURIComponent(
				query
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
				query
			)}`,
			name: "Freepik",
		},
		pinterest: {
			url: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(
				query
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
				query
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
				0
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
				500
			);
		}
	}

	// Check if platform is supported
	if (!platforms[platform]) {
		return c.json(
			{
				success: false,
				error: `Unsupported platform. Supported platforms: ${Object.keys(
					platforms
				).join(", ")}`,
			},
			400
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
				400
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
			500
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
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36"
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
			`--proxy-server=http://${selectedProxy.host}:${selectedProxy.port}`
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
				"Chrome/123.0.0.0 Safari/537.36"
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
				query
			)}&hl=${language}&gl=${country}&num=${num}&pws=0`,
			{
				waitUntil: "domcontentloaded",
				timeout: timeout,
			}
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
			document.body
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

// New Puppeteer-based URL scraping endpoint
app.post("/scrap-url-puppeteer", async (c) => {
	customLogger("Scraping URL with Puppeteer", await c.req.header());
	let {
		url,
		selectors = {}, // Custom selectors for specific elements
		waitForSelector = null, // Wait for specific element to load
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

	const isValidUrl = isValidURL(url);

	if (!url || !isValidUrl) {
		return c.json({ error: "URL is required or invalid" }, 400);
	}

	let newUrl = rewriteUrl(url);
	if (newUrl) {
		url = newUrl;
	}

	if (newUrl.includes("format=json")) {
		const data = await scrapJson(newUrl);
		return c.json({
			success: true,
			data: data,
		});
	}
	if (newUrl.includes("format=html")) {
		const html = await scrapHtml(newUrl);
		const data = dataExtractionFromHtml(html, {
			includeSemanticContent,
			includeImages,
			includeLinks,
			extractMetadata,
		});
		return c.json({
			success: true,
			data: data,
		});
	}

	let existingData;
	if (includeCache) {
		// Check if URL already exists in Supabase using an 'eq' filter for exact match
		const { data, error: fetchError } = await supabase
			.from("universo")
			.select("scraped_data, scraped_at, url, markdown, screenshot")
			.eq("url", url);

		existingData = data[0];
		if (fetchError || !existingData) {
			return c.json(
				{
					success: false,
					error: "Internal server error",
				},
				500
			);
		}
	}

	if (existingData && existingData.scraped_data) {
		// Check if cached data matches current request parameters
		const scrapedData = existingData.scraped_data;

		return c.json({
			success: true,
			data: JSON.parse(scrapedData),
			markdown: existingData?.markdown,
			markdownContent: existingData?.markdownContent,
			url: url,
			scraped_at: existingData?.scraped_at,
		});
	}

	let browser;
	let scrapedData = {};

	try {
		const puppeteerExtra = (await import("puppeteer-core")).default;
		const chromium = (await import("@sparticuz/chromium")).default;

		const maxAttempts = useProxy ? 3 : 1;
		let lastError;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			let selectedProxy = null;
			let launchArgs = [...chromium.args, "--disable-web-security"];
			const { userAgent, extraHTTPHeaders, viewport } = generateRandomHeaders();

			try {
				if (useProxy) {
					selectedProxy = proxyManager.getNextProxy();
					launchArgs.push(
						`--proxy-server=http://${selectedProxy.host}:${selectedProxy.port}`
					);
				}

				try {
					const executablePath = await chromium.executablePath();
					browser = await puppeteerExtra.launch({
						headless: true,
						args: launchArgs,
						executablePath: executablePath,
						ignoreDefaultArgs: ["--disable-extensions"],
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
							...(useProxy && selectedProxy
								? [
										`--proxy-server=http://${selectedProxy.host}:${selectedProxy.port}`,
								  ]
								: []),
						],
					});
				}

				const page = await browser.newPage();

				// Apply randomized profile
				await page.setViewport(viewport);
				await page.setUserAgent(userAgent);
				await page.setExtraHTTPHeaders(extraHTTPHeaders);

				// Per-request proxy auth
				if (useProxy && selectedProxy?.username) {
					await page.authenticate({
						username: selectedProxy.username,
						password: selectedProxy.password,
					});
				}

				// Subtle evasions beyond stealth
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
					const originalQuery = window.navigator.permissions.query;
					window.navigator.permissions.query = (parameters) =>
						parameters.name === "notifications"
							? Promise.resolve({ state: Notification.permission })
							: originalQuery(parameters);
				});

				// Enhanced resource blocking for faster loading
				let blockedResources = {
					images: 0,
					fonts: 0,
					stylesheets: 0,
					media: 0,
				};

				// Set request interception
				await page.setRequestInterception(true);
				page.on("request", (request) => {
					const resourceType = request.resourceType();
					const url = request.url().toLowerCase();

					// Block Vercel security checkpoints and bot detection
					if (
						url.includes("vercel") &&
						(url.includes("security") || url.includes("checkpoint"))
					) {
						request.abort();
						return;
					}

					// Block Cloudflare and other bot detection services
					if (
						url.includes("cloudflare") ||
						url.includes("bot-detection") ||
						url.includes("challenge")
					) {
						request.abort();
						return;
					}

					// Enhanced resource blocking when includeImages is false

					// Block all image-related resources
					if (resourceType === "image") {
						blockedResources.images++;
						request.abort();
						return;
					}

					// Block image URLs by file extension
					const imageExtensions = [
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
					const hasImageExtension = imageExtensions.some((ext) =>
						url.includes(ext)
					);
					if (hasImageExtension) {
						blockedResources.images++;
						request.abort();
						return;
					}

					// Block common image CDN and hosting services
					const imageServices = [
						"cdn",
						"images",
						"img",
						"photo",
						"pic",
						"media",
						"assets",
					];
					const hasImageService = imageServices.some((service) =>
						url.includes(service)
					);
					if (
						hasImageService &&
						(url.includes(".jpg") ||
							url.includes(".png") ||
							url.includes(".gif"))
					) {
						blockedResources.images++;
						request.abort();
						return;
					}

					// Block data URLs (base64 encoded images)
					if (url.startsWith("data:image/")) {
						blockedResources.images++;
						request.abort();
						return;
					}

					// Always block fonts and handle stylesheets gracefully for faster loading
					if (resourceType === "stylesheet") {
						blockedResources.stylesheets++;
						// Respond with empty CSS to avoid 'Could not parse CSS stylesheet' errors
						request.respond({
							status: 200,
							contentType: "text/css",
							body: "",
						});
						return;
					}
					if (resourceType === "font") {
						blockedResources.fonts++;
						request.abort();
						return;
					}

					// Block media files (videos, audio) for faster loading
					if (["media"].includes(resourceType)) {
						blockedResources.media++;
						request.abort();
						return;
					}

					request.continue();
				});

				// Navigate to URL
				const navStart = Date.now();
				let redditUrl = null;
				if (url.includes("reddit.com")) {
					redditUrl = url.endsWith("/")
						? url.slice(0, -1) + ".json"
						: url + "/.json";
					await page.goto(redditUrl, {
						waitUntil: "domcontentloaded",
						timeout: timeout,
					});
					const jsonText = await page.$eval("pre", (el) => el.textContent);
					const parsedData = await parseRedditData(jsonText, url);
					const { markdown, posts } = parsedData;

					return c.json({
						success: true,
						url: url,
						jsonText: jsonText,
						markdown: markdown,
						data: {
							posts: posts,
							url: url,
							title: "Reddit Posts",
							metadata: null,
						},
					});
				}
				await page.goto(url, {
					waitUntil: "domcontentloaded",
					timeout: timeout,
				});
				const navLatency = Date.now() - navStart;

				// Wait for specific selector if provided
				if (waitForSelector) {
					try {
						await page.waitForSelector(waitForSelector, { timeout: 10000 });
					} catch (error) {
						console.warn(
							`Selector ${waitForSelector} not found within timeout`
						);
					}
				}

				// Extract page content
				if (includeSemanticContent) {
					scrapedData = await page.evaluate(
						async (options, preProcessedContent) => {
							const data = {
								url: window.location.href,
								title: document.title,
								content: {},
								metadata: {},
								links: [],
								images: [],
								screenshot: null,
								orderedContent: preProcessedContent, // Use the pre-processed content
							};

							const selectorsToRemove = [
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

							selectorsToRemove.forEach((sel) => {
								document.querySelectorAll(sel).forEach((el) => el.remove());
							});

							[("h1", "h2", "h3", "h4", "h5", "h6")].forEach((tag) => {
								data.content[tag] = Array.from(
									document.querySelectorAll(tag)
								).map((h) => h.textContent.trim());
							});

							// Extract metadata
							if (options.extractMetadata) {
								// Meta tags
								const metaTags = document.querySelectorAll("meta");
								metaTags.forEach((meta) => {
									const name =
										meta.getAttribute("name") || meta.getAttribute("property");
									const content = meta.getAttribute("content");
									if (name && content) {
										data.metadata[name] = content;
									}
								});

								// Open Graph tags
								const ogTags = document.querySelectorAll(
									'meta[property^="og:"]'
								);
								ogTags.forEach((meta) => {
									const property = meta.getAttribute("property");
									const content = meta.getAttribute("content");
									if (property && content) {
										data.metadata[property] = content;
									}
								});

								// Twitter Card tags
								const twitterTags = document.querySelectorAll(
									'meta[name^="twitter:"]'
								);
								twitterTags.forEach((meta) => {
									const name = meta.getAttribute("name");
									const content = meta.getAttribute("content");
									if (name && content) {
										data.metadata[name] = content;
									}
								});
							}

							// Extract links
							if (options.includeLinks) {
								const links = document.querySelectorAll("a[href]");

								const currentUrl = new URL(window.location.href);
								const seedDomain = currentUrl.hostname;

								const rawLinks = Array.from(links).map((link) => ({
									text: link.textContent.trim(),
									href: link.href,
									title: link.getAttribute("title") || "",
								}));

								// Filter links by domain and remove duplicates
								const seenLinks = new Set();
								data.links = rawLinks.filter((link) => {
									// Skip if no meaningful text or title
									if (!(link?.text?.length > 0 || link?.title?.length > 0)) {
										return false;
									}

									try {
										// Check if link URL is valid and matches seed domain
										const linkUrl = new URL(link.href);
										if (linkUrl.hostname !== seedDomain) {
											return false; // Skip external links
										}
									} catch (error) {
										// Skip invalid URLs
										return false;
									}

									// Remove duplicates based on text, href, or title
									const key = `${link.text}|${link.href}|${link.title}`;
									if (seenLinks.has(key)) return false;
									seenLinks.add(key);
									return true;
								});
							}

							if (options.includeSemanticContent) {
								// Extract semantic content with optimized methods - prioritizing important content
								const extractSemanticContent = (
									selector,
									processor = (el) => el.textContent.trim()
								) => {
									const elements = document.querySelectorAll(selector);
									return elements.length > 0
										? Array.from(elements).map(processor)
										: [];
								};

								const extractTableContent = (table) => {
									const rows = Array.from(table.querySelectorAll("tr"));
									return rows
										.map((row) => {
											const cells = Array.from(
												row.querySelectorAll("td, th")
											).map((cell) => cell.textContent.trim());
											return cells.filter((cell) => cell.length > 0);
										})
										.filter((row) => row.length > 0);
								};

								const extractListContent = (list) => {
									return Array.from(list.querySelectorAll("li"))
										.map((li) => li.textContent.trim())
										.filter((item) => item.length > 0);
								};

								// Prioritized semantic content - focus on main content, skip navigation/footer/repetitive elements
								const rawSemanticContent = {
									// High priority: Main content elements
									articleContent: extractSemanticContent("article"),

									divs: extractSemanticContent("div"),

									// High priority: Core text content
									paragraphs: extractSemanticContent("p"),
									span: extractSemanticContent("span"),
									blockquotes: extractSemanticContent("blockquote"),
									codeBlocks: extractSemanticContent("code"),
									preformatted: extractSemanticContent("pre"),
									tables: extractSemanticContent("table", extractTableContent),
									unorderedLists: extractSemanticContent(
										"ul",
										extractListContent
									),
									orderedLists: extractSemanticContent(
										"ol",
										extractListContent
									),
								};

								// Remove duplicates from semantic content
								const removeDuplicates = (array) => {
									if (!Array.isArray(array)) return array;
									const seen = new Set();
									return array.filter((item) => {
										if (typeof item === "string") {
											const normalized = item.toLowerCase().trim();
											if (seen.has(normalized)) return false;
											seen.add(normalized);
											return true;
										} else if (typeof item === "object" && item !== null) {
											// Handle complex objects like tables
											const key = JSON.stringify(item);
											if (seen.has(key)) return false;
											seen.add(key);
											return true;
										}
										return true;
									});
								};

								// Apply duplicate removal to prioritized semantic content
								data.content.semanticContent = Object.fromEntries(
									Object.entries(rawSemanticContent).map(([key, value]) => [
										key,
										removeDuplicates(value),
									])
								);
							}

							// Extract images
							if (options.includeImages) {
								const images = document.querySelectorAll("img[src]");
								data.images = Array.from(images).filter((img) => {
									if (
										img.src.startsWith("data:image/") ||
										img.src.startsWith("blob:") ||
										img.src.startsWith("image:") ||
										img.src.startsWith("data:")
									) {
										return;
									}
									return {
										src: img.src,
										alt: img.alt || "",
										title: img.title || "",
										width: img.naturalWidth || img.width,
										height: img.naturalHeight || img.height,
									};
								});
							}

							// Extract custom selectors if provided
							if (
								options.selectors &&
								Object.keys(options.selectors).length > 0
							) {
								data.customSelectors = {};
								for (const [key, selector] of Object.entries(
									options.selectors
								)) {
									try {
										const elements = document.querySelectorAll(selector);
										if (elements.length === 1) {
											data.customSelectors[key] =
												elements[0].textContent.trim();
										} else if (elements.length > 1) {
											data.customSelectors[key] = Array.from(elements).map(
												(el) => el.textContent.trim()
											);
										}
									} catch (error) {
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
						}
					);
				}

				// Get page content and process with JSDOM
				const pageHtml = await page.content();
				const dom = new JSDOM(pageHtml);
				const document = dom.window.document;

				// Remove unwanted elements from JSDOM document
				const selectorsToRemove = [
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

				selectorsToRemove.forEach((sel) => {
					document.querySelectorAll(sel).forEach((el) => el.remove());
				});

				const { markdown } = extractSemanticContentWithFormattedMarkdown(
					document.body
				);

				// Optional screenshot capture and upload
				let screenshotUrl = null;
				if (takeScreenshot) {
					try {
						const screenshotBuffer = await page.screenshot({ fullPage: true });
						const uniqueFileName = `screenshots/${Date.now()}-${uuidv4().replace(
							/[^a-zA-Z0-9]/g,
							""
						)}.png`;
						const bucket = storage.bucket(process.env.FIREBASE_BUCKET);
						const file = bucket.file(
							`ihr-website-screenshot/${uniqueFileName}`
						);
						await file.save(screenshotBuffer, {
							metadata: {
								contentType: "image/png",
								cacheControl: "public, max-age=3600",
							},
						});
						await file.makePublic();
						screenshotUrl = `https://storage.googleapis.com/${process.env.FIREBASE_BUCKET}/${file.name}`;
					} catch (ssErr) {
						console.error("❌ Error taking/uploading screenshot:", ssErr);
					}
				}

				await page.close();

				// Record proxy performance
				if (useProxy && selectedProxy) {
					proxyManager.recordProxyResult(selectedProxy.host, true, navLatency);
				}

				// Store new data in Supabase
				try {
					if (!includeCache) {
						// Check if the URL already exists in the "universo" table
						const { data: existingRows, error: fetchError } = await supabase
							.from("universo")
							.select("id")
							.eq("url", url);

						let insertError = null;
						if (!fetchError && (!existingRows || existingRows.length === 0)) {
							const { error } = await supabase.from("universo").insert({
								title: scrapedData.title || "No Title",
								url: url,
								markdown: markdown,
								scraped_at: new Date().toISOString(),
								scraped_data: JSON.stringify(scrapedData),
							});
							insertError = error;
						}

						if (insertError) {
							console.error("❌ Error storing data in Supabase:", insertError);
							throw insertError;
						}
					}
				} catch (supabaseError) {
					console.error("❌ Supabase storage error:", supabaseError);
				}

				// Remove empty keys from content
				if (includeSemanticContent && scrapedData?.content) {
					removeEmptyKeys(scrapedData?.content);
				}

				let summary;
				if (aiSummary) {
					let MAX_TOKENS_LIMIT = 3000;
					const splitter = RecursiveCharacterTextSplitter.fromLanguage(
						"markdown",
						{
							separators: "\n\n",
							chunkSize: 1024,
							chunkOverlap: 128,
						}
					);
					const chunkInput = await splitter.splitText(markdown);
					const slicedChunkInput = chunkInput.slice(0, MAX_TOKENS_LIMIT);
					const chunkedMarkdown = slicedChunkInput.join("\n\n");
					const aiResponse = await genai.models.generateContent({
						model: "gemini-1.5-flash",
						contents: [
							{
								role: "user",
								parts: [
									{
										text: `Summarize the following markdown: ${chunkedMarkdown};
										The length or token count for the summary depend on the content but always lies between
										100 to 1000 tokens
										
										`,
									},
								],
							},
						],
					});
					summary = aiResponse.candidates[0].content.parts[0].text;
				}

				return c.json({
					success: true,
					summary: summary,
					data: scrapedData,
					url: url,
					markdown: markdown,
					screenshot: screenshotUrl,
					timestamp: new Date().toISOString(),
				});
			} catch (attemptError) {
				lastError = attemptError;
				if (useProxy && selectedProxy) {
					proxyManager.recordProxyResult(selectedProxy.host, false);
				}
				try {
					if (browser) await browser.close();
				} catch {}
				// Backoff before retrying
				if (attempt < maxAttempts) {
					await randomDelay(300, 1200);
					continue;
				}
				throw attemptError;
			}
		}
	} catch (error) {
		console.error("❌ Web scraping error (Puppeteer):", error);

		return c.json(
			{
				success: false,
				error: "Failed to scrape URL using Puppeteer",
				details: "Unable to scrap, check URL",
				url: url,
			},
			500
		);
	} finally {
		if (browser) {
			await browser.close();
		}
	}
});

// Take Screenshot API Endpoint
app.post("/take-screenshot", async (c) => {
	try {
		const {
			url,
			fullPage,
			coords,
			waitForSelector,
			timeout = 50000,
			device = "desktop",
		} = await c.req.json();

		if (!url) {
			return c.json(
				{
					success: false,
					error: "URL is required",
				},
				400
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
				400
			);
		}

		// Capture website screenshot

		try {
			// Import puppeteer-core and chromium
			const puppeteer = await import("puppeteer-core");
			const chromium = (await import("@sparticuz/chromium")).default;

			let browser;
			let scrapedData;

			// Try to launch browser with @sparticuz/chromium first
			try {
				const executablePath = await chromium.executablePath();

				browser = await puppeteer.launch({
					headless: true,
					args: chromium.args,
					executablePath: executablePath,
					ignoreDefaultArgs: ["--disable-extensions"],
				});
			} catch (chromiumError) {
				// Fallback: try to use system Chrome or let puppeteer find a browser
				browser = await puppeteer.launch({
					headless: true,
					executablePath:
						"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					args: [
						"--no-sandbox",
						"--disable-setuid-sandbox",
						"--disable-dev-shm-usage",
						"--disable-gpu",
						"--disable-web-security",
					],
				});
			}

			const page = await browser.newPage();

			const viewportMapping = {
				desktop: {
					width: 1920,
					height: 1080,
					scale: 1,
				},
				tablet: {
					width: 1024,
					height: 768,
					scale: 1,
				},
				mobile: {
					width: 375,
					height: 667,
					scale: 1,
				},
			};

			const viewport = viewportMapping[device];

			// Set viewport and user agent
			await page.setViewport(viewport);
			await page.setUserAgent(userAgents.random().toString());

			// Set extra headers
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

			// Set request interception
			await page.setRequestInterception(true);
			await page.setJavaScriptEnabled(true);
			page.on("request", (request) => {
				request.continue();
			});

			// Navigate to URL
			await page.goto(url, {
				waitUntil: "domcontentloaded",
				timeout: timeout,
			});

			// Wait for specific selector if provided
			if (waitForSelector) {
				try {
					await page.waitForSelector(waitForSelector, { timeout: 10000 });
				} catch (error) {
					console.warn(`Selector ${waitForSelector} not found within timeout`);
				}
			}

			// INSERT_YOUR_CODE
			// Determine screenshot options based on input
			let screenshotOptions = {
				optimizeForSpeed: true,
				encoding: "binary",
			};

			if (typeof fullPage !== "undefined" && fullPage) {
				// If fullPage is present and true, set only fullPage, do not set clip
				screenshotOptions.fullPage = true;
			} else if (
				typeof coords !== "undefined" &&
				coords &&
				typeof coords.x === "number" &&
				typeof coords.y === "number" &&
				typeof coords.width === "number" &&
				typeof coords.height === "number"
			) {
				// If coords are present, set clip and do not set fullPage
				screenshotOptions.clip = {
					x: coords.x,
					y: coords.y,
					width: coords.width,
					height: coords.height,
				};
			} else {
				// Default to viewport screenshot
				screenshotOptions.clip = {
					x: 0,
					y: 0,
					width: viewport.width,
					height: viewport.height,
				};
			}
			const screenshotBuffer = await page.screenshot(screenshotOptions);

			const pageHtml = await page.content();
			const dom = new JSDOM(pageHtml);
			const document = dom.window.document;

			// Remove unwanted elements from JSDOM document
			const selectorsToRemove = [
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

			selectorsToRemove.forEach((sel) => {
				document.querySelectorAll(sel).forEach((el) => el.remove());
			});

			const { markdown } = extractSemanticContentWithFormattedMarkdown(
				document.body
			);

			// Extract page content
			scrapedData = await page.evaluate(async () => {
				const data = {
					url: window.location.href,
					metadata: {},
				};

				// Meta tags
				const metaTags = document.querySelectorAll("meta");
				metaTags.forEach((meta) => {
					const name =
						meta.getAttribute("name") || meta.getAttribute("property");
					const content = meta.getAttribute("content");
					if (name && content) {
						data.metadata[name] = content;
					}
				});

				// Open Graph tags
				const ogTags = document.querySelectorAll('meta[property^="og:"]');
				ogTags.forEach((meta) => {
					const property = meta.getAttribute("property");
					const content = meta.getAttribute("content");
					if (property && content) {
						data.metadata[property] = content;
					}
				});

				// Twitter Card tags
				const twitterTags = document.querySelectorAll('meta[name^="twitter:"]');
				twitterTags.forEach((meta) => {
					const name = meta.getAttribute("name");
					const content = meta.getAttribute("content");
					if (name && content) {
						data.metadata[name] = content;
					}
				});

				return data;
			});

			await page.close();

			// Generate a unique filename for Supabase storage
			const uniqueFileName = `screenshots/${Date.now()}-${uuidv4().replace(
				/[^a-zA-Z0-9]/g,
				""
			)}.png`;

			// Upload to Firebase storage
			const bucket = storage.bucket(process.env.FIREBASE_BUCKET);
			const file = bucket.file(`ihr-website-screenshot/${uniqueFileName}`);

			try {
				await file.save(screenshotBuffer, {
					metadata: {
						contentType: "image/png",
						cacheControl: "public, max-age=3600",
					},
				});

				// Make the file publicly accessible
				await file.makePublic();

				// Get the public URL
				const screenshotUrl = `https://storage.googleapis.com/${process.env.FIREBASE_BUCKET}/${file.name}`;

				return c.json(
					{
						success: true,
						url: url,
						markdown: markdown,
						metadata: scrapedData.metadata,
						screenshot: screenshotUrl,
						timestamp: new Date().toISOString(),
					},
					200
				);
			} catch (firebaseError) {
				console.error("❌ Error uploading to Firebase storage:", firebaseError);

				return c.json(
					{
						success: false,
						error: "Failed to upload screenshot to Firebase storage",
						details: firebaseError.message,
					},
					500
				);
			}
		} catch (captureError) {
			console.error("❌ Error capturing screenshot:", captureError);

			return c.json(
				{
					success: false,
					error: "Failed to capture screenshot",
					details: captureError.message,
				},
				500
			);
		}
	} catch (error) {
		console.error("❌ Screenshot API error:", error);
		return c.json(
			{
				success: false,
				error: "Internal server error",
				details: error.message,
			},
			500
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
				400
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
				400
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
						200
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
						200
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
						200
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
					200
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
					200
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
				200
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
			500
		);
	}
});

app.post("/crawl-take-screenshots", async (c) => {
	try {
		const {
			url,
			maxUrls = 10,
			waitForSelector,
			timeout = 30000,
		} = await c.req.json();

		if (!url) {
			return c.json(
				{
					success: false,
					error: "URL is required",
				},
				400
			);
		}

		// Validate URL format
		let seedUrl;
		try {
			seedUrl = new URL(url);
		} catch (error) {
			return c.json(
				{
					success: false,
					error: "Invalid URL format",
				},
				400
			);
		}

		const domain = seedUrl.hostname;
		const crawledUrls = new Set();

		try {
			// Import puppeteer-core and chromium
			const puppeteer = await import("puppeteer-core");
			const chromium = (await import("@sparticuz/chromium")).default;

			let browser;
			let page;

			// Try to launch browser with @sparticuz/chromium first
			try {
				const executablePath = await chromium.executablePath();

				browser = await puppeteer.launch({
					headless: true,
					args: chromium.args,
					executablePath: executablePath,
					ignoreDefaultArgs: ["--disable-extensions"],
				});
			} catch (chromiumError) {
				// Fallback: try to use system Chrome or let puppeteer find a browser
				browser = await puppeteer.launch({
					headless: true,
					executablePath:
						"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					args: [
						"--no-sandbox",
						"--disable-setuid-sandbox",
						"--disable-dev-shm-usage",
						"--disable-gpu",
						"--disable-web-security",
					],
				});
			}

			page = await browser.newPage();

			// Set viewport and user agent
			await page.setViewport({ width: 1920, height: 1080 });
			await page.setUserAgent(userAgents.random().toString());

			// Set extra headers
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

			// Set request interception
			await page.setRequestInterception(true);
			await page.setJavaScriptEnabled(true);
			page.on("request", (request) => {
				request.continue();
			});

			// Function to crawl and collect URLs
			const crawlPage = async (currentUrl) => {
				if (crawledUrls.size >= maxUrls) return;

				try {
					await page.goto(currentUrl, {
						waitUntil: "domcontentloaded",
						timeout: timeout,
					});

					// Wait for specific selector if provided
					if (waitForSelector) {
						try {
							await page.waitForSelector(waitForSelector, { timeout: 10000 });
						} catch (error) {
							console.warn(
								`Selector ${waitForSelector} not found within timeout`
							);
						}
					}

					// Extract all links from the page
					const links = await page.evaluate((domain) => {
						const anchors = Array.from(document.querySelectorAll("a[href]"));
						const urls = new Set();

						// Define extensions and patterns to exclude
						const excludedExtensions = [
							".pdf",
							".doc",
							".docx",
							".xls",
							".xlsx",
							".ppt",
							".pptx",
							".zip",
							".rar",
							".7z",
							".tar",
							".gz",
							".jpg",
							".jpeg",
							".png",
							".gif",
							".bmp",
							".svg",
							".webp",
							".ico",
							".mp4",
							".avi",
							".mov",
							".wmv",
							".flv",
							".webm",
							".mp3",
							".wav",
							".flac",
							".aac",
							".ogg",
							".css",
							".js",
							".json",
							".xml",
							".txt",
							".csv",
							".exe",
							".dmg",
							".pkg",
							".deb",
							".rpm",
							".apk",
							".ipa",
							".app",
							".bin",
						];

						anchors.forEach((anchor) => {
							try {
								const href = anchor.getAttribute("href");
								if (!href) return;

								// Skip data URLs and javascript URLs
								if (
									href.startsWith("data:") ||
									href.startsWith("javascript:") ||
									href.startsWith("mailto:") ||
									href.startsWith("tel:")
								) {
									return;
								}

								// Handle relative URLs
								const url = new URL(href, window.location.href);

								// Only include URLs from the same domain
								if (url.hostname !== domain) return;

								// Skip URLs with excluded extensions
								const pathname = url.pathname.toLowerCase();
								const hasExcludedExtension = excludedExtensions.some((ext) =>
									pathname.endsWith(ext)
								);
								if (hasExcludedExtension) return;

								// Skip URLs with fragments only (same page anchors)
								if (url.pathname === "" && url.search === "" && url.hash !== "")
									return;

								urls.add(url.href);
							} catch (e) {
								// Skip invalid URLs
							}
						});

						return Array.from(urls);
					}, domain);

					// Add current URL to crawled set
					crawledUrls.add(currentUrl);

					// Add new URLs to crawl queue (up to maxUrls)
					for (const link of links) {
						if (crawledUrls.size >= maxUrls) break;
						if (!crawledUrls.has(link)) {
							crawledUrls.add(link);
						}
					}

					return links;
				} catch (error) {
					console.error(`Error crawling ${currentUrl}:`, error);
					return [];
				}
			};

			// Start crawling from the seed URL
			await crawlPage(url);

			// Take screenshots of all crawled URLs
			const screenshotPromises = Array.from(crawledUrls).map(
				async (crawlUrl) => {
					try {
						const response = await fetch(`${origin}/take-screenshot`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								url: crawlUrl,
								waitForSelector: waitForSelector,
								timeout: timeout,
							}),
						});

						const data = await response.json();

						return {
							url: crawlUrl,
							screenshot: data.screenshot,
							metadata: data.metadata,
							markdown: data.markdown,
							success: data.success,
						};
					} catch (error) {
						console.error(`Error taking screenshot for ${crawlUrl}:`, error);
						return {
							url: crawlUrl,
							screenshot: null,
							metadata: null,
							success: false,
							error: error.message,
						};
					}
				}
			);

			// Wait for all screenshots to complete
			const screenshotResults = await Promise.all(screenshotPromises);

			await page.close();
			await browser.close();

			return c.json({
				success: true,
				seedUrl: url,
				domain: domain,
				crawledUrls: Array.from(crawledUrls),
				totalUrls: crawledUrls.size,
				results: screenshotResults,
				timestamp: new Date().toISOString(),
			});
		} catch (captureError) {
			console.error("❌ Error in crawl-screenshots:", captureError);

			return c.json(
				{
					success: false,
					crawledUrls: crawledUrls,
					error: "Failed to crawl and take screenshots",
					details: captureError.message,
				},
				500
			);
		}
	} catch (error) {
		console.error("❌ Crawl-screenshots API error:", error);
		return c.json(
			{
				success: false,
				error: "Internal server error",
				details: error.message,
			},
			500
		);
	}
});

app.post("/crawl-url", async (c) => {
	try {
		const {
			url,
			maxUrls = 5,
			allowSeedDomains = false,
			waitForSelector,
			timeout = 60000,
		} = await c.req.json();

		if (!url) {
			return c.json(
				{
					success: false,
					error: "URL is required",
				},
				400
			);
		}

		// Validate URL format
		let seedUrl;
		try {
			seedUrl = new URL(url);
		} catch (error) {
			return c.json(
				{
					success: false,
					error: "Invalid URL format",
				},
				400
			);
		}

		const domain = seedUrl.hostname;
		const crawledUrls = new Set();

		try {
			// Import puppeteer-core and chromium
			const puppeteer = await import("puppeteer-core");
			const chromium = (await import("@sparticuz/chromium")).default;

			let browser;
			let page;

			// Try to launch browser with @sparticuz/chromium first
			try {
				const executablePath = await chromium.executablePath();

				browser = await puppeteer.launch({
					headless: true,
					args: chromium.args,
					executablePath: executablePath,
					ignoreDefaultArgs: ["--disable-extensions"],
				});
			} catch (chromiumError) {
				// Fallback: try to use system Chrome or let puppeteer find a browser
				browser = await puppeteer.launch({
					headless: true,
					executablePath:
						"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					args: [
						"--no-sandbox",
						"--disable-setuid-sandbox",
						"--disable-dev-shm-usage",
						"--disable-gpu",
						"--disable-web-security",
					],
				});
			}

			page = await browser.newPage();

			// Set viewport and user agent
			await page.setViewport({ width: 1920, height: 1080 });
			await page.setUserAgent(userAgents.random().toString());

			// Set extra headers
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

			// Set request interception
			await page.setRequestInterception(true);
			await page.setJavaScriptEnabled(true);
			page.on("request", (request) => {
				request.continue();
			});

			// Function to crawl and collect URLs
			const crawlPage = async (currentUrl) => {
				if (crawledUrls.size >= maxUrls) return;

				try {
					await page.goto(currentUrl, {
						waitUntil: "domcontentloaded",
						timeout: timeout,
					});

					// Wait for specific selector if provided
					if (waitForSelector) {
						try {
							await page.waitForSelector(waitForSelector, { timeout: 10000 });
						} catch (error) {
							console.warn(
								`Selector ${waitForSelector} not found within timeout`
							);
						}
					}

					// Extract all links from the page
					const links = await page.evaluate((domain) => {
						const anchors = Array.from(document.querySelectorAll("a[href]"));
						const urls = new Set();

						// Define extensions and patterns to exclude
						const excludedExtensions = [
							".pdf",
							".doc",
							".docx",
							".xls",
							".xlsx",
							".ppt",
							".pptx",
							".zip",
							".rar",
							".7z",
							".tar",
							".gz",
							".jpg",
							".jpeg",
							".png",
							".gif",
							".bmp",
							".svg",
							".webp",
							".ico",
							".mp4",
							".avi",
							".mov",
							".wmv",
							".flv",
							".webm",
							".mp3",
							".wav",
							".flac",
							".aac",
							".ogg",
							".css",
							".js",
							".json",
							".xml",
							".txt",
							".csv",
							".exe",
							".dmg",
							".pkg",
							".deb",
							".rpm",
							".apk",
							".ipa",
							".app",
							".bin",
						];

						anchors.forEach((anchor) => {
							try {
								const href = anchor.getAttribute("href");
								if (!href) return;

								// Skip data URLs and javascript URLs
								if (
									href.startsWith("data:") ||
									href.startsWith("javascript:") ||
									href.startsWith("mailto:") ||
									href.startsWith("tel:")
								) {
									return;
								}

								// Handle relative URLs
								const url = new URL(href, window.location.href);

								// Only include URLs from the same domain
								if (url.hostname !== domain && allowSeedDomains) return;

								// Skip URLs with excluded extensions
								const pathname = url.pathname.toLowerCase();
								// const hasExcludedExtension = excludedExtensions.some((ext) =>
								// 	pathname.endsWith(ext)
								// );
								// if (hasExcludedExtension) return;

								// Skip URLs with fragments only (same page anchors)
								if (url.pathname === "" && url.search === "" && url.hash !== "")
									return;

								urls.add(url.href);
							} catch (e) {
								// Skip invalid URLs
							}
						});

						return Array.from(urls);
					}, domain);

					// Add current URL to crawled set
					crawledUrls.add(currentUrl);

					// Add new URLs to crawl queue (up to maxUrls)
					for (const link of links) {
						if (crawledUrls.size >= maxUrls) break;
						if (!crawledUrls.has(link)) {
							crawledUrls.add(link);
						}
					}

					return links;
				} catch (error) {
					console.error(`Error crawling ${currentUrl}:`, error);
					return [];
				}
			};

			// Start crawling from the seed URL
			await crawlPage(url);

			await page.close();
			await browser.close();

			return c.json({
				success: true,
				seedUrl: url,
				domain: domain,
				crawledUrls: Array.from(crawledUrls),
				totalUrls: crawledUrls.size,
				timestamp: new Date().toISOString(),
			});
		} catch (captureError) {
			console.error("❌ Error in crawl-screenshots:", captureError);

			return c.json(
				{
					success: false,
					crawledUrls: crawledUrls,
					error: "Failed to crawl and take screenshots",
					details: captureError.message,
				},
				500
			);
		}
	} catch (error) {
		console.error("❌ Crawl-screenshots API error:", error);
		return c.json(
			{
				success: false,
				error: "Internal server error",
				details: error.message,
			},
			500
		);
	}
});

const parseRedditData = (data, url) => {
	console.log(data, "data");
	if (!data || !data.data || !data.data.children) {
		return { markdown: "No Reddit data found", posts: [] };
	}

	const posts = [];
	let markdown = `# Reddit Posts from ${url}\n\n`;

	data.data.children.forEach((child, index) => {
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
				postData.upvoteRatio * 100
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
		0
	)}\n`;
	markdown += `- **Total Comments:** ${posts.reduce(
		(sum, post) => sum + post.numComments,
		0
	)}\n`;
	markdown += `- **Average Score:** ${Math.round(
		posts.reduce((sum, post) => sum + post.score, 0) / posts.length
	)}\n`;
	markdown += `- **Average Upvote Ratio:** ${Math.round(
		(posts.reduce((sum, post) => sum + post.upvoteRatio, 0) / posts.length) *
			100
	)}%\n`;

	return { markdown, posts };
};

app.post("/scrap-reddit", async (c) => {
	try {
		const { url } = await c.req.json();

		const proxy = proxyManager.getNextProxy();
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

		// Parse Reddit JSON and create LLM-friendly markdown
		const parsedData = await parseRedditData(jsonUrl, url);

		try {
			// Fetch Reddit JSON data with enhanced bot detection bypass and proxy support
			const response = await axios.get(jsonUrl, {
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
					Accept: "application/json, text/plain, */*",
					"Accept-Language": "en-US,en;q=0.9",
					"Accept-Encoding": "gzip, deflate, br",
					"Cache-Control": "no-cache",
					Pragma: "no-cache",
					"Sec-Ch-Ua":
						'"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
					"Sec-Ch-Ua-Mobile": "?0",
					"Sec-Ch-Ua-Platform": '"Windows"',
					"Sec-Fetch-Dest": "empty",
					"Sec-Fetch-Mode": "cors",
					"Sec-Fetch-Site": "same-origin",
					DNT: "1",
					Connection: "keep-alive",
					Referer: "https://www.reddit.com/",
					Origin: "https://www.reddit.com",
					"X-Requested-With": "XMLHttpRequest",
					"X-Forwarded-For": "192.168.1.1",
					"X-Real-IP": "192.168.1.1",
					"CF-Connecting-IP": "192.168.1.1",
					"X-Forwarded-Proto": "https",
					"X-Forwarded-Host": "www.reddit.com",
				},
				timeout: 30000,
				maxRedirects: 5,

				proxy: {
					protocol: "http",
					host: proxy.host,
					port: proxy.port,
					auth: {
						username: proxy.username,
						password: proxy.password,
					},
				},
				// Proxy configuration
				// Alternative proxy configuration for different proxy types
				// proxy: false, // Disable proxy
				// proxy: 'http://proxy-server.com:8080', // Simple proxy
				// proxy: 'socks5://proxy-server.com:1080', // SOCKS5 proxy
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
			const { markdown, posts } = parsedData(redditData);

			const allLinks = posts.map((post) => post.url);
			const allImages = posts.map((post) => post.image);

			return c.json({
				success: true,
				markdown: markdown,
				data: {
					url: url,
					posts: posts,
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

					// Try with different user agent and simpler headers + proxy
					const fallbackResponse = await axios.get(jsonUrl, {
						headers: {
							"User-Agent":
								"Mozilla/5.0 (compatible; RedditBot/1.0; +https://www.reddit.com/robots.txt)",
							Accept: "application/json",
							"X-Forwarded-For": "192.168.1.1",
							"X-Real-IP": "192.168.1.1",
						},
						timeout: 30000,
						// Proxy configuration for fallback
						proxy: {
							protocol: "https",
							host: "proxy-server.com",
							port: 8080,
							auth: {
								username: "proxy-user",
								password: "proxy-pass",
							},
						},
					});

					const redditData = fallbackResponse.data;
					const { markdown, posts } = parseRedditData(redditData);

					return c.json({
						success: true,
						url: url,
						markdown: markdown,
						data: {
							metadata: null,
							posts: posts,
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
						503
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
				500
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
			500
		);
	}
});

app.post("/scrap-git", async (c) => {
	const { url } = await c.req.json();
	const newUrl = new URL(url);
	if (!newUrl || newUrl.hostname !== "github.com") {
		return c.json(
			{
				success: false,
				error: "URL is required and must be a github URL",
			},
			400
		);
	}
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
			content.body
		);
		return c.json({
			success: true,
			data: {
				url: url,
				title: metadata.title,
				content: content,
				metadata: metadata,
			},
			markdown: markdown,
		});
	} catch (error) {
		console.error("❌ Github scraper error:", error);
		return c.json(
			{
				success: false,
				error: "Internal server error",
			},
			500
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
				400
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
			415
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
				400
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

const ddgSearchTool = {
	name: "ddg_search",
	description:
		"Perform a DuckDuckGo web search to find relevant information based on a query.",
	parameters: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "The search query for DuckDuckGo.",
			},
		},
		required: ["query"],
	},
};

const scrapUrlPuppeteerTool = {
	name: "scrap_url_puppeteer",
	description:
		"Scrape content from a given URL using Puppeteer. Can extract semantic content, images, links, and metadata, and take screenshots.",
	parameters: {
		type: "object",
		properties: {
			url: {
				type: "string",
				description: "The URL to scrape.",
			},
			includeSemanticContent: {
				type: "boolean",
				description:
					"Whether to extract semantic content (paragraphs, headings, lists, tables). Defaults to true.",
				default: true,
			},
			includeImages: {
				type: "boolean",
				description:
					"Whether to extract image URLs and their attributes. Defaults to true.",
				default: true,
			},
			includeLinks: {
				type: "boolean",
				description: "Whether to extract internal links. Defaults to true.",
				default: true,
			},
			extractMetadata: {
				type: "boolean",
				description:
					"Whether to extract meta, Open Graph, and Twitter card tags. Defaults to true.",
				default: true,
			},
			takeScreenshot: {
				type: "boolean",
				description:
					"Whether to take a full-page screenshot of the URL and return its URL. Defaults to false.",
				default: false,
			},
		},
		required: ["url"],
	},
};

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
			400
		);
	}
	if (!process.env.GITHUB_TOKEN) {
		return c.json(
			{ success: false, error: "GITHUB_TOKEN not configured" },
			500
		);
	}

	const parsed = parseGithubRepoInput(input);
	if (!parsed) {
		return c.json(
			{ success: false, error: "Invalid GitHub repo identifier" },
			400
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
			}
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
				repoRes.status
			);
		}
		const repoJson = await repoRes.json();

		// Languages
		const langRes = await fetch(
			`https://api.github.com/repos/${owner}/${repoName}/languages`,
			{
				headers: ghHeaders,
			}
		);
		const languages = langRes.ok ? await langRes.json() : {};

		// README raw text
		const readmeRes = await fetch(
			`https://api.github.com/repos/${owner}/${repoName}/readme`,
			{
				headers: { ...ghHeaders, Accept: "application/vnd.github.raw" },
			}
		);
		const readme = readmeRes.ok ? await readmeRes.text() : "";

		// Top-level files/directories
		const contentsRes = await fetch(
			`https://api.github.com/repos/${owner}/${repoName}/contents?ref=${encodeURIComponent(
				repoJson.default_branch || "main"
			)}`,
			{ headers: ghHeaders }
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
			2
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
			500
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
			400
		);
	}
	if (!process.env.GITHUB_TOKEN) {
		return c.json(
			{ success: false, error: "GITHUB_TOKEN not configured" },
			500
		);
	}

	const parsed = parseGithubRepoInput(input);
	if (!parsed) {
		return c.json(
			{ success: false, error: "Invalid GitHub repo identifier" },
			400
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
			{ headers: ghHeaders }
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
				repoRes.status
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
				(i) => i.pull_request && isWithin(i.closed_at || i.updated_at)
			);

			// Hydrate PR details for those issues
			pullRequests = [];
			for (const item of issuePRs) {
				const prNumber = item.number;
				const prRes = await fetch(
					`https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}`,
					{ headers: ghHeaders }
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
			2
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
				])
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
			500
		);
	}
});

app.post("/profiler-users-send-email", async (c) => {
	try {
		const usersRef = firestore.collection("profiler-users");
		const snapshot = await usersRef.get();

		if (snapshot.empty) {
			return c.json({
				success: true,
				emails: [],
				message: "No users found in profiler-users collection.",
			});
		}

		const emails = [];
		snapshot.forEach((doc) => {
			const userData = doc.data();
			if (userData.email) {
				emails.push(userData.email);
			}
		});

		if (emails.length === 0) {
			return c.json({
				success: true,
				emails: [],
				message: "No emails found in profiler-users collection.",
			});
		}

		const resend = new Resend(process.env.RESEND_API_KEY);
		const emailHtml = await fs.readFile("email.html", "utf-8");

		const sendPromises = emails.map(async (email) => {
			try {
				await resend.emails.send({
					from: "connect@ihatereading.in",
					to: email,
					subject: "Exciting Updates from gettemplate.website!",
					html: emailHtml,
				});
				return { email, status: "sent" };
			} catch (sendError) {
				console.error(`Failed to send email to ${email}:`, sendError);
				return { email, status: "failed", error: sendError.message };
			}
		});

		const results = await Promise.all(sendPromises);

		return c.json({
			success: true,
			message: `Attempted to send emails to ${emails.length} users.`,
			results,
		});
	} catch (error) {
		console.error("Error in /profiler-users-send-email endpoint:", error);
		return c.json(
			{
				success: false,
				error: "Failed to process email sending request",
				details: error.message,
			},
			500
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
				400
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
				'[data-testid="source-name"], .wEwyrc, .NUnG9d'
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
			500
		);
	}
});

const port = 3001;
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
