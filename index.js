import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { firestore } from "./firebase.js";
import { GoogleGenAI } from "@google/genai";
import { chromium } from "playwright";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { performance } from "perf_hooks";
import { cpus } from "os";
import { ChatOllama, Ollama } from "@langchain/ollama";
const { request } = await import("undici");
import aiWebSearchAgent from "./ai-examples/ai-web-search-agent.js";

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

const app = new Hono();

// Apply performance monitoring middleware
app.use("*", performanceMiddleware);

app.use("/");

app.get("/", (c) => {
	return c.text("Welcome to iHateReading API", 200);
});

app.get("/home", async (c) => {
	try {
		// Fetch blog posts from Firestore
		const postsSnapshot = await firestore
			.collection("publish")
			.orderBy("timeStamp", "desc")
			.get();
		const posts = [];

		postsSnapshot.docs.forEach(async (doc) => {
			posts.push({
				id: doc.id,
				...doc.data(),
			});
		});

		// Format timestamp (assuming it's a Firestore timestamp)
		const formatDate = (timestamp) => {
			if (!timestamp) return "Unknown date";
			const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
			return date.toLocaleDateString("en-US", {
				year: "numeric",
				month: "long",
				day: "numeric",
			});
		};

		const calculateReadingTime = (htmlContent) => {
			if (!htmlContent) return 0;
			// Remove HTML tags
			const text = htmlContent.replace(/<[^>]*>/g, " ");
			// Remove extra whitespace and split into words
			const words = text.trim().split(/\s+/);
			const wordsPerMinute = 200; // average reading speed
			const minutes = Math.ceil(words.length / wordsPerMinute);
			return isNaN(minutes) ? 0 : minutes;
		};

		const bloghtml = `
  <html>
  <script src="https://cdn.tailwindcss.com"></script>
  <body class="bg-gray-50 min-h-screen">
    <div class="container mx-auto px-4 py-8 max-w-7xl">
      <header class="mb-12">
        <h1 class="text-4xl font-bold text-gray-900 mb-2">Blog</h1>
        <p class="text-gray-600">Latest articles by <a href="https://ihatereading.in" class="text-zinc-600 hover:text-zinc-800 underline cursor-pointer font-medium" target="_blank">iHateReading.in</a></p>
      </header>
      
      <div class="space-y-2 grid grid-cols-1 md:grid-cols-1 lg:grid-cols-1 gap-4 justify-center items-start">
        ${posts
					.filter((item) => (item?.title?.length > 0 ? item : null))
					.map(
						(post) => `
          <article class="bg-white cursor-pointer max-w-4xl mx-auto rounded-xl shadow-md p-6 hover:shadow-lg transition-shadow my-4"  onClick="window.location.href='/t/${post?.title.replace(
						/\s+/g,
						"-"
					)}'">
            <header class="mb-4">
            
              <h2 class="text-2xl font-bold text-gray-900 mb-2 hover:text-zinc-600 transition-colors">
                ${post?.title || post?.name}
              </h2>
              <p class="text-gray-600 text-lg mb-3">
                ${post?.description || post?.htmlContent?.substring(0, 150)}
              </p>
              <div class="flex items-center text-sm text-gray-500 space-x-4">
                <span class="flex items-center">
                  <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                  </svg>
                  ${formatDate(post?.timeStamp)}
                </span>
                <span class="flex items-center">
                  <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                  </svg>
                  ${calculateReadingTime(post?.content)} min read
                </span>
              </div>
            </header>
            <footer class="mt-6 pt-4 border-t border-gray-200">
              <a href="/t/${post?.title.replace(
								/\s+/g,
								"-"
							)}" class="text-zinc-600 cursor-pointer hover:text-zinc-800 font-medium">
                Read blog →
              </a>
            </footer>
          </article>
        `
					)
					.join("")}
      </div>
    </div>
  </body>
  </html>
  `;
		return c.html(bloghtml);
	} catch (error) {
		console.error("Error fetching posts:", error);
		return c.text("Error loading blog posts", 500);
	}
});

app.get("/t/:slug", async (c) => {
	try {
		const slug = c.req.param("slug");

		// Convert slug back to title by replacing hyphens with spaces
		const title = slug.replace(/-/g, " ");

		// Fetch the specific blog post from Firestore
		const postsSnapshot = await firestore
			.collection("publish")
			.where("title", "==", title)
			.get();

		const post = {
			id: postsSnapshot.docs[0].id,
			...postsSnapshot.docs[0].data(),
		};

		// Format timestamp (assuming it's a Firestore timestamp)
		const formatDate = (timestamp) => {
			if (!timestamp) return "Unknown date";
			const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
			return date.toLocaleDateString("en-US", {
				year: "numeric",
				month: "long",
				day: "numeric",
			});
		};

		const calculateReadingTime = (htmlContent) => {
			if (!htmlContent) return 0;
			// Remove HTML tags
			const text = htmlContent.replace(/<[^>]*>/g, " ");
			// Remove extra whitespace and split into words
			const words = text.trim().split(/\s+/);
			const wordsPerMinute = 200; // average reading speed
			const minutes = Math.ceil(words.length / wordsPerMinute);
			return isNaN(minutes) ? 0 : minutes;
		};

		const blogPostHtml = `
  <html>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="/blog-styles.css" />
  <script>
    function copyToClipboard(text) {
      navigator.clipboard.writeText(text).then(function() {
        // Show a temporary success message
        const button = event.target.closest('button');
        const originalHTML = button.innerHTML;
        button.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>';
        button.classList.remove('text-gray-500', 'hover:text-green-600');
        button.classList.add('text-green-600');
        
        setTimeout(() => {
          button.innerHTML = originalHTML;
          button.classList.remove('text-green-600');
          button.classList.add('text-gray-500', 'hover:text-green-600');
        }, 2000);
      }).catch(function(err) {
        console.error('Could not copy text: ', err);
      });
    }
  </script>
  <body class="bg-gray-50 min-h-screen">
    <div class="container mx-auto px-4 py-8 max-w-4xl">
      <a href="/home" class="text-zinc-600 hover:text-zinc-800 font-medium inline-block">
        ← Back to Blog
      </a>
      <header class="mt-8 bg-white rounded-t-xl shadow-md px-8 pb-4 pt-8">
        <h1 class="text-2xl font-bold text-gray-900">${
					post?.title || post?.name
				}</h1>
        <p class="text-gray-600 text-lg mb-4">${post?.description || ""}</p>
        <div class="flex items-center justify-between">
          <div class="flex items-center text-sm text-gray-500 space-x-4">
            <span class="flex items-center">
              <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
              </svg>
              ${formatDate(post?.timeStamp)}
            </span>
            <span class="flex items-center">
              <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
              ${calculateReadingTime(post?.content)} min read
            </span>
          </div>
          
          <div class="flex items-center justify-start space-x-3">
            <!-- Twitter Icon -->
            <a href="https://twitter.com/intent/tweet?text=${encodeURIComponent(
							post?.title || post?.name
						)}&url=${encodeURIComponent(`http://localhost:3001/t/${slug}`)}" 
               target="_blank" 
               class="text-gray-500 hover:text-blue-400 transition-colors duration-200">
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M23.953 4.57a10 10 0 01-2.825.775 4.958 4.958 0 002.163-2.723c-.951.555-2.005.959-3.127 1.184a4.92 4.92 0 00-8.384 4.482C7.69 8.095 4.067 6.13 1.64 3.162a4.822 4.822 0 00-.666 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 01-2.228-.616v.06a4.923 4.923 0 003.946 4.827 4.996 4.996 0 01-2.212.085 4.936 4.936 0 004.604 3.417 9.867 9.867 0 01-6.102 2.105c-.39 0-.779-.023-1.17-.067a13.995 13.995 0 007.557 2.209c9.053 0 13.998-7.496 13.998-13.985 0-.21 0-.42-.015-.63A9.935 9.935 0 0024 4.59z"/>
              </svg>
            </a>
            
            <!-- LinkedIn Icon -->
            <a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
							`http://localhost:3001/t/${slug}`
						)}" 
               target="_blank" 
               class="text-gray-500 hover:text-blue-600 transition-colors duration-200">
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
              </svg>
            </a>
            
            <!-- Copy Link Icon -->
            <button onclick="copyToClipboard('http://localhost:3001/t/${slug}')" 
                    class="text-gray-500 hover:text-green-600 transition-colors duration-200">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
              </svg>
            </button>
          </div>
        </div>

      </header>
      
      <article class="bg-white rounded-b-xl shadow-md p-8">
        <div class="prose prose-lg max-w-none">
          ${post?.content || "Content not available"}
        </div>
      </article>
    </div>
  </body>
  </html>
  `;

		return c.html(blogPostHtml);
	} catch (error) {
		console.error("Error fetching blog post:", error);
		return c.text("Error loading blog post", 500);
	}
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

// 1. Bulk Scraping Job Creation (with single query optimization)
app.post("/scrap-google-maps-bulk", async (c) => {
	try {
		// Validate request body
		let requestBody;
		try {
			requestBody = await c.req.json();
		} catch (jsonError) {
			console.error("JSON parsing error:", jsonError);
			return c.json(
				{
					success: false,
					error: "Invalid JSON in request body. Please send valid JSON data.",
					example: {
						region: "india",
						singleQuery: "Mumbai restaurant",
					},
				},
				400
			);
		}

		// Validate request body is not null/undefined
		if (!requestBody || typeof requestBody !== "object") {
			return c.json(
				{
					success: false,
					error: "Request body must be a valid JSON object",
					example: {
						region: "india",
						singleQuery: "Mumbai restaurant",
					},
				},
				400
			);
		}

		const {
			region = "india",
			batchSize = 1000,
			priority = "normal",
			singleQuery = null,
		} = requestBody;

		if (singleQuery && typeof singleQuery === "string" && singleQuery.trim()) {
			const cleanQuery = singleQuery.trim();

			const result = await scrapeGoogleMapsLocation(cleanQuery);

			if (result.success && result.data) {
				// Store result directly in locations table
				try {
					const locationData = {
						name: result.data.name || "",
						address: result.data.address || "",
						google_maps_url: result.data.url || "",
						scraped_at: new Date().toISOString(),
					};

					// Add optional columns if they exist in the schema
					if (result.data.coordinates?.lat && result.data.coordinates?.lng) {
						locationData.latitude = result.data.coordinates.lat;
						locationData.longitude = result.data.coordinates.lng;
					}

					// Try to insert with all columns, fallback to minimal if needed
					try {
						await supabase.from("locations").insert(locationData);
					} catch (insertError) {
						// If insert fails, try with minimal columns
						const minimalData = {
							name: locationData.name,
							address: locationData.address,
							scraped_at: locationData.scraped_at,
						};
						await supabase.from("locations").insert(minimalData);
					}
				} catch (dbError) {
					console.error("Failed to store location:", dbError);
				}
			}

			return c.json({
				success: true,
				message: "Single query processed successfully",
				data: {
					query: singleQuery,
					result: result.data,
				},
			});
		}

		let queries, batchInfo;

		if (region === "india") {
			const batchNumber = parseInt(requestBody.batchNumber) || 0;
			const batchSize = parseInt(requestBody.batchSize) || 50;

			batchInfo = addBatchToQueue(batchNumber, batchSize);
			queries = batchInfo.queries;
		} else {
			queries = [];
		}

		if (queries.length === 0) {
			return c.json(
				{
					success: false,
					error: `No queries generated for region: ${region}. Currently only 'india' is supported.`,
					supportedRegions: ["india"],
				},
				400
			);
		}

		// Start bulk scraping and store results directly
		console.log(`🚀 Starting bulk scraping for ${queries.length} queries`);

		const startTime = Date.now();
		const results = await scrapeGoogleMapsBulk(queries, 3);
		const totalTime = Date.now() - startTime;

		let storedCount = 0;
		let storageErrors = [];

		console.log(`📊 Processing ${results.length} results for storage...`);

		for (const { query, result } of results) {
			if (result.success && result.data) {
				try {
					const locationData = {
						name: result.data.name || "",
						address: result.data.address || "",
						google_maps_url: result.data.url || "",
						scraped_at: new Date().toISOString(),
					};

					if (result.data.coordinates?.lat && result.data.coordinates?.lng) {
						locationData.latitude = result.data.coordinates.lat;
						locationData.longitude = result.data.coordinates.lng;
					}

					console.log(`💾 Attempting to store: ${result.data.name || query}`);

					const { error: insertError } = await supabase
						.from("locations")
						.insert(locationData);

					if (insertError) {
						throw new Error(`Supabase insert error: ${insertError.message}`);
					}

					storedCount++;
					console.log(`✅ Stored successfully: ${result.data.name || query}`);

					// Track successful location in queue
					trackSuccessfulLocation(batchInfo.batchNumber);
				} catch (error) {
					console.error(`❌ Failed to store location for "${query}":`, error);
					storageErrors.push({ query, error: error.message });

					// Track failed storage
					trackFailedLocation(
						batchInfo.batchNumber,
						query,
						`Storage error: ${error.message}`
					);
				}
			} else {
				console.log(
					`⚠️ Skipping failed result for "${query}": ${result.error}`
				);
				// Track failed scraping
				trackFailedLocation(
					batchInfo.batchNumber,
					query,
					result.error || "Unknown error"
				);
			}
		}

		// Calculate statistics
		const successfulQueries = results.filter((r) => r.result.success).length;
		const failedQueries = results.filter((r) => !r.result.success).length;
		const successRate = ((successfulQueries / results.length) * 100).toFixed(2);

		// Mark batch as completed in queue
		markBatchCompleted(batchInfo.batchNumber, results);

		console.log(
			`📊 Storage Summary: ${storedCount}/${results.length} locations stored successfully`
		);
		if (storageErrors.length > 0) {
			console.log(
				`❌ Storage Errors: ${storageErrors.length} locations failed to store`
			);
			storageErrors.forEach((err) =>
				console.log(`  - ${err.query}: ${err.error}`)
			);
		}

		return c.json({
			success: true,
			message: "Bulk scraping completed successfully",
			data: {
				totalQueries: queries.length,
				successfulQueries,
				failedQueries,
				storedInDatabase: storedCount,
				successRate: `${successRate}%`,
				processingTime: `${totalTime}ms`,
				estimatedTime: `${Math.ceil(totalTime / 1000)} seconds`,
				method: "scrape-then-store",
				storageErrors: storageErrors.length > 0 ? storageErrors : undefined,
				results: results.slice(0, 10), // Return first 10 results for preview
				batch: {
					currentBatch: batchInfo.batchNumber + 1,
					totalBatches: batchInfo.totalBatches,
					hasMore: batchInfo.hasMore,
					progress: batchInfo.progress,
					nextBatch: batchInfo.hasMore ? batchInfo.batchNumber + 1 : null,
				},
			},
		});
	} catch (error) {
		console.error("Bulk scraping job creation error:", error);
		return c.json(
			{
				success: false,
				error: error.message,
			},
			500
		);
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

						// Wait for the map to load
						await page.waitForSelector('div[role="main"]', { timeout: 30000 });

						// Wait a bit for the location to be fully loaded
						await page.waitForTimeout(5000);

						// Extract location data
						const locationData = await page.evaluate(() => {
							const url = window.location.href;
							const coordsMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
							const locationName =
								document.querySelector("h1")?.textContent || "";
							const address =
								document.querySelector('button[data-item-id="address"]')
									?.textContent || "";

							// Determine type based on content
							let type = "Location";
							if (
								locationName.toLowerCase().includes("restaurant") ||
								locationName.toLowerCase().includes("cafe")
							)
								type = "Restaurant";
							else if (
								locationName.toLowerCase().includes("hotel") ||
								locationName.toLowerCase().includes("inn")
							)
								type = "Accommodation";
							else if (
								locationName.toLowerCase().includes("museum") ||
								locationName.toLowerCase().includes("gallery")
							)
								type = "Cultural";
							else if (
								locationName.toLowerCase().includes("park") ||
								locationName.toLowerCase().includes("garden")
							)
								type = "Recreation";

							return {
								name: locationName,
								address: address,
								coordinates: coordsMatch
									? {
											lat: parseFloat(coordsMatch[1]),
											lng: parseFloat(coordsMatch[2]),
									  }
									: null,
								url: url,
								details: details,
								rating: rating,
								reviews: reviews,
								type: type,
							};
						});

						return { query, ...locationData };
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

// Custom Google Search Agent using Playwright
app.post("/google-search", async (c) => {
	const {
		query,
		limit = 5,
		config = {
			blockAds: true,
			storeInCache: true,
			timeout: 30000,
			userAgent:
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
		},
	} = await c.req.json();

	if (!query) {
		return c.json({ error: "Query is required" }, 400);
	}

	let browser;

	try {
		// Launch browser with proper configuration
		browser = await chromium.launch({
			headless: true,
			userAgent: config.userAgent,
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
			],
		});

		let searchResults;
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

		// Search Google using undici HTTP client for better stealth
		try {
			// Random user agent rotation
			const userAgents = [
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
			];
			const selectedUserAgent =
				userAgents[Math.floor(Math.random() * userAgents.length)];

			// Random delay to mimic human behavior
			await new Promise((resolve) =>
				setTimeout(resolve, Math.random() * 3000 + 1000)
			);

			// Build Google search URL with additional parameters for better results
			const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(
				query
			)}&num=${limit}&hl=en&gl=us&source=hp&ie=UTF-8&oe=UTF-8`;

			// Prepare headers to look like a real browser
			const headers = {
				"User-Agent": selectedUserAgent,
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Accept-Encoding": "gzip, deflate, br",
				DNT: "1",
				Connection: "keep-alive",
				"Upgrade-Insecure-Requests": "1",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Cache-Control": "max-age=0",
			};

			// Make the request using undici
			const response = await request(searchUrl, {
				method: "GET",
				headers,
				bodyTimeout: config.timeout,
				headersTimeout: config.timeout,
			});

			// Check if we got blocked
			if (response.statusCode === 403 || response.statusCode === 429) {
				console.warn(
					"⚠️ Google blocked the request - HTTP status:",
					response.statusCode
				);
				searchResults = {
					error: `Google blocked the request (HTTP ${response.statusCode}). Try again later or use a different IP.`,
					blocked: true,
					statusCode: response.statusCode,
					suggestion: "Consider using a proxy or waiting before retrying",
				};
				return;
			}

			if (response.statusCode !== 200) {
				console.warn(
					"⚠️ Unexpected response from Google:",
					response.statusCode
				);
				searchResults = {
					error: `Unexpected response from Google (HTTP ${response.statusCode})`,
					statusCode: response.statusCode,
				};
				return;
			}

			// Get the HTML content
			const htmlContent = await response.body.text();

			// Check for anti-bot content
			if (
				htmlContent.includes("unusual traffic") ||
				htmlContent.includes("Terms of Service") ||
				htmlContent.includes("Sorry") ||
				htmlContent.includes("captcha")
			) {
				console.warn("⚠️ Google detected automated access");
				searchResults = {
					error:
						"Google detected automated access. Try again later or use a different IP.",
					blocked: true,
					suggestion: "Consider using a proxy or waiting before retrying",
				};
				return;
			}

			// Parse HTML and extract search results
			const { JSDOM } = await import("jsdom");
			const dom = new JSDOM(htmlContent);
			const document = dom.window.document;

			// Extract search results using multiple selectors
			const results = [];
			const selectors = [
				".g a[href]", // Standard Google results
				"[data-ved] a[href]", // Alternative selector
				".yuRUbf a[href]", // Another common selector
				'a[href*="http"]:not([href*="google.com"])', // Fallback
			];

			let links = [];
			for (const selector of selectors) {
				links = document.querySelectorAll(selector);
				if (links.length > 0) break;
			}

			links.forEach((link, index) => {
				if (results.length >= limit) return;

				const url = link.href;
				const title = link.textContent.trim();

				// Skip Google's own pages and obvious non-results
				if (
					url.includes("google.com") ||
					url.includes("youtube.com") ||
					url.includes("maps.google") ||
					title.length < 5 ||
					title.length > 200 ||
					title.toLowerCase().includes("sign in") ||
					title.toLowerCase().includes("terms") ||
					title.toLowerCase().includes("privacy") ||
					title.toLowerCase().includes("sorry")
				) {
					return;
				}

				// Extract domain
				let domain = "";
				try {
					domain = new URL(url).hostname.replace("www.", "");
				} catch (e) {
					domain = "";
				}

				// Try to extract a snippet from nearby elements
				let snippet = "";
				const parent = link.closest("div");
				if (parent) {
					const snippetEl = parent.querySelector(".s, .st, span, div");
					if (snippetEl && snippetEl !== link) {
						snippet = snippetEl.textContent.trim().substring(0, 200);
					}
				}

				results.push({
					title,
					url,
					snippet,
					domain,
					position: results.length + 1,
				});
			});

			if (results.length === 0) {
				console.warn(
					"⚠️ No search results found - possible detection or no results"
				);
				searchResults = {
					error:
						"No search results found. Google may have blocked the request.",
					noResults: true,
					suggestion: "Try a different query or wait before retrying",
				};
			} else {
				console.log(`✅ Found ${results.length} search results using undici`);
				searchResults = results;
			}
		} catch (error) {
			console.error("Google search error with undici:", error);
			searchResults = { error: error.message };
		}

		await context.close();

		return c.json({
			success: true,
			query,
			results: searchResults,
			total: searchResults.length,
			config: {
				blockAds: config.blockAds,
				storeInCache: config.storeInCache,
				timeout: config.timeout,
			},
		});
	} catch (error) {
		console.error("❌ Google search error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to perform Google search",
				details: error.message,
			},
			500
		);
	} finally {
		if (browser) {
			await browser.close();
		}
	}
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
			userAgent: await page.evaluate(() => navigator.userAgent),
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

// Google News Scraping API - Scrape news from Google News search
app.post("/scrape-google-news", async (c) => {
	const {
		city,
		state,
		country = "IN",
		language = "en-IN",
		timeout = 30000,
		maxArticles = 20,
		includeImages = false,
		includeLinks = true,
	} = await c.req.json();

	if (!city || !state) {
		return c.json({ error: "City and state are required" }, 400);
	}

	// Construct Google News URL
	const query = `${city}%20${state}`;
	const googleNewsUrl = `https://news.google.com/search?q=${query}&hl=${language}&gl=${country}&ceid=${country}:${
		language.split("-")[0]
	}`;

	let browser;
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

		const context = await browser.newContext({
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

		const page = await context.newPage();

		// Block unnecessary resources for faster loading
		await page.route("**/*", (route) => {
			const type = route.request().resourceType();
			if (["font", "stylesheet", "image"].includes(type) && !includeImages) {
				return route.abort();
			}
			return route.continue();
		});

		// Navigate to Google News URL
		await page.goto(googleNewsUrl, {
			waitUntil: "domcontentloaded",
			timeout: timeout,
		});

		// Wait for news articles to load
		await page.waitForTimeout(3000);

		// Use the existing scrap-url logic by calling it internally
		const scrapeRequest = {
			url: googleNewsUrl,
			userQuestion: `Extract news articles about ${city} ${state} from this Google News page. Focus on the main news articles, their titles, sources, and timestamps.`,
			selectors: {
				articles:
					"article[data-n-tid], div[data-n-tid], div[jslog], div[data-ved]",
				searchQuery: 'input[aria-label*="Search"], input[name="q"]',
				relatedTopics:
					'a[href*="search?q="], div[role="button"], span[role="button"]',
			},
			waitForSelector: "article[data-n-tid], div[data-n-tid]",
			timeout: timeout,
			includeImages: includeImages,
			includeLinks: includeLinks,
			extractMetadata: true,
		};

		// Call the existing scrap-url endpoint logic
		const response = await fetch(`http://localhost:3001/scrap-url`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(scrapeRequest),
		});

		if (!response.ok) {
			throw new Error(`Scraping failed: ${response.statusText}`);
		}

		const scrapeResult = await response.json();
		scrapedData = scrapeResult.data || scrapeResult;

		// Add page info
		scrapedData.pageInfo = {
			url: googleNewsUrl,
			scrapedAt: new Date().toISOString(),
			searchQuery: `${city} ${state}`,
			city,
			state,
			country,
			language,
			userAgent: await page.evaluate(() => navigator.userAgent),
			viewport: await page.viewportSize(),
		};

		await page.close();
		await context.close();

		return c.json({
			success: true,
			data: scrapedData,
			url: googleNewsUrl,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error("❌ Google News scraping error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to scrape Google News",
				details: error.message,
				url: googleNewsUrl,
				searchQuery: `${city} ${state}`,
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

// Bulk Wikipedia scraping endpoint
// Required columns in locations table:
// - id, name, state, latitude, longitude
// Optional columns (will be created if they don't exist):
// - wikipedia_content, wikipedia_url
app.post("/bulk-wikipedia-scrap", async (c) => {
	try {
		const {
			batchSize = 50,
			maxConcurrentBrowsers = 3,
			useProxy = false,
			forceRestart = false,
		} = await c.req.json();

		// Force restart if requested
		if (forceRestart) {
			wikipediaScrapingQueue.batches.clear();
			wikipediaScrapingQueue.currentBatch = 0;
			wikipediaScrapingQueue.isProcessing = false;
			console.log("🔄 Wikipedia scraping queue restarted");
		}

		// Check if already processing
		if (wikipediaScrapingQueue.isProcessing) {
			return c.json(
				{
					success: false,
					error: "Wikipedia scraping is already in progress",
					currentStatus: wikipediaScrapingQueue.getStats(),
					suggestion: "Use forceRestart: true to restart the queue",
				},
				409
			);
		}

		console.log("🚀 Starting bulk Wikipedia scraping...");

		// Fetch locations from Supabase
		// Note: Only selecting columns that actually exist in the table
		const { data: locations, error: fetchError } = await supabase
			.from("locations")
			.select("id, name, state, latitude, longitude")
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
						"Ensure the locations table has data before running Wikipedia scraping",
				},
				404
			);
		}

		console.log(`📊 Found ${locations.length} locations to process`);
		console.log(`📋 Sample location data:`, locations[0]);

		// Create batches
		const batches = [];
		for (let i = 0; i < locations.length; i += batchSize) {
			const batch = locations.slice(i, i + batchSize);
			const batchNumber = batches.length;
			batches.push({ batchNumber, locations: batch });

			// Add to queue
			wikipediaScrapingQueue.addBatch(batchNumber, batch);
		}

		console.log(
			`📦 Created ${batches.length} batches of ${batchSize} locations each`
		);

		// Start processing in background
		wikipediaScrapingQueue.isProcessing = true;
		processWikipediaBatches(batches, maxConcurrentBrowsers, useProxy);

		return c.json({
			success: true,
			message: "Bulk Wikipedia scraping started successfully",
			data: {
				totalLocations: locations.length,
				batchSize,
				totalBatches: batches.length,
				maxConcurrentBrowsers,
				useProxy,
				queueStatus: wikipediaScrapingQueue.getStats(),
			},
			endpoints: {
				status: "/wikipedia-scraping-status",
				results: "/wikipedia-scraping-results",
			},
		});
	} catch (error) {
		console.error("❌ Bulk Wikipedia scraping error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to start bulk Wikipedia scraping",
				details: error.message,
			},
			500
		);
	}
});

// Wikipedia scraping status endpoint
app.get("/wikipedia-scraping-status", (c) => {
	return c.json({
		success: true,
		status: wikipediaScrapingQueue.getStats(),
		timestamp: new Date().toISOString(),
	});
});

// Wikipedia scraping results endpoint
app.get("/wikipedia-scraping-results", (c) => {
	const { batchNumber } = c.req.query();

	if (batchNumber !== undefined) {
		const batch = wikipediaScrapingQueue.batches.get(parseInt(batchNumber));
		if (!batch) {
			return c.json(
				{
					success: false,
					error: `Batch ${batchNumber} not found`,
				},
				404
			);
		}

		return c.json({
			success: true,
			batchNumber: parseInt(batchNumber),
			data: batch,
		});
	}

	// Return all completed batches
	const completedBatches = Array.from(wikipediaScrapingQueue.batches.entries())
		.filter(([_, batch]) => batch.status === "completed")
		.map(([number, batch]) => ({
			batchNumber: number,
			status: batch.status,
			startedAt: batch.startedAt,
			completedAt: batch.completedAt,
			successCount: batch.successCount,
			failedCount: batch.failedCount,
			results: batch.results.slice(0, 10), // Return first 10 results for preview
		}));

	return c.json({
		success: true,
		completedBatches,
		totalCompleted: completedBatches.length,
	});
});

// Background processing function
async function processWikipediaBatches(
	batches,
	maxConcurrentBrowsers,
	useProxy
) {
	try {
		// Process batches sequentially to avoid overwhelming Wikipedia
		for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
			const { batchNumber, locations } = batches[batchIndex];

			// Mark batch as started
			wikipediaScrapingQueue.markBatchStarted(batchNumber);

			// Process current batch
			const batchResults = await processWikipediaBatch(
				locations,
				maxConcurrentBrowsers,
				useProxy
			);

			// Mark batch as completed
			wikipediaScrapingQueue.markBatchCompleted(batchNumber, batchResults);

			// Store results in Supabase
			await storeWikipediaResults(batchResults);

			// Add delay between batches to be respectful to Wikipedia
			if (batchIndex < batches.length - 1) {
				const delay = Math.min(5000, locations.length * 100); // Adaptive delay
				console.log(`⏳ Waiting ${delay}ms before next batch...`);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}

		console.log("🎉 All Wikipedia batches completed successfully!");
		wikipediaScrapingQueue.isProcessing = false;
	} catch (error) {
		console.error("❌ Error processing Wikipedia batches:", error);
		wikipediaScrapingQueue.isProcessing = false;
	}
}

// Process a single batch of locations
async function processWikipediaBatch(
	locations,
	maxConcurrentBrowsers,
	useProxy
) {
	const results = [];

	try {
		// Process locations with controlled concurrency
		const concurrencyLimit = Math.min(maxConcurrentBrowsers, 5); // Cap at 5 concurrent requests
		const chunks = [];

		// Split locations into chunks for controlled concurrency
		for (let i = 0; i < locations.length; i += concurrencyLimit) {
			chunks.push(locations.slice(i, i + concurrencyLimit));
		}

		// Process chunks sequentially to avoid overwhelming the API
		for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
			const chunk = chunks[chunkIndex];
			let chunkStats = {
				totalUrls: 0,
				validUrls: 0,
				invalidUrls: 0,
				successfulScrapes: 0,
			};

			// Process current chunk in parallel
			const chunkPromises = chunk.map(async (location) => {
				// Generate Wikipedia URLs (handle cases where state might be null)
				const urls = generateWikipediaURLs(
					location.name,
					location.state || null
				);

				// Track URL validation stats for this location
				chunkStats.totalUrls += urls.length;

				// Try each URL strategy until one works
				for (const url of urls) {
					try {
						// First check if the URL is valid and accessible
						const isUrlValid = await checkWikipediaURL(url);

						if (!isUrlValid) {
							console.warn(`⚠️ URL not accessible: ${url}`);
							chunkStats.invalidUrls++;
							continue;
						}

						chunkStats.validUrls++;
						const result = await extractWikipediaContent(url, useProxy);

						if (result.success) {
							chunkStats.successfulScrapes++;
							return {
								locationId: location.id,
								locationName: location.name,
								locationState: location.state,
								success: true,
								wikipediaUrl: url,
								content: result.data,
							};
						}
					} catch (error) {
						console.warn(`⚠️ Failed to extract from ${url}:`, error.message);
						continue;
					}
				}

				return {
					locationId: location.id,
					locationName: location.name,
					locationState: location.state,
					success: false,
					error: "All Wikipedia URL strategies failed",
					attemptedUrls: urls,
				};
			});

			// Wait for current chunk to complete
			const chunkResults = await Promise.all(chunkPromises);
			results.push(...chunkResults);

			// Add small delay between chunks to be respectful
			if (chunkIndex < chunks.length - 1) {
				const delay = 1000; // 1 second delay between
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	} catch (error) {
		console.error("❌ Error processing Wikipedia batch:", error);
	}

	return results;
}

// Store Wikipedia results in Supabase
async function storeWikipediaResults(results) {
	const successfulResults = results.filter((r) => r.success);
	const failedResults = results.filter((r) => !r.success);

	// Update successful results
	for (const result of successfulResults) {
		try {
			// Extract paragraphs from the content and join them into readable text
			const paragraphs = result.content?.paragraphs || [];
			const wikipediaContent =
				paragraphs.length > 0 ? paragraphs.join("\n\n") : null;

			const { error } = await supabase
				.from("locations")
				.update({
					wikipedia_content: wikipediaContent,
					wikipedia_url: result.wikipediaUrl,
				})
				.eq("id", result.locationId);

			if (error) {
				console.error(
					`❌ Failed to update location ${result.locationId}:`,
					error
				);
			} else {
				console.log(
					`✅ Updated location ${result.locationId} with Wikipedia content (${paragraphs.length} paragraphs)`
				);
			}
		} catch (error) {
			console.error(`❌ Error updating location ${result.locationId}:`, error);
		}
	}
}

// Airbnb Scraping Endpoint
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

		console.log(`\n=== PROCESSING COMPLETE ===`);
		console.log(`Total sources: ${sources.length}`);
		console.log(`Successful: ${successful}`);
		console.log(`Failed: ${failed}`);
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

// one table for all links only unique ones hashing links and if scraped or not we have that table
// keep adding new hashed links in this table or just adding new ones with set when searched online
// later one database optimisation we can do afterwards

// Performance monitoring endpoints
app.get("/performance", (c) => {
	const metrics = performanceMonitor.getAllMetrics();
	return c.json({
		success: true,
		timestamp: new Date().toISOString(),
		metrics: performanceMonitor.formatMetrics(metrics),
	});
});

app.get("/performance/system", (c) => {
	const systemMetrics = performanceMonitor.getSystemMetrics();
	return c.json({
		success: true,
		timestamp: new Date().toISOString(),
		system: performanceMonitor.formatMetrics(systemMetrics),
	});
});

app.get("/performance/operations", (c) => {
	const operations = Array.from(performanceMonitor.metrics.values())
		.filter((op) => op.status === "completed")
		.sort((a, b) => b.startTime - a.startTime)
		.slice(0, 50); // Return last 50 operations

	return c.json({
		success: true,
		timestamp: new Date().toISOString(),
		operations: operations.map((op) => ({
			name: op.name,
			duration: op.duration,
			cpuUsage: op.cpuUsage,
			memoryUsage: op.memoryUsage,
			startTime: op.startTime,
			completedAt: op.completedAt,
		})),
	});
});

app.get("/performance/summary", (c) => {
	const summary = {
		scrapUrl: performanceMonitor.getOperationSummary("scrap-url"),
		crawlUrl: performanceMonitor.getOperationSummary("crawl-url"),
		googleMaps: performanceMonitor.getOperationSummary("google-maps"),
		airbnb: performanceMonitor.getOperationSummary("airbnb-scrap"),
		wikipedia: performanceMonitor.getOperationSummary("wikipedia-scrap"),
	};

	return c.json({
		success: true,
		timestamp: new Date().toISOString(),
		summary,
	});
});

// Cleanup old metrics periodically
setInterval(() => {
	performanceMonitor.cleanup();
}, 5 * 60 * 1000); // Every 5 minutes

const port = 3001;
console.log(`Server is running on port ${port}`);
console.log(`📊 Performance monitoring enabled`);
console.log(`   📈 /performance - All metrics`);
console.log(`   💻 /performance/system - System metrics`);
console.log(`   🔄 /performance/operations - Recent operations`);
console.log(`   📋 /performance/summary - Operation summaries`);

serve({
	fetch: app.fetch,
	port,
});

// URL Crawling Endpoint - Crawls a single URL and processes up to 20 links found on that page
app.post("/crawl-url", async (c) => {
	const {
		url,
		maxLinks = 20, // Maximum number of links to crawl from the parent page
		batchSize = 5, // Number of links to process concurrently in each batch
		delayBetweenBatches = 1000, // Delay between batches in milliseconds
		includeSemanticContent = true, // Whether to include semantic content in scraped data
		useProxy = false, // Whether to use proxy for crawling
		includeImages = false, // Whether to include images in scraped data
		includeLinks = true, // Whether to include links in scraped data
		extractMetadata = true, // Whether to extract metadata
		timeout = 30000, // Timeout for each request
		validateLinks = true, // Whether to validate links before crawling
		restrictToSeedDomain = true, // Whether to only allow links from the same domain as seed URL
	} = await c.req.json();

	if (!url) {
		return c.json({ error: "URL is required" }, 400);
	}

	// Validate URL format
	let targetUrl;
	try {
		targetUrl = new URL(url);
	} catch (error) {
		return c.json({ error: "Invalid URL format" }, 400);
	}

	console.log(`🕷️ Starting URL crawl for: ${targetUrl.href}`);
	console.log(
		`📊 Configuration: maxLinks=${maxLinks}, batchSize=${batchSize}, useProxy=${useProxy}`
	);

	try {
		// Step 1: Scrape the parent URL to get all links
		console.log(`🔍 Step 1: Scraping parent URL to extract links...`);

		const parentScrapeResponse = await fetch(
			`http://localhost:3001/scrap-url`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					url: targetUrl.href,
					useProxy: useProxy,
					includeSemanticContent: false,
					includeImages: includeImages,
					includeLinks: includeLinks,
					extractMetadata: extractMetadata,
					timeout: timeout,
				}),
			}
		);

		if (!parentScrapeResponse.ok) {
			throw new Error(
				`Failed to scrape parent URL: ${parentScrapeResponse.statusText}`
			);
		}

		const parentScrapeData = await parentScrapeResponse.json();

		if (!parentScrapeData.success) {
			throw new Error(`Parent URL scraping failed: ${parentScrapeData.error}`);
		}

		// Extract links from the parent page
		const allLinks = parentScrapeData.data?.links || [];
		console.log(`🔗 Found ${allLinks.length} total links on parent page`);

		const validLinks = [];
		const invalidLinks = [];
		const processedUrls = new Set([targetUrl.href]); // Track processed URLs to avoid duplicates

		// Extract seed domain for filtering
		const seedDomain = targetUrl.hostname.toLowerCase();
		console.log(`🌐 Seed domain: ${seedDomain}`);
		if (restrictToSeedDomain) {
			console.log(
				`🔒 Domain restriction: Only allowing links from ${seedDomain}`
			);
		} else {
			console.log(`🌍 Domain restriction: Allowing links from any domain`);
		}

		for (const link of allLinks) {
			try {
				// Skip if we've already processed this URL
				if (processedUrls.has(link.href)) {
					continue;
				}

				// Basic link validation
				if (!link.href || typeof link.href !== "string") {
					invalidLinks.push({ ...link, reason: "Invalid href" });
					continue;
				}

				// Parse the link URL
				let linkUrl;
				try {
					linkUrl = new URL(link.href);
				} catch (error) {
					invalidLinks.push({ ...link, reason: "Invalid URL format" });
					continue;
				}

				// Skip if we've already processed this URL
				if (processedUrls.has(linkUrl.href)) {
					continue;
				}

				// Domain filtering - only allow links from the same domain as seed URL
				if (restrictToSeedDomain) {
					const linkDomain = linkUrl.hostname.toLowerCase();

					// Simple domain check: hostname must match seed domain exactly
					if (linkDomain !== seedDomain) {
						invalidLinks.push({
							...link,
							reason: `External domain: ${linkDomain}`,
						});
						continue;
					}
				}

				// Enhanced link filtering for authentic content links only
				if (validateLinks) {
					// Skip non-HTTP/HTTPS protocols
					if (
						linkUrl.protocol === "mailto:" ||
						linkUrl.protocol === "tel:" ||
						linkUrl.protocol === "javascript:" ||
						linkUrl.protocol === "data:" ||
						linkUrl.protocol === "blob:" ||
						linkUrl.protocol === "file:" ||
						linkUrl.protocol === "ftp:" ||
						linkUrl.protocol === "sftp:"
					) {
						invalidLinks.push({
							...link,
							reason: "Unsupported protocol",
						});
						continue;
					}

					// Skip anchor links and scroll-to links
					if (linkUrl.href.includes("#") || linkUrl.hash) {
						invalidLinks.push({
							...link,
							reason: "Anchor/scroll link",
						});
						continue;
					}

					// Skip image file extensions
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
						".jfif",
						".pjpeg",
						".pjp",
					];
					const hasImageExtension = imageExtensions.some((ext) =>
						linkUrl.href.toLowerCase().includes(ext)
					);
					if (hasImageExtension) {
						invalidLinks.push({
							...link,
							reason: "Image file link",
						});
						continue;
					}

					// Skip video file extensions
					const videoExtensions = [
						".mp4",
						".avi",
						".mov",
						".wmv",
						".flv",
						".webm",
						".mkv",
						".m4v",
						".3gp",
						".ogv",
						".ts",
						".mts",
						".m2ts",
						".divx",
						".xvid",
					];
					const hasVideoExtension = videoExtensions.some((ext) =>
						linkUrl.href.toLowerCase().includes(ext)
					);
					if (hasVideoExtension) {
						invalidLinks.push({
							...link,
							reason: "Video file link",
						});
						continue;
					}

					// Skip audio file extensions
					const audioExtensions = [
						".mp3",
						".wav",
						".flac",
						".aac",
						".ogg",
						".wma",
						".m4a",
						".opus",
						".amr",
						".3ga",
						".ra",
						".mid",
						".midi",
					];
					const hasAudioExtension = audioExtensions.some((ext) =>
						linkUrl.href.toLowerCase().includes(ext)
					);
					if (hasAudioExtension) {
						invalidLinks.push({
							...link,
							reason: "Audio file link",
						});
						continue;
					}

					// Skip document and archive file extensions
					const documentExtensions = [
						".pdf",
						".doc",
						".docx",
						".xls",
						".xlsx",
						".ppt",
						".pptx",
						".txt",
						".rtf",
						".odt",
						".ods",
						".odp",
						".csv",
					];
					const archiveExtensions = [
						".zip",
						".rar",
						".7z",
						".tar",
						".gz",
						".bz2",
						".xz",
						".lzma",
					];
					const hasDocumentExtension = documentExtensions.some((ext) =>
						linkUrl.href.toLowerCase().includes(ext)
					);
					const hasArchiveExtension = archiveExtensions.some((ext) =>
						linkUrl.href.toLowerCase().includes(ext)
					);
					if (hasDocumentExtension || hasArchiveExtension) {
						invalidLinks.push({
							...link,
							reason: "Document/archive file link",
						});
						continue;
					}

					// Skip social media sharing and tracking links
					const socialMediaPatterns = [
						"share",
						"shareArticle",
						"sharethis",
						"addthis",
						"facebook.com/sharer",
						"twitter.com/intent",
						"linkedin.com/sharing",
						"pinterest.com/pin/create",
						"whatsapp.com/send",
						"telegram.me/share",
						"reddit.com/submit",
						"buffer.com/add",
						"digg.com/submit",
						"stumbleupon.com/submit",
					];
					const hasSocialMediaPattern = socialMediaPatterns.some((pattern) =>
						linkUrl.href.toLowerCase().includes(pattern)
					);
					if (hasSocialMediaPattern) {
						invalidLinks.push({
							...link,
							reason: "Social media sharing link",
						});
						continue;
					}

					// Skip analytics and tracking links
					const trackingPatterns = [
						"google-analytics",
						"googletagmanager",
						"facebook.com/tr",
						"pixel",
						"tracking",
						"analytics",
						"stats",
						"metrics",
						"clicktrack",
						"affiliate",
						"ref=",
						"utm_",
						"campaign",
					];
					const hasTrackingPattern = trackingPatterns.some((pattern) =>
						linkUrl.href.toLowerCase().includes(pattern)
					);
					if (hasTrackingPattern) {
						invalidLinks.push({
							...link,
							reason: "Analytics/tracking link",
						});
						continue;
					}

					// Skip login, signup, and account-related links
					const accountPatterns = [
						"login",
						"signin",
						"signup",
						"register",
						"signout",
						"logout",
						"account",
						"profile",
						"dashboard",
						"admin",
						"user",
						"member",
						"auth",
						"oauth",
						"sso",
						"password",
						"reset",
						"verify",
					];
					const hasAccountPattern = accountPatterns.some((pattern) =>
						linkUrl.href.toLowerCase().includes(pattern)
					);
					if (hasAccountPattern) {
						invalidLinks.push({
							...link,
							reason: "Account/authentication link",
						});
						continue;
					}

					// Skip very long URLs (likely generated or spam)
					if (linkUrl.href.length > 500) {
						invalidLinks.push({ ...link, reason: "URL too long" });
						continue;
					}

					// Skip URLs with too many query parameters (likely tracking)
					if (linkUrl.searchParams.size > 10) {
						invalidLinks.push({ ...link, reason: "Too many query parameters" });
						continue;
					}

					// Skip URLs that are just the domain (no meaningful path)
					if (linkUrl.pathname === "/" || linkUrl.pathname === "") {
						invalidLinks.push({ ...link, reason: "Just domain root" });
						continue;
					}

					// Skip URLs with suspicious patterns
					const suspiciousPatterns = [
						"click",
						"redirect",
						"go",
						"jump",
						"visit",
						"goto",
						"out",
						"external",
						"away",
						"exit",
						"leave",
						"depart",
					];
					const hasSuspiciousPattern = suspiciousPatterns.some((pattern) =>
						linkUrl.href.toLowerCase().includes(pattern)
					);
					if (hasSuspiciousPattern) {
						invalidLinks.push({
							...link,
							reason: "Suspicious redirect pattern",
						});
						continue;
					}
				}

				// Add to valid links
				validLinks.push({
					...link,
					parsedUrl: linkUrl.href,
					domain: linkUrl.hostname,
				});

				// Mark as processed
				processedUrls.add(linkUrl.href);

				// Stop if we have enough valid links
				if (validLinks.length >= maxLinks) {
					break;
				}
			} catch (error) {
				invalidLinks.push({
					...link,
					reason: `Validation error: ${error.message}`,
				});
			}
		}

		console.log(
			`✅ Validated ${validLinks.length} links (${invalidLinks.length} invalid)`
		);

		// Log detailed filtering statistics
		if (invalidLinks.length > 0) {
			console.log(`📊 Invalid links breakdown:`);
			const reasonCounts = {};
			invalidLinks.forEach((link) => {
				const reason = link.reason || "Unknown reason";
				reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
			});

			Object.entries(reasonCounts)
				.sort(([, a], [, b]) => b - a) // Sort by count descending
				.forEach(([reason, count]) => {
					console.log(`   ❌ ${reason}: ${count} links`);
				});
		}

		// Log domain filtering summary
		if (restrictToSeedDomain) {
			const externalDomainCount = invalidLinks.filter(
				(link) => link.reason && link.reason.includes("External domain")
			).length;

			console.log(
				`🌐 Domain filtering: ${externalDomainCount} external domain links blocked`
			);
			console.log(`✅ Links passing domain filter: ${validLinks.length}`);
		}

		// Step 3: Process links in batches
		console.log(
			`🔄 Step 3: Processing ${validLinks.length} links in batches of ${batchSize}...`
		);

		const crawlResults = [];
		const batches = [];

		// Create batches
		for (let i = 0; i < validLinks.length; i += batchSize) {
			batches.push(validLinks.slice(i, i + batchSize));
		}

		console.log(`📦 Created ${batches.length} batches`);

		// Process each batch
		for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
			const batch = batches[batchIndex];
			console.log(
				`🔄 Processing batch ${batchIndex + 1}/${batches.length} with ${
					batch.length
				} links...`
			);

			// Process current batch concurrently
			const batchPromises = batch.map(async (link, linkIndex) => {
				try {
					console.log(
						`🔍 Crawling link ${batchIndex * batchSize + linkIndex + 1}/${
							validLinks.length
						}: ${link.parsedUrl}`
					);

					// Call scrap-url for this link
					const linkResponse = await fetch(`http://localhost:3001/scrap-url`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							url: link.parsedUrl,
							useProxy: useProxy,
							includeSemanticContent: includeSemanticContent,
							includeImages: includeImages,
							includeLinks: includeLinks,
							extractMetadata: extractMetadata,
							timeout: timeout,
						}),
					});

					if (!linkResponse.ok) {
						throw new Error(
							`HTTP error: ${linkResponse.status} ${linkResponse.statusText}`
						);
					}

					const linkData = await linkResponse.json();

					if (!linkData.success) {
						throw new Error(`Scraping failed: ${linkData.error}`);
					}

					// Extract key information from the scraped data
					const extractedData = {
						originalLink: link,
						url: link.parsedUrl,
						title: linkData.data?.title || link.text || "No title",
						description:
							linkData.data?.metadata?.description ||
							linkData.data?.metadata?.["og:description"] ||
							"No description",
						scrapedAt: linkData.timestamp,
						success: true,
						content: {
							headings: linkData.data?.content || {},
							paragraphs:
								linkData.data?.content?.semanticContent?.paragraphs || [],
							images: linkData.data?.images || [],
							links: linkData.data?.links || [],
						},
						metadata: linkData.data?.metadata || {},
						pageInfo: linkData.data?.pageInfo || {},
					};

					console.log(`✅ Successfully crawled: ${link.parsedUrl}`);
					return extractedData;
				} catch (error) {
					console.error(`❌ Failed to crawl ${link.parsedUrl}:`, error.message);

					return {
						originalLink: link,
						url: link.parsedUrl,
						success: false,
						error: error.message,
						scrapedAt: new Date().toISOString(),
					};
				}
			});

			// Wait for current batch to complete
			const batchResults = await Promise.allSettled(batchPromises);

			// Process batch results
			const successfulResults = [];
			const failedResults = [];

			batchResults.forEach((result, index) => {
				if (result.status === "fulfilled") {
					const data = result.value;
					if (data.success) {
						successfulResults.push(data);
					} else {
						failedResults.push(data);
					}
				} else {
					// Handle rejected promises
					const link = batch[index];
					failedResults.push({
						originalLink: link,
						url: link.parsedUrl,
						success: false,
						error: `Promise rejected: ${result.reason}`,
						scrapedAt: new Date().toISOString(),
					});
				}
			});

			// Add batch results to overall results
			crawlResults.push(...successfulResults, ...failedResults);

			console.log(
				`📊 Batch ${batchIndex + 1} completed: ${
					successfulResults.length
				} successful, ${failedResults.length} failed`
			);

			// Add delay between batches (except for the last batch)
			if (batchIndex < batches.length - 1 && delayBetweenBatches > 0) {
				console.log(`⏳ Waiting ${delayBetweenBatches}ms before next batch...`);
				await new Promise((resolve) =>
					setTimeout(resolve, delayBetweenBatches)
				);
			}
		}

		// Step 4: Prepare final response
		console.log(`🎉 Crawling completed! Processing final results...`);

		const successfulCrawls = crawlResults.filter((r) => r.success);
		const failedCrawls = crawlResults.filter((r) => !r.success);
		const successRate = (
			(successfulCrawls.length / crawlResults.length) *
			100
		).toFixed(2);

		// Calculate statistics
		const totalImages = successfulCrawls.reduce(
			(sum, crawl) => sum + (crawl.content?.images?.length || 0),
			0
		);
		const totalLinks = successfulCrawls.reduce(
			(sum, crawl) => sum + (crawl.content?.links?.length || 0),
			0
		);
		const totalParagraphs = successfulCrawls.reduce(
			(sum, crawl) => sum + (crawl.content?.paragraphs?.length || 0),
			0
		);

		// Collect all unique links from all nested scrap responses using Map to avoid duplicates
		console.log(`🔗 Collecting all unique links from nested responses...`);
		const uniqueLinksMap = new Map();

		// Add links from parent URL
		if (parentScrapeData.data?.links) {
			parentScrapeData.data.links.forEach((link, index) => {
				if (link.href && typeof link.href === "string") {
					const key = link.href.toLowerCase().trim();
					if (!uniqueLinksMap.has(key)) {
						uniqueLinksMap.set(key, {
							...link,
							source: "parent",
							sourceIndex: index,
							discoveredAt: "parent_page",
						});
					}
				}
			});
		}

		// Add links from all crawled pages
		successfulCrawls.forEach((crawl, crawlIndex) => {
			if (crawl.content?.links && Array.isArray(crawl.content.links)) {
				crawl.content.links.forEach((link, linkIndex) => {
					if (link.href && typeof link.href === "string") {
						const key = link.href.toLowerCase().trim();
						if (!uniqueLinksMap.has(key)) {
							uniqueLinksMap.set(key, {
								...link,
								source: "crawled_page",
								sourceUrl: crawl.url,
								sourceTitle: crawl.title,
								crawlIndex: crawlIndex,
								linkIndex: linkIndex,
								discoveredAt: "nested_crawl",
							});
						}
					}
				});
			}
		});

		// Convert Map to array and sort by source for better organization
		const allUniqueLinks = Array.from(uniqueLinksMap.values()).sort((a, b) => {
			// Sort by source priority: parent first, then crawled pages
			if (a.source === "parent" && b.source !== "parent") return -1;
			if (a.source !== "parent" && b.source === "parent") return 1;

			// Then sort by crawl index and link index
			if (a.source === "crawled_page" && b.source === "crawled_page") {
				if (a.crawlIndex !== b.crawlIndex) return a.crawlIndex - b.crawlIndex;
				return a.linkIndex - b.linkIndex;
			}

			// For parent links, sort by original index
			if (a.source === "parent" && b.source === "parent") {
				return a.sourceIndex - b.sourceIndex;
			}

			return 0;
		});

		console.log(
			`🔗 Collected ${allUniqueLinks.length} unique links from all sources`
		);

		// Apply domain filtering to allUniqueLinks if restrictToSeedDomain is enabled
		let filteredUniqueLinks = allUniqueLinks;
		if (restrictToSeedDomain) {
			const beforeFiltering = allUniqueLinks.length;
			filteredUniqueLinks = allUniqueLinks.filter((link) => {
				try {
					const linkUrl = new URL(link.href);
					const linkDomain = linkUrl.hostname.toLowerCase();
					return linkDomain === seedDomain;
				} catch (error) {
					// If URL parsing fails, filter it out
					return false;
				}
			});

			const afterFiltering = filteredUniqueLinks.length;
			const filteredOut = beforeFiltering - afterFiltering;
			console.log(`🔒 Domain filtering applied to allUniqueLinks:`);
			console.log(`   📊 Before filtering: ${beforeFiltering} links`);
			console.log(`   ✅ After filtering: ${afterFiltering} links`);
			console.log(`   ❌ Filtered out: ${filteredOut} external domain links`);
		}

		const finalResponse = {
			success: true,
			message: `Successfully crawled ${targetUrl.href} and processed ${validLinks.length} links`,
			parentUrl: {
				url: targetUrl.href,
				title: parentScrapeData.data?.title || "No title",
				description:
					parentScrapeData.data?.metadata?.description || "No description",
				totalLinksFound: allLinks.length,
				validLinksFound: validLinks.length,
				invalidLinksFound: invalidLinks.length,
			},
			crawlResults: {
				total: crawlResults.length,
				successful: successfulCrawls.length,
				failed: failedCrawls.length,
				successRate: `${successRate}%`,
			},
			contentSummary: {
				totalImages: totalImages,
				totalLinks: totalLinks,
				totalParagraphs: totalParagraphs,
				averageImagesPerPage:
					successfulCrawls.length > 0
						? (totalImages / successfulCrawls.length).toFixed(2)
						: 0,
				averageLinksPerPage:
					successfulCrawls.length > 0
						? (totalLinks / successfulCrawls.length).toFixed(2)
						: 0,
				averageParagraphsPerPage:
					successfulCrawls.length > 0
						? (totalParagraphs / successfulCrawls.length).toFixed(2)
						: 0,
			},
			configuration: {
				maxLinks: maxLinks,
				batchSize: batchSize,
				delayBetweenBatches: delayBetweenBatches,
				useProxy: useProxy,
				includeImages: includeImages,
				includeLinks: includeLinks,
				extractMetadata: extractMetadata,
				timeout: timeout,
				validateLinks: validateLinks,
				restrictToSeedDomain: restrictToSeedDomain,
				seedDomain: seedDomain,
			},
			allUniqueLinks: {
				total: filteredUniqueLinks.length,
				links: filteredUniqueLinks,
				summary: {
					fromParent: filteredUniqueLinks.filter(
						(link) => link.source === "parent"
					).length,
					fromCrawledPages: filteredUniqueLinks.filter(
						(link) => link.source === "crawled_page"
					).length,
					uniqueDomains: new Set(
						filteredUniqueLinks.map((link) => {
							try {
								return new URL(link.href).hostname;
							} catch {
								return "invalid-url";
							}
						})
					).size,
				},
			},
			results: crawlResults,
			timestamp: new Date().toISOString(),
			processingTime: Date.now() - Date.now(), // Will be calculated properly in actual implementation
		};

		console.log(`📊 Final Statistics:`);
		console.log(`✅ Successful crawls: ${successfulCrawls.length}`);
		console.log(`❌ Failed crawls: ${failedCrawls.length}`);
		console.log(`📈 Success rate: ${successRate}%`);
		console.log(`🖼️ Total images found: ${totalImages}`);
		console.log(`🔗 Total links found: ${totalLinks}`);
		console.log(`📝 Total paragraphs found: ${totalParagraphs}`);
		console.log(`🔗 Unique Links Summary:`);
		console.log(
			`   📍 From parent page: ${
				filteredUniqueLinks.filter((link) => link.source === "parent").length
			}`
		);
		console.log(
			`   🕷️ From crawled pages: ${
				filteredUniqueLinks.filter((link) => link.source === "crawled_page")
					.length
			}`
		);
		console.log(
			`   🌐 Unique domains: ${
				new Set(
					filteredUniqueLinks.map((link) => {
						try {
							return new URL(link.href).hostname;
						} catch {
							return "invalid-url";
						}
					})
				).size
			}`
		);

		return c.json(finalResponse);
	} catch (error) {
		console.error("❌ URL crawling error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to crawl URL",
				details: error.message,
				url: targetUrl?.href || url,
				timestamp: new Date().toISOString(),
			},
			500
		);
	}
});

// Scrap-chat endpoint - LLM-powered chat about scraped URL content
app.post("/scrap-chat", async (c) => {
	try {
		const {
			url,
			question,
			useProxy = false,
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

		if (!question) {
			return c.json(
				{
					success: false,
					error: "Question is required",
				},
				400
			);
		}

		console.log(`🤖 Starting scrap-chat for URL: ${url}`);
		console.log(`❓ Question: ${question}`);

		// Step 1: Scrape the URL using the existing scrap-url endpoint
		console.log(`🔍 Step 1: Scraping URL to extract content...`);

		const scrapeResponse = await fetch(`http://localhost:3001/scrap-url`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				url: url,
				useProxy: useProxy,
				includeImages: includeImages,
				includeLinks: false, // We don't need links for chat
				extractMetadata: true, // We need this for context
				includeSemanticContent: true, // We need this for context
				timeout: 30000,
			}),
		});

		if (!scrapeResponse.ok) {
			throw new Error(`Failed to scrape URL: ${scrapeResponse.statusText}`);
		}

		const scrapeData = await scrapeResponse.json();

		if (!scrapeData.success) {
			throw new Error(`URL scraping failed: ${scrapeData.error}`);
		}

		console.log(`✅ URL scraped successfully`);

		const allLinks = scrapeData.data?.links || [];
		// Step 2: Extract relevant content for LLM context
		const scrapedContent = scrapeData.data;
		const semanticContent = scrapedContent?.content?.semanticContent || {};

		// Extract paragraphs and divs for context
		const paragraphs = semanticContent.paragraphs || [];
		const divs = semanticContent.divs || [];
		const headings = scrapedContent?.content || {};

		// Combine all text content for context
		const allTextContent = [];

		// Add headings
		Object.entries(headings).forEach(([tag, texts]) => {
			if (Array.isArray(texts) && texts.length > 0) {
				allTextContent.push(`${tag.toUpperCase()}:`);
				texts.forEach((text) => allTextContent.push(`- ${text}`));
			}
		});

		// Add paragraphs
		if (paragraphs.length > 0) {
			allTextContent.push("PARAGRAPHS:");
			paragraphs.forEach((para) => allTextContent.push(para));
		}

		// Add div content (limited to avoid too much context)
		if (divs.length > 0) {
			allTextContent.push("DIV CONTENT:");
			divs.slice(0, 10).forEach((div) => allTextContent.push(div)); // Limit to first 10 divs
		}

		// Join all content with proper spacing
		const contextText = allTextContent.join("\n\n");

		console.log(
			`📝 Extracted ${paragraphs.length} paragraphs and ${divs.length} divs for context`
		);
		console.log(`📊 Total context length: ${contextText.length} characters`);

		// Step 3: Prepare prompt for Google GenAI
		const prompt = `You are an AI assistant that helps users understand web content. 

Here is the content from the webpage at ${url}:

${contextText}

The user's question is: ${question}

Please provide a comprehensive answer based ONLY on the content above. If the information is not available in the provided content, clearly state that. 

Guidelines:
1. Answer the question directly and concisely
2. Use information only from the scraped content
3. If you need to reference specific parts, mention them
4. If the question cannot be answered with the available content, explain why
5. Keep your response focused and relevant to the question

Below are the links scrapped from the URL page:
${JSON.stringify(allLinks, null, 2)}

Answer:`;

		console.log(`🧠 Step 2: Sending content to Google GenAI for analysis...`);

		// Step 4: Send to Google GenAI
		const genaiResponse = await genai.models.generateContent({
			model: "gemini-2.0-flash",
			contents: [
				{
					role: "user",
					parts: [{ text: prompt }],
				},
			],
		});

		const aiAnswer = genaiResponse.candidates[0].content.parts[0].text;
		const thought = genaiResponse.candidates[0].content.parts[0].thought;

		console.log(`✅ GenAI response generated successfully`);

		// Step 5: Prepare final response
		const finalResponse = {
			success: true,
			message: "Successfully analyzed URL content and generated AI response",
			data: {
				url: url,
				question: question,
				aiAnswer: aiAnswer,
				thought: thought,
				contentSummary: {
					title: scrapedContent?.title || "No title",
					totalParagraphs: paragraphs.length,
					totalDivs: divs.length,
					contextLength: contextText.length,
					scrapedAt:
						scrapedContent?.pageInfo?.scrapedAt || new Date().toISOString(),
				},
				metadata: {
					description:
						scrapedContent?.metadata?.description ||
						scrapedContent?.metadata?.["og:description"] ||
						"No description",
					author:
						scrapedContent?.metadata?.author ||
						scrapedContent?.metadata?.["og:author"] ||
						"Unknown",
					keywords: scrapedContent?.metadata?.keywords || "No keywords",
				},
				processingInfo: {
					useProxy: useProxy,
					includeImages: includeImages,
					timestamp: new Date().toISOString(),
				},
			},
		};

		console.log(`🎉 Scrap-chat completed successfully`);
		console.log(`�� Response summary:`);
		console.log(`   - Question: ${question}`);
		console.log(`   - Answer length: ${aiAnswer.length} characters`);
		console.log(`   - Context used: ${contextText.length} characters`);

		return c.json(finalResponse);
	} catch (error) {
		console.error("❌ Scrap-chat error:", error);

		return c.json(
			{
				success: false,
				error: "Failed to process scrap-chat request",
				details: error.message,
				url: url || "Unknown",
				timestamp: new Date().toISOString(),
			},
			500
		);
	}
});

async function main() {
	const locations = await supabase.from("locations").select("*").limit(5);
	// console.log(locations.data, "locations");

	const question = `What all other keys or columns i can fetch in locations table to make it better production ready`;

	const prompt = `I am providing you the locations of cities in India with other details including 
	google_maps_url, wikipedia_content, airbnb_url,airbnb_listings, unsplash_images, google_images
	and more. locations: ${JSON.stringify(locations.data, null, 2)}
	
	Your job is to answer the questions related as per using locations data: ${question}`;
	const response2 = await genai.models.generateContent({
		model: "gemini-2.0-flash",
		contents: [
			{
				role: "user",
				parts: [{ text: prompt }],
			},
		],
	});
	console.log(response2.candidates[0].content.parts[0].text, "response");
}

const firecrawlUrlScrapFunction = async (query) => {
	try {
		const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: query,
				onlyMainContent: true,
				parsers: ["pdf"],
				formats: ["markdown"],
			}),
		});

		if (!response.ok) {
			throw new Error(
				`Firecrawl API error: ${response.status} ${response.statusText}`
			);
		}

		const data = await response.json();
		return { result: data, success: true };
	} catch (error) {
		return { error: error.message, success: false };
	}
};

app.post("/ai-url-chat", async (c) => {
	const { link, prompt } = await c.req.json();

	// Use the new scrap-url-puppeteer endpoint instead of firecrawl
	const puppeteerResponse = await fetch(
		`http://localhost:3001/scrap-url-puppeteer`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				url: link,
				includeSemanticContent: true,
				includeImages: false,
				includeLinks: true,
				extractMetadata: true,
				timeout: 30000,
			}),
		}
	);

	if (!puppeteerResponse.ok) {
		return c.json({ error: "Failed to scrape URL using Puppeteer" }, 500);
	}

	const puppeteerData = await puppeteerResponse.json();
	console.log("Puppeteer scraping result:", puppeteerData);

	if (!puppeteerData.success) {
		return c.json(
			{ error: "Puppeteer scraping failed", details: puppeteerData.error },
			500
		);
	}

	// Extract the scraped content for the LLM
	const scrapedContent = puppeteerData.data;
	const contentForLLM = {
		title: scrapedContent.title,
		url: scrapedContent.url,
		content: scrapedContent.content,
		metadata: scrapedContent.metadata,
		links: scrapedContent.links,
		semanticContent: scrapedContent.content.semanticContent || {},
	};

	const response = await genai.models.generateContent({
		model: "gemini-2.0-flash",
		contents: [
			{
				role: "model",
				parts: [
					{
						text: `You are a helpful assistant. I am providing you with scraped content from a website. Your job is to answer the user's questions related to the content of this website.

Website URL: ${link}
Website Title: ${contentForLLM.title}

Scraped Content Summary:
- Headings: ${JSON.stringify(contentForLLM.content)}
- Metadata: ${JSON.stringify(contentForLLM.metadata)}
- Semantic Content: ${JSON.stringify(contentForLLM.semanticContent)}
- Links: ${JSON.stringify(contentForLLM.links)}

Please use this information to answer the user's question about the website content.`,
					},
				],
			},
			{
				role: "user",
				parts: [{ text: prompt }],
			},
		],
	});

	return c.json({
		answer: response.candidates[0].content.parts[0].text,
		scrapedData: contentForLLM,
		url: link,
		timestamp: new Date().toISOString(),
	});
});

// New Puppeteer-based URL scraping endpoint
app.post("/scrap-url-puppeteer", async (c) => {
	// Start performance monitoring for this operation
	const operationId = performanceMonitor.startOperation("scrap-url-puppeteer");
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
		useProxy = false, // Note: Proxy support would need additional implementation
	} = await c.req.json();

	if (!url) {
		return c.json({ error: "URL is required" }, 400);
	}

	let browser;
	let scrapedData = {};

	try {
		// Import puppeteer-core and chromium
		const puppeteer = await import("puppeteer-core");
		const chromium = (await import("@sparticuz/chromium")).default;

		// Try to launch browser with @sparticuz/chromium first
		try {
			const executablePath = await chromium.executablePath();
			console.log(`🔍 Chromium executable path: ${executablePath}`);

			browser = await puppeteer.launch({
				headless: true,
				args: chromium.args,
				executablePath: executablePath,
				ignoreDefaultArgs: ["--disable-extensions"],
			});
			console.log("✅ Successfully launched browser with @sparticuz/chromium");
		} catch (chromiumError) {
			console.warn(
				"⚠️ Failed to launch with @sparticuz/chromium, trying fallback..."
			);
			console.warn("Chromium error:", chromiumError.message);

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
			console.log(
				"✅ Successfully launched browser with fallback configuration"
			);
		}

		const page = await browser.newPage();

		// Set viewport and user agent
		await page.setViewport({ width: 1920, height: 1080 });
		await page.setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
		);

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

		// Wait a bit for dynamic content to load
		//await page.waitForTimeout(2000);

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

		// Add page info - PUPPETEER ENDPOINT
		scrapedData.pageInfo = {
			url: url,
			scrapedAt: new Date().toISOString(),
			userAgent: await page.evaluate(() => navigator.userAgent),
			viewport: await page.viewport(),
			proxyInfo: null, // Proxy support not implemented in this version
		};

		await page.close();

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

		console.log(
			`   🚫 Blocked: ${blockedResources.images} images, ${blockedResources.fonts} fonts, ${blockedResources.stylesheets} stylesheets, ${blockedResources.media} media`
		);

		return c.json({
			success: true,
			data: scrapedData,
			url: url,
			timestamp: new Date().toISOString(),
			proxyUsed: null, // Proxy not supported in this version
			useProxy: false,
			performance: performanceMetrics,
			note: "This endpoint uses Puppeteer with @sparticuz/chromium instead of Playwright",
		});
	} catch (error) {
		console.error("❌ Web scraping error (Puppeteer):", error);

		return c.json(
			{
				success: false,
				error: "Failed to scrape URL using Puppeteer",
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
