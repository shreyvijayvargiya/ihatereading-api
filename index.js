import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { firestore, storage } from "./firebase.js";
import { GoogleGenAI, Type } from "@google/genai";
import { chromium } from "playwright";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { performance } from "perf_hooks";
import { cpus } from "os";
import { ChatOllama } from "@langchain/ollama";
import UserAgent from "user-agents";
import { v4 as uuidv4 } from "uuid";
import { JSDOM } from "jsdom";
import axios from "axios";
import {
	Agent as UndiciAgent,
	ProxyAgent as UndiciProxyAgent,
	fetch as undiciFetch,
} from "undici";
import https from "https";
import { load } from "cheerio";
import { extractSemanticContentWithFormattedMarkdown } from "./lib/extractSemanticContent.js";
import { logger } from "hono/logger";
import { env, pipeline as hgpipeline } from "@huggingface/transformers";
import UserAgents from "user-agents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";

const userAgents = new UserAgent();
const getRandomInt = (min, max) =>
	Math.floor(Math.random() * (max - min + 1)) + min;
function get_useragent() {
	const lynx_version = `Lynx/${getRandomInt(2, 3)}.${getRandomInt(
		8,
		9
	)}.${getRandomInt(0, 2)}`;
	const libwww_version = `libwww-FM/${getRandomInt(2, 3)}.${getRandomInt(
		13,
		15
	)}`;
	const ssl_mm_version = `SSL-MM/${getRandomInt(1, 2)}.${getRandomInt(3, 5)}`;
	const openssl_version = `OpenSSL/${getRandomInt(1, 3)}.${getRandomInt(
		0,
		4
	)}.${getRandomInt(0, 9)}`;
	return `${lynx_version} ${libwww_version} ${ssl_mm_version} ${openssl_version}`;
}

const ollama = new ChatOllama({
	// model: "gemma:2b",
	model: "gemma3:270m",
	baseURL: "http://localhost:11434",
	temperature: 0.5,
});

// Load environment variables
dotenv.config();

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
				host: "23.95.150.145",
				port: 6114,
				username: "jpjjloxo",
				password: "vy6njj7uds7x",
				country: "US",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "198.23.239.134",
				port: 6540,
				username: "jpjjloxo",
				password: "vy6njj7uds7x",
				country: "US",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "45.38.107.97",
				port: 6014,
				username: "jpjjloxo",
				password: "vy6njj7uds7x",
				country: "US",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "107.172.163.27",
				port: 6543,
				username: "jpjjloxo",
				password: "vy6njj7uds7x",
				country: "US",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "64.137.96.74",
				port: 6641,
				username: "jpjjloxo",
				password: "vy6njj7uds7x",
				country: "US",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "45.43.186.39",
				port: 6257,
				username: "jpjjloxo",
				password: "vy6njj7uds7x",
				country: "US",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "154.203.43.247",
				port: 5536,
				username: "jpjjloxo",
				password: "vy6njj7uds7x",
				country: "US",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "216.10.27.159",
				port: 6837,
				username: "jpjjloxo",
				password: "vy6njj7uds7x",
				country: "US",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "136.0.207.84",
				port: 6661,
				username: "jpjjloxo",
				password: "vy6njj7uds7x",
				country: "US",
				lastUsed: 0,
				failCount: 0,
				isHealthy: true,
			},
			{
				host: "142.147.128.93",
				port: 6593,
				username: "jpjjloxo",
				password: "vy6njj7uds7x",
				country: "US",
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

// Utility function to create browser context with proxy
const createBrowserContextWithProxy = async (browser, options = {}) => {
	const proxy = proxyManager.getNextProxy();

	const contextOptions = {
		userAgent:
			options.userAgent ||
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		viewport: options.viewport || { width: 1920, height: 1080 },
		extraHTTPHeaders: options.extraHTTPHeaders || {
			dnt: "1",
			"upgrade-insecure-requests": "1",
			accept:
				"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
			"sec-fetch-site": "none",
			"sec-fetch-mode": "navigate",
			"sec-fetch-user": "?1",
			"sec-fetch-dest": "document",
			"accept-language": "en-US,en;q=0.9",
		},
		proxy: {
			server: `http://${proxy.host}:${proxy.port}`,
			username: proxy.username,
			password: proxy.password,
		},
	};

	const context = await browser.newContext(contextOptions);

	// Store proxy info in context for later reference
	context.proxyInfo = proxy;

	return context;
};

// Utility function to handle proxy success/failure
const handleProxyResult = (context, success) => {
	if (context.proxyInfo) {
		if (success) {
			proxyManager.markProxySuccess(context.proxyInfo.host);
		} else {
			proxyManager.markProxyFailed(context.proxyInfo.host);
		}
	}
};

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

const sessionStore = new Map(); // key: domain, value: { cookies: [], updatedAt: number }

const getDomainFromUrl = (rawUrl) => {
	try {
		const u = new URL(rawUrl);
		return u.hostname;
	} catch {
		return null;
	}
};

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

const getSessionCookies = (url) => {
	const domain = getDomainFromUrl(url);
	if (!domain) return [];
	const entry = sessionStore.get(domain);
	if (!entry) return [];
	// TTL 1 hour
	if (Date.now() - entry.updatedAt > 60 * 60 * 1000) {
		sessionStore.delete(domain);
		return [];
	}
	return entry.cookies || [];
};

const saveSessionCookies = (url, cookies) => {
	const domain = getDomainFromUrl(url);
	if (!domain) return;
	sessionStore.set(domain, { cookies, updatedAt: Date.now() });
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

// Google Maps scraping endpoint using headless Chrome
app.post("/scrap-google-maps", async (c) => {
	try {
		const { queries, singleQuery, limit = 10 } = await c.req.json();

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

// get top places and maps and locations from LLM by enhancing the system prompt
// if didn't get location from LLM then try using locations supabase database for detailed
app.post("/ai-travel-agent", async (c) => {
	try {
		const { prompt } = await c.req.json();

		if (!prompt) {
			return c.json(
				{
					success: false,
					error: "Travel prompt is required",
				},
				400
			);
		}

		const generateItineraryPrompt = (prompt) => {
			return `You are a travel itinerary expert. Generate a detailed travel itinerary based on the following requirements:

	${prompt}

	Please follow these guidelines:
	1. Analyze the prompt to determine the start and end destinations, number of days, and any specific requirements
	2. For each location mentioned in the itinerary, create:
	   a. A specific and optimized Google image search query that will return the best possible images. Follow these rules for image queries:
	      - Include the full name of the location
	      - Add descriptive terms like "landmark", "tourist spot", "famous", "beautiful", "scenic", "aerial view" where appropriate
	      - Include specific features or attractions of the location
	      - Use terms that will yield high-quality, professional photos
	      - Avoid generic terms that might return irrelevant results
	      - Format as: ![Location Name](query: "specific search query")
	   
	   b. A Google Maps location query for places that need coordinates. Follow these rules for location queries:
	      - Always include the full name of the place
	      - Always include the city/area name
	      - Always include the country
	      - For restaurants: include "restaurant" and street name if available
	      - For hotels: include "hotel" and street name if available
	      - For attractions: include specific identifiers (e.g., "temple", "museum", "park")
	      - For meeting points: include nearby landmarks
	      - Format as: [Location Name](location: "specific location query")
	      - Use this format for ALL places that need coordinates: restaurants, hotels, attractions, meeting points, etc.
	      - Be as specific as possible to ensure accurate coordinates

	3. Format the response in Markdown with the following structure:

	# Travel Itinerary

	## Overview
	- Brief summary of the trip
	- Total duration
	- Main highlights

	## Day-by-Day Breakdown

	### Day 1: [Location Name]
	![Location Name](query: "location name landmark scenic view")
	
	#### Morning
	- Activity 1 (Time) at [Place Name](location: "Place Name, Street Name, City, Country")
	- Activity 2 (Time) at [Place Name](location: "Place Name, Street Name, City, Country")
	
	#### Afternoon
	- Lunch at [Restaurant Name](location: "Restaurant Name, Street Name, City, Country restaurant")
	- Activity 1 (Time) at [Place Name](location: "Place Name, Street Name, City, Country")
	
	#### Evening
	- Dinner at [Restaurant Name](location: "Restaurant Name, Street Name, City, Country restaurant")
	- Activity 1 (Time) at [Place Name](location: "Place Name, Street Name, City, Country")
	
	#### Accommodation
	- [Hotel Name](location: "Hotel Name, Street Name, City, Country hotel")
	- Estimated cost
	
	#### Local Cuisine
	- Restaurant recommendations with location queries
	- Must-try dishes
	
	#### Transportation
	- How to get there
	- Estimated cost

	[Repeat for each day]

	## Budget Breakdown
	- Accommodation
	- Transportation
	- Activities
	- Food
	- Miscellaneous

	## Travel Tips
	- Best time to visit
	- Local customs and etiquette
	- Safety considerations
	- Packing suggestions

	Make sure to:
	1. Include specific details about each location and activity
	2. Provide accurate time estimates
	3. Include practical information like costs and transportation options
	4. Format all content in proper Markdown
	5. For each location:
	   - Create an optimized image search query that will return the best possible images
	   - Add a location query for places that need coordinates
	6. Use the formats:
	   - ![Location Name](query: "specific search query") for images
	   - [Location Name](location: "specific location query") for Google Maps coordinates

	Example of good queries:
	- Image query for Eiffel Tower: "Eiffel Tower Paris landmark aerial view sunset"
	- Location query for Eiffel Tower: "Eiffel Tower, Champ de Mars, 75007 Paris, France"
	
	- Image query for Tokyo Skytree: "Tokyo Skytree Japan modern architecture night view"
	- Location query for Tokyo Skytree: "Tokyo Skytree, 1 Chome-1-2 Oshiage, Sumida City, Tokyo, Japan"
	
	- Image query for Grand Canyon: "Grand Canyon Arizona USA scenic landscape aerial view"
	- Location query for Grand Canyon: "Grand Canyon National Park, Arizona, United States"
	
	- Image query for Sensō-ji Temple: "Sensō-ji Temple Tokyo Asakusa district famous pagoda"
	- Location query for Sensō-ji Temple: "Sensō-ji Temple, 2 Chome-3-1 Asakusa, Taito City, Tokyo, Japan"
	
	- Image query for Le Jules Verne: "Le Jules Verne Restaurant Eiffel Tower Paris fine dining"
	- Location query for Le Jules Verne: "Le Jules Verne Restaurant, Eiffel Tower, 75007 Paris, France"
	
	- Image query for Park Hyatt Tokyo: "Park Hyatt Tokyo hotel luxury rooms city view"
	- Location query for Park Hyatt Tokyo: "Park Hyatt Tokyo, 3-7-1-2 Nishishinjuku, Shinjuku City, Tokyo, Japan"`;
		};
		// User prompt with the travel requirements from user input
		const userPrompt = `Create a detailed travel itinerary based on this request:

${prompt}

Please provide a comprehensive itinerary following the structure specified in the system prompt.`;

		const initialItineraryResult = await genai.models.generateContent({
			model: "gemini-1.5-flash",
			contents: [
				{ role: "model", parts: [{ text: generateItineraryPrompt(prompt) }] },
				{ role: "user", parts: [{ text: userPrompt }] },
			],
			config: {
				tools: [
					{
						googleSearch: true,
						googleSearchRetrieval: true,
					},
				],
			},
		});

		const itinerary =
			initialItineraryResult.candidates[0].content.parts[0].text;
		const thought =
			initialItineraryResult.candidates[0].content.parts[0].thought;

		return c.json({
			itinerary: itinerary,
			thought: thought,
		});
	} catch (error) {
		console.error("AI Travel Agent Error:", error);
		return c.json(
			{
				success: false,
				error: error.message,
			},
			500
		);
	}
});

app.post("/find-latest-jobs", async (c) => {
	const { query } = await c.req.json();
	const urlEncodedQuery = encodeURIComponent(query);

	const apiUrl = `https://jsearch.p.rapidapi.com/search?query=${urlEncodedQuery}&page=1&num_pages=1&date_posted=all`;

	const response = await fetch(apiUrl, {
		method: "GET",
		headers: {
			"x-rapidapi-host": "jsearch.p.rapidapi.com",
			"x-rapidapi-key": "eIy5QzLhLAmshwdt2uWvSf1qt2FKp1WsxBfjsnW4MYd6YpicwO",
		},
	});

	if (!response.ok) {
		return c.json(
			{
				success: false,
				error: `API error: ${response.status} ${response.statusText}`,
			},
			500
		);
	}

	const data = await response.json();
	return c.json({
		success: true,
		data,
	});
});

// reading markdown using machine learning models to extract data using

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

	const results = [];
	try {
		console.log(`🔍 Starting Bing search for: "${query}"`);

		const response = await axios.get(`https://www.bing.com/search`, {
			headers: {
				"User-Agent": get_useragent(),
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": `${language}-${country},${language};q=0.9`,
				"Accept-Encoding": "gzip, deflate",
				Referer: "https://www.bing.com/",
				DNT: "1",
				"Upgrade-Insecure-Requests": "1",
			},
			params: {
				q: encodeURIComponent(query),
				first: 1, // Start position (Bing uses 'first' instead of 'start')
				count: Math.min(num, 10), // Bing's count parameter, max 10 per page
				ln: language,
				cc: country.toUpperCase(),
			},
			timeout: timeout,
			// httpsAgent: new https.Agent({
			// 	rejectUnauthorized: true,
			// }),
		});

		// Use response.data directly - axios already handles UTF-8
		const dom = new JSDOM(response.data);
		const document = dom.window.document;

		// Get Bing search results using correct selectors
		const result_block = document.querySelectorAll("li.b_algo,");

		for (const result of result_block) {
			// Try multiple title selectors for Bing
			const title_tag = result.querySelector("h2 a, .b_title a, a[href]");
			const description_tag = result.querySelector(
				".b_caption p, .b_snippet, .b_caption"
			);

			if (title_tag && description_tag) {
				const link = title_tag.href;
				const title = (title_tag.textContent || "").trim();
				const description = (description_tag.textContent || "").trim();

				// Clean Bing redirect URLs
				let cleanLink = link;
				try {
					if (link.includes("bing.com/ck/")) {
						const urlMatch = link.match(/u=([^&]+)/);
						if (urlMatch) {
							cleanLink = decodeURIComponent(urlMatch[1]);
						}
					}
				} catch (urlError) {
					console.log("URL cleaning error:", urlError.message);
				}

				results.push({
					title,
					description,
					link: cleanLink,
				});
			}
		}

		console.log(`🎯 Total Bing results collected: ${results.length}`);

		return c.json({
			success: true,
			query,
			results: results.slice(0, num),
			totalFound: results.length,
			engine: "bing",
			parameters: {
				language,
				country,
				num,
				timeout,
			},
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

app.post("/google-search", async (c) => {
	const {
		query,
		num = 10,
		language = "en",
		country = "in",
	} = await c.req.json();

	const results = [];
	try {
		const response = await axios.get(`https://www.google.com/search`, {
			headers: {
				"User-Agent": get_useragent(),
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Accept-Charset": "utf-8", // Explicitly request UTF-8
				"Accept-Encoding": "gzip, deflate",
			},

			params: {
				q: encodeURIComponent(query),
				results: num,
				hl: language,
				gl: country,
				safe: "active",
			},
			withCredentials: true,
			httpsAgent: new https.Agent({
				rejectUnauthorized: true,
			}),
		});

		// Use response.data directly - axios already handles UTF-8
		const dom = new JSDOM(response.data, {
			contentType: "text/html",
			includeNodeLocations: false,
			storageQuota: 10000000,
		});
		const document = dom.window.document;

		const result_block = document.querySelectorAll("div.ezO2md");

		for (const result of result_block) {
			const link_tag = result.querySelector("a[href]");
			const title_tag = link_tag ? link_tag.querySelector("span.CVA68e") : null;
			const description_tag = result.querySelector("span.FrIlee");

			if (link_tag && title_tag && description_tag) {
				const link = decodeURIComponent(
					link_tag.href.split("&")[0].replace("/url?q=", "")
				);

				const title = (title_tag.textContent || "").trim().normalize("NFC");
				const description = (description_tag.textContent || "")
					.trim()
					.normalize("NFC");

				if (link.startsWith("http") || link.startsWith("https")) {
					results.push({
						title,
						description,
						link: cleanGoogleUrl(link),
					});
				}
			}
		}

		const { markdown } = await extractSemanticContentWithFormattedMarkdown(
			document.body
		);

		return c.json({
			query,
			results,
			markdown: markdown,
		});
	} catch (error) {
		console.error("Google search error:", error);
		return c.json({ error: error.message }, 500);
	}
});

// scrap URL
app.post("/scrap-url", async (c) => {
	// Start performance monitoring for this operation
	const operationId = performanceMonitor.startOperation("scrap-url");
	const startTime = performance.now();
	const startCpuUsage = process.cpuUsage();
	const startMemoryUsage = process.memoryUsage();

	const {
		url,
		selectors = {}, // Custom selectors for specific elements
		waitForSelector = null, // Wait for specific element to load
		timeout = 30000,
		includeSemanticContent = true,
		includeImages = true,
		includeLinks = true,
		extractMetadata = true,
		useProxy = false, // New option to enable/disable proxy (default: false)
	} = await c.req.json();

	if (!url) {
		return c.json({ error: "URL is required" }, 400);
	}

	let browser;
	let context;
	let scrapedData = {};

	try {
		// Launch browser with anti-detection settings
		browser = await chromium.launch({
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
				"--disable-web-security",
				"--disable-features=VizDisplayCompositor",
			],
		});

		// Use proxy management system only if explicitly enabled
		if (useProxy) {
			console.log("🔒 Using enhanced proxy system with anti-detection...");
			context = await createBrowserContextWithProxy(
				browser,
				{
					viewport: { width: 1920, height: 1080 },
					extraHTTPHeaders: {
						dnt: "1",
						"upgrade-insecure-requests": "1",
						accept:
							"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
						"sec-fetch-site": "none",
						"sec-fetch-mode": "navigate",
						"sec-fetch-user": "?1",
						"sec-fetch-dest": "document",
						"accept-language": "en-US,en;q=0.9",
					},
				},
				url
			); // Pass target URL for domain-aware proxy selection
		} else {
			context = await browser.newContext({
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				viewport: { width: 1920, height: 1080 },
				extraHTTPHeaders: {
					dnt: "1",
					"upgrade-insecure-requests": "1",
					accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
					"sec-fetch-site": "none",
					"sec-fetch-mode": "navigate",
					"sec-fetch-user": "?1",
					"sec-fetch-dest": "document",
					"accept-language": "en-US,en;q=0.9",
				},
			});
		}

		const page = await context.newPage();

		// Enhanced resource blocking for faster loading
		let blockedResources = { images: 0, fonts: 0, stylesheets: 0, media: 0 };

		await page.route("**/*", (route) => {
			const request = route.request();
			const type = request.resourceType();
			const url = request.url().toLowerCase();

			// Enhanced resource blocking when includeImages is false
			if (!includeImages) {
				// Block all image-related resources
				if (type === "image") {
					blockedResources.images++;
					return route.abort();
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
					return route.abort();
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
					(url.includes(".jpg") || url.includes(".png") || url.includes(".gif"))
				) {
					blockedResources.images++;
					return route.abort();
				}

				// Block data URLs (base64 encoded images)
				if (url.startsWith("data:image/")) {
					blockedResources.images++;
					return route.abort();
				}
			}

			// Always block fonts and stylesheets for faster loading
			if (["font", "stylesheet"].includes(type)) {
				if (type === "font") blockedResources.fonts++;
				if (type === "stylesheet") blockedResources.stylesheets++;
				return route.abort();
			}

			// Block media files (videos, audio) for faster loading
			if (["media"].includes(type)) {
				blockedResources.media++;
				return route.abort();
			}

			return route.continue();
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

		// Wait a bit for dynamic content to load
		await page.waitForTimeout(2000);

		// Extract page content
		scrapedData = await page.evaluate(
			(options) => {
				const data = {
					url: window.location.href,
					title: document.title,
					timestamp: new Date().toISOString(),
					content: {},
					metadata: {},
					links: [],
					images: [],
				};

				["h1", "h2", "h3", "h4", "h5", "h6"].forEach((tag) => {
					data.content[tag] = Array.from(document.querySelectorAll(tag)).map(
						(h) => h.textContent.trim()
					);
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
					const ogTags = document.querySelectorAll('meta[property^="og:"]');
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
				const links = document.querySelectorAll("a");
				const rawLinks = Array.from(links).map((link) => ({
					text: link.textContent.trim(),
					href: link.href,
					title: link.getAttribute("title") || "",
				}));

				// Remove duplicate links based on text, href, or title
				const seenLinks = new Set();
				data.links = rawLinks.filter((link) => {
					const key = `${link.text}|${link.href}|${link.title}`;
					if (seenLinks.has(key)) return false;
					seenLinks.add(key);
					return true;
				});

				if (options.includeSemanticContent) {
					// Extract semantic content with optimized methods
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
								const cells = Array.from(row.querySelectorAll("td, th")).map(
									(cell) => cell.textContent.trim()
								);
								return cells.filter((cell) => cell.length > 0);
							})
							.filter((row) => row.length > 0);
					};

					const extractListContent = (list) => {
						return Array.from(list.querySelectorAll("li"))
							.map((li) => li.textContent.trim())
							.filter((item) => item.length > 0);
					};

					// Add semantic content to data.content structure
					const rawSemanticContent = {
						paragraphs: extractSemanticContent("p"),
						divs: extractSemanticContent("div", (el) =>
							el.textContent.trim().substring(0, 200)
						),
						tables: extractSemanticContent("table", extractTableContent),
						blockquotes: extractSemanticContent("blockquote"),
						preformatted: extractSemanticContent("pre"),
						unorderedLists: extractSemanticContent("ul", extractListContent),
						orderedLists: extractSemanticContent("ol", extractListContent),
						codeBlocks: extractSemanticContent("code"),
						articleSections: extractSemanticContent("article"),
						sectionContent: extractSemanticContent("section"),
						asideContent: extractSemanticContent("aside"),
						mainContent: extractSemanticContent("main"),
						headerContent: extractSemanticContent("header"),
						footerContent: extractSemanticContent("footer"),
						navContent: extractSemanticContent("aside"),
						formContent: extractSemanticContent("form"),
						fieldsetContent: extractSemanticContent("fieldset"),
						labelContent: extractSemanticContent("label"),
						spanContent: extractSemanticContent("span", (el) =>
							el.textContent.trim().substring(0, 100)
						),
						strongContent: extractSemanticContent("strong"),
						emContent: extractSemanticContent("em"),
						markContent: extractSemanticContent("mark"),
						smallContent: extractSemanticContent("small"),
						citeContent: extractSemanticContent("cite"),
						timeContent: extractSemanticContent("time"),
						addressContent: extractSemanticContent("address"),
						detailsContent: extractSemanticContent("details"),
						summaryContent: extractSemanticContent("summary"),
						figureContent: extractSemanticContent("figure"),
						figcaptionContent: extractSemanticContent("figcaption"),
						dlContent: extractSemanticContent("dl", (el) => {
							const dts = Array.from(el.querySelectorAll("dt")).map((dt) =>
								dt.textContent.trim()
							);
							const dds = Array.from(el.querySelectorAll("dd")).map((dd) =>
								dd.textContent.trim()
							);
							return { terms: dts, definitions: dds };
						}),
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
								// Handle complex objects like tables and definition lists
								const key = JSON.stringify(item);
								if (seen.has(key)) return false;
								seen.add(key);
								return true;
							}
							return true;
						});
					};

					// Apply duplicate removal to all semantic content
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
					data.images = Array.from(images).map((img) => ({
						src: img.src,
						alt: img.alt || "",
						title: img.title || "",
						width: img.naturalWidth || img.width,
						height: img.naturalHeight || img.height,
					}));
				}

				// Extract custom selectors if provided
				if (options.selectors && Object.keys(options.selectors).length > 0) {
					data.customSelectors = {};
					for (const [key, selector] of Object.entries(options.selectors)) {
						try {
							const elements = document.querySelectorAll(selector);
							if (elements.length === 1) {
								data.customSelectors[key] = elements[0].textContent.trim();
							} else if (elements.length > 1) {
								data.customSelectors[key] = Array.from(elements).map((el) =>
									el.textContent.trim()
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

		await page.close();
		await context.close();

		// Mark proxy as successful if used
		if (useProxy && context.proxyInfo) {
			handleProxyResult(context, true);
			console.log(
				`✅ Proxy ${context.proxyInfo.host} marked as successful for ${url}`
			);
		}

		return c.json({
			success: true,
			data: scrapedData,
			url: url,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error("❌ Web scraping error:", error);

		// Mark proxy as failed if used
		if (useProxy && context && context.proxyInfo) {
			handleProxyResult(context, false);
			console.log(
				`❌ Proxy ${context.proxyInfo.host} marked as failed for ${url}`
			);
		}

		return c.json(
			{
				success: false,
				error: "Failed to scrape URL",
				details: error.message,
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

// Reddit Post JSON API - Automatically converts Reddit post URLs to JSON format
app.post("/reddit-post-to-json", async (c) => {
	try {
		const { url } = await c.req.json();

		if (!url) {
			return c.json({ error: "URL is required" }, 400);
		}

		// Validate and parse Reddit URL
		let redditUrl;
		try {
			const parsedUrl = new URL(url);

			// Check if it's a Reddit domain
			if (
				!parsedUrl.hostname.includes("reddit.com") &&
				!parsedUrl.hostname.includes("redd.it") &&
				!parsedUrl.hostname.includes("old.reddit.com")
			) {
				return c.json(
					{
						success: false,
						error:
							"URL must be from Reddit domain (reddit.com, redd.it, old.reddit.com)",
						providedUrl: url,
						expectedDomains: ["reddit.com", "redd.it", "old.reddit.com"],
					},
					400
				);
			}

			// Check if it's a post URL (contains /r/ and /comments/)
			if (
				!parsedUrl.pathname.includes("/r/") ||
				!parsedUrl.pathname.includes("/comments/")
			) {
				return c.json(
					{
						success: false,
						error:
							"URL must be a Reddit post (should contain /r/ and /comments/)",
						providedUrl: url,
						pathname: parsedUrl.pathname,
						examples: [
							"https://www.reddit.com/r/programming/comments/abc123/title_of_post/",
							"https://old.reddit.com/r/technology/comments/xyz789/another_post_title/",
						],
					},
					400
				);
			}

			// Convert to JSON format
			// Remove trailing slash and append .json
			const cleanPath = parsedUrl.pathname.replace(/\/$/, "");
			redditUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}${cleanPath}.json`;
		} catch (error) {
			return c.json(
				{
					success: false,
					error: "Invalid URL format",
					details: error.message,
					providedUrl: url,
				},
				400
			);
		}

		console.log(`🔗 Converting Reddit URL to JSON: ${redditUrl}`);

		// Fetch the JSON response from Reddit
		const response = await fetch(redditUrl, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				Accept: "application/json",
				"Accept-Language": "en-US,en;q=0.9",
				DNT: "1",
				Connection: "keep-alive",
				"Upgrade-Insecure-Requests": "1",
			},
			timeout: 30000,
		});

		if (!response.ok) {
			return c.json(
				{
					success: false,
					error: `Reddit API returned ${response.status}: ${response.statusText}`,
					statusCode: response.status,
					statusText: response.statusText,
					url: redditUrl,
				},
				response.status
			);
		}

		const redditData = await response.json();

		// Extract and format the post data
		if (!redditData || !Array.isArray(redditData) || redditData.length === 0) {
			return c.json(
				{
					success: false,
					error: "Invalid response from Reddit API",
					response: redditData,
				},
				500
			);
		}

		// Reddit returns an array where [0] is the post and [1] is the comments
		const postData = redditData[0]?.data?.children?.[0]?.data;
		const commentsData = redditData[1]?.data?.children || [];

		if (!postData) {
			return c.json(
				{
					success: false,
					error: "Could not extract post data from Reddit response",
					response: redditData,
				},
				500
			);
		}

		// Format the response
		const formattedPost = {
			id: postData.id,
			title: postData.title,
			author: postData.author,
			subreddit: postData.subreddit,
			url: postData.url,
			permalink: `https://reddit.com${postData.permalink}`,
			score: postData.score,
			upvoteRatio: postData.upvote_ratio,
			numComments: postData.num_comments,
			created: new Date(postData.created_utc * 1000).toISOString(),
			createdUtc: postData.created_utc,
			isVideo: postData.is_video,
			isSelf: postData.is_self,
			isRedditMediaDomain: postData.is_reddit_media_domain,
			domain: postData.domain,
			over18: postData.over_18,
			spoiler: postData.spoiler,
			locked: postData.locked,
			stickied: postData.stickied,
			archived: postData.archived,
			clicked: postData.clicked,
			hidden: postData.hidden,
			saved: postData.saved,
			edited: postData.edited
				? new Date(postData.edited * 1000).toISOString()
				: false,
			content: {
				selftext: postData.selftext || null,
				selftextHtml: postData.selftext_html || null,
				thumbnail: postData.thumbnail,
				preview: postData.preview,
				media: postData.media,
				secureMedia: postData.secure_media,
				mediaEmbed: postData.media_embed,
				secureMediaEmbed: postData.secure_media_embed,
				galleryData: postData.gallery_data,
				images: postData.images,
				video: postData.video,
				audio: postData.audio,
			},
			metadata: {
				subredditType: postData.subreddit_type,
				subredditSubscribers: postData.subreddit_subscribers,
				subredditId: postData.subreddit_id,
				authorFullname: postData.author_fullname,
				authorFlairText: postData.author_flair_text,
				authorFlairCssClass: postData.author_flair_css_class,
				authorFlairType: postData.author_flair_type,
				authorPatreonFlair: postData.author_patreon_flair,
				authorPremium: postData.author_premium,
				canModPost: postData.can_mod_post,
				canGild: postData.can_gild,
				spoiler: postData.spoiler,
				locked: postData.locked,
				hideScore: postData.hide_score,
				quarantine: postData.quarantine,
				linkFlairText: postData.link_flair_text,
				linkFlairCssClass: postData.link_flair_css_class,
				linkFlairType: postData.link_flair_type,
				whitelistStatus: postData.whitelist_status,
				contestMode: postData.contest_mode,
				viewCount: postData.view_count,
				visited: postData.visited,
				gilded: postData.gilded,
				topAwardedType: postData.top_awarded_type,
				hideFromRobots: postData.hide_from_robots,
				isRobotIndexable: postData.is_robot_indexable,
				isRedditMediaDomain: postData.is_reddit_media_domain,
				isMedia: postData.is_media,
				isVideo: postData.is_video,
				isSelf: postData.is_self,
				isOc: postData.is_oc,
				isGallery: postData.is_gallery,
				isCrosspostable: postData.is_crosspostable,
				isRedditMediaDomain: postData.is_reddit_media_domain,
				isVideo: postData.is_video,
				isSelf: postData.is_self,
				isOc: postData.is_oc,
				isGallery: postData.is_gallery,
				isCrosspostable: postData.is_crosspostable,
			},
		};

		// Format comments
		const formattedComments = commentsData.map((comment) => {
			const commentData = comment.data;
			return {
				id: commentData.id,
				author: commentData.author,
				body: commentData.body,
				bodyHtml: commentData.body_html,
				score: commentData.score,
				created: new Date(commentData.created_utc * 1000).toISOString(),
				createdUtc: commentData.created_utc,
				permalink: `https://reddit.com${commentData.permalink}`,
				parentId: commentData.parent_id,
				linkId: commentData.link_id,
				subreddit: commentData.subreddit,
				subredditId: commentData.subreddit_id,
				authorFullname: commentData.author_fullname,
				authorFlairText: commentData.author_flair_text,
				authorFlairCssClass: commentData.author_flair_css_class,
				authorFlairType: commentData.author_flair_type,
				authorPatreonFlair: commentData.author_patreon_flair,
				authorPremium: commentData.author_premium,
				canGild: commentData.can_gild,
				gilded: commentData.gilded,
				edited: commentData.edited
					? new Date(commentData.edited * 1000).toISOString()
					: false,
				scoreHidden: commentData.score_hidden,
				controversiality: commentData.controversiality,
				distinguished: commentData.distinguished,
				stickied: commentData.stickied,
				archived: commentData.archived,
				locked: commentData.locked,
				quarantine: commentData.quarantine,
				spoiler: commentData.spoiler,
				hideScore: commentData.hide_score,
				upvoteRatio: commentData.upvote_ratio,
				replies: commentData.replies?.data?.children || [],
				depth: commentData.depth,
				repliesCount: commentData.replies?.data?.children?.length || 0,
			};
		});

		return c.json({
			success: true,
			originalUrl: url,
			jsonUrl: redditUrl,
			post: formattedPost,
			comments: formattedComments,
			totalComments: formattedComments.length,
			timestamp: new Date().toISOString(),
			note: "Data retrieved directly from Reddit's JSON API for better reliability",
		});
	} catch (error) {
		console.error("❌ Reddit post API error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to fetch Reddit post data",
				details: error.message,
				url: url,
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

const dataExtractionFromHtml = (html, options) => {
	const $ = load(html);

	// Remove unwanted elements using Cheerio
	const selectorsToRemove = [
		"nav",
		"header",
		"footer",
		"aside",
		".navbar",
		".sidebar",
		".comments",
		"[role='navigation']",
		"[role='banner']",
		"[role='contentinfo']",
		"[aria-label*='comment']",
		"[id*='comment']",
	];
	selectorsToRemove.forEach((sel) => {
		$(sel).remove();
	});

	// Initialize data structure
	const data = {
		url: options.url || "",
		title: $("title").text().trim() || $("h1").first().text().trim(),
		content: {},
		metadata: {},
		links: [],
		images: [],
		screenshot: null,
	};

	// Extract headings using Cheerio
	["h1", "h2", "h3", "h4", "h5", "h6"].forEach((tag) => {
		data.content[tag] = $(tag)
			.map((i, el) => $(el).text().trim())
			.get();
	});

	// Extract metadata using Cheerio
	if (options.extractMetadata) {
		// Meta tags
		$("meta").each((i, meta) => {
			const name = $(meta).attr("name") || $(meta).attr("property");
			const content = $(meta).attr("content");
			if (name && content) {
				data.metadata[name] = content;
			}
		});

		// Open Graph tags
		$('meta[property^="og:"]').each((i, meta) => {
			const property = $(meta).attr("property");
			const content = $(meta).attr("content");
			if (property && content) {
				data.metadata[property] = content;
			}
		});

		// Twitter Card tags
		$('meta[name^="twitter:"]').each((i, meta) => {
			const name = $(meta).attr("name");
			const content = $(meta).attr("content");
			if (name && content) {
				data.metadata[name] = content;
			}
		});
	}

	// Extract links using Cheerio
	if (options.includeLinks) {
		const currentUrl = options.url || "";
		const seedDomain = currentUrl ? new URL(currentUrl).hostname : "";

		const rawLinks = [];
		$("a[href]").each((i, link) => {
			const $link = $(link);
			rawLinks.push({
				text: $link.text().trim(),
				href: $link.attr("href"),
				title: $link.attr("title") || "",
			});
		});

		// Filter links by domain and remove duplicates
		const seenLinks = new Set();
		data.links = rawLinks.filter((link) => {
			// Skip if no meaningful text or title
			if (!(link?.text?.length > 0 || link?.title?.length > 0)) {
				return false;
			}

			try {
				// Check if link URL is valid and matches seed domain
				if (seedDomain && link.href) {
					const linkUrl = new URL(link.href, currentUrl);
					if (linkUrl.hostname !== seedDomain) {
						return false; // Skip external links
					}
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
		const cleanedLinks = data.links.filter((link) => cleanGoogleUrl(link.href));
		data.links = cleanedLinks;
	}

	if (options.includeSemanticContent) {
		// Extract semantic content with optimized methods using Cheerio
		const extractSemanticContent = (
			selector,
			processor = (el) => $(el).text().trim()
		) => {
			const elements = $(selector);
			return elements.length > 0
				? elements.map((i, el) => processor(el)).get()
				: [];
		};

		const extractTableContent = (table) => {
			const rows = $(table).find("tr");
			return rows
				.map((i, row) => {
					const cells = $(row)
						.find("td, th")
						.map((j, cell) => $(cell).text().trim())
						.get();
					return cells.filter((cell) => cell.length > 0);
				})
				.get()
				.filter((row) => row.length > 0);
		};

		const extractListContent = (list) => {
			return $(list)
				.find("li")
				.map((i, li) => $(li).text().trim())
				.get()
				.filter((item) => item.length > 0);
		};

		// Prioritized semantic content - focus on main content, skip navigation/footer/repetitive elements
		const rawSemanticContent = {
			// High priority: Main content elements
			mainContent: extractSemanticContent("main"),
			articleContent: extractSemanticContent("article"),

			divs: extractSemanticContent("div"),

			// High priority: Core text content
			paragraphs: extractSemanticContent("p"),
			span: extractSemanticContent("span"),
			blockquotes: extractSemanticContent("blockquote"),
			codeBlocks: extractSemanticContent("code"),
			preformatted: extractSemanticContent("pre"),
			tables: extractSemanticContent("table", extractTableContent),
			unorderedLists: extractSemanticContent("ul", extractListContent),
			orderedLists: extractSemanticContent("ol", extractListContent),
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

	// Extract images using Cheerio
	if (options.includeImages) {
		data.images = $("img[src]")
			.map((i, img) => ({
				src: $(img).attr("src"),
				alt: $(img).attr("alt") || "",
				title: $(img).attr("title") || "",
				width: $(img).attr("width") || "",
				height: $(img).attr("height") || "",
			}))
			.get();
	}

	// Extract custom selectors if provided using Cheerio
	if (options.selectors && Object.keys(options.selectors).length > 0) {
		data.customSelectors = {};
		for (const [key, selector] of Object.entries(options.selectors)) {
			try {
				const elements = $(selector);
				if (elements.length === 1) {
					data.customSelectors[key] = elements.first().text().trim();
				} else if (elements.length > 1) {
					data.customSelectors[key] = elements
						.map((i, el) => $(el).text().trim())
						.get();
				}
			} catch (error) {
				data.customSelectors[key] = null;
			}
		}
	}

	return data;
};

function chunkMarkdownByHeaders(markdown, maxChunkSize = 1000) {
	// Parse markdown into AST
	const tree = unified().use(remarkParse).parse(markdown);

	// Accumulate chunk nodes and metadata
	const chunks = [];
	let currentChunk = [];
	let currentSize = 0;

	function pushChunk() {
		if (currentChunk.length > 0) {
			const chunkRoot = { type: "root", children: currentChunk };
			const chunkMarkdown = unified().use(remarkStringify).stringify(chunkRoot);
			chunks.push(chunkMarkdown.trim());
			currentChunk = [];
			currentSize = 0;
		}
	}

	// Walk through top-level nodes grouping by size (approximate char length)
	for (const node of tree.children) {
		const nodeText = unified()
			.use(remarkStringify)
			.stringify({ type: "root", children: [node] });
		const nodeLength = nodeText.length;

		if (currentSize + nodeLength > maxChunkSize) {
			pushChunk();
		}

		currentChunk.push(node);
		currentSize += nodeLength;
	}

	// Push leftover chunk
	pushChunk();

	return chunks;
}

async function createMarkdownEmbeddingRecords(markdown, idPrefix = "chunk") {
	const chunks = chunkMarkdownByHeaders(markdown, 1000); // 1000 chars per chunk

	const embeddingRecords = [];
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const id = `${idPrefix}-${i}`;

		const embeddingRecord = await createEmbeddingRecord(chunk, id, {
			chunkIndex: i,
			totalChunks: chunks.length,
		});
		embeddingRecords.push(embeddingRecord);
	}

	return embeddingRecords;
}

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
		const puppeteerExtra = (await import("puppeteer-extra")).default;
		const StealthPlugin = (await import("puppeteer-extra-plugin-stealth"))
			.default;
		puppeteerExtra.use(StealthPlugin());
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

app.post("/scrap-url-llm", async (c) => {
	try {
		const { url, prompt } = await c.req.json();
		const xfProto = c.req.header("x-forwarded-proto") || "http";
		const xfHost = c.req.header("x-forwarded-host") || c.req.header("host");
		const fallbackHost = `127.0.0.1:${process.env.PORT || "3000"}`;
		const baseUrl = `${xfProto}://${xfHost || fallbackHost}`;

		const response = await axios.post(
			`${baseUrl}/scrap-url-puppeteer`,
			{ url },
			{ headers: { "Content-Type": "application/json" }, timeout: 60000 }
		);

		const markdown =
			response.data?.markdown || response.data?.data?.markdown || "";

		const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
			separators: "\n\n",
			chunkSize: 1024,
			chunkOverlap: 128,
		});

		const chunkInput = await splitter.splitText(markdown);
		const MAX_TOKENS_LIMIT = 1000;

		const slicedChunkInput = chunkInput.slice(0, MAX_TOKENS_LIMIT);
		const chunkedMarkdown = slicedChunkInput.join("\n\n");

		const systemPrompt = `You are a helpful assistant that improves markdown readability while preserving every word exactly as in the input.
Given below is the chunked markdown content scraped from url: 
${chunkedMarkdown}
Instructions:
- Create the complete markdown for the user
- Make sure the formatting, syntax is correct 
- Format the output strictly as markdown ready for LLM consumption.
		`;

		const contents = [
			{
				role: "model",
				parts: [
					{
						text: systemPrompt,
					},
				],
			},
		];

		if (prompt && String(prompt).trim().length > 0) {
			contents.push({
				role: "user",
				parts: [
					{
						text: String(prompt),
					},
				],
			});
		}

		const llmResponse = await genai.models.generateContent({
			model: "gemini-1.5-flash",
			contents,
		});

		const llmMarkdown = llmResponse.candidates[0].content.parts[0].text;
		const tokenCount = llmResponse.candidates[0].tokenCount;
		const promptTokenCount = llmResponse.usageMetadata.promptTokenCount;
		const candidateTokenCount = llmResponse.usageMetadata.candidatesTokenCount;
		return c.json({
			success: true,
			response: llmMarkdown,
			chunkedMarkdown: chunkedMarkdown,
			tokenCount: tokenCount,
			candidateTokenCount: candidateTokenCount,
			promptTokenCount: promptTokenCount,
		});
	} catch (error) {
		console.log("Error in LLM scraping", error);
		return c.json({ success: false, error: error.message }, 500);
	}
});

const searchFnDecl = {
	name: "google_search",
	description:
		"Search Google and return results with title, link, description.",
	parameters: {
		type: Type.OBJECT,
		properties: {
			query: { type: Type.STRING, description: "Search query" },
			num: { type: Type.NUMBER, description: "Number of results" },
			language: { type: Type.STRING, description: "Language code" },
			country: { type: Type.STRING, description: "Country code" },
		},
		required: ["query"],
	},
};

const scrapFnDecl = {
	name: "scrap_url",
	description: "Scrape a URL and return chunkedMarkdown.",
	parameters: {
		type: Type.OBJECT,
		properties: {
			url: { type: Type.STRING, description: "URL to scrape" },
		},
		required: ["url"],
	},
};

const scrapMetadataDecl = {
	name: "scrap_metadata",
	description: "Scrape metadata from a URL.",
	parameters: {
		type: Type.OBJECT,
		properties: {
			url: {
				type: Type.STRING,
				description: "URL to scrape metadata from",
			},
		},
	},
};
const crawlUrlFnDecl = {
	name: "crawl_url",
	description: "Crawl a URL and return chunkedMarkdown.",
	parameters: {
		type: Type.OBJECT,
		properties: {
			url: { type: Type.STRING, description: "URL to crawl" },
		},
		required: ["url"],
	},
};
// One endpoint: LLM answers, and can call google-search and scrap-url-puppeteer as needed
app.post("/ai-answer", async (c) => {
	try {
		const { prompt, numResults = 5 } = await c.req.json();
		if (!prompt || String(prompt).trim().length === 0) {
			return c.json({ success: false, error: "prompt is required" }, 400);
		}

		const xfProto = c.req.header("x-forwarded-proto") || "http";
		const xfHost = c.req.header("x-forwarded-host") || c.req.header("host");
		const fallbackHost = `127.0.0.1:${process.env.PORT || "3000"}`;
		const baseUrl = `${xfProto}://${xfHost || fallbackHost}`;

		let response = await genai.models.generateContent({
			model: "gemini-1.5-flash",
			contents: [
				{
					role: "user",
					parts: [
						{
							text: `You are a highly precise and helpful assistant. Follow these instructions strictly:

1. To provide exact answers based on source content, **always prioritize using scrap_url** to fetch the full page content in markdown format before answering.

2. Use google_search only for finding relevant URLs or data sources. Your search queries must be clear, context-rich, and optimized for precise, high-quality results.

3. Use scrap_metadata strictly for obtaining webpage metadata like titles, descriptions, or authors as necessary.

4. Use crawl_url only when explicitly instructed or if you need to gather all links from a webpage.

5. Do not answer the user queries directly without first attempting to collect supporting information from the appropriate tools.

6. When combining information, rely on the scrapped URL content primarily to build accurate and comprehensive responses.

7. Keep all queries and tool calls concise but meaningful and aligned with the user’s prompt.

8. Strictly use tools provided to you and do not answer without using google search tool

User prompt: ${prompt}`,
						},
					],
				},
			],
			config: {
				tools: [
					{
						functionDeclarations: [
							searchFnDecl,
							scrapFnDecl,
							scrapMetadataDecl,
							crawlUrlFnDecl,
						],
					},
				],
			},
		});


		const toolCalls =
			response.candidates?.[0]?.content?.parts?.filter((p) => p.functionCall) ||
			[];
		const conversation = [
			{ role: "user", parts: [{ text: prompt }] },
			{ role: "model", parts: response.candidates?.[0]?.content?.parts || [] },
		];

		const toolArtifacts = {
			searchResults: [],
			scraps: [],
			metadata: [],
			crawlUrls: [],
		};

		for (const callPart of toolCalls) {
			const { name, args } = callPart.functionCall;
			let resultPayload;
			if (name === "google_search") {
				const searchReq = {
					query: args?.query || prompt,
					num: Number(args?.num ?? numResults),
					language: args?.language || "en",
					country: args?.country || "in",
				};
				const searchRes = await axios.post(
					`${baseUrl}/google-search`,
					searchReq,
					{
						headers: { "Content-Type": "application/json" },
					}
				);
				resultPayload =
					searchRes.data?.results?.map((r) => ({
						title: r.title,
						link: r.link,
						description: r.description,
					})) || [];
				toolArtifacts.searchResults.push(...resultPayload);
			} else if (name === "scrap_url") {
				const scrapRes = await axios.post(
					`${baseUrl}/scrap-url-puppeteer`,
					{ url: args?.url },
					{
						headers: { "Content-Type": "application/json" },
						timeout: 60000,
					}
				);
				resultPayload = {
					url: args?.url,
					chunkedMarkdown:
						scrapRes.data?.markdown || scrapRes.data?.data?.markdown,
				};
				toolArtifacts.scraps.push(resultPayload);
			} else if (name === "scrap_metadata") {
				const scrapMetadataRes = await axios.post(
					`${baseUrl}/take-metadata`,
					{ url: args?.url },
					{ headers: { "Content-Type": "application/json" } }
				);
				resultPayload = {
					url: args?.url,
					metadata: scrapMetadataRes.data?.metadata,
				};
				toolArtifacts.metadata.push(resultPayload);
			} else if (name === "crawl_url") {
				const crawlUrlRes = await axios.post(
					`${baseUrl}/crawl-url`,
					{ url: args?.url },
					{ headers: { "Content-Type": "application/json" } }
				);
				resultPayload = {
					url: args?.url,
					crawlUrls: crawlUrlRes.data?.crawledUrls,
				};
				toolArtifacts.crawlUrls.push(resultPayload);
			}

			conversation.push({
				role: "user",
				parts: [
					{ text: `Function ${name} result: ${JSON.stringify(resultPayload)}` },
				],
			});
			conversation.push({
				role: "model",
				parts: [
					{
						text: `You are a helpful assistant. Answer the user's prompt. 
							User prompt: ${prompt}

							The answer should be precise to the user query, provide citiations, links and metadata and 
							single page markdown content fetched and added below 
							Strictly follow the instructions and use the tools provided.
							
							Function ${name} result: ${JSON.stringify(resultPayload)}`,
					},
				],
			});
			response = await genai.models.generateContent({
				model: "gemini-1.5-flash",
				contents: conversation,
			});
		}

		const finalText = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
		return c.json({
			success: true,
			response: finalText,
			tools: toolArtifacts,
			usageMetadata: response.usageMetadata.totalTokenCount,
		});
	} catch (error) {
		console.error("/ai-answer error:", error);
		return c.json({ success: false, error: error.message }, 500);
	}
});

app.post("/simple-scrap", async (c) => {
	const {
		url,
		useProxy = true,
		skipTlsVerification = true,
	} = await c.req.json();
	try {
		const proxy = useProxy ? proxyManager.getNextProxy() : null;
		const agentOpts = { maxRedirections: 10 };
		const dispatcher = proxy
			? new UndiciProxyAgent({
					uri: `http://${proxy.host}:${proxy.port}`,
					token: proxy.username
						? `Basic ${Buffer.from(
								`${proxy.username}:${proxy.password ?? ""}`
						  ).toString("base64")}`
						: undefined,
					requestTls: { rejectUnauthorized: !skipTlsVerification },
					...agentOpts,
			  })
			: new UndiciAgent({
					connect: { rejectUnauthorized: !skipTlsVerification },
					...agentOpts,
			  });

		const randomUA = new UserAgents().toString();
		const start = Date.now();
		const res = await undiciFetch(url.trim(), {
			dispatcher,
			headers: {
				"User-Agent": randomUA,
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Accept-Encoding": "gzip, deflate, br",
			},
			redirect: "follow",
		});
		const html = await res.text();
		const latency = Date.now() - start;
		if (useProxy && proxy) {
			proxyManager.recordProxyResult(proxy.host, res.ok, latency);
		}

		const dom = new JSDOM(html);
		const document = dom.window.document;
		const { markdown } = extractSemanticContentWithFormattedMarkdown(
			document.body
		);

		return c.json({
			success: true,
			data: {
				url: url,
				html: html,
				metadata: {},
				title: "",
			},
			markdown: markdown,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.log(error);
		return c.json({ error: error.message, success: false }, 500);
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

// similar to scrap github redirect to this API
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

// new set
// flat the entire links then use git
const buildRepositoryStructure = async (repo, depth = 0) => {
	console.log(
		`${"  ".repeat(depth)}Building structure for ${repo.length} items`
	);

	// Safety check
	if (!Array.isArray(repo)) {
		console.log("Error: repo is not an array:", typeof repo, repo);
		return [];
	}

	const structure = [];

	for (const item of repo) {
		try {
			// Check if this is a directory (no file extension) or a file
			const isDirectory = item.text && !item.text.split(".")[1];

			console.log(
				`${"  ".repeat(depth)}${isDirectory ? "📁" : "📄"} Processing: ${
					item.text
				}`
			);

			if (isDirectory) {
				// This is a directory - fetch its contents and recurse
				console.log(`${"  ".repeat(depth)}Going into directory: ${item.text}`);

				const response = await axios.get(
					"https://github.com" + item.href.toString()
				);
				const $ = load(response.data);

				// Look for table with directory contents
				const table = $("table");
				if (table.length > 0) {
					const dom = new JSDOM(table.html());
					const content = dom.window.document;
					const { content: tableSemanticContent } =
						extractSemanticContentWithFormattedMarkdown(content.body);

					// Recursively build structure for directory contents
					if (
						Array.isArray(tableSemanticContent) &&
						tableSemanticContent.length > 0
					) {
						const children = await buildRepositoryStructure(
							tableSemanticContent,
							depth + 1
						);

						structure.push({
							type: "directory",
							name: item.text,
							path: item.href,
							children: children,
						});

						console.log(
							`${"  ".repeat(depth)}✅ Directory ${item.text} has ${
								children.length
							} children`
						);
					} else {
						// Empty directory
						structure.push({
							type: "directory",
							name: item.text,
							path: item.href,
							children: [],
						});
					}
				} else {
					console.log(
						`${"  ".repeat(depth)}❌ No table found in directory: ${item.text}`
					);
					// Directory without table - still add it but with empty children
					structure.push({
						type: "directory",
						name: item.text,
						path: item.href,
						children: [],
					});
				}
			} else {
				// This is a file - extract its content
				console.log(
					`${"  ".repeat(depth)}Extracting content from file: ${item.text}`
				);

				const response = await axios.get(
					"https://github.com/" + item.href.toString()
				);
				const $ = load(response.data);
				const article = $("textarea.react-blog-textarea").contents();

				const dom = new JSDOM($.html());

				if (article.html().length > 0) {
					const content = dom.window.document;
					const { markdown } = extractSemanticContentWithFormattedMarkdown(
						content.body
					);

					structure.push({
						type: "file",
						name: item.text,
						path: item.href,
						content: markdown,
						contentLength: markdown.length,
					});

					console.log(
						`${"  ".repeat(depth)}✅ Extracted ${
							markdown.length
						} characters from ${item.text}`
					);
				} else {
					console.log(
						`${"  ".repeat(depth)}❌ No article content found in file: ${
							item.text
						}`
					);
					// File without content - still add it but with empty content
					structure.push({
						type: "file",
						name: item.text,
						path: item.href,
						content: "",
						contentLength: 0,
					});
				}
			}
		} catch (error) {
			console.error(
				`${"  ".repeat(depth)}❌ Error processing ${item.text}:`,
				error.message
			);
			// Add error entry to structure
			structure.push({
				type: "error",
				name: item.text,
				path: item.href,
				error: error.message,
			});
		}
	}

	console.log(
		`${"  ".repeat(depth)}Completed building structure. Found ${
			structure.length
		} items.`
	);
	return structure;
};

env.useWebWorkers = false;
env.useFSCache = true;
env.useBrowserCache = false;
env.cacheDir =
	process.env.NODE_ENV === "production" ? "/tmp/hf-cache" : "./cache";

async function createEmbeddingRecord(
	markdownContent,
	id,
	metadata = {},
	timestamp = new Date().toISOString()
) {
	// Get embedding with pooling and normalization for fixed-length vector
	const embeddingResult = await hgpipeline("embeddings", model, {
		cache_dir: "./cache",
		revision: "main",
		device: "cpu",
		dtype: "float32",
		subfolder: "onnx",
		use_external_data_format: true,
		model_file_name: "model.onnx",
	});

	// embeddingResult.data is Float32Array of vector values
	const embeddingVector = Array.from(embeddingResult.data); // Convert to plain array for storage

	return {
		id,
		content: markdownContent,
		vector: embeddingVector,
		metadata,
		timestamp,
	};
}

const generateVectorEmbeddings = async (obj) => {
	const {
		id,
		name,
		state,
		latitude,
		longitude,
		wikipedia_content,
		unsplash_images,
		images,
	} = obj;
	const joinedText = [
		name,
		state,
		`lat:${latitude}, long:${longitude}`,
		JSON.stringify(wikipedia_content),
		unsplash_images?.join(", "),
		images?.join(", "),
	].join("\n");

	// Generate embedding for the search query
	const { vector: embeddingVector } = await createEmbeddingRecord(
		joinedText,
		`unique_id_${Math.random() + Date.now()}`
	);

	// same time update supabase using obj.id
	const { error } = await supabase
		.from("locations")
		.update({
			vectorEmbedding: embeddingVector,
		})
		.eq("id", id);

	if (error) {
		console.error("❌ Error updating supabase:", error);
		return {
			id,
			error: error.message,
			success: false,
		};
	}
	return {
		id,
		vectorEmbedding: embeddingVector,
		success: true,
	};
};

// Create an API endpoint (example shown with ExpressJS)
app.post("/generate-embeddings", async (c) => {
	return c.json({
		success: true,
		embeddings: filteredEmbeddings,
		timestamp: new Date().toISOString(),
	});
});

app.post("/perform-search", async (c) => {
	const { query, num = 10 } = await c.req.json();
	if (!query) {
		return c.json({ error: "Query text is required" }, 400);
	}
	try {
		// Generate embedding for the search query
		const embeddingResult = await embedder(query, {
			pooling: "mean",
			normalize: true,
		});
		const queryVector = Array.from(embeddingResult.data);

		const { data: results, error } = await supabase.rpc("match_locations", {
			query_embedding: queryVector,
			match_threshold: 0.2,
			match_count: num,
		});
		return c.json(
			{
				data: results,
			},
			200
		);
	} catch (err) {
		console.error(err);
		return c.json({ error: "Server error" }, 500);
	}
});

export default app;
