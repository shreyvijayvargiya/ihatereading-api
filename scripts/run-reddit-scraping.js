#!/usr/bin/env node
/**
 * Scraping / data-collection Reddit monitor — loops every 30s by default.
 * Default: scrape-only. Pass --llm to score with OpenRouter.
 *
 *   npm run reddit:scraping
 *   npm run reddit:scraping -- once
 *   npm run reddit:scraping -- list
 */

import "dotenv/config";
import { getAgent } from "../lib/redditAgents/configs.js";
import { listAgentPosts } from "../lib/redditAgents/core.js";
import { runScrapingProblemsAgent } from "../lib/redditAgents/scrapingProblems.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "run").toLowerCase();
const once =
	args.includes("--once") || cmd === "once" || args.includes("--no-loop");
const skipGoogle = args.includes("--skip-google");
const llm = args.includes("--llm") || args.includes("--enrich");
const intervalMs = Number(process.env.REDDIT_SCRAPING_INTERVAL_MS || 30 * 1000);

async function runOnce() {
	if (llm && !process.env.OPENROUTER_API_KEY?.trim()) {
		console.error("OPENROUTER_API_KEY required with --llm / --enrich");
		process.exit(1);
	}
	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;
	const agent = getAgent("scraping");
	console.log(
		`[scraping] ${agent.subsPerRun} of ${agent.subreddits.length} subs/tick, google=${skipGoogle ? "off" : "on"} llm=${llm ? "on" : "off"} base=${baseUrl}`,
	);
	const summary = await runScrapingProblemsAgent({
		baseUrl,
		skipGoogle,
		...(llm ? { llm: true } : {}),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`Scraping / data-collection Reddit monitor

Default is scrape-only (no OpenRouter). Pass --llm to score.

  npm run reddit:scraping
  npm run reddit:scraping -- once
  npm run reddit:scraping -- --skip-google
  npm run reddit:scraping -- --llm
  npm run reddit:scraping -- list

Looks for scrape problems, data collection, directories/databases via crawl,
AI scraper agents, monitoring agents.
Collection: redditScrapingPosts
HTTP: POST /reddit-agents/scraping/run
      POST /reddit-agents/scraping/run  { "llm": true }

Env:
  REDDIT_SCRAPING_INTERVAL_MS=30000
  REDDIT_SCRAPING_SUBS_PER_RUN=10
  REDDIT_SCRAPING_QUERIES_PER_RUN=3
  SCRAPE_API_BASE_URL=http://localhost:3002
  REDDIT_USE_LLM=1
`);
		process.exit(0);
	}

	if (cmd === "list") {
		const posts = await listAgentPosts("scraping", {
			minScore: 0,
			limit: 50,
		});
		console.log(JSON.stringify({ count: posts.length, posts }, null, 2));
		process.exit(0);
	}

	if (!once) {
		const label =
			intervalMs >= 60_000
				? `${intervalMs / 60000} min`
				: `${intervalMs / 1000} sec`;
		console.log(`[scraping] loop every ${label} (Ctrl+C stop)`);
		for (;;) {
			const started = Date.now();
			try {
				await runOnce();
			} catch (err) {
				console.error("[scraping] run failed:", err?.message || err);
			}
			const elapsed = Date.now() - started;
			console.log(
				`[scraping] sleeping ${intervalMs / 1000}s (last run ${Math.round(elapsed / 1000)}s)…`,
			);
			await new Promise((r) => setTimeout(r, intervalMs));
		}
		return;
	}

	await runOnce();
}

main().catch((err) => {
	console.error("[scraping] fatal:", err?.message || err);
	process.exit(1);
});
