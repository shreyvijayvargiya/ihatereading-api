#!/usr/bin/env node
/**
 * Enrich existing ai-styles-prompts docs (4 at a time, every 10s, until last).
 *
 *   npm run ai:styles:enrich
 *   npm run ai:styles:enrich:once
 *   npm run ai:styles:enrich -- --reset
 */

import "dotenv/config";
import {
	AI_STYLES_AGENT,
	AI_STYLES_ENRICH,
} from "../lib/aiStylesPrompts/configs.js";
import {
	loadEnrichState,
	runAiStylesEnrichAgent,
} from "../lib/aiStylesPrompts/enrich.js";
import { cliWantsUseAi, hasOpenRouterKey, useAiOpts } from "../lib/useAi.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "run").toLowerCase();

function flag(name) {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

const once =
	args.includes("--once") || cmd === "once" || args.includes("--no-loop");
const useAI = cliWantsUseAi(args);
const reset = args.includes("--reset") || cmd === "reset";
const batch = flag("--batch") ? Number(flag("--batch")) : undefined;
const intervalMs = Number(
	process.env.AI_STYLES_ENRICH_INTERVAL_MS || AI_STYLES_ENRICH.intervalMs || 10_000,
);

async function runOnce(opts = {}) {
	if (useAI && !hasOpenRouterKey()) {
		console.error("[ai-styles:enrich] OPENROUTER_API_KEY required with --use-ai");
		process.exit(1);
	}
	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;
	console.log(
		`[ai-styles:enrich] collection=${AI_STYLES_AGENT.collection} batch=${batch || AI_STYLES_ENRICH.batchSize} llm=${useAI ? "on" : "off"} base=${baseUrl}`,
	);
	const summary = await runAiStylesEnrichAgent({
		baseUrl,
		batch,
		reset: opts.reset === true,
		...useAiOpts(useAI),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`AI styles enrich — walk Firestore ${AI_STYLES_AGENT.collection}

Default Google+scrape only. Pass --use-ai for LLM plan/merge.

  npm run ai:styles:enrich
  npm run ai:styles:enrich:once
  npm run ai:styles:enrich -- --use-ai
  npm run ai:styles:enrich -- --reset
  npm run ai:styles:enrich -- once --batch 4
  npm run ai:styles:enrich -- status

Each tick loads 4 docs, Google-searches + scrapes to fill missing keys,
updates values, drops duplicates, can delete junk or add related Refero styles.
Loops every 10s until the last document, then exits.

Env:
  AI_STYLES_ENRICH_INTERVAL_MS=10000
  AI_STYLES_ENRICH_BATCH=4
  OPENROUTER_API_KEY
  SCRAPE_API_BASE_URL=http://localhost:3002
`);
		process.exit(0);
	}

	if (cmd === "status") {
		const state = await loadEnrichState();
		console.log(
			JSON.stringify(
				{
					collection: AI_STYLES_AGENT.collection,
					batchSize: AI_STYLES_ENRICH.batchSize,
					intervalMs,
					state,
				},
				null,
				2,
			),
		);
		process.exit(0);
	}

	if (!once) {
		console.log(
			`[ai-styles:enrich] loop every ${intervalMs / 1000}s × ${AI_STYLES_ENRICH.batchSize} docs (Ctrl+C stop)`,
		);
		let first = true;
		for (;;) {
			const started = Date.now();
			try {
				const summary = await runOnce({ reset: first && reset });
				first = false;
				if (summary?.atEnd) {
					console.log("[ai-styles:enrich] reached last Firestore object — done");
					process.exit(0);
				}
			} catch (err) {
				console.error("[ai-styles:enrich] run failed:", err?.message || err);
				first = false;
			}
			const elapsed = Date.now() - started;
			console.log(
				`[ai-styles:enrich] sleeping ${intervalMs / 1000}s (last tick ${Math.round(elapsed / 1000)}s)…`,
			);
			await new Promise((r) => setTimeout(r, intervalMs));
		}
	}

	await runOnce({ reset });
}

main().catch((err) => {
	console.error("[ai-styles:enrich] fatal:", err?.message || err);
	process.exit(1);
});
