#!/usr/bin/env node
/**
 * Outbound B2B prospect pipeline — karyam.xyz + saascrm.site
 *
 * Usage:
 *   npm run outbound:prospects
 *   npm run outbound:prospects -- --loop
 *   npm run outbound:prospects -- --use-ai
 *   npm run outbound:prospects -- --country us --channel maps
 *   npm run outbound:prospects -- list
 */

import "dotenv/config";
import {
	DISCOVERY_JOBS,
	INTENTS,
	OUTBOUND_AGENT,
} from "../lib/outboundProspects/configs.js";
import { listLeads } from "../lib/outboundProspects/core.js";
import { runOutboundProspectsAgent } from "../lib/outboundProspects/orchestrator.js";
import { cliAiOpts, hasOpenRouterKey } from "../lib/useAi.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "run").toLowerCase();

function flag(name) {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

const hasLoop = args.includes("--loop");
const ai = cliAiOpts(args);
const useAI = Boolean(ai.useAI);
const intervalMs = Number(
	process.env.OUTBOUND_PROSPECTS_INTERVAL_MS || 30 * 1000,
);

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
		`[outbound-prospects] llm=${useAI ? ai.model : "off"} base=${baseUrl} collection=${OUTBOUND_AGENT.collection}`,
	);

	const summary = await runOutboundProspectsAgent({
		baseUrl,
		brand: flag("--brand"),
		intent: flag("--intent"),
		channel: flag("--channel"),
		country: flag("--country"),
		jobId: flag("--job"),
		jobsPerRun: flag("--jobs") ? Number(flag("--jobs")) : undefined,
		enrich: !args.includes("--no-enrich"),
		...ai,
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`Outbound B2B prospect pipeline (karyam.xyz + saascrm.site)

Firestore collection: ${OUTBOUND_AGENT.collection}
Jobs in rotation: ${DISCOVERY_JOBS.length}
Intents: ${INTENTS.join(", ")}

Commands:
  run (default)     One discovery tick
  list              Print latest leads from Firestore
  jobs              List discovery job ids

Flags:
  --loop            Repeat every OUTBOUND_PROSPECTS_INTERVAL_MS (default 30s)
  --use-ai          OpenRouter score + outreach draft (default: scrape-only)
  --model <id>      OpenRouter model (default free Gemini)
  --brand karyam|saascrm
  --intent ${INTENTS[0]}|...
  --channel google|maps
  --country us|au|uk|de|in
  --job <job-id>    Run a single job
  --jobs <n>        Jobs per tick (default ${OUTBOUND_AGENT.jobsPerRun})
  --no-enrich       Skip /scrape contact enrichment

HTTP:
  POST /outbound-prospects/run
  GET  /outbound-prospects

Requires API server for /google-search, /scrape-google-maps, /scrape:
  npm run dev
`);
		return;
	}

	if (cmd === "jobs") {
		console.log(JSON.stringify(DISCOVERY_JOBS, null, 2));
		return;
	}

	if (cmd === "list") {
		const leads = await listLeads(OUTBOUND_AGENT.collection, {
			limit: Number(flag("--limit") || 30),
			minScore: Number(flag("--min-score") || 0),
		});
		console.log(JSON.stringify(leads, null, 2));
		return;
	}

	if (hasLoop) {
		console.log(`[outbound-prospects] loop every ${intervalMs}ms`);
		for (;;) {
			await runOnce();
			await new Promise((r) => setTimeout(r, intervalMs));
		}
	}

	await runOnce();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
