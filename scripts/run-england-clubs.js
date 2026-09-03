#!/usr/bin/env node
/**
 * England football clubs — Soccer Wiki countryId=ENG (333 clubs).
 *
 * Loops until Firestore `clubs` has 333 docs, then exits.
 * Dashboard ticks use `once` (one listing page); dashboard loop continues until 333.
 *
 *   npm run england:clubs
 *   npm run england:clubs -- once
 *   npm run england:clubs -- --reset
 *   npm run england:clubs -- --enrich
 *   npm run england:clubs -- list
 */

import "dotenv/config";
import { ENGLAND_CLUBS_AGENT, TOTAL_CLUBS } from "../lib/englandClubs/configs.js";
import {
	listClubs,
	runEnglandClubsAgent,
} from "../lib/englandClubs/orchestrator.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "run").toLowerCase();

function flag(name) {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

const once =
	args.includes("--once") || cmd === "once" || args.includes("--no-loop");
const reset = args.includes("--reset");
const enrich = args.includes("--enrich") || args.includes("--google");
const pagesPerRun = flag("--pages") ? Number(flag("--pages")) : once ? 1 : 1;
const intervalMs = Number(process.env.CLUBS_INTERVAL_MS || 8_000);

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function runTick(isReset) {
	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;
	console.log(
		`[england-clubs-cli] ${ENGLAND_CLUBS_AGENT.id} enrich=${enrich} reset=${isReset} base=${baseUrl}`,
	);
	const summary = await runEnglandClubsAgent({
		baseUrl,
		reset: isReset,
		enrich,
		pagesPerRun,
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`England football clubs (Soccer Wiki ENG, ${TOTAL_CLUBS} clubs)

Loops until ${TOTAL_CLUBS} clubs are stored, then stops. No LLM. Does not auto-start on npm run dev.

  npm run england:clubs              # loop until ${TOTAL_CLUBS}
  npm run england:clubs -- once      # one listing page
  npm run england:clubs -- --reset   # start from offset 0
  npm run england:clubs -- --enrich
  npm run england:clubs -- list

Pipeline per tick:
  1. Scrape Soccer Wiki listing (offset 0, 50, … 300)
  2. Store club / manager / league / stadium / founded
  3. Repeat until Firestore count >= ${TOTAL_CLUBS}

Env:
  CLUBS_PAGES_PER_RUN=1
  CLUBS_INTERVAL_MS=8000
  CLUBS_ENRICH_PER_PAGE=8
  SCRAPE_API_BASE_URL=http://localhost:3002
`);
		process.exit(0);
	}

	if (cmd === "list") {
		const clubs = await listClubs({ limit: 80 });
		console.log(JSON.stringify({ count: clubs.length, clubs }, null, 2));
		process.exit(0);
	}

	let first = true;
	for (;;) {
		const summary = await runTick(reset && first);
		first = false;
		if (summary.done) {
			console.log(
				`[england-clubs-cli] finished ${summary.stored}/${TOTAL_CLUBS} clubs`,
			);
			return;
		}
		if (once) {
			console.log(
				`[england-clubs-cli] ${summary.stored}/${TOTAL_CLUBS} — run again or use dashboard loop`,
			);
			return;
		}
		console.log(
			`[england-clubs-cli] ${summary.stored}/${TOTAL_CLUBS} stored — next page in ${intervalMs}ms`,
		);
		await sleep(intervalMs);
	}
}

main().catch((err) => {
	console.error("[england-clubs-cli] fatal:", err?.message || err);
	process.exit(1);
});
