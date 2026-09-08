#!/usr/bin/env node
/**
 * Enrich England clubs in Firestore (4 at a time).
 *
 * Google search + /scrape + /scrape-google-maps → stadium, lat/lng, phone, contact.
 * Pass --use-ai to let OpenRouter plan queries and extract emails (default: free Gemini).
 *
 *   npm run england:clubs:enrich
 *   npm run england:clubs:enrich -- once
 *   npm run england:clubs:enrich -- --use-ai
 *   npm run england:clubs:enrich -- once --use-ai --model google/gemma-4-26b-a4b-it:free
 *   npm run england:clubs:enrich -- --reset
 */

import "dotenv/config";
import {
	ENRICH_BATCH_SIZE,
	ENRICH_INTERVAL_MS,
	LOCAL_API_BASE,
	TOTAL_CLUBS,
} from "../lib/englandClubs/configs.js";
import { countClubs, countEnrichedClubs } from "../lib/englandClubs/core.js";
import { runEnglandClubsEnrichAgent } from "../lib/englandClubs/enrich.js";
import { cliAiOpts, hasOpenRouterKey } from "../lib/useAi.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "run").toLowerCase();
const once =
	args.includes("--once") || cmd === "once" || args.includes("--no-loop");
const reset = args.includes("--reset");
const ai = cliAiOpts(args);

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function runTick(isReset) {
	if (ai.useAI && !hasOpenRouterKey()) {
		console.error("OPENROUTER_API_KEY required with --use-ai / --llm");
		process.exit(1);
	}
	console.log(
		`[england-clubs-enrich-cli] batch=${ENRICH_BATCH_SIZE} reset=${isReset} llm=${ai.useAI ? ai.model : "off"} base=${LOCAL_API_BASE}`,
	);
	const summary = await runEnglandClubsEnrichAgent({
		baseUrl: LOCAL_API_BASE,
		reset: isReset,
		...ai,
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`England clubs enrichment (Firestore → Google + Maps)

Reads the clubs collection, 4 docs at a time, until every club has maps/contact fields.
Searches Google, LinkedIn, and X for Head of Ticketing (HT), CMO, Marketing Head, and staff emails.
Only stores addresses that appear in search snippets or club pages — never invented.
Default is scrape-only. Pass --use-ai to extract emails with OpenRouter (default model: free Gemini).

  npm run england:clubs:enrich
  npm run england:clubs:enrich -- once
  npm run england:clubs:enrich -- --use-ai
  npm run england:clubs:enrich -- --use-ai --model google/gemini-2.0-flash-exp:free
  npm run england:clubs:enrich -- --reset

Needs Wikidata/Wikipedia (no local API required). OPENROUTER_API_KEY is required only with --use-ai.
`);
		process.exit(0);
	}

	let first = true;
	for (;;) {
		const summary = await runTick(reset && first);
		first = false;
		const stored = summary.stored || (await countClubs().catch(() => TOTAL_CLUBS));
		const enriched =
			summary.enriched ?? (await countEnrichedClubs().catch(() => 0));
		if (summary.done) {
			console.log(
				`[england-clubs-enrich-cli] finished ${enriched}/${stored} clubs`,
			);
			return;
		}
		if (once) {
			console.log(
				`[england-clubs-enrich-cli] ${enriched}/${stored} — run again or omit once to loop`,
			);
			return;
		}
		console.log(
			`[england-clubs-enrich-cli] ${enriched}/${stored} enriched — next ${ENRICH_BATCH_SIZE} in ${ENRICH_INTERVAL_MS}ms`,
		);
		await sleep(ENRICH_INTERVAL_MS);
	}
}

main().catch((err) => {
	console.error("[england-clubs-enrich-cli] fatal:", err?.message || err);
	process.exit(1);
});
