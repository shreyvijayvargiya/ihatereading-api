/**
 * Inkgest Browser Agent — Puppeteer-powered headless browser for dynamic SPAs.
 * Trail-based ReAct loop: observe → LLM decision → execute → log → repeat.
 * Used when planner determines a URL is a dynamic SPA (React, npm.com, LinkedIn, etc.).
 */

import { Hono } from "hono";
import { z } from "zod";
import puppeteer from "puppeteer";
import { firestore } from "../config/firebase.js";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import crypto from "crypto";

// --- Zod Schemas ---

const BrowserAgentInput = z.object({
	url: z.string().url(),
	goal: z.string().min(1).max(500),
	maxDepth: z.number().min(1).max(10).default(5),
});

const BrowserAgentOutput = z.object({
	data: z.record(z.unknown()),
	trail: z.array(
		z.object({
			step: z.number(),
			action: z.string(),
			target: z.string().optional(),
			value: z.string().optional(),
			reasoning: z.string(),
			result: z.string(),
			extractedData: z.unknown().optional(),
		}),
	),
	stepsUsed: z.number(),
	goalAchieved: z.boolean(),
	partial: z.boolean(),
});

const LLMActionDecision = z.object({
	action: z.enum(["navigate", "click", "type", "scroll", "extract", "done"]),
	target: z.string().optional(),
	value: z.string().optional(),
	reasoning: z.string(),
	goalAchieved: z.boolean(),
	extractedData: z.record(z.unknown()).optional(),
});

// --- Concurrency Semaphore ---

let activeBrowserSessions = 0;
const MAX_BROWSER_SESSIONS = 2;

async function acquireBrowserSlot(timeoutMs = 30000) {
	const start = Date.now();
	while (activeBrowserSessions >= MAX_BROWSER_SESSIONS) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(
				"Browser agent rate limit: max 2 concurrent sessions. Try again in a moment.",
			);
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	activeBrowserSessions++;
}

function releaseBrowserSlot() {
	activeBrowserSessions = Math.max(0, activeBrowserSessions - 1);
}

// --- Scrape API (use existing index.js /scrape endpoint) ---

function getScrapeApiBase() {
	return (
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://localhost:${process.env.PORT || 3001}`
	);
}

/**
 * Fetch scraped content for a URL using the existing /scrape endpoint.
 * Returns { markdown, data } or null on failure.
 */
async function fetchScrapedContent(url, timeoutMs = 20000) {
	const base = getScrapeApiBase().replace(/\/$/, "");
	try {
		const res = await fetch(`${base}/scrape`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				url,
				includeSemanticContent: true,
				includeLinks: true,
				includeImages: false,
				extractMetadata: true,
				timeout: Math.min(timeoutMs, 30000),
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const json = await res.json().catch(() => ({}));
		if (!res.ok || !json.success) {
			return null;
		}
		return {
			markdown: json.markdown ?? json.data?.semanticContent ?? "",
			data: json.data ?? {},
			summary: json.summary ?? null,
		};
	} catch {
		return null;
	}
}

// --- Helpers ---

function generateJobId() {
	return crypto.randomBytes(12).toString("base64url").slice(0, 12);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function llm(messages, { maxTokens = 1000, temperature = 0.2 } = {}) {
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
		},
		body: JSON.stringify({
			model: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
			messages,
			temperature,
			max_tokens: maxTokens,
			response_format: { type: "json_object" },
		}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data?.error?.message || `OpenRouter ${res.status}`);
	}
	return {
		content: data?.choices?.[0]?.message?.content || "",
		tokensUsed: data?.usage?.total_tokens || 0,
	};
}

async function isCancelled(jobId) {
	const doc = await firestore
		.collection("browserAgentJobs")
		.doc(jobId)
		.get();
	return doc.data()?.status === "cancelled";
}

async function appendTrailStep(jobId, trailStep) {
	await firestore
		.collection("browserAgentJobs")
		.doc(jobId)
		.update({
			trail: FieldValue.arrayUnion({
				...trailStep,
				timestamp: Timestamp.now(),
			}),
		});
}

// --- DOM Snapshot ---

async function extractDomSnapshot(page) {
	return await page.evaluate(() => {
		const MAX_CHARS = 2500;
		const parts = [];

		parts.push(`TITLE: ${document.title}`);

		document.querySelectorAll("input, textarea, select").forEach((el) => {
			const label =
				el.getAttribute("placeholder") ||
				el.getAttribute("aria-label") ||
				el.getAttribute("name") ||
				"input";
			parts.push(
				`INPUT[${el.tagName.toLowerCase()}] placeholder="${String(label).slice(0, 50)}"`,
			);
		});

		document
			.querySelectorAll("button, [role='button'], a[href]")
			.forEach((el) => {
				const text = el.innerText?.trim().slice(0, 50);
				if (text) parts.push(`BUTTON/LINK: "${text}"`);
			});

		document.querySelectorAll("h1, h2, h3").forEach((el) => {
			parts.push(
				`HEADING: ${el.innerText?.trim().slice(0, 100)}`,
			);
		});

		const mainText = document.body.innerText?.trim().slice(0, 800);
		if (mainText) parts.push(`CONTENT PREVIEW:\n${mainText}`);

		return parts.join("\n").slice(0, MAX_CHARS);
	});
}

// --- Execute Action ---

/**
 * Execute one agent action. Returns either a result string or
 * { result, scrapedContent } for navigate (so we can feed /scrape content to the LLM).
 */
async function executeAction(page, decision) {
	try {
		switch (decision.action) {
			case "navigate": {
				await page.goto(decision.target, {
					waitUntil: "networkidle2",
					timeout: 15000,
				});
				const scraped = await fetchScrapedContent(decision.target, 20000);
				return {
					result: "navigated successfully",
					scrapedContent: scraped,
				};
			}

			case "click":
				await page.waitForSelector(decision.target, { timeout: 5000 });
				await page.click(decision.target);
				await sleep(1000);
				return "clicked successfully";

			case "type":
				await page.waitForSelector(decision.target, { timeout: 5000 });
				await page.click(decision.target);
				await page.type(decision.target, decision.value || "", {
					delay: 50,
				});
				await page.keyboard.press("Enter");
				await sleep(2000);
				return `typed "${decision.value}" and submitted`;

			case "scroll":
				if (decision.target === "window") {
					await page.evaluate(() => window.scrollBy(0, 800));
				} else {
					await page.evaluate((sel) => {
						document.querySelector(sel)?.scrollIntoView();
					}, decision.target || "body");
				}
				await sleep(1000);
				return "scrolled";

			case "extract": {
				let rawText = "";
				if (decision.target && decision.target !== "page") {
					rawText = await page
						.evaluate((sel) => {
							return document.querySelector(sel)?.innerText || "";
						}, decision.target)
						.catch(() => "");
				}
				return `extracted data${rawText ? ` (${rawText.slice(0, 100)}...)` : ""}`;
			}

			case "done":
				return "goal achieved";

			default:
				return "unknown action";
		}
	} catch (err) {
		return `action failed: ${err.message}`;
	}
}

// --- ReAct Loop ---

async function runBrowserAgentLoop(page, input, jobId) {
	const trail = [];
	let totalTokensUsed = 0;
	let mergedData = {};
	let stepsUsed = 0;
	let goalAchieved = false;
	const stuckCounter = {};
	/** Scraped content for current page (from /scrape API), used in LLM context */
	let currentScrapedContent = null;

	// Step 0: initial navigation + scrape content via /scrape API
	try {
		await page.goto(input.url, {
			waitUntil: "networkidle2",
			timeout: 15000,
		});
	} catch (err) {
		trail.push({
			step: 0,
			action: "navigate",
			target: input.url,
			result: `navigation failed: ${err.message}`,
			reasoning: "Initial navigation",
			error: true,
		});
		if (jobId) await appendTrailStep(jobId, trail[0]);
		return {
			data: mergedData,
			trail,
			stepsUsed: 0,
			goalAchieved: false,
			partial: true,
			tokensUsed: 0,
		};
	}

	// Fetch scraped content for initial URL using /scrape endpoint
	const initialScraped = await fetchScrapedContent(input.url, 20000);
	currentScrapedContent = initialScraped;
	const scrapedPreview = initialScraped?.markdown
		? initialScraped.markdown.slice(0, 500) + (initialScraped.markdown.length > 500 ? "..." : "")
		: null;

	trail.push({
		step: 0,
		action: "navigate",
		target: input.url,
		result: "navigated",
		reasoning: "Initial navigation",
		scrapedContentPreview: scrapedPreview,
		scrapeOk: !!initialScraped,
	});
	if (jobId) await appendTrailStep(jobId, trail[0]);

	for (let step = 1; step <= input.maxDepth; step++) {
		stepsUsed = step;

		// 1. Check cancellation (only when running as HTTP job)
		if (jobId && (await isCancelled(jobId))) {
			break;
		}

		// 2. Get page state
		const currentUrl = await page.url();
		const pageTitle = await page.title();
		const domSnapshot = await extractDomSnapshot(page);

		// 3. Trail summary (last 5 steps)
		const trailSummary = trail
			.slice(-5)
			.map(
				(s) =>
					`Step ${s.step}: ${s.action} on "${s.target || ""}" → ${s.result}`,
			)
			.join("\n");

		// Scraped page content for LLM (from /scrape API)
		const scrapedSection = currentScrapedContent?.markdown
			? `\nScraped page content (from /scrape API):\n${currentScrapedContent.markdown.slice(0, 3500)}${currentScrapedContent.markdown.length > 3500 ? "\n..." : ""}`
			: "";

		// 4. LLM decision
		let content = "";
		let tokensUsed = 0;
		try {
			const llmRes = await llm(
				[
					{
						role: "system",
						content: `You are a browser control agent. Your goal is: "${input.goal}"

Decide the SINGLE next action to take based on the current page state.

Available actions:
- navigate: go to a URL (target = full URL)
- click: click an element (target = CSS selector)
- type: type text into an input (target = CSS selector, value = text to type)
- scroll: scroll down to load more content (target = "window" or CSS selector)
- extract: extract data from current page into structured JSON (target = CSS selector or "page", extractedData = the data)
- done: goal is fully achieved, no more actions needed

Rules:
- Prefer extract when you can see the data you need
- Use scroll when results might be paginated or lazy-loaded
- Use navigate only when you need to go to a completely different page
- If you've tried the same action+target 3 times, try something different
- goalAchieved = true ONLY when you have successfully extracted all needed data

Respond with valid JSON only matching this schema:
{ action, target?, value?, reasoning, goalAchieved, extractedData? }`,
					},
					{
						role: "user",
						content: `Current URL: ${currentUrl}
Page title: ${pageTitle}
${scrapedSection}

Recent trail:
${trailSummary}

Current page DOM snapshot:
${domSnapshot}`,
					},
				],
				{ maxTokens: 600, temperature: 0.2 },
			);
			content = llmRes.content;
			tokensUsed = llmRes.tokensUsed;
		} catch (err) {
			trail.push({
				step: stepsUsed,
				action: "llm_error",
				reasoning: err.message,
				result: "skipping step",
			});
			if (jobId) await appendTrailStep(jobId, trail[trail.length - 1]);
			continue;
		}

		totalTokensUsed += tokensUsed;

		// 5. Parse decision
		let decision;
		try {
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
			decision = LLMActionDecision.parse(parsed);
		} catch {
			trail.push({
				step: stepsUsed,
				action: "parse_error",
				reasoning: "LLM response could not be parsed",
				result: "skipping step",
			});
			if (jobId) await appendTrailStep(jobId, trail[trail.length - 1]);
			continue;
		}

		// 6. Stuck detection
		const stuckKey = `${decision.action}:${decision.target || ""}`;
		stuckCounter[stuckKey] = (stuckCounter[stuckKey] || 0) + 1;
		if (stuckCounter[stuckKey] >= 3) {
			trail.push({
				step: stepsUsed,
				action: "stuck_detected",
				reasoning: "Same action repeated 3 times",
				result: "breaking loop",
			});
			if (jobId) await appendTrailStep(jobId, trail[trail.length - 1]);
			break;
		}

		// 7. Execute action
		const actionResultRaw = await executeAction(page, decision);
		const resultText =
			typeof actionResultRaw === "string"
				? actionResultRaw
				: actionResultRaw.result;
		const scrapedFromAction =
			typeof actionResultRaw === "object" && actionResultRaw?.scrapedContent != null
				? actionResultRaw.scrapedContent
				: null;
		if (scrapedFromAction) currentScrapedContent = scrapedFromAction;

		// 8. Merge extracted data
		if (decision.action === "extract" && decision.extractedData) {
			mergedData = { ...mergedData, ...decision.extractedData };
		}

		// 9. Log to trail
		const trailStep = {
			step: stepsUsed,
			action: decision.action,
			target: decision.target,
			value: decision.value,
			reasoning: decision.reasoning,
			result: resultText,
			extractedData: decision.extractedData || null,
		};
		if (decision.action === "navigate" && scrapedFromAction?.markdown) {
			trailStep.scrapedContentPreview = scrapedFromAction.markdown.slice(0, 500);
			trailStep.scrapeOk = true;
		}
		trail.push(trailStep);

		// 10. Append to Firestore
		if (jobId) await appendTrailStep(jobId, trailStep);

		// 11. Check if done
		if (decision.goalAchieved || decision.action === "done") {
			goalAchieved = true;
			break;
		}

		await sleep(500);
	}

	return {
		data: mergedData,
		trail,
		stepsUsed,
		goalAchieved,
		partial: !goalAchieved,
		tokensUsed: totalTokensUsed,
	};
}

// --- Run Job (background) ---

async function runJob(jobId, input) {
	const startTime = Date.now();
	let browser;

	try {
		await firestore.collection("browserAgentJobs").doc(jobId).update({
			status: "running",
			startedAt: Timestamp.now(),
		});

		await acquireBrowserSlot();

		browser = await puppeteer.launch({
			headless: true,
			args: ["--no-sandbox", "--disable-setuid-sandbox"],
		});

		const page = await browser.newPage();
		const result = await runBrowserAgentLoop(page, input, jobId);

		await page.close();

		const timeMs = Date.now() - startTime;

		const output = {
			data: result.data,
			trail: result.trail,
			stepsUsed: result.stepsUsed,
			goalAchieved: result.goalAchieved,
			partial: result.partial,
		};

		const validated = BrowserAgentOutput.safeParse(output);
		const finalResult = validated.success
			? validated.data
			: { ...output, partial: true };

		await firestore.collection("browserAgentJobs").doc(jobId).update({
			status: "completed",
			result: finalResult,
			completedAt: Timestamp.now(),
			timeMs,
			tokensUsed: result.tokensUsed,
		});
	} catch (err) {
		await firestore.collection("browserAgentJobs").doc(jobId).update({
			status: "failed",
			error: err.message,
			completedAt: Timestamp.now(),
		});
	} finally {
		if (browser) {
			try {
				await browser.close();
			} catch {}
		}
		releaseBrowserSlot();
	}
}

// --- Exported Skill (for InkgestAgent DAG) ---

export async function browserAgentSkill(input) {
	const parsed = BrowserAgentInput.parse(input);
	await acquireBrowserSlot();
	let browser;

	try {
		browser = await puppeteer.launch({
			headless: true,
			args: ["--no-sandbox", "--disable-setuid-sandbox"],
		});

		const page = await browser.newPage();
		const result = await runBrowserAgentLoop(page, parsed, null);

		await page.close();

		const output = {
			data: result.data,
			trail: result.trail,
			stepsUsed: result.stepsUsed,
			goalAchieved: result.goalAchieved,
			partial: result.partial,
		};

		const validated = BrowserAgentOutput.safeParse(output);
		return validated.success ? validated.data : { ...output, partial: true };
	} finally {
		if (browser) {
			try {
				await browser.close();
			} catch {}
		}
		releaseBrowserSlot();
	}
}

// --- Hono Router ---
export const browserAgentRouter = new Hono();

function sseEvent(event, data) {
	return `data: ${JSON.stringify({ event, ...data })}\n\n`;
}

// TODO: verify Firebase ID token from Authorization header
// const uid = await verifyFirebaseToken(c.req.header("Authorization")?.replace("Bearer ", ""))
// For now: accept all requests

browserAgentRouter.post("/execute", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const parsed = BrowserAgentInput.safeParse(body);
		if (!parsed.success) {
			return c.json(
				{ error: "Invalid input", details: parsed.error.flatten() },
				400,
			);
		}

		const jobId = generateJobId();
		const input = parsed.data;

		await firestore.collection("browserAgentJobs").doc(jobId).set({
			jobId,
			status: "queued",
			input: {
				url: input?.url,
				goal: input?.goal,
				maxDepth: input?.maxDepth,
			},
			trail: [],
			result: null,
			error: null,
			tokensUsed: 0,
			timeMs: 0,
			createdAt: Timestamp.now(),
			startedAt: null,
			completedAt: null,
			cancelledAt: null,
		});

		runJob(jobId, input).catch((err) => {
			console.error("[browser-agent] runJob error:", err);
		});

		return c.json({ jobId, status: "queued" });
	} catch (err) {
		return c.json({ error: err.message }, 500);
	}
});

browserAgentRouter.get("/execute/:jobId/stream", async (c) => {
	const jobId = c.req.param("jobId");
	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const write = (text) => controller.enqueue(encoder.encode(text));

			let lastTrailLength = 0;
			let lastStatus = null;
			const startTime = Date.now();
			const TIMEOUT_MS = 5 * 60 * 1000;

			const poll = async () => {
				if (Date.now() - startTime > TIMEOUT_MS) {
					write(sseEvent("timeout", {}));
					controller.close();
					return;
				}

				const doc = await firestore
					.collection("browserAgentJobs")
					.doc(jobId)
					.get();

				if (!doc.exists) {
					write(sseEvent("error", { error: "Job not found" }));
					controller.close();
					return;
				}

				const data = doc.data();
				const status = data?.status || "unknown";
				const trail = data?.trail || [];

				if (status !== lastStatus) {
					write(sseEvent("status_changed", { status }));
					lastStatus = status;
				}

				if (trail.length > lastTrailLength) {
					for (let i = lastTrailLength; i < trail.length; i++) {
						write(sseEvent("trail_step", { step: trail[i] }));
					}
					lastTrailLength = trail.length;
				}

				if (status === "completed") {
					write(sseEvent("completed", { result: data.result }));
					controller.close();
					return;
				}
				if (status === "failed") {
					write(
						sseEvent("failed", {
							error: data.error || "Unknown error",
						}),
					);
					controller.close();
					return;
				}
				if (status === "cancelled") {
					write(sseEvent("cancelled"));
					controller.close();
					return;
				}

				setTimeout(poll, 800);
			};

			poll();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
});

browserAgentRouter.get("/execute/:jobId", async (c) => {
	const jobId = c.req.param("jobId");
	const doc = await firestore
		.collection("browserAgentJobs")
		.doc(jobId)
		.get();

	if (!doc.exists) {
		return c.json({ error: "Job not found" }, 404);
	}

	const data = doc.data();
	return c.json({
		jobId: data.jobId,
		status: data.status,
		input: data.input,
		trail: data.trail,
		result: data.result,
		error: data.error,
		tokensUsed: data.tokensUsed,
		timeMs: data.timeMs,
		createdAt: data.createdAt?.toMillis?.(),
		startedAt: data.startedAt?.toMillis?.(),
		completedAt: data.completedAt?.toMillis?.(),
	});
});

browserAgentRouter.patch("/execute/:jobId/cancel", async (c) => {
	const jobId = c.req.param("jobId");
	const doc = await firestore
		.collection("browserAgentJobs")
		.doc(jobId)
		.get();

	if (!doc.exists) {
		return c.json({ error: "Job not found" }, 404);
	}

	const status = doc.data()?.status;
	if (status === "completed" || status === "failed" || status === "cancelled") {
		return c.json({ error: `Job already ${status}` }, 400);
	}

	await firestore.collection("browserAgentJobs").doc(jobId).update({
		status: "cancelled",
		cancelledAt: Timestamp.now(),
	});

	return c.json({ jobId, status: "cancelled" });
});
