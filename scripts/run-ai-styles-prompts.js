#!/usr/bin/env node
/**
 * AI DESIGN.md style prompts — Refero Styles catalog.
 *
 *   npm run ai:styles
 *   npm run ai:styles -- once
 *   npm run ai:styles -- list
 */

import "dotenv/config";
import { AI_STYLES_AGENT, REFERO_LIST_URL } from "../lib/aiStylesPrompts/configs.js";
import {
	countPrompts,
	listPrompts,
	runAiStylesPromptsAgent,
} from "../lib/aiStylesPrompts/orchestrator.js";
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
const stylesPerRun = flag("--styles") ? Number(flag("--styles")) : undefined;
const intervalMs = Number(process.env.AI_STYLES_INTERVAL_MS || 30 * 1000);

async function runOnce() {
	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;

	if (useAI && !hasOpenRouterKey()) {
		console.error("OPENROUTER_API_KEY required with --use-ai");
		process.exit(1);
	}

	console.log(`[ai-styles] list=${REFERO_LIST_URL} llm=${useAI ? "on" : "off"} base=${baseUrl}`);
	const summary = await runAiStylesPromptsAgent({
		baseUrl,
		stylesPerRun,
		scrape: !args.includes("--no-scrape"),
		...useAiOpts(useAI),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`AI DESIGN.md style prompts (Refero)

Default is scrape-only. Pass --use-ai to LLM-enrich DESIGN.md.

  npm run ai:styles
  npm run ai:styles -- once
  npm run ai:styles -- --use-ai
  npm run ai:styles -- once --styles 10
  npm run ai:styles -- list
  npm run ai:styles -- count
  npm run ai:styles:enrich

Collection: ${AI_STYLES_AGENT.collection}
Catalog: ${REFERO_LIST_URL}
Then /style/{id} for DESIGN.md, preview image/video, colors, type.
Target: ${AI_STYLES_AGENT.targetCount}

Env:
  AI_STYLES_INTERVAL_MS=30000
  AI_STYLES_TARGET=100
  AI_STYLES_PER_RUN=8
  SCRAPE_API_BASE_URL=http://localhost:3002
`);
		process.exit(0);
	}

	if (cmd === "count") {
		const n = await countPrompts(AI_STYLES_AGENT.collection);
		console.log(
			JSON.stringify(
				{
					collection: AI_STYLES_AGENT.collection,
					count: n,
					target: AI_STYLES_AGENT.targetCount,
				},
				null,
				2,
			),
		);
		process.exit(0);
	}

	if (cmd === "list") {
		const prompts = await listPrompts(AI_STYLES_AGENT.collection, {
			tag: flag("--tag"),
			category: flag("--category"),
			limit: 40,
		});
		console.log(JSON.stringify({ count: prompts.length, prompts }, null, 2));
		process.exit(0);
	}

	if (!once) {
		console.log(
			`[ai-styles] loop every ${intervalMs / 1000}s (Ctrl+C stop) — cap ${AI_STYLES_AGENT.targetCount}`,
		);
		for (;;) {
			const started = Date.now();
			try {
				const summary = await runOnce();
				if (summary?.atCapacity) {
					console.log(
						`[ai-styles] at capacity ${AI_STYLES_AGENT.targetCount} — still looping; Ctrl+C to stop`,
					);
				}
			} catch (err) {
				console.error("[ai-styles] run failed:", err?.message || err);
			}
			const elapsed = Date.now() - started;
			console.log(
				`[ai-styles] sleeping ${intervalMs / 1000}s (last run ${Math.round(elapsed / 1000)}s)…`,
			);
			await new Promise((r) => setTimeout(r, intervalMs));
		}
	}

	await runOnce();
}

main().catch((err) => {
	console.error("[ai-styles] fatal:", err?.message || err);
	process.exit(1);
});
