#!/usr/bin/env node
/**
 * YC Launch YC enrichment — company page → /launches/ post → email + founders.
 *
 * Reverse batch order: W26 → S26 → P26 → F26 → W25 → … (loops forever).
 *
 *   npm run yc:companies:launch-enrich
 *   npm run yc:companies:launch-enrich -- once
 *   npm run yc:companies:launch-enrich -- --reset
 */

import "dotenv/config";
import {
	LAUNCH_ENRICH_BATCH_SIZE,
	LAUNCH_ENRICH_INTERVAL_MS,
	LAUNCH_ENRICH_BATCH_ORDER,
	YC_AGENT,
} from "../lib/ycCompanies/configs.js";
import {
	countCompanies,
	countLaunchEnrichedCompanies,
} from "../lib/ycCompanies/core.js";
import { runYcCompaniesLaunchEnrichAgent } from "../lib/ycCompanies/launchEnrich.js";
import { resolveScrapeBaseUrl } from "../lib/scrapefast.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "run").toLowerCase();
const once =
	args.includes("--once") || cmd === "once" || args.includes("--no-loop");
const reset = args.includes("--reset");

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function runTick(isReset) {
	const baseUrl = resolveScrapeBaseUrl();
	console.log(
		`[yc-launch-enrich-cli] batch=${LAUNCH_ENRICH_BATCH_SIZE} reset=${isReset} order=${LAUNCH_ENRICH_BATCH_ORDER.slice(0, 4).join(",")}… base=${baseUrl} collection=${YC_AGENT.collection}`,
	);
	const summary = await runYcCompaniesLaunchEnrichAgent({ reset: isReset, baseUrl });
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`YC companies Launch YC enrichment (Firestore → /scrape)

For each company (newest batches first, reverse doc id within batch):
  1. Scrape ycombinator.com/companies/{slug}
  2. Find Launch YC URL (/launches/…)
  3. Scrape launch post for email, founders, ask text
  4. Merge into yc-companies doc (launchUrl, launchMarkdown, emails, …)

Batch loop: W26 → S26 → P26 → F26 → W25 → … then repeats.

  npm run yc:companies:launch-enrich
  npm run yc:companies:launch-enrich -- once
  npm run yc:companies:launch-enrich -- --reset

No OpenRouter / LLM. Requires API running for POST /scrape.
`);
		process.exit(0);
	}

	let first = true;
	for (;;) {
		const summary = await runTick(reset && first);
		first = false;
		const stored = summary.stored || (await countCompanies().catch(() => 0));
		const enriched =
			summary.launchEnriched ??
			(await countLaunchEnrichedCompanies().catch(() => 0));
		if (once) {
			console.log(
				`[yc-launch-enrich-cli] ${enriched}/${stored} launch-enriched — omit once to loop`,
			);
			return;
		}
		console.log(
			`[yc-launch-enrich-cli] ${enriched}/${stored} — next tick in ${LAUNCH_ENRICH_INTERVAL_MS}ms (batch ${summary.currentBatch}, cycle ${summary.cycle})`,
		);
		await sleep(LAUNCH_ENRICH_INTERVAL_MS);
	}
}

main().catch((err) => {
	console.error("[yc-launch-enrich-cli] fatal:", err?.message || err);
	process.exit(1);
});
