#!/usr/bin/env node
/**
 * Karyam.xyz B2B founder lead agent CLI.
 *
 * Usage:
 *   npm run karyam:founders
 *   npm run karyam:founders -- --intent saas-crm
 *   npm run karyam:founders -- --use-ai
 *   npm run karyam:founders -- --loop
 *   npm run karyam:founders -- list
 *   npm run karyam:founders -- queries
 *   npm run karyam:founders -- send --id <leadId>
 */

import "dotenv/config";
import {
	ALL_QUERIES,
	INTENTS,
	KARYAM_AGENT,
	queriesForIntent,
} from "../lib/karyamFounders/configs.js";
import {
	listLeads,
	runKaryamFoundersAgent,
	sendLeadsByIds,
} from "../lib/karyamFounders/orchestrator.js";
import { autosendConfig } from "../lib/karyamFounders/autosend.js";
import { cliWantsUseAi, hasOpenRouterKey, useAiOpts } from "../lib/useAi.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "run").toLowerCase();

function flag(name) {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

const hasLoop = args.includes("--loop");
const useAI = cliWantsUseAi(args);
const doSend = args.includes("--send");
const intent = flag("--intent");
const queryId = flag("--query");
const queriesPerRun = flag("--queries") ? Number(flag("--queries")) : undefined;
const intervalMs = Number(process.env.KARYAM_FOUNDERS_INTERVAL_MS || 30 * 1000);

async function runOnce() {
	if (useAI && !hasOpenRouterKey()) {
		console.error("OPENROUTER_API_KEY required with --use-ai");
		process.exit(1);
	}
	if (doSend && !autosendConfig().configured) {
		console.error("AUTOSEND_API_KEY required with --send");
		process.exit(1);
	}
	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;

	console.log(
		`[founders-cli] karyam — intent=${intent || "all"} llm=${useAI ? "on" : "off"} send=${doSend ? "on" : "off"} base=${baseUrl}`,
	);
	const summary = await runKaryamFoundersAgent({
		baseUrl,
		intent,
		queryId,
		queriesPerRun,
		enrich: !args.includes("--no-enrich"),
		send: doSend,
		...useAiOpts(useAI),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`Karyam.xyz B2B founder lead agent

Google search → nested page scrape (email / phone / LinkedIn / founder-CTO-HR) → Firestore.
Default is scrape-only. Pass --use-ai to draft emails. Pass --send to email via AutoSend.

  npm run karyam:founders
  npm run karyam:founders -- --use-ai
  npm run karyam:founders -- --intent saas-crm
  npm run karyam:founders -- --intent ai-agent --queries 4
  npm run karyam:founders -- --loop
  npm run karyam:founders -- list
  npm run karyam:founders -- list --intent mvp --has-email
  npm run karyam:founders -- queries
  npm run karyam:founders -- send --id <leadId>
  npm run karyam:founders -- send --min-score 4

Intents: ${INTENTS.join(", ")}

Env:
  KARYAM_FOUNDERS_QUERIES_PER_RUN=3
  KARYAM_FOUNDERS_ENRICH_PER_RUN=6
  KARYAM_FOUNDERS_INTERVAL_MS=30000
  USE_AI=1
  AUTOSEND_API_KEY=
  AUTOSEND_FROM_EMAIL=hello@karyam.xyz
  AUTOSEND_FROM_NAME=Karyam
  AUTOSEND_PROJECT_ID=
  SCRAPE_API_BASE_URL=http://localhost:3002  (needs /google-search + /scrape)

Collection: ${KARYAM_AGENT.collection}
Queries: ${ALL_QUERIES.length}
`);
		process.exit(0);
	}

	if (cmd === "queries") {
		let qs = intent ? queriesForIntent(intent) : ALL_QUERIES;
		console.log(
			JSON.stringify({ count: qs.length, intents: INTENTS, queries: qs }, null, 2),
		);
		process.exit(0);
	}

	if (cmd === "list") {
		const leads = await listLeads(KARYAM_AGENT.collection, {
			minScore: flag("--min-score") ? Number(flag("--min-score")) : 0,
			intent,
			hasEmail: args.includes("--has-email") || undefined,
			outreachStatus: flag("--status"),
			limit: flag("--limit") ? Number(flag("--limit")) : 50,
		});
		console.log(JSON.stringify({ count: leads.length, leads }, null, 2));
		process.exit(0);
	}

	if (cmd === "send") {
		if (!autosendConfig().configured) {
			console.error("AUTOSEND_API_KEY is not set");
			process.exit(1);
		}
		const id = flag("--id");
		if (id) {
			const results = await sendLeadsByIds([id]);
			console.log(JSON.stringify({ results }, null, 2));
			process.exit(results[0]?.success ? 0 : 1);
		}
		const leads = await listLeads(KARYAM_AGENT.collection, {
			minScore: flag("--min-score") ? Number(flag("--min-score")) : 4,
			hasEmail: true,
			limit: flag("--limit") ? Number(flag("--limit")) : 10,
		});
		const unsent = leads.filter((l) => l.outreachStatus !== "sent");
		const results = await sendLeadsByIds(unsent.map((l) => l.id));
		console.log(
			JSON.stringify(
				{
					sent: results.filter((r) => r.success).length,
					failed: results.filter((r) => !r.success).length,
					results,
				},
				null,
				2,
			),
		);
		return;
	}

	if (cmd === "once") {
		await runOnce();
		return;
	}

	if (hasLoop || cmd === "run") {
		if (hasLoop) {
			const label =
				intervalMs >= 60_000
					? `${intervalMs / 60000} min`
					: `${intervalMs / 1000} sec`;
			console.log(`[founders-cli] loop every ${label} (Ctrl+C to stop)`);
			for (;;) {
				try {
					await runOnce();
				} catch (err) {
					console.error("[founders-cli] run failed:", err?.message || err);
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
	console.error("[founders-cli] fatal:", err?.message || err);
	process.exit(1);
});
