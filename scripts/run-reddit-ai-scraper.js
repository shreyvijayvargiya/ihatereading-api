#!/usr/bin/env node
/**
 * Generic Reddit scraper — prompt chooses the topic (no hardcoded subs).
 * Default: scrape-only (Google + RSS, no OpenRouter). Pass --llm to plan/score.
 *
 *   npm run reddit:ai-scraper -- --prompt "people looking for scrapers and data collection"
 *   npm run reddit:ai-scraper -- once --prompt "..." --llm
 *   npm run reddit:ai-scraper -- list
 *   npm run reddit:ai-scraper -- topics
 */

import "dotenv/config";
import { REDDIT_AI_SCRAPER } from "../lib/redditAiScraper/configs.js";
import {
	listAiScraperPosts,
	listAiScraperTopics,
	runRedditAiScraper,
} from "../lib/redditAiScraper/orchestrator.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "run").toLowerCase();
const once =
	args.includes("--once") || cmd === "once" || args.includes("--no-loop");
const skipGoogle = args.includes("--skip-google");
const rediscover = args.includes("--rediscover");
const llm = args.includes("--llm") || args.includes("--enrich");

function flag(name) {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

const prompt =
	flag("--prompt") ||
	process.env.REDDIT_AI_SCRAPER_PROMPT ||
	"";
const intervalMs = Number(process.env.REDDIT_AI_SCRAPER_INTERVAL_MS || 30 * 1000);

async function runOnce() {
	if (llm && !process.env.OPENROUTER_API_KEY?.trim()) {
		console.error("OPENROUTER_API_KEY required with --llm / --enrich");
		process.exit(1);
	}
	if (!String(prompt).trim()) {
		console.error('Missing --prompt "your research goal" (or REDDIT_AI_SCRAPER_PROMPT)');
		process.exit(1);
	}
	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;
	console.log(
		`[reddit-ai-scraper] llm=${llm ? "on" : "off"} prompt=${JSON.stringify(prompt).slice(0, 80)}`,
	);
	const summary = await runRedditAiScraper({
		prompt,
		baseUrl,
		skipGoogle,
		rediscover,
		...(llm ? { llm: true } : {}),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`Reddit scraper — one agent for any topic

Default is scrape-only: Google site:reddit.com + RSS (no OpenRouter).
Pass --llm to plan queries/subs and score posts.

  npm run reddit:ai-scraper -- --prompt "find scraping / data-collection problems"
  npm run reddit:ai-scraper -- once --prompt "..."
  npm run reddit:ai-scraper -- --prompt "..." --llm
  npm run reddit:ai-scraper -- --rediscover --prompt "..."
  npm run reddit:ai-scraper -- topics
  npm run reddit:ai-scraper -- list --topic scraping-data-collection

First scrape-only run needs Google (omit --skip-google) to discover subreddits.
Later runs reuse the saved topic and RSS-rotate.

Stores into ${REDDIT_AI_SCRAPER.collection}

HTTP: POST /reddit-ai-scraper/run  { "prompt": "..." }
      POST /reddit-ai-scraper/run  { "prompt": "...", "llm": true }

Env:
  REDDIT_AI_SCRAPER_PROMPT=...
  REDDIT_AI_SCRAPER_INTERVAL_MS=30000
  REDDIT_AI_SCRAPER_SUBS_PER_RUN=10
  REDDIT_AI_SCRAPER_MAX_SUBS=20
  REDDIT_USE_LLM=1
`);
		process.exit(0);
	}

	if (cmd === "topics") {
		const topics = await listAiScraperTopics(50);
		console.log(JSON.stringify({ count: topics.length, topics }, null, 2));
		process.exit(0);
	}

	if (cmd === "list") {
		const posts = await listAiScraperPosts({
			topicId: flag("--topic"),
			minScore: 0,
			limit: 50,
		});
		console.log(JSON.stringify({ count: posts.length, posts }, null, 2));
		process.exit(0);
	}

	const shouldLoop = !once && cmd !== "once";
	if (shouldLoop) {
		const label =
			intervalMs >= 60_000
				? `${intervalMs / 60000} min`
				: `${intervalMs / 1000} sec`;
		console.log(`[reddit-ai-scraper] loop every ${label} (Ctrl+C stop)`);
		for (;;) {
			const started = Date.now();
			try {
				await runOnce();
			} catch (err) {
				console.error("[reddit-ai-scraper] run failed:", err?.message || err);
			}
			const elapsed = Date.now() - started;
			console.log(
				`[reddit-ai-scraper] sleeping ${intervalMs / 1000}s (last run ${Math.round(elapsed / 1000)}s)…`,
			);
			await new Promise((r) => setTimeout(r, intervalMs));
		}
		return;
	}

	await runOnce();
}

main().catch((err) => {
	console.error("[reddit-ai-scraper] fatal:", err?.message || err);
	process.exit(1);
});
