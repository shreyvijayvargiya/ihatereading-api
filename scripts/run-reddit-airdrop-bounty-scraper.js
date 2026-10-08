#!/usr/bin/env node
/**
 * Reddit → AirdropBounty topic scraper CLI.
 *
 *   npm run reddit:airdrop-bounty
 *   npm run reddit:airdrop-bounty -- --site airdropbounty-events --limit 20
 *   npm run reddit:airdrop-bounty -- --loop
 */

import "dotenv/config";
import { hasOpenRouterKey } from "../lib/useAi.js";
import { resolveResearchBaseUrl } from "../lib/contentResearch/http.js";
import { runRedditAirdropBountyScraper } from "../lib/content/services/reddit-airdrop-scraper.js";

const args = process.argv.slice(2);
const hasLoop = args.includes("--loop");
const intervalMs = Number(process.env.REDDIT_AIRDROP_INTERVAL_MS || 600_000);

function flag(name) {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

const baseUrl =
	process.env.SCRAPE_API_BASE_URL ||
	process.env.INKGEST_SCRAPE_BASE_URL ||
	`http://127.0.0.1:${process.env.PORT || 3002}`;

async function runOnce() {
	if (!hasOpenRouterKey()) {
		console.error("OPENROUTER_API_KEY is required");
		process.exit(1);
	}

	const siteId = flag("--site") || flag("--siteId") || "airdropbounty-events";
	const limit = Number(flag("--limit") || 20);

	console.log(
		`[reddit-airdrop] site=${siteId} limit=${limit} base=${baseUrl}`,
	);

	const summary = await runRedditAirdropBountyScraper(siteId, {
		baseUrl,
		limit,
		llm: !args.includes("--no-llm"),
		refreshContent: !args.includes("--no-refresh"),
	});

	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`Reddit AirdropBounty topic scraper

  npm run reddit:airdrop-bounty
  npm run reddit:airdrop-bounty -- --site airdropbounty-events --limit 20
  npm run reddit:airdrop-bounty -- --loop

Options:
  --site <id>       Firestore site id (default: airdropbounty-events)
  --limit <n>       Max topics to discover (default: 20)
  --no-llm          Skip LLM scoring on RSS posts (still uses LLM for queries/topics)
  --no-refresh      Skip refreshing site content cache
  --loop            Repeat every REDDIT_AIRDROP_INTERVAL_MS (default 10m; RSS pacing via REDDIT_RSS_MIN_INTERVAL_MS=10s)

HTTP:
  POST /reddit-airdrop-bounty-scraper
  { "siteId": "airdropbounty-events", "limit": 20 }
`);
		return;
	}

	if (!hasLoop) {
		await runOnce();
		return;
	}

	console.log(`[reddit-airdrop] loop every ${intervalMs / 1000}s (Ctrl+C to stop)`);
	for (;;) {
		try {
			await runOnce();
		} catch (err) {
			console.error("[reddit-airdrop]", err?.message || err);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
