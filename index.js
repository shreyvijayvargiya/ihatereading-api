import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { firestore, storage } from "./firebase.js";
import { GoogleGenAI } from "@google/genai";
import { chromium } from "playwright";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { performance } from "perf_hooks";
import { cpus } from "os";
import { ChatOllama } from "@langchain/ollama";
import UserAgent from "user-agents";
import { pipeline } from "@xenova/transformers";
import { v4 as uuidv4 } from "uuid";
import { imageDimensionsFromStream } from "image-dimensions";
import toMarkdown from "./lib/toMarkdown.js";
import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { load } from "cheerio";
import extractImagesFromContent from "./lib/extractImages.js";
import TurndownService from "turndown";

const userAgents = new UserAgent();

const ollama = new ChatOllama({
	// model: "gemma:2b",
	model: "nemotron-mini:latest",
	baseURL: "http://localhost:11434",
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

		// Sort by last used time and fail count
		const sortedProxies = availableProxies.sort((a, b) => {
			if (a.failCount !== b.failCount) {
				return a.failCount - b.failCount;
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

// Initialize the embedding model
let embedder = null;

// Initialize embedding model asynchronously
async function initializeEmbedder() {
	try {
		console.log("🔄 Initializing embedding model...");
		embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
		console.log("✅ Embedding model initialized successfully");
	} catch (error) {
		console.error("❌ Failed to initialize embedding model:", error);
	}
}

// Initialize the embedder when the server starts
initializeEmbedder();

// Function to create embeddings for text
async function createEmbedding(text) {
	if (!embedder) {
		throw new Error(
			"Embedding model not initialized. Please wait for initialization to complete."
		);
	}

	try {
		const embedding = await embedder(text);
		return embedding;
	} catch (error) {
		console.error("Error creating embedding:", error);
		throw new Error(`Failed to create embedding: ${error.message}`);
	}
}

// Function to create embeddings for multiple text chunks
async function embedChunks(chunks) {
	if (!embedder) {
		throw new Error(
			"Embedding model not initialized. Please wait for initialization to complete."
		);
	}

	try {
		return Promise.all(
			chunks.map(async (chunk) => {
				const embedding = await embedder(chunk);
				return { chunk, embedding };
			})
		);
	} catch (error) {
		console.error("Error creating embeddings for chunks:", error);
		throw new Error(`Failed to create embeddings for chunks: ${error.message}`);
	}
}

const app = new Hono();

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

// Core Google Maps scraping function (extracted from the endpoint)
const scrapeGoogleMapsLocation = async (
	query,
	browserInstance = null,
	contextInstance = null
) => {
	try {
		let browser = browserInstance;
		let context = contextInstance;
		let shouldCloseBrowser = false;
		let shouldCloseContext = false;

		try {
			// Use provided browser instance or create new one
			if (!browser) {
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
						"--disable-web-security",
						"--disable-features=VizDisplayCompositor",
						"--disable-background-timer-throttling",
						"--disable-backgrounding-occluded-windows",
						"--disable-renderer-backgrounding",
					],
				});
				shouldCloseBrowser = true;
			}

			// Use provided context or create new one
			if (!context) {
				context = await browser.newContext();

				// Block unnecessary resources to improve performance
				await context.route("**/*", (route) => {
					const type = route.request().resourceType();
					return ["image", "font", "stylesheet", "media"].includes(type)
						? route.abort()
						: route.continue();
				});
				shouldCloseContext = true;
			}

			const page = await context.newPage();

			// Navigate to Google Maps with optimized settings
			await page.goto(
				`https://www.google.com/maps/search/${encodeURIComponent(query)}`,
				{
					waitUntil: "domcontentloaded", // Faster than networkidle
					timeout: 20000, // Reduced timeout
				}
			);

			// Wait for the map to load with better strategy
			await page.waitForSelector('div[role="main"]', { timeout: 15000 });

			// Wait for map to fully load and coordinates to appear
			// Give more time for city searches to resolve to specific coordinates
			await page.waitForTimeout(3000);

			// Try to wait for any loading indicators to disappear
			try {
				await page.waitForSelector("[data-js-log]", { timeout: 5000 });
			} catch (e) {
				// Ignore if not found, continue anyway
			}

			// Try to click on the map to get more specific coordinates
			try {
				// Look for the main map area and click on it
				const mapArea = await page.$('div[role="main"]');
				if (mapArea) {
					// Click in the center of the map area
					await mapArea.click();
					await page.waitForTimeout(1000); // Wait for any map interactions
				}
			} catch (e) {
				// Ignore click errors
			}

			// Extract location data with improved coordinate detection
			const locationData = await page.evaluate(() => {
				console.log("🔍 Starting coordinate extraction...");
				const url = window.location.href;

				// Try multiple ways to get coordinates
				let coordinates = null;

				// Method 1: Check URL for coordinates
				const urlCoordsMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
				if (urlCoordsMatch) {
					coordinates = {
						lat: parseFloat(urlCoordsMatch[1]),
						lng: parseFloat(urlCoordsMatch[2]),
					};
					console.log("✅ Found coordinates in URL:", coordinates);
				} else {
					console.log("❌ No coordinates in URL");
				}

				// Method 2: Look for coordinates in the page content
				if (!coordinates) {
					// Try to find coordinates in various page elements
					const coordElements = document.querySelectorAll(
						"[data-lat], [data-lng], [data-coordinates]"
					);
					for (const element of coordElements) {
						const lat =
							element.getAttribute("data-lat") ||
							element.getAttribute("data-coordinates");
						const lng = element.getAttribute("data-lng");
						if (lat && lng) {
							const latNum = parseFloat(lat);
							const lngNum = parseFloat(lng);
							if (!isNaN(latNum) && !isNaN(lngNum)) {
								coordinates = { lat: latNum, lng: lngNum };
								break;
							}
						}
					}
				}

				// Method 3: Look for coordinates in text content
				if (!coordinates) {
					const pageText = document.body.textContent;
					const coordPattern = /(-?\d+\.\d+),\s*(-?\d+\.\d+)/g;
					const matches = pageText.match(coordPattern);
					if (matches && matches.length > 0) {
						// Take the first coordinate pair found
						const coords = matches[0]
							.split(",")
							.map((c) => parseFloat(c.trim()));
						if (coords.length === 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
							coordinates = { lat: coords[0], lng: coords[1] };
						}
					}
				}

				// Method 4: Try to get coordinates from map center (if available)
				if (!coordinates && window.google && window.google.maps) {
					try {
						const map =
							document.querySelector("#scene-container") ||
							document.querySelector("[data-js-log]");
						if (map && map._googleMap) {
							const center = map._googleMap.getCenter();
							if (center) {
								coordinates = { lat: center.lat(), lng: center.lng() };
							}
						}
					} catch (e) {
						// Ignore errors accessing map object
					}
				}

				const locationName = document.querySelector("h1")?.textContent || "";
				const address =
					document.querySelector('button[data-item-id="address"]')
						?.textContent || "";

				return {
					name: locationName,
					address: address,
					coordinates: coordinates,
					url: url,
				};
			});

			// Close only the page, keep context for reuse
			await page.close();

			// If no coordinates found, try a fallback strategy for city names
			if (!locationData.coordinates) {
				console.log(
					`⚠️ No coordinates found for "${query}", trying fallback strategy...`
				);

				// For city names, try to get approximate coordinates by searching with "city center" or similar
				if (
					query &&
					!query.includes("restaurant") &&
					!query.includes("hotel") &&
					!query.includes("market")
				) {
					// This might be a city name, try to get approximate coordinates
					console.log(
						`📍 Query "${query}" appears to be a city name, coordinates may be approximate`
					);

					// Return success with a note about approximate coordinates
					return {
						success: true,
						data: {
							...locationData,
							note: "City name - coordinates may be approximate or city center",
							queryType: "city",
						},
						warning: "City coordinates are approximate",
					};
				}

				return {
					success: false,
					error: "Location not found or coordinates not available",
					data: locationData,
				};
			}

			return {
				success: true,
				data: locationData,
			};
		} catch (error) {
			console.error(`Error processing query "${query}":`, error);
			return {
				success: false,
				error: error.message,
				data: {
					query,
					name: "",
					address: "",
					coordinates: null,
					url: "",
				},
			};
		} finally {
			// Only close context if we created it (not for shared instances)
			if (context && shouldCloseContext) {
				await context.close();
			}
			// Only close browser if we created it (not for shared instances)
			if (browser && shouldCloseBrowser) {
				await browser.close();
			}
		}
	} catch (error) {
		console.error("Google Maps Scraping Error:", error);
		return {
			success: false,
			error: "Failed to fetch location data",
			details: error.message,
		};
	}
};

// Bulk scraping with multiple browser instances for parallel processing
const scrapeGoogleMapsBulk = async (queries, maxConcurrentBrowsers = 3) => {
	const results = [];
	const browsers = [];
	const contexts = [];

	try {
		for (let i = 0; i < maxConcurrentBrowsers; i++) {
			const browser = await chromium.launch({
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
					"--disable-web-security",
					"--disable-features=VizDisplayCompositor",
					"--disable-background-timer-throttling",
					"--disable-backgrounding-occluded-windows",
					"--disable-renderer-backgrounding",
				],
			});

			// Create context for this browser
			const context = await browser.newContext();

			// Block unnecessary resources to improve performance
			await context.route("**/*", (route) => {
				const type = route.request().resourceType();
				return ["image", "font", "stylesheet", "media"].includes(type)
					? route.abort()
					: route.continue();
			});

			browsers.push(browser);
			contexts.push(context);
		}

		// Process queries in batches to avoid overwhelming Google Maps
		const batchSize = Math.max(
			1,
			Math.ceil(queries.length / maxConcurrentBrowsers)
		);
		const batches = [];
		for (let i = 0; i < queries.length; i += batchSize) {
			batches.push(queries.slice(i, i + batchSize));
		}

		// Process batches sequentially to avoid rate limiting
		for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
			const batch = batches[batchIndex];
			console.log(
				`🔄 Processing batch ${batchIndex + 1}/${batches.length} with ${
					batch.length
				} queries`
			);

			// Process current batch in parallel
			const batchPromises = batch.map(async (query, index) => {
				const browserIndex = index % maxConcurrentBrowsers;
				const browser = browsers[browserIndex];
				const context = contexts[browserIndex];

				// Retry mechanism for failed queries
				const maxRetries = 2;
				let lastError = null;

				for (let retry = 0; retry <= maxRetries; retry++) {
					try {
						if (retry > 0) {
							console.log(
								`🔄 Retry ${retry} for query "${query}" with browser ${
									browserIndex + 1
								}`
							);
							// Small delay before retry
							await new Promise((resolve) => setTimeout(resolve, 1000));
						} else {
							console.log(
								`🔍 Processing query "${query}" with browser ${
									browserIndex + 1
								}`
							);
						}

						const result = await scrapeGoogleMapsLocation(
							query,
							browser,
							context
						);

						// If successful, return result
						if (result.success) {
							return { query, result };
						}

						// If no coordinates found, don't retry
						if (
							result.error === "Location not found or coordinates not available"
						) {
							return { query, result };
						}

						// For other errors, continue to retry
						lastError = result.error;
					} catch (error) {
						lastError = error.message;
						console.error(
							`Error processing query "${query}" (attempt ${retry + 1}):`,
							error
						);

						// If it's the last retry, return error
						if (retry === maxRetries) {
							return {
								query,
								result: { success: false, error: error.message },
							};
						}
					}
				}

				// If all retries failed, return last error
				return {
					query,
					result: {
						success: false,
						error: lastError || "Max retries exceeded",
					},
				};
			});

			// Wait for current batch to complete
			const batchResults = await Promise.all(batchPromises);
			results.push(...batchResults);

			// Add delay between batches to avoid overwhelming Google Maps
			if (batchIndex < batches.length - 1) {
				const delay = Math.min(2000, batch.length * 500); // Adaptive delay based on batch size
				console.log(`⏳ Waiting ${delay}ms before next batch...`);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}

		// Calculate final statistics
		const successfulQueries = results.filter((r) => r.result.success).length;
		const failedQueries = results.filter((r) => !r.result.success).length;
		const successRate = ((successfulQueries / results.length) * 100).toFixed(2);

		console.log(
			`🎉 All batches completed! Total queries processed: ${results.length}`
		);
		console.log(`📊 Final Statistics:`);
		console.log(`✅ Successful: ${successfulQueries}`);
		console.log(`❌ Failed: ${failedQueries}`);
		console.log(`📈 Success Rate: ${successRate}%`);

		return results;
	} catch (error) {
		console.error("Bulk scraping error:", error);
		return results; // Return partial results if available
	} finally {
		// Close all contexts first
		console.log(`🧹 Closing ${contexts.length} browser contexts`);
		await Promise.all(contexts.map((context) => context.close()));

		// Then close all browser instances
		console.log(`🧹 Closing ${browsers.length} browser instances`);
		await Promise.all(browsers.map((browser) => browser.close()));
	}
};

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

app.post("/scrap-google-images", async (c) => {
	const { queries, options = {}, limit = 5 } = await c.req.json();

	// Handle both single query and array of queries
	const queryArray = Array.isArray(queries) ? queries : [queries];

	if (!queryArray.length || queryArray.some((q) => !q)) {
		return c.json({ error: "Invalid queries" }, 400);
	}

	let browser;
	try {
		const tbsParts = Object.entries(options)
			.map(([k, v]) => codeMap[k]?.[v])
			.filter(Boolean);
		const tbsQuery = tbsParts.length ? `&tbs=${tbsParts.join(",")}` : "";

		// Launch browser with proper configuration
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
		const context = await browser.newContext({
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.61 Safari/537.36",
			viewport: { width: 1920, height: 1080 },
			extraHTTPHeaders: {
				dnt: "1",
				"upgrade-insecure-requests": "1",
				accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
				"sec-fetch-site": "same-origin",
				"sec-fetch-mode": "navigate",
				"sec-fetch-user": "?1",
				"sec-fetch-dest": "document",
				referer: "https://www.google.com/",
				"accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
			},
		});

		// Block unnecessary resources
		await context.route("**/*", (route) => {
			const type = route.request().resourceType();
			return ["font", "stylesheet"].includes(type)
				? route.abort()
				: route.continue();
		});

		// Process all queries in parallel using Promise.all
		const results = await Promise.all(
			queryArray.map(async (query) => {
				const page = await context.newPage();
				try {
					await page.goto(
						`https://www.google.com/search?q=${encodeURIComponent(
							query
						)}&tbm=isch${tbsQuery}`,
						{
							waitUntil: "networkidle",
						}
					);
					await page.waitForSelector('img[src^="https"]');
					await page.evaluate(() =>
						window.scrollTo(0, document.body.scrollHeight)
					);
					await page.waitForTimeout(2000);

					const images = await page.evaluate(
						(max) =>
							Array.from(document.querySelectorAll('img[src^="https"]'))
								.map((img) => ({
									url: img.src,
									w: img.naturalWidth,
									h: img.naturalHeight,
									...img,
								}))
								.filter((i) => i.w > 100 && i.h > 100)
								.slice(0, max)
								.map((i) => i.url),
						limit
					);

					return { query, images };
				} catch (error) {
					console.error(`Error processing query "${query}":`, error);
					return {
						query,
						images: [],
						error: error.message,
					};
				} finally {
					await page.close();
				}
			})
		);

		// Close the shared context after all queries are complete
		await context.close();

		// If single query was provided, return just the images array
		if (!Array.isArray(queries)) {
			const result = results[0];
			if (!result.images.length) {
				return c.json({
					error: "No images found",
					data: result,
				});
			}
			return c.json(result.images);
		}

		// For multiple queries, return array of results
		return c.json(results);
	} catch (error) {
		console.error("Error scraping Google Images:", error);
		return c.json({
			error: "Failed to fetch images",
			details: error.message,
		});
	} finally {
		if (browser) {
			await browser.close();
		}
	}
});

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
			model: "gemini-2.0-flash",
			contents: [
				{ role: "model", parts: [{ text: generateItineraryPrompt(prompt) }] },
				{ role: "user", parts: [{ text: userPrompt }] },
			],
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
	// i can queue multiple API URL
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

// Dedicated Bing Search endpoint using Playwright (like multi-search)
app.post("/bing-search", async (c) => {
	const {
		query,
		limit = 5,
		config = {
			timeout: 30000,
		},
	} = await c.req.json();

	if (!query) {
		return c.json({ error: "Query is required" }, 400);
	}

	let searchResults;
	let browser;

	try {
		// Use Playwright like bing-search for JavaScript rendering
		browser = await chromium.launch({
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
			],
		});

		const context = await browser.newContext({
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.61 Safari/537.36",
			viewport: { width: 1920, height: 1080 },
			extraHTTPHeaders: {
				dnt: "1",
				"upgrade-insecure-requests": "1",
				accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
				"sec-fetch-site": "same-origin",
				"sec-fetch-mode": "navigate",
				"sec-fetch-user": "?1",
				"sec-fetch-dest": "document",
				referer: "https://www.bing.com/",
				"accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
			},
		});

		const page = await context.newPage();

		// Navigate to Bing search
		await page.goto(
			`https://www.bing.com/search?q=${encodeURIComponent(
				query
			)}&count=${limit}`,
			{
				waitUntil: "networkidle",
				timeout: config.timeout,
			}
		);

		// Wait for search results to load (like multi-search does)
		await page.waitForTimeout(1000);

		// Extract search results using the same method as multi-search
		const bingResults = await page.evaluate((maxResults) => {
			const results = [];
			const searchItems = document.querySelectorAll(".b_algo");

			searchItems.forEach((item, index) => {
				if (index >= maxResults) return;

				const titleElement = item.querySelector("h2 a");
				const snippetElement = item.querySelector(".b_caption p");

				if (titleElement) {
					results.push({
						title: titleElement.textContent.trim(),
						url: titleElement.href,
						snippet: snippetElement ? snippetElement.textContent.trim() : "",
						position: index + 1,
					});
				}
			});

			return results;
		}, limit);

		// Process results and add domain extraction
		const results = bingResults.map((result, index) => {
			let domain = "";
			try {
				domain = new URL(result.url).hostname.replace("www.", "");
			} catch (e) {
				domain = "";
			}

			return {
				...result,
				domain,
				position: index + 1,
			};
		});

		if (results.length === 0) {
			console.warn(
				"⚠️ No Bing search results found - possible detection or no results"
			);
			searchResults = {
				error: "No search results found. Bing may have blocked the request.",
				noResults: true,
				suggestion: "Try a different query or wait before retrying",
			};
		} else {
			console.log(
				`✅ Found ${results.length} Bing search results using Playwright`
			);
			searchResults = results;
		}

		await page.close();
		await context.close();
	} catch (error) {
		console.error("Bing search error with Playwright:", error);
		searchResults = { error: error.message };
	} finally {
		if (browser) {
			await browser.close();
		}
	}

	return c.json({
		success: true,
		query,
		results: searchResults,
		total: Array.isArray(searchResults) ? searchResults.length : 0,
		engine: "bing",
		config: {
			timeout: config.timeout,
		},
	});
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

		// Add page info
		scrapedData.pageInfo = {
			url: url,
			scrapedAt: new Date().toISOString(),
			userAgent: userAgents.random().toString(),
			viewport: await page.viewportSize(),
			proxyInfo:
				useProxy && context.proxyInfo
					? {
							host: context.proxyInfo.host,
							port: context.proxyInfo.port,
							country: context.proxyInfo.country,
					  }
					: null,
		};

		await page.close();
		await context.close();

		// Mark proxy as successful if used
		if (useProxy && context.proxyInfo) {
			handleProxyResult(context, true);
			console.log(
				`✅ Proxy ${context.proxyInfo.host} marked as successful for ${url}`
			);
		}

		// const prompt = `
		// We are providing you the JSON format scraped data from the URL ${url} given by the user. Understand the JSON prompt to
		// answer the user question.
		// Here is the JSON data:
		// ${JSON.stringify(scrapedData)}
		// Here is the user question:
		// ${userQuestion}
		// `;
		// const response = genai.models.generateContent({
		// 	model: "gemini-1.5-flash",
		// 	prompt: "Extract the main content of the page",
		// 	contents: [
		// 		{
		// 			role: "model",
		// 			parts: [
		// 				{
		// 					text: prompt,
		// 				},
		// 			],
		// 		},
		// 	],
		// });

		// End performance monitoring
		const endTime = performance.now();
		const endCpuUsage = process.cpuUsage();
		const endMemoryUsage = process.memoryUsage();

		const performanceMetrics = {
			duration: endTime - startTime,
			cpuUsage: {
				user: endCpuUsage.user - startCpuUsage.user,
				system: endCpuUsage.system - startCpuUsage.system,
				total:
					endCpuUsage.user +
					endCpuUsage.system -
					(startCpuUsage.user + startCpuUsage.system),
			},
			memoryUsage: {
				rss: endMemoryUsage.rss - startMemoryUsage.rss,
				heapUsed: endMemoryUsage.heapUsed - startMemoryUsage.heapUsed,
				heapTotal: endMemoryUsage.heapTotal - startMemoryUsage.heapTotal,
			},
			resourceBlocking: blockedResources,
		};

		// Log performance metrics
		console.log(`📊 Scrap-URL Performance:`);
		console.log(`   ⏱️ Duration: ${performanceMetrics.duration.toFixed(2)}ms`);
		console.log(
			`   💻 CPU: ${(performanceMetrics.cpuUsage.total / 1000000).toFixed(2)}s`
		);
		console.log(
			`   🧠 Memory: ${(
				performanceMetrics.memoryUsage.heapUsed /
				1024 /
				1024
			).toFixed(2)} MB`
		);
		console.log(
			`   🚫 Blocked: ${blockedResources.images} images, ${blockedResources.fonts} fonts, ${blockedResources.stylesheets} stylesheets, ${blockedResources.media} media`
		);

		return c.json({
			success: true,
			data: scrapedData,
			//answer: (await response).candidates[0].content.parts[0].text,
			url: url,
			timestamp: new Date().toISOString(),
			proxyUsed:
				useProxy && context.proxyInfo
					? {
							host: context.proxyInfo.host,
							port: context.proxyInfo.port,
							country: context.proxyInfo.country,
					  }
					: null,
			useProxy: useProxy, // Include the flag to show what was used
			performance: performanceMetrics,
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
	const { query, platform } = await c.req.json();

	if (!query) {
		return c.json({ success: false, error: "query is required" }, 400);
	}

	if (!platform) {
		return c.json(
			{
				success: false,
				error:
					"Platform is required. Choose from: 'google', 'unsplash', 'getty', 'istock', 'shutterstock', 'adobe', 'pexels', 'pixabay', 'freepik', 'pinterest', 'flickr', 'fivehundredpx', 'deviantart', 'behance', 'artstation', 'reuters', 'apimages', 'custom'",
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
				includeLinks: true,
				extractMetadata: true,
				// selectors: getPlatformSelectors(platform),
				// Platform-specific wait selectors
				// waitForSelector: getPlatformWaitSelector(platform),
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
app.post("/reddit-post", async (c) => {
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

// goverment website to register complain or individual contact to share complaints
// Wikipedia URL validation utility
async function checkWikipediaURL(url) {
	try {
		const res = await fetch(url, { method: "HEAD" });
		return res.ok;
	} catch {
		return false;
	}
}

// Wikipedia URL generation utility with 3 specific strategies
function generateWikipediaURLs(cityName, stateName) {
	const urls = [];

	// Clean city name - replace spaces with underscores
	const cleanCity = cityName.trim().replace(/\s+/g, "_");

	// Clean state name - keep original spaces, don't add underscores
	const cleanState = stateName ? stateName.trim() : "";

	// Strategy 1: domain.com/wiki/city,_state (with original spaces in state)
	if (cleanState) {
		urls.push(`https://en.wikipedia.org/wiki/${cleanCity},_${cleanState}`);
	}

	// Strategy 2: domain.com/wiki/city,_state (with underscores in state)
	if (cleanState) {
		const cleanStateWithUnderscores = cleanState.replace(/\s+/g, "_");
		urls.push(
			`https://en.wikipedia.org/wiki/${cleanCity},_${cleanStateWithUnderscores}`
		);
	}

	// Strategy 3: domain.com/wiki/city (city only, no state)
	urls.push(`https://en.wikipedia.org/wiki/${cleanCity}`);

	return urls;
}

// Wikipedia content extraction utility using existing scrap-url API
async function extractWikipediaContent(wikipediaUrl, useProxy = false) {
	try {
		console.log(`🔍 Scraping Wikipedia content from: ${wikipediaUrl}`);

		// Use the existing scrap-url API endpoint
		const response = await fetch(`http://localhost:3001/scrap-url`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				url: wikipediaUrl,
				useProxy: useProxy,
				includeImages: false,
				includeLinks: false,
				extractMetadata: true,
				timeout: 30000,
				waitForSelector: "#mw-content-text",
			}),
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const scrapedData = await response.json();

		if (!scrapedData.success) {
			return {
				success: false,
				error: scrapedData.error || "Failed to scrape Wikipedia page",
				url: wikipediaUrl,
			};
		}

		// Extract paragraphs from semantic content
		const paragraphs =
			scrapedData.data?.content?.semanticContent?.paragraphs || [];

		if (paragraphs.length === 0) {
			return {
				success: false,
				error: "No paragraphs found in Wikipedia content",
				url: wikipediaUrl,
			};
		}

		return {
			success: true,
			data: {
				title: scrapedData.data.title,
				url: wikipediaUrl,
				extractedAt: new Date().toISOString(),
				paragraphs: paragraphs,
				summary: paragraphs.slice(0, 3).join(" ").substring(0, 500) + "...",
				rawData: scrapedData.data,
			},
			url: wikipediaUrl,
		};
	} catch (error) {
		console.error(
			`❌ Wikipedia content extraction error for ${wikipediaUrl}:`,
			error
		);
		return {
			success: false,
			error: error.message,
			url: wikipediaUrl,
		};
	}
}

// Bulk Wikipedia scraping with queue management
const wikipediaScrapingQueue = {
	batches: new Map(),
	currentBatch: 0,
	isProcessing: false,

	addBatch(batchNumber, locations) {
		this.batches.set(batchNumber, {
			locations,
			status: "pending",
			startedAt: null,
			completedAt: null,
			results: [],
			successCount: 0,
			failedCount: 0,
			errors: [],
		});
	},

	getNextBatch() {
		for (const [batchNumber, batch] of this.batches) {
			if (batch.status === "pending") {
				return { batchNumber, batch };
			}
		}
		return null;
	},

	markBatchStarted(batchNumber) {
		const batch = this.batches.get(batchNumber);
		if (batch) {
			batch.status = "processing";
			batch.startedAt = new Date();
		}
	},

	markBatchCompleted(batchNumber, results) {
		const batch = this.batches.get(batchNumber);
		if (batch) {
			batch.status = "completed";
			batch.completedAt = new Date();
			batch.results = results;
			batch.successCount = results.filter((r) => r.success).length;
			batch.failedCount = results.filter((r) => !r.success).length;
		}
	},

	getStats() {
		const total = this.batches.size;
		const pending = Array.from(this.batches.values()).filter(
			(b) => b.status === "pending"
		).length;
		const processing = Array.from(this.batches.values()).filter(
			(b) => b.status === "processing"
		).length;
		const completed = Array.from(this.batches.values()).filter(
			(b) => b.status === "completed"
		).length;

		return {
			total,
			pending,
			processing,
			completed,
			batches: Array.from(this.batches.entries()).map(([number, batch]) => ({
				batchNumber: number,
				status: batch.status,
				startedAt: batch.startedAt,
				completedAt: batch.completedAt,
				successCount: batch.successCount,
				failedCount: batch.failedCount,
			})),
		};
	},
};

// Bulk Airbnb scraping with queue management
const airbnbScrapingQueue = {
	batches: new Map(),
	currentBatch: 0,
	isProcessing: false,

	addBatch(batchNumber, locations) {
		this.batches.set(batchNumber, {
			locations,
			status: "pending",
			startedAt: null,
			completedAt: null,
			results: [],
			successCount: 0,
			failedCount: 0,
			errors: [],
		});
	},

	getNextBatch() {
		for (const [batchNumber, batch] of this.batches) {
			if (batch.status === "pending") {
				return { batchNumber, batch };
			}
		}
		return null;
	},

	markBatchStarted(batchNumber) {
		const batch = this.batches.get(batchNumber);
		if (batch) {
			batch.status = "processing";
			batch.startedAt = new Date();
		}
	},

	markBatchCompleted(batchNumber, results) {
		const batch = this.batches.get(batchNumber);
		if (batch) {
			batch.status = "completed";
			batch.completedAt = new Date();
			batch.results = results;
			batch.successCount = results.filter((r) => r.success).length;
			batch.failedCount = results.filter((r) => !r.success).length;
		}
	},

	getStats() {
		const total = this.batches.size;
		const pending = Array.from(this.batches.values()).filter(
			(b) => b.status === "pending"
		).length;
		const processing = Array.from(this.batches.values()).filter(
			(b) => b.status === "processing"
		).length;
		const completed = Array.from(this.batches.values()).filter(
			(b) => b.status === "completed"
		).length;

		return {
			total,
			pending,
			processing,
			completed,
			batches: Array.from(this.batches.entries()).map(([number, batch]) => ({
				batchNumber: number,
				status: batch.status,
				startedAt: batch.startedAt,
				completedAt: batch.completedAt,
				successCount: batch.successCount,
				failedCount: batch.failedCount,
			})),
		};
	},
};

app.post("/bulk-airbnb-scrap", async (c) => {
	try {
		const {
			batchSize = 50,
			maxConcurrentBrowsers = 3,
			useProxy = false,
		} = await c.req.json();

		// Fetch locations from Supabase
		const { data: locations, error: fetchError } = await supabase
			.from("locations")
			.select("id, name, state")
			.order("id", { ascending: false })
			.limit(40);

		if (fetchError) {
			console.error("❌ Error fetching locations from Supabase:", fetchError);
			return c.json(
				{
					success: false,
					error: "Failed to fetch locations from database",
					details: fetchError.message,
				},
				500
			);
		}

		if (!locations || locations.length === 0) {
			return c.json(
				{
					success: false,
					error: "No locations found in database",
					suggestion:
						"Ensure the locations table has data before running Airbnb scraping",
				},
				404
			);
		}

		// Create batches
		const batches = [];
		for (let i = 0; i < locations.length; i += batchSize) {
			const batch = locations.slice(i, i + batchSize);
			const batchNumber = batches.length;
			batches.push({ batchNumber, locations: batch });

			// Add to queue
			airbnbScrapingQueue.addBatch(batchNumber, batch);
		}

		// Start processing in background
		airbnbScrapingQueue.isProcessing = true;
		processAirbnbBatches(batches, maxConcurrentBrowsers, useProxy);

		return c.json({
			success: true,
			message: "Bulk Airbnb scraping started successfully",
			data: {
				totalLocations: locations.length,
				batchSize,
				totalBatches: batches.length,
				maxConcurrentBrowsers,
				useProxy,
				queueStatus: airbnbScrapingQueue.getStats(),
			},
			endpoints: {
				status: "/airbnb-scraping-status",
				results: "/airbnb-scraping-results",
			},
		});
	} catch (error) {
		console.error("❌ Bulk Airbnb scraping error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to start bulk Airbnb scraping",
				details: error.message,
			},
			500
		);
	}
});

// Background processing function
async function processAirbnbBatches(batches, maxConcurrentBrowsers, useProxy) {
	try {
		// Process batches sequentially to avoid overwhelming Airbnb
		for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
			const { batchNumber, locations } = batches[batchIndex];

			// Mark batch as started
			airbnbScrapingQueue.markBatchStarted(batchNumber);

			// Process current batch
			const batchResults = await processAirbnbBatch(
				locations,
				maxConcurrentBrowsers,
				useProxy
			);

			console.log(`📊 Batch ${batchNumber} results:`, {
				totalResults: batchResults.length,
				successful: batchResults.filter((r) => r.success).length,
				failed: batchResults.filter((r) => !r.success).length,
				results: batchResults,
			});

			// Data is already stored in Supabase during chunk processing
			// No need to call storeAirbnbResults again

			// Mark batch as completed
			airbnbScrapingQueue.markBatchCompleted(batchNumber, batchResults);

			// Add delay between batches to be respectful to Airbnb
			if (batchIndex < batches.length - 1) {
				const delay = Math.min(10000, locations.length * 200); // Adaptive delay
				console.log(`⏳ Waiting ${delay}ms before next batch...`);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}

		console.log("🎉 All Airbnb batches completed successfully!");
		airbnbScrapingQueue.isProcessing = false;
	} catch (error) {
		console.error("❌ Error processing Airbnb batches:", error);
		airbnbScrapingQueue.isProcessing = false;
	}
}

// Process a single batch of locations
async function processAirbnbBatch(locations, maxConcurrentBrowsers, useProxy) {
	const results = [];

	try {
		// Process locations with controlled concurrency
		const concurrencyLimit = Math.min(maxConcurrentBrowsers, 3); // Cap at 3 concurrent requests
		const chunks = [];

		// Split locations into chunks for controlled concurrency
		for (let i = 0; i < locations.length; i += concurrencyLimit) {
			chunks.push(locations.slice(i, i + concurrencyLimit));
		}

		// Process chunks sequentially to avoid overwhelming the API
		for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
			const chunk = chunks[chunkIndex];

			// Process current chunk in parallel
			const chunkPromises = chunk.map(async (location) => {
				try {
					// Call the existing scrap-airbnb endpoint logic
					const searchQuery = `${location.name.replaceAll(
						" ",
						"-"
					)}--${location.state.replaceAll(" ", "-")}`;
					const airbnbUrl = `https://www.airbnb.com/s/${searchQuery}--India/homes`;

					const response = await fetch(`http://localhost:3001/scrap-airbnb`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							city: location.name,
							state: location.state,
						}),
					});

					if (!response.ok) {
						throw new Error(`HTTP error! status: ${response.status}`);
					}

					const scrapData = await response.json();

					return {
						locationId: location.id,
						locationName: location.name,
						locationState: location.state,
						success: true,
						airbnbUrl: airbnbUrl,
						listings: scrapData.listings,
						totalListings: scrapData.listings.length,
					};
				} catch (error) {
					console.warn(
						`⚠️ Failed to scrape Airbnb for ${location.name}:`,
						error.message
					);
					return {
						locationId: location.id,
						locationName: location.name,
						locationState: location.state,
						success: false,
						error: error.message,
					};
				}
			});

			// Wait for current chunk to complete
			const chunkResults = await Promise.all(chunkPromises);

			// Store results directly to Supabase here
			console.log(
				`💾 Storing ${chunkResults.length} chunk results to Supabase...`
			);
			for (const result of chunkResults) {
				if (
					result.success &&
					result.listings &&
					Array.isArray(result.listings)
				) {
					try {
						console.log(
							`💾 Updating location ${result.locationId} with ${result.totalListings} listings...`
						);

						const { error } = await supabase
							.from("locations")
							.update({
								airbnb_listings: result.listings,
								airbnb_url: [result.airbnbUrl],
							})
							.eq("id", result.locationId);

						if (error) {
							console.error(
								`❌ Failed to update location ${result.locationId}:`,
								error
							);
						} else {
							console.log(
								`✅ Updated location ${result.locationId} with Airbnb listings (${result.totalListings} listings)`
							);
						}
					} catch (dbError) {
						console.error(
							`❌ Database error for location ${result.locationId}:`,
							dbError
						);
					}
				} else {
					console.log(
						`⚠️ Skipping location ${result.locationId} - success: ${
							result.success
						}, hasListings: ${!!result.listings}`
					);
				}
			}

			results.push(...chunkResults);

			// Add small delay between chunks to be respectful
			if (chunkIndex < chunks.length - 1) {
				const delay = 500; // 2 second delay between chunks
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	} catch (error) {
		console.error("❌ Error processing Airbnb batch:", error);
	}

	console.log(
		`📊 Batch processing completed. Total results: ${results.length}`
	);
	console.log(
		`📋 Results summary:`,
		results.map((r) => ({
			location: r.locationName,
			success: r.success,
			listings: r.totalListings || 0,
			error: r.error || "none",
		}))
	);

	return results;
}

const fetchScrapedData = async () => {
	const data = await firestore.collection("ScrapedData").get();
	return data.docs.map((item) => item.data());
};

async function processAllScrapedSources() {
	try {
		console.log("Starting to process all scraped sources...");

		// Get all scraped sources
		const data = await fetchScrapedData();
		const sources = data.flatMap((item) => item.latestBlogs);

		console.log(`Found ${sources.length} sources to process`);

		// Process sources in batches to avoid overwhelming the system
		const batchSize = 10;
		const results = [];

		for (let i = 0; i < sources.length; i += batchSize) {
			const batch = sources.slice(i, i + batchSize);
			console.log(
				`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
					sources.length / batchSize
				)}`
			);

			// Process batch concurrently
			const batchPromises = batch.map(async (source) => {
				try {
					// Get article data from scrap-url endpoint
					const response = await fetch(`http://localhost:3001/scrap-url`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							url: source.link,
						}),
					});

					if (!response.ok) {
						console.log(`Failed to scrape ${source.link}: ${response.status}`);
						return null;
					}

					const articleData = await response.json();
					const title = articleData.data?.title;
					const description =
						articleData.data.metadata?.description ||
						articleData.data.metadata["og:description"];
					const banner_image =
						articleData.data.metadata?.image ||
						articleData.data.metadata["og:image"] ||
						articleData.data.metadata["twitter:image"];
					const pubDate = articleData.data?.timestamp;
					const semanticcontent = JSON.stringify(
						articleData.data?.content?.semanticContent || ""
					);

					// Prepare data for Supabase insertion
					const articleRecord = {
						author:
							articleData.data.metadata["og:author"] ||
							articleData.data.metadata["author"] ||
							"",
						link: source.link,
						title,
						description,
						pub_date: pubDate,
						banner_image,
						semanticcontent,
					};

					// Insert into Supabase
					const { data, error } = await supabase
						.from("rssfeedarticles")
						.upsert(articleRecord, {
							onConflict: "link",
						});

					if (error) {
						console.log(`Supabase error for ${source.link}:`, error.message);
						return { success: false, error: error.message, link: source.link };
					}

					console.log(`Successfully processed: ${source.link}`);
					return { success: true, link: source.link, title: articleData.title };
				} catch (error) {
					console.log(`Error processing ${source.link}:`, error.message);
					return { success: false, error: error.message, link: source.link };
				}
			});

			// Wait for batch to complete
			const batchResults = await Promise.allSettled(batchPromises);
			results.push(
				...batchResults.map((result) => result.value).filter(Boolean)
			);

			// Small delay between batches to be respectful to the system
			if (i + batchSize < sources.length) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}

		// Summary
		const successful = results.filter((r) => r.success).length;
		const failed = results.filter((r) => !r.success).length;

		console.log(
			`Success rate: ${((successful / sources.length) * 100).toFixed(2)}%`
		);

		return {
			total: sources.length,
			successful,
			failed,
			results,
		};
	} catch (error) {
		console.error("Error in processAllScrapedSources:", error);
		throw error;
	}
}

app.get("/process-all-scraped-sources", async (c) => {
	const result = await processAllScrapedSources();
	return c.json(result);
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

app.post("/ai-url-chat", async (c) => {
	const { link, prompt } = await c.req.json();
	console.log(`${origin}/scrap-url-puppeteer`);

	if (!link || !prompt) {
		return c.json({ error: "Both link and prompt are required" }, 400);
	}

	try {
		// Fetch data from puppeteer endpoint
		const data = await fetch(`${origin}/scrap-url-puppeteer`, {
			method: "POST",
			body: JSON.stringify({
				url: link,
			}),
		});

		const results = await data.json();
		const scrapedData = results.data;

		const modelPrompt = `You are a helpful AI assistant. A user is asking a question about a website. 
Please provide a helpful answer based on the data from the link/url provided by the user.
Website: ${link}

Question: ${prompt}
The data for the website is in markdown format:
${results.mardown}

Read the data markdown and answer the user question as given above.
`;

		// Use Google GenAI to answer the question
		const response = await genai.models.generateContent({
			model: "gemini-2.0-flash",
			contents: [
				{
					role: "model",
					parts: [
						{
							text: modelPrompt,
						},
					],
				},
				{
					role: "user",
					parts: [
						{
							text: `You are a helpful AI assistant. A user is asking a question about a website. Please provide a helpful answer based on the context.
							
							Question: ${prompt}`,
						},
					],
				},
			],
		});

		return c.json({
			answer: response.candidates[0].content.parts[0].text,
			scrapedData: scrapedData,
			url: link,
			markdown: results.markdown,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error("❌ AI URL Chat error:", error);
		return c.json(
			{ error: "Failed to process request", details: error.message },
			500
		);
	}
});

const uploadImageToFirebaseStorage = async () => {
	// Upload to Firebase storage
	const bucket = storage.bucket(process.env.FIREBASE_BUCKET);
	const file = bucket.file(`ihr-website-screenshot/${uniqueFileName}`);

	try {
		await file.save(websiteScreenshot, {
			metadata: {
				contentType: "image/png",
				cacheControl: "public, max-age=3600",
			},
		});

		// Make the file publicly accessible
		await file.makePublic();

		// Get the public URL
		const screenshotUrl = `https://storage.googleapis.com/${process.env.FIREBASE_BUCKET}/${file.name}`;

		return {
			success: true,
			url: url,
			title: title,
			screenshot: screenshotUrl,
			storagePath: `ihr-website-screenshot/${uniqueFileName}`,
			timestamp: new Date().toISOString(),
		};
	} catch (firebaseError) {
		console.error("❌ Error uploading to Firebase storage:", firebaseError);

		return {
			success: false,
			error: "Failed to upload screenshot to Firebase storage",
			details: firebaseError.message,
		};
	}
};

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
		}
	}
}
// New Puppeteer-based URL scraping endpoint
app.post("/scrap-url-puppeteer", async (c) => {
	const {
		url,
		selectors = {}, // Custom selectors for specific elements
		waitForSelector = null, // Wait for specific element to load
		timeout = 30000,
		includeSemanticContent = true,
		includeImages = true,
		includeLinks = true,
		extractMetadata = true,
		includeCache = false,
	} = await c.req.json();

	const isValidUrl = isValidURL(url);

	if (!url || !isValidUrl) {
		return c.json({ error: "URL is required or invalid" }, 400);
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
		// Import puppeteer-core and chromium
		const puppeteer = await import("puppeteer-core");
		const chromium = (await import("@sparticuz/chromium")).default;

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

		// Enhanced resource blocking for faster loading
		let blockedResources = { images: 0, fonts: 0, stylesheets: 0, media: 0 };

		// Set request interception
		await page.setRequestInterception(true);
		page.on("request", (request) => {
			const resourceType = request.resourceType();
			const url = request.url().toLowerCase();

			// Enhanced resource blocking when includeImages is false
			if (!includeImages) {
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
					(url.includes(".jpg") || url.includes(".png") || url.includes(".gif"))
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
			}

			// Always block fonts and stylesheets for faster loading
			if (["font", "stylesheet"].includes(resourceType)) {
				if (resourceType === "font") blockedResources.fonts++;
				if (resourceType === "stylesheet") blockedResources.stylesheets++;
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

		const html = await page.content();

		const dom = new JSDOM(html, { url: url });
		const isReadable = isProbablyReaderable(dom.window.document);

		let markdownContent;

		if (isReadable) {
			const turndown = new TurndownService();
			markdownContent = turndown.turndown(dom.window.document.body.innerHTML);
		}

		// Extract page content
		scrapedData = await page.evaluate(
			async (options) => {
				const data = {
					url: window.location.href,
					title: document.title,
					content: {},
					metadata: {},
					links: [],
					images: [],
					screenshot: null,
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
				if (options.includeLinks) {
					const links = document.querySelectorAll("a");

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
						markdown: toMarkdown(scrapedData),
						markdownContent: markdownContent,
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

		removeEmptyKeys(scrapedData.content.semanticContent);
		removeEmptyKeys(scrapedData.content);

		return c.json({
			success: true,
			data: scrapedData,
			url: url,
			markdown: toMarkdown(scrapedData),
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
			title = "Website Screenshot",
			waitForSelector,
			timeout = 30000,
			includeImages = false,
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

			const screenshotBuffer = await page.screenshot({
				fullPage: false,
				optimizeForSpeed: true,
				encoding: "binary",
			});

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

				return c.json({
					success: true,
					url: url,
					metadata: scrapedData.metadata,
					screenshot: screenshotUrl,
					timestamp: new Date().toISOString(),
				});
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

const filterValidImages = async (locations) => {
	let results = [];
	try {
		locations.forEach(async (location) => {
			const imgs = new Set();
			if (location) {
				try {
					const { body: imageStream } = await fetch(location);
					if (imageStream) {
						const { height, width } = await imageDimensionsFromStream(
							imageStream
						);
						if (
							height &&
							width &&
							height > 600 &&
							width > 600 &&
							!imgs.has(location)
						) {
							imgs.add(location);
						}
					} else {
						console.log("No image stream", location);
					}
				} catch (err) {
					console.log("Error in batch", err);
				}
			}
			return imgs;
		});
	} catch (err) {
		console.log("Error in batch", err);
	}
	return results;
};

app.get("/filter-images/:batch", async (c) => {
	const batch = await c.req.param("batch");
	const locations = await supabase
		.from("locations")
		.select("unsplash_images, images")
		.range((batch - 1) * 50, batch * 50 - 1);

	for (const location of locations.data) {
		let new_unsplash_images = [];
		let new_images = [];
		if (location?.unsplash_images?.length > 0) {
			new_unsplash_images = await filterValidImages(location.unsplash_images);
		}
		if (location?.images?.length > 0) {
			new_images = await filterValidImages(location.images);
		}

		if (new_unsplash_images.length > 0 || new_images.length > 0) {
			console.log(`Supabase table updated for ${location.id}`);
			await supabase
				.from("locations")
				.update({ unsplash_images: new_unsplash_images, images: new_images })
				.eq("id", location.id);
		}
	}

	return c.json({ success: true, batch: batch });
});

app.post("/filter-images-batch", async (c) => {
	let batch = 1;
	while (batch < 25) {
		console.log(`Starting batch: ${batch}`);
		try {
			await fetch("http://localhost:3001/filter-images/" + batch, {
				method: "GET",
			});
			console.log(`Finished batch: ${batch}`);
		} catch (error) {
			console.error(`Error in batch: ${batch}`, error);
		}
		batch++;
	}
	return c.json({ success: true, batch: batch });
});

// ... existing code ...

const filterAndUpdateImages = async () => {
	try {
		// Get all locations with their image arrays
		const { data: locations, error } = await supabase
			.from("locations")
			.select("id, unsplash_images, images");

		if (error) {
			console.error("Error fetching locations:", error);
			return { success: false, error: error.message };
		}

		// Flatten all images into a single array with their location IDs
		const allImages = [];
		locations.forEach((location) => {
			if (location.unsplash_images?.length > 0) {
				location.unsplash_images.forEach((imageUrl) => {
					allImages.push({
						locationId: location.id,
						imageUrl: imageUrl,
						type: "unsplash_images",
					});
				});
			}
			if (location.images?.length > 0) {
				location.images.forEach((imageUrl) => {
					allImages.push({
						locationId: location.id,
						imageUrl: imageUrl,
						type: "images",
					});
				});
			}
		});

		console.log(`Processing ${allImages.length} total images...`);

		// Process images in batches to avoid overwhelming the system
		const batchSize = 10;
		const validImages = new Map(); // locationId -> { unsplash_images: [], images: [] }

		for (let i = 0; i < allImages.length; i += batchSize) {
			const batch = allImages.slice(i, i + batchSize);

			// Process batch concurrently
			const batchPromises = batch.map(async (imageData) => {
				try {
					const { body: imageStream } = await fetch(imageData.imageUrl);
					if (imageStream) {
						const { height, width } = await imageDimensionsFromStream(
							imageStream
						);
						if (height && width && height > 600 && width > 600) {
							// Initialize location data if not exists
							if (!validImages.has(imageData.locationId)) {
								validImages.set(imageData.locationId, {
									unsplash_images: [],
									images: [],
								});
							}

							// Add valid image to appropriate array
							const locationData = validImages.get(imageData.locationId);
							if (imageData.type === "unsplash_images") {
								locationData.unsplash_images.push(imageData.imageUrl);
							} else {
								locationData.images.push(imageData.imageUrl);
							}
						}
					}
				} catch (err) {
					console.log(
						`Error processing image ${imageData.imageUrl}:`,
						err.message
					);
				}
			});

			await Promise.all(batchPromises);

			// Small delay between batches to be respectful to external services
			if (i + batchSize < allImages.length) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}

		// Update database with filtered images
		let updatedCount = 0;
		for (const [locationId, imageData] of validImages) {
			try {
				const { error: updateError } = await supabase
					.from("locations")
					.update({
						unsplash_images: imageData.unsplash_images,
						images: imageData.images,
					})
					.eq("id", locationId);

				if (updateError) {
					console.error(`Error updating location ${locationId}:`, updateError);
				} else {
					updatedCount++;
					console.log(
						`Updated location ${locationId} - unsplash: ${imageData.unsplash_images.length}, images: ${imageData.images.length}`
					);
				}
			} catch (err) {
				console.error(`Error updating location ${locationId}:`, err);
			}
		}

		console.log(
			`Successfully processed ${allImages.length} images, updated ${updatedCount} locations`
		);
		return {
			success: true,
			totalImages: allImages.length,
			updatedLocations: updatedCount,
		};
	} catch (err) {
		console.error("Error in filterAndUpdateImages:", err);
		return { success: false, error: err.message };
	}
};

// Add this endpoint to use the method
app.post("/filter-all-images", async (c) => {
	const result = await filterAndUpdateImages();
	return c.json(result);
});

// ... existing code ...

app.post("/repo", async (c) => {
	const { name } = await c.req.json();

	const owner = "rumca-js";

	//https://github.com/rumca-js/RSS-Link-Database-2025/tree/main
	try {
		const url = `https://api.github.com/repos/${owner}/${name}`;
		const response = await fetch(
			`https://api.github.com/repos/${owner}/${name}/contents`,
			{
				headers: {
					Authorization: `token ${process.env.GITHUB_TOKEN}`,
					"User-Agent": "node-fetch", // GitHub requires User-Agent
					Accept: "application/vnd.github+json",
				},
			}
		);

		if (!response.ok) {
			return c.json({ error: "Failed to fetch repo" }, response.status);
		}

		const data = await response.json();
		return c.json(data);
	} catch (error) {
		console.error(error);
		return c.json({ error: "Internal Server Error" }, 500);
	}
});

app.post("/push-repo", async (c) => {
	const { projectName, content, fileName = "README.md" } = await c.req.json();

	if (!projectName || !content) {
		return c.json({ error: "projectName and content are required" }, 400);
	}

	const owner = "shreyvijayvargiya";
	const repo = "ihatereading-api"; // Your main repository name

	try {
		// First, check if the repository exists
		const repoResponse = await fetch(
			`https://api.github.com/repos/${owner}/${repo}`,
			{
				headers: {
					Authorization: `token ${process.env.GITHUB_TOKEN}`,
					"User-Agent": "node-fetch",
					Accept: "application/vnd.github+json",
				},
			}
		);

		if (!repoResponse.ok) {
			return c.json(
				{ error: "Repository not found or access denied" },
				repoResponse.status
			);
		}

		// Create the folder structure by creating a file in the project-name folder
		// GitHub automatically creates folders when you create files with paths
		const filePath = `${projectName}/${fileName}`;

		// Get the current branch (usually main or master)
		const branchResponse = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/branches/main`,
			{
				headers: {
					Authorization: `token ${process.env.GITHUB_TOKEN}`,
					"User-Agent": "node-fetch",
					Accept: "application/vnd.github+json",
				},
			}
		);

		if (!branchResponse.ok) {
			// Try master branch if main doesn't exist
			const masterBranchResponse = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/branches/master`,
				{
					headers: {
						Authorization: `token ${process.env.GITHUB_TOKEN}`,
						"User-Agent": "node-fetch",
						Accept: "application/vnd.github+json",
					},
				}
			);

			if (!masterBranchResponse.ok) {
				return c.json({ error: "Could not determine default branch" }, 400);
			}

			const masterBranchData = await masterBranchResponse.json();
			var defaultBranch = "master";
			var sha = masterBranchData.commit.sha;
		} else {
			const branchData = await branchResponse.json();
			var defaultBranch = "main";
			var sha = branchData.commit.sha;
		}

		// Create the file in the project folder
		const createFileResponse = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
			{
				method: "PUT",
				headers: {
					Authorization: `token ${process.env.GITHUB_TOKEN}`,
					"User-Agent": "node-fetch",
					Accept: "application/vnd.github+json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					message: `Add ${projectName} project folder`,
					content: Buffer.from(content).toString("base64"),
					branch: defaultBranch,
				}),
			}
		);

		if (!createFileResponse.ok) {
			const errorData = await createFileResponse.json();
			console.error("GitHub API Error:", errorData);
			return c.json(
				{ error: "Failed to create project folder", details: errorData },
				createFileResponse.status
			);
		}

		const result = await createFileResponse.json();

		return c.json({
			success: true,
			message: `Successfully created ${projectName} folder with ${fileName}`,
			file: result.content,
			projectUrl: `https://github.com/${owner}/${repo}/tree/${defaultBranch}/${projectName}`,
		});
	} catch (error) {
		console.error("Error creating project folder:", error);
		return c.json(
			{ error: "Internal Server Error", details: error.message },
			500
		);
	}
});

app.get("/ai-chat-form", async (c) => {
	const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI URL Chat</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg,rgb(23, 23, 23) 0%,rgb(28, 28, 28) 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            overflow: hidden;
        }

        .header {
            background: linear-gradient(135deg,rgb(16, 16, 16) 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }

        .header h1 {
            font-size: 2.5rem;
            margin-bottom: 10px;
            font-weight: 300;
        }

        .header p {
            font-size: 1.1rem;
            opacity: 0.9;
        }

        .form-container {
            padding: 40px;
        }

        .form-group {
            margin-bottom: 25px;
        }

        .form-group label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #333;
            font-size: 1.1rem;
        }

        .form-group input, .form-group textarea {
            width: 100%;
            padding: 15px;
            border: 2px solid #e1e5e9;
            border-radius: 10px;
            font-size: 1rem;
            transition: all 0.3s ease;
            font-family: inherit;
        }

        .form-group input:focus, .form-group textarea:focus {
            outline: none;
            border-color:rgb(0, 0, 0);
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }

        .form-group textarea {
            resize: vertical;
            min-height: 100px;
        }

        .submit-btn {
            background: linear-gradient(135deg,rgb(37, 37, 37) 0%,rgb(36, 36, 36) 100%);
            color: white;
            border: none;
            padding: 15px 30px;
            border-radius: 10px;
            font-size: 1.1rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            width: 100%;
            margin-top: 10px;
        }

        .submit-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(0, 0, 0, 0.3);
        }

        .submit-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }

        .loader {
            display: none;
            text-align: center;
            padding: 20px;
        }

        .spinner {
            border: 4px solid #f3f3f3;
            border-top: 4px solidrgb(33, 33, 33);
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 15px;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .answer-container {
            margin-top: 30px;
            padding: 25px;
            background: #f8f9fa;
            border-radius: 15px;
            border-left: 5px solidrgb(59, 59, 59);
            display: none;
        }

        .answer-container h3 {
            color: #333;
            margin-bottom: 15px;
            font-size: 1.3rem;
        }

        .answer-content {
            line-height: 1.6;
            color: #555;
            font-size: 1.1rem;
        }

        /* Markdown styling */
        .answer-content h1, .answer-content h2, .answer-content h3, 
        .answer-content h4, .answer-content h5, .answer-content h6 {
            margin: 20px 0 10px 0;
            color: #333;
            font-weight: 600;
        }

        .answer-content h1 { font-size: 1.8rem; }
        .answer-content h2 { font-size: 1.6rem; }
        .answer-content h3 { font-size: 1.4rem; }
        .answer-content h4 { font-size: 1.2rem; }
        .answer-content h5 { font-size: 1.1rem; }
        .answer-content h6 { font-size: 1rem; }

        .answer-content p {
            margin: 10px 0;
        }

        .answer-content ul, .answer-content ol {
            margin: 10px 0;
            padding-left: 30px;
        }

        .answer-content li {
            margin: 5px 0;
        }

        .answer-content blockquote {
            border-left: 4px solid #667eea;
            margin: 15px 0;
            padding: 10px 20px;
            background: #f8f9fa;
            font-style: italic;
        }

        .answer-content code {
            background: #f1f3f4;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'Courier New', monospace;
            font-size: 0.9rem;
        }

        .answer-content pre {
            background: #f1f3f4;
            padding: 15px;
            border-radius: 8px;
            overflow-x: auto;
            margin: 15px 0;
        }

        .answer-content pre code {
            background: none;
            padding: 0;
        }

        .answer-content strong {
            font-weight: 600;
        }

        .answer-content em {
            font-style: italic;
        }

        .answer-content a {
            color: #667eea;
            text-decoration: none;
        }

        .answer-content a:hover {
            text-decoration: underline;
        }

        .answer-content table {
            border-collapse: collapse;
            width: 100%;
            margin: 15px 0;
        }

        .answer-content th, .answer-content td {
            border: 1px solid #ddd;
            padding: 8px 12px;
            text-align: left;
        }

        .answer-content th {
            background: #f8f9fa;
            font-weight: 600;
        }

        .error-message {
            background: #fee;
            color: #c33;
            padding: 15px;
            border-radius: 10px;
            margin-top: 20px;
            border-left: 4px solid #c33;
            display: none;
        }

        .url-info {
            background: #e8f4fd;
            padding: 15px;
            border-radius: 10px;
            margin-top: 15px;
            border-left: 4px solidrgb(63, 63, 63);
            display: none;
        }

        .url-info h4 {
            color:rgb(77, 77, 77);
            margin-bottom: 8px;
        }

        .url-info p {
            color: #555;
            margin: 5px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 AI URL Chat</h1>
            <p>Ask questions about any website content</p>
        </div>
        
        <div class="form-container">
            <form id="chatForm">
                <div class="form-group">
                    <label for="url">Website URL:</label>
                    <input type="url" id="url" name="url" placeholder="https://example.com" required>
                </div>
                
                <div class="form-group">
                    <label for="question">Your Question:</label>
                    <textarea id="question" name="question" placeholder="Ask anything about the website content..." required></textarea>
                </div>
                
                <button type="submit" class="submit-btn" id="submitBtn">
                    🚀 Get AI Answer
                </button>
            </form>

            <div class="loader" id="loader">
                <div class="spinner"></div>
                <p>🤖 AI is analyzing the website and thinking...</p>
            </div>

            <div class="error-message" id="errorMessage"></div>

            <div class="answer-container" id="answerContainer">

                <div class="answer-content" id="answerContent"></div>
                
                <div class="url-info" id="urlInfo">
                    <h4>📊 Website Information:</h4>
                    <p id="urlTitle"></p>
                    <p id="urlUrl"></p>
                    <p id="urlTimestamp"></p>
                </div>
            </div>
        </div>
    </div>

    <script>
        document.getElementById('chatForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const url = document.getElementById('url').value;
            const question = document.getElementById('question').value;
            const submitBtn = document.getElementById('submitBtn');
            const loader = document.getElementById('loader');
            const answerContainer = document.getElementById('answerContainer');
            const errorMessage = document.getElementById('errorMessage');
            
            // Reset UI
            errorMessage.style.display = 'none';
            answerContainer.style.display = 'none';
            
            // Show loader and disable button
            loader.style.display = 'block';
            submitBtn.disabled = true;
            submitBtn.textContent = '⏳ Processing...';
            
            try {
                const response = await fetch('/ai-url-chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        link: url,
                        prompt: question
                    })
                });
                
                const data = await response.json();
                
                if (!response.ok) {
                    throw new Error(data.error || 'Failed to get answer');
                }
                
                // Convert markdown response to HTML and display
                try {
                    const html = await convertMarkdownToHtml(data.answer);
                    document.getElementById('answerContent').innerHTML = html;
                } catch (error) {
                    console.error('Markdown conversion error:', error);
                    // Fallback to plain text if conversion fails
                    document.getElementById('answerContent').textContent = data.answer;
                }
                
                // Display URL info
                document.getElementById('urlTitle').textContent = 'Title: ' + (data.scrapedData.title || 'N/A');
                document.getElementById('urlUrl').textContent = 'URL: ' + data.url;
                document.getElementById('urlTimestamp').textContent = 'Analyzed: ' + new Date(data.timestamp).toLocaleString();
                
                // Show containers
                answerContainer.style.display = 'block';
                document.getElementById('urlInfo').style.display = 'block';
                
            } catch (error) {
                console.error('Error:', error);
                errorMessage.textContent = 'Error: ' + error.message;
                errorMessage.style.display = 'block';
            } finally {
                // Hide loader and re-enable button
                loader.style.display = 'none';
                submitBtn.disabled = false;
                submitBtn.textContent = '🚀 Get AI Answer';
            }
        });
    </script>
</body>
</html>`;

	return new Response(htmlContent, {
		headers: {
			"Content-Type": "text/html",
		},
	});
});

// we want to make ihatereading frontend few API as well
