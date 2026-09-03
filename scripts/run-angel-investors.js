#!/usr/bin/env node
/**
 * Angel / seed investor agent CLI.
 *
 * Usage:
 *   npm run angel:investors
 *   npm run angel:investors -- --platform x
 *   npm run angel:investors -- --loop
 *   npm run angel:investors -- list
 *   npm run angel:investors -- queries
 */

import "dotenv/config";
import { ANGEL_AGENT, ALL_QUERIES } from "../lib/angelInvestors/configs.js";
import {
	listInvestors,
	runAngelInvestorsAgent,
} from "../lib/angelInvestors/orchestrator.js";
import { cliWantsUseAi, hasOpenRouterKey, useAiOpts } from "../lib/useAi.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "run").toLowerCase();

function flag(name) {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

const hasLoop = args.includes("--loop");
const useAI = cliWantsUseAi(args);
const platform = flag("--platform");
const queriesPerRun = flag("--queries") ? Number(flag("--queries")) : undefined;
const intervalMs = Number(process.env.ANGEL_INTERVAL_MS || 30 * 1000);

async function runOnce() {
	if (useAI && !hasOpenRouterKey()) {
		console.error("OPENROUTER_API_KEY required with --use-ai");
		process.exit(1);
	}
	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;

	console.log(
		`[angel-cli] angel-seed — platform=${platform || "all"} llm=${useAI ? "on" : "off"} base=${baseUrl}`,
	);
	const summary = await runAngelInvestorsAgent({
		baseUrl,
		platform,
		queriesPerRun,
		enrich: !args.includes("--no-enrich"),
		...useAiOpts(useAI),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`Angel / seed investor agent

Default is scrape-only. Pass --use-ai to score with OpenRouter.

  npm run angel:investors
  npm run angel:investors -- --use-ai
  npm run angel:investors -- --platform x
  npm run angel:investors -- --platform linkedin --queries 2
  npm run angel:investors -- --loop
  npm run angel:investors -- list
  npm run angel:investors -- list --platform google
  npm run angel:investors -- queries

Env:
  ANGEL_QUERIES_PER_RUN=3
  ANGEL_ENRICH_PER_RUN=8
  ANGEL_INTERVAL_MS=30000   (30 sec loop default)
  USE_AI=1
  SCRAPE_API_BASE_URL=http://localhost:3002  (needs /google-search + /scrape)

Collection: ${ANGEL_AGENT.collection}
`);
		process.exit(0);
	}

	if (cmd === "queries") {
		let qs = ALL_QUERIES;
		if (platform) qs = qs.filter((q) => q.platform === platform);
		console.log(JSON.stringify({ count: qs.length, queries: qs }, null, 2));
		process.exit(0);
	}

	if (cmd === "list") {
		const investors = await listInvestors(ANGEL_AGENT.collection, {
			minScore: 0,
			platform,
			limit: 50,
		});
		console.log(JSON.stringify({ count: investors.length, investors }, null, 2));
		process.exit(0);
	}

	if (hasLoop || cmd === "run") {
		if (hasLoop) {
			const label =
				intervalMs >= 60_000
					? `${intervalMs / 60000} min`
					: `${intervalMs / 1000} sec`;
			console.log(`[angel-cli] loop every ${label} (Ctrl+C to stop)`);
			for (;;) {
				try {
					await runOnce();
				} catch (err) {
					console.error("[angel-cli] run failed:", err?.message || err);
				}
				await new Promise((r) => setTimeout(r, intervalMs));
			}
		}
		await runOnce();
		return;
	}

	await runOnce();
}

main().catch((err) => {
	console.error("[angel-cli] fatal:", err?.message || err);
	process.exit(1);
});
