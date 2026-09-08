#!/usr/bin/env node
/**
 * Business CRM directory — Google search + scrape, LLM off.
 * Loops every 10s by default. Stores unique CRM websites in Firestore.
 *
 *   npm run crm:directory
 *   npm run crm:directory -- once
 *   npm run crm:directory -- list
 */

import "dotenv/config";
import { CRM_AGENT, CRM_QUERIES, INTERVAL_MS } from "../lib/crmDirectory/configs.js";
import { listCrms, runCrmDirectoryAgent } from "../lib/crmDirectory/orchestrator.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "run").toLowerCase();

function flag(name) {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

const once = args.includes("--once") || cmd === "once" || args.includes("--no-loop");
const intervalMs = Number(process.env.CRM_INTERVAL_MS || INTERVAL_MS);
const queriesPerRun = flag("--queries") ? Number(flag("--queries")) : undefined;

async function runOnce() {
	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;
	console.log(
		`[crm-cli] ${CRM_AGENT.id} llm=off interval=${intervalMs}ms queries=${queriesPerRun || CRM_AGENT.queriesPerRun} base=${baseUrl}`,
	);
	const summary = await runCrmDirectoryAgent({
		baseUrl,
		queriesPerRun,
		enrich: !args.includes("--no-enrich"),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`Business CRM directory (Google + scrape, no AI)

  npm run crm:directory
  npm run crm:directory -- once
  npm run crm:directory -- --queries 2
  npm run crm:directory -- list
  npm run crm:directory -- queries

Each tick: next keyword of ${CRM_QUERIES.length} → Google SERP → scrape CRM lists →
save unique product websites (sha256 domain) to ${CRM_AGENT.collection}

Env:
  CRM_INTERVAL_MS=${INTERVAL_MS}
  CRM_QUERIES_PER_RUN=1
  CRM_SCRAPE_LISTS_PER_RUN=2
  CRM_ENRICH_PER_RUN=4
  SCRAPE_API_BASE_URL=http://localhost:3002
`);
		process.exit(0);
	}

	if (cmd === "queries") {
		console.log(JSON.stringify({ count: CRM_QUERIES.length, queries: CRM_QUERIES }, null, 2));
		process.exit(0);
	}

	if (cmd === "list") {
		const crms = await listCrms(CRM_AGENT.collection, { limit: 80 });
		console.log(JSON.stringify({ count: crms.length, crms }, null, 2));
		process.exit(0);
	}

	if (once) {
		await runOnce();
		return;
	}

	console.log(`[crm-cli] looping every ${intervalMs / 1000}s (Ctrl+C to stop)`);
	for (;;) {
		try {
			await runOnce();
		} catch (err) {
			console.error("[crm-cli] run failed:", err?.message || err);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

main().catch((err) => {
	console.error("[crm-cli] fatal:", err?.message || err);
	process.exit(1);
});
