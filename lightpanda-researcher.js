"use strict";

/**
 * Lightpanda Researcher
 * ---------------------
 * Takes a user prompt → asks OpenRouter to generate YC/HN search queries →
 * scrapes Hacker News search results with Lightpanda → synthesises a final
 * answer via OpenRouter → prints structured JSON with full metadata.
 *
 * Usage:
 *   OPENROUTER_API_KEY=<key> node lightpanda-researcher.js "best YC companies 2024"
 */

import { lightpanda } from "@lightpanda/browser";
import puppeteer from "puppeteer-core";

const LP_OPTS = { host: "127.0.0.1", port: 9222 };
const MODEL = "google/gemini-2.0-flash-001";

// ── OpenRouter helper ──────────────────────────────────────────────────────────

async function callOpenRouter(messages, { jsonMode = false } = {}) {
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://ihatereading.in",
			"X-Title": "Lightpanda Researcher",
		},
		body: JSON.stringify({
			model: MODEL,
			messages,
			...(jsonMode ? { response_format: { type: "json_object" } } : {}),
		}),
	});
	const data = await res.json();
	if (data.error) throw new Error(`OpenRouter: ${data.error.message}`);
	return {
		text: data.choices?.[0]?.message?.content ?? "",
		usage: {
			promptTokens: data.usage?.prompt_tokens ?? 0,
			completionTokens: data.usage?.completion_tokens ?? 0,
			totalTokens: data.usage?.total_tokens ?? 0,
		},
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

// ── Lightpanda page helper ─────────────────────────────────────────────────────
// Opens a fresh context+page, navigates to url, runs fn(page), fully closes.
// Lightpanda: ONE context at a time, no re-navigation of a live page.

async function withPage(browser, url, fn) {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	try {
		await page.setUserAgent(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		).catch(() => {});
		await page.goto(url, { waitUntil: "load", timeout: 30000 });
		await new Promise((r) => setTimeout(r, 2500));
		return await fn(page);
	} finally {
		await page.close().catch(() => {});
		await context.close().catch(() => {});
	}
}

// ── HN scraper ────────────────────────────────────────────────────────────────

async function scrapeHNSearch(browser, query) {
	const searchUrl = `https://hn.algolia.com/?q=${encodeURIComponent(query)}&type=story`;
	return withPage(browser, searchUrl, async (page) => {
		// Wait for results to appear
		await page.waitForFunction(
			() => document.querySelector(".Story_container, .story") != null,
			{ timeout: 8000 },
		).catch(() => {});

		return page.evaluate((q) => {
			const items = Array.from(
				document.querySelectorAll(".Story_container, .story, article"),
			).slice(0, 10);

			return {
				query: q,
				url: window.location.href,
				results: items.map((row) => {
					const titleEl =
						row.querySelector(".Story_title a, .titleline a, h2 a, a[href]");
					const metaEls = row.querySelectorAll(
						".Story_meta > span:not(.Story_separator, .Story_comment), .subtext span",
					);
					return {
						title: (titleEl?.textContent || "").trim(),
						url: titleEl?.href || titleEl?.getAttribute("href") || "",
						meta: Array.from(metaEls).map((el) => el.textContent.trim()).filter(Boolean),
						snippet: (row.querySelector("p, .comment")?.textContent || "").trim().slice(0, 300),
					};
				}).filter((r) => r.title.length > 0),
			};
		}, query).catch(() => ({ query, url: searchUrl, results: [] }));
	});
}

// ── Main researcher flow ───────────────────────────────────────────────────────

async function research(prompt) {
	const tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	const addUsage = (u) => {
		tokenUsage.promptTokens += u.promptTokens;
		tokenUsage.completionTokens += u.completionTokens;
		tokenUsage.totalTokens += u.totalTokens;
	};

	// ── Step 1: Generate search queries ───────────────────────────────────────
	console.error("[1/4] Generating search queries…");
	const queryGen = await callOpenRouter(
		[
			{
				role: "system",
				content:
					"You are a research assistant specialising in Hacker News and YC content. " +
					"Given a user research prompt, generate 2–4 focused search queries optimised " +
					"for the Algolia HN search (hn.algolia.com). " +
					"Respond ONLY with a JSON object: { \"queries\": [\"query1\", \"query2\", ...] }",
			},
			{ role: "user", content: prompt },
		],
		{ jsonMode: true },
	);
	addUsage(queryGen.usage);

	let queries;
	try {
		queries = parseJsonFromLLM(queryGen.text).queries;
		if (!Array.isArray(queries) || queries.length === 0) throw new Error("empty");
	} catch {
		queries = [prompt];
	}
	console.error(`[1/4] Queries: ${JSON.stringify(queries)}`);

	// ── Step 2: Scrape HN with Lightpanda ─────────────────────────────────────
	console.error("[2/4] Starting Lightpanda…");
	const proc = await lightpanda.serve(LP_OPTS);
	await new Promise((r) => setTimeout(r, 500));
	const browser = await puppeteer.connect({
		browserWSEndpoint: `ws://${LP_OPTS.host}:${LP_OPTS.port}`,
	});

	const scrapedResults = [];
	const scrapedUrls = [];

	try {
		console.error("[3/4] Scraping HN search pages…");
		for (const q of queries) {
			try {
				const result = await scrapeHNSearch(browser, q);
				scrapedResults.push(result);
				scrapedUrls.push(result.url);
				console.error(`    ✓ "${q}" → ${result.results.length} results`);
			} catch (err) {
				console.error(`    ✗ "${q}" failed: ${err.message}`);
				scrapedResults.push({ query: q, url: "", results: [] });
			}
		}
	} finally {
		await browser.disconnect().catch(() => {});
		proc.stdout.destroy();
		proc.stderr.destroy();
		proc.kill();
		console.error("[3/4] Lightpanda stopped.");
	}

	// ── Step 3: Synthesise answer with LLM ────────────────────────────────────
	console.error("[4/4] Synthesising answer…");

	const context = scrapedResults
		.map(({ query, results }) => {
			if (results.length === 0) return `## Query: "${query}"\n_No results found._`;
			const rows = results
				.map(
					(r, i) =>
						`${i + 1}. **${r.title}**\n   URL: ${r.url}\n   Meta: ${r.meta.join(" | ")}\n   ${r.snippet ? `Snippet: ${r.snippet}` : ""}`,
				)
				.join("\n\n");
			return `## Query: "${query}"\n${rows}`;
		})
		.join("\n\n---\n\n");

	const synthesis = await callOpenRouter(
		[
			{
				role: "system",
				content:
					"You are an expert researcher. Using the Hacker News search results provided, " +
					"answer the user's research prompt thoroughly. " +
					"Respond ONLY with a JSON object:\n" +
					"{\n" +
					'  "answer": "<comprehensive markdown answer>",\n' +
					'  "topLinks": [{ "title": "", "url": "", "reason": "" }],\n' +
					'  "keyInsights": ["insight1", "insight2"],\n' +
					'  "limitations": "<what was not found or caveats>"\n' +
					"}",
			},
			{
				role: "user",
				content: `Research prompt: ${prompt}\n\n--- HN Search Results ---\n\n${context}`,
			},
		],
		{ jsonMode: true },
	);
	addUsage(synthesis.usage);

	let synthesised;
	try {
		synthesised = parseJsonFromLLM(synthesis.text);
	} catch {
		synthesised = { answer: synthesis.text, topLinks: [], keyInsights: [], limitations: "" };
	}

	// ── Final output ──────────────────────────────────────────────────────────
	return {
		prompt,
		answer: synthesised.answer ?? "",
		topLinks: synthesised.topLinks ?? [],
		keyInsights: synthesised.keyInsights ?? [],
		limitations: synthesised.limitations ?? "",
		metadata: {
			queriesUsed: queries,
			scrapedUrls,
			scrapedUrlsCount: scrapedUrls.length,
			totalResultsFound: scrapedResults.reduce((n, r) => n + r.results.length, 0),
			model: MODEL,
			tokenUsage,
		},
		rawResults: scrapedResults,
	};
}

// ── CLI entry point ────────────────────────────────────────────────────────────

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
	console.error("Usage: node lightpanda-researcher.js \"your research prompt\"");
	process.exit(1);
}
if (!process.env.OPENROUTER_API_KEY) {
	console.error("Error: OPENROUTER_API_KEY env var is required.");
	process.exit(1);
}

research(prompt)
	.then((result) => {
		console.log(JSON.stringify(result, null, 2));
	})
	.catch((err) => {
		console.error("Fatal:", err.message);
		process.exit(1);
	});
