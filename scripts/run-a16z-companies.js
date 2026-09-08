#!/usr/bin/env node
/**
 * a16z companies agent — ONE CLI (loops by default, 4 companies / 8000ms).
 *
 * Pipeline (each tick):
 *   1. Fetch https://a16z.com/portfolio/?status=Active
 *   2. Parse data-companies JSON (card + modal: name, description, socials, stage)
 *   3. Next 4 companies not yet stored/site-enriched
 *   4. Site enrich in-process when a website exists
 *   5. Firestore yc-companies (same collection as YC, hash dedupe)
 *
 * Usage:
 *   npm run a16z:companies
 *   npm run a16z:companies -- once
 *   npm run a16z:companies -- list
 *   npm run a16z:companies -- list --status Active
 *   npm run a16z:companies -- --reset
 */

import "dotenv/config";
import { A16Z_AGENT, INTERVAL_MS } from "../lib/a16zCompanies/configs.js";
import {
	listCompanies,
	runA16zCompaniesAgent,
} from "../lib/a16zCompanies/orchestrator.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "run").toLowerCase();

function flag(name) {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

const once =
	args.includes("--once") || cmd === "once" || args.includes("--no-loop");
const status = flag("--status") || "Active";
const reset = args.includes("--reset");
const intervalMs = Number(process.env.A16Z_INTERVAL_MS || INTERVAL_MS);

async function runOnce({ reset: resetTick = false } = {}) {
	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;

	console.log(
		`[a16z-cli] ${A16Z_AGENT.id} — status=${status} enrich=${!args.includes("--no-enrich")} reset=${resetTick} base=${baseUrl}`,
	);
	const summary = await runA16zCompaniesAgent({
		baseUrl,
		status,
		reset: resetTick,
		enrich: !args.includes("--no-enrich"),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`a16z companies agent (loops every ${INTERVAL_MS}ms by default)

  npm run a16z:companies
  npm run a16z:companies -- once
  npm run a16z:companies -- --reset
  npm run a16z:companies -- --status all
  npm run a16z:companies -- list
  npm run a16z:companies -- list --status Active

Each tick stores 4 Active portfolio companies, then enriches each website
(pages, logo/brand, llm.txt, address/lat/lng) using the YC site-enrich method.

Env:
  A16Z_INTERVAL_MS=${INTERVAL_MS}
  A16Z_BATCH_SIZE=4
  SCRAPE_API_BASE_URL=http://localhost:3002

Collection: ${A16Z_AGENT.collection}
`);
		process.exit(0);
	}

	if (cmd === "list") {
		const companies = await listCompanies(A16Z_AGENT.collection, {
			status: flag("--status"),
			hiring: args.includes("--hiring"),
			limit: 50,
		});
		console.log(JSON.stringify({ count: companies.length, companies }, null, 2));
		process.exit(0);
	}

	if (once) {
		await runOnce({ reset });
		return;
	}

	const label =
		intervalMs >= 60_000
			? `${intervalMs / 60000} min`
			: `${intervalMs / 1000} sec`;
	console.log(`[a16z-cli] looping every ${label} — 4 companies/tick (Ctrl+C to stop)`);
	let applyReset = reset;
	for (;;) {
		try {
			const summary = await runOnce({ reset: applyReset });
			applyReset = false;
			if (summary?.done) {
				console.log("[a16z-cli] listing complete — stopping");
				return;
			}
		} catch (err) {
			applyReset = false;
			console.error("[a16z-cli] run failed:", err?.message || err);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

main().catch((err) => {
	console.error("[a16z-cli] fatal:", err?.message || err);
	process.exit(1);
});
