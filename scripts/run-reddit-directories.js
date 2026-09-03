#!/usr/bin/env node
/**
 * Directory / aggregator Reddit ideas — loops every 30s by default.
 * Default: scrape-only. Pass --llm to score with OpenRouter.
 *
 *   npm run reddit:directories
 *   npm run reddit:directories -- once
 *   npm run reddit:directories -- list
 */

import "dotenv/config";
import { getAgent } from "../lib/redditAgents/configs.js";
import { listAgentPosts } from "../lib/redditAgents/core.js";
import { runDirectoryIdeasAgent } from "../lib/redditAgents/directoryIdeas.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "run").toLowerCase();
const once =
	args.includes("--once") || cmd === "once" || args.includes("--no-loop");
const skipGoogle = args.includes("--skip-google");
const llm = args.includes("--llm") || args.includes("--enrich");
const intervalMs = Number(process.env.REDDIT_DIRECTORIES_INTERVAL_MS || 30 * 1000);

async function runOnce() {
	if (llm && !process.env.OPENROUTER_API_KEY?.trim()) {
		console.error("OPENROUTER_API_KEY required with --llm / --enrich");
		process.exit(1);
	}
	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;
	const agent = getAgent("directories");
	console.log(
		`[directories] ${agent.subsPerRun} subs/tick, google=${skipGoogle ? "off" : "on"} llm=${llm ? "on" : "off"} base=${baseUrl}`,
	);
	const summary = await runDirectoryIdeasAgent({
		baseUrl,
		skipGoogle,
		...(llm ? { llm: true } : {}),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`Directory / aggregator idea finder (Reddit)

Default is scrape-only (no OpenRouter). Pass --llm to score.

  npm run reddit:directories
  npm run reddit:directories -- once
  npm run reddit:directories -- --skip-google
  npm run reddit:directories -- --llm
  npm run reddit:directories -- list

Looks for posts asking for collections, alternatives, directories, datasets (Kaggle-style).
Collection: redditDirectoryPosts
HTTP: POST /reddit-agents/directories/run
      POST /reddit-agents/directories/run  { "llm": true }

Env:
  REDDIT_DIRECTORIES_INTERVAL_MS=30000
  REDDIT_DIRECTORIES_SUBS_PER_RUN=10
  REDDIT_DIRECTORIES_QUERIES_PER_RUN=3
  SCRAPE_API_BASE_URL=http://localhost:3002   (Google discovery)
  REDDIT_USE_LLM=1                            (same as --llm)
`);
		process.exit(0);
	}

	if (cmd === "list") {
		const posts = await listAgentPosts("directories", {
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
		console.log(`[directories] loop every ${label} (Ctrl+C stop)`);
		for (;;) {
			const started = Date.now();
			try {
				await runOnce();
			} catch (err) {
				console.error("[directories] run failed:", err?.message || err);
			}
			const elapsed = Date.now() - started;
			console.log(
				`[directories] sleeping ${intervalMs / 1000}s (last run ${Math.round(elapsed / 1000)}s)…`,
			);
			await new Promise((r) => setTimeout(r, intervalMs));
		}
		return;
	}

	await runOnce();
}

main().catch((err) => {
	console.error("[directories] fatal:", err?.message || err);
	process.exit(1);
});
