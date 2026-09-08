#!/usr/bin/env node
/**
 * Enrich yc-companies websites (4 at a time).
 *
 * For each company website: landing, logo/brand, llm.txt, sitemap, RSS,
 * plus blog/pricing/about (same-domain URLs stored as hash keys).
 *
 *   npm run yc:companies:enrich
 *   npm run yc:companies:enrich -- once
 *   npm run yc:companies:enrich -- --reset
 */

import "dotenv/config";
import {
	SITE_ENRICH_BATCH_SIZE,
	SITE_ENRICH_INTERVAL_MS,
	YC_AGENT,
} from "../lib/ycCompanies/configs.js";
import {
	countCompanies,
	countSiteEnrichedCompanies,
} from "../lib/ycCompanies/core.js";
import { runYcCompaniesSiteEnrichAgent } from "../lib/ycCompanies/siteEnrich.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "run").toLowerCase();
const once =
	args.includes("--once") || cmd === "once" || args.includes("--no-loop");
const reset = args.includes("--reset");

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function runTick(isReset) {
	console.log(
		`[yc-site-enrich-cli] batch=${SITE_ENRICH_BATCH_SIZE} reset=${isReset} collection=${YC_AGENT.collection}`,
	);
	const summary = await runYcCompaniesSiteEnrichAgent({ reset: isReset });
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`YC companies site enrichment (Firestore → website scrape)

Reads yc-companies, 4 docs at a time. For each website:
  landing, logo/brand, /llm.txt, sitemap, RSS, blog, pricing + address / lat / lng / mapsUrl.
Unique page URLs are stored on the company doc as sitePages[hash].

  npm run yc:companies:enrich
  npm run yc:companies:enrich -- once
  npm run yc:companies:enrich -- --reset

No OpenRouter. HTTP fetch only (no Chrome).
`);
		process.exit(0);
	}

	let first = true;
	for (;;) {
		const summary = await runTick(reset && first);
		first = false;
		const stored = summary.stored || (await countCompanies().catch(() => 0));
		const enriched =
			summary.enriched ?? (await countSiteEnrichedCompanies().catch(() => 0));
		if (summary.done) {
			console.log(
				`[yc-site-enrich-cli] finished ${enriched}/${stored} companies`,
			);
			return;
		}
		if (once) {
			console.log(
				`[yc-site-enrich-cli] ${enriched}/${stored} — run again or omit once to loop`,
			);
			return;
		}
		console.log(
			`[yc-site-enrich-cli] ${enriched}/${stored} enriched — next ${SITE_ENRICH_BATCH_SIZE} in ${SITE_ENRICH_INTERVAL_MS}ms`,
		);
		await sleep(SITE_ENRICH_INTERVAL_MS);
	}
}

main().catch((err) => {
	console.error("[yc-site-enrich-cli] fatal:", err?.message || err);
	process.exit(1);
});
