#!/usr/bin/env node
/**
 * YC companies agent — ONE CLI (loops by default).
 *
 * Pipeline (each tick):
 *   1. Discover — scrape YC directory + Hacker News + Google discovery
 *   2. Enrich  — Google scrape for founder / funding / email / address
 *   3. LLM     — final structured company profile
 *   4. Store   — Firestore yc-companies (hash dedupe, no repeats)
 *
 * Usage:
 *   npm run yc:companies              # loop forever (default)
 *   npm run yc:companies -- once      # single run
 *   npm run yc:companies -- list
 *   npm run yc:companies -- list --status shutdown
 *   npm run yc:companies -- sources
 *   npm run yc:companies -- --status funded
 */

import "dotenv/config";
import { ALL_SOURCES, YC_AGENT } from "../lib/ycCompanies/configs.js";
import {
	listCompanies,
	runYcCompaniesAgent,
} from "../lib/ycCompanies/orchestrator.js";
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
const status = flag("--status");
const hiring = args.includes("--hiring");
const sourcesPerRun = flag("--sources") ? Number(flag("--sources")) : undefined;
const intervalMs = Number(process.env.YC_INTERVAL_MS || 30 * 1000);

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
		`[yc-cli] ${YC_AGENT.id} — status=${status || "all"} hiring=${hiring} llm=${useAI ? "on" : "off"} base=${baseUrl}`,
	);
	const summary = await runYcCompaniesAgent({
		baseUrl,
		status,
		hiring,
		sourcesPerRun,
		enrich: !args.includes("--no-enrich"),
		...useAiOpts(useAI),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`YC companies agent (single CLI, loops by default)

Default is scrape-only. Pass --use-ai to LLM-polish profiles.

  npm run yc:companies
  npm run yc:companies -- once
  npm run yc:companies -- --use-ai
  npm run yc:companies -- --hiring
  npm run yc:companies -- --status funded
  npm run yc:companies -- list
  npm run yc:companies -- list --hiring
  npm run yc:companies -- list --status Active
  npm run yc:companies -- sources

Pipeline per tick:
  1. yc-oss JSON (real YC startups / hiring)
  2. Scrape each company page for founders + jobs
  3. Optional Google enrich (funding/email)
  4. Optional --use-ai polish → Firestore (hash dedupe)

Env:
  YC_SOURCES_PER_RUN=1
  YC_PAGE_SIZE=40
  YC_ENRICH_PER_RUN=8
  YC_INTERVAL_MS=30000
  USE_AI=1
  SCRAPE_API_BASE_URL=http://localhost:3002

Collection: ${YC_AGENT.collection}
`);
		process.exit(0);
	}

	if (cmd === "sources") {
		let src = ALL_SOURCES;
		if (status) {
			src = src.filter(
				(s) => String(s.statusHint || "").toLowerCase() === status.toLowerCase(),
			);
		}
		console.log(
			JSON.stringify(
				{
					count: src.length,
					sources: src.map((s) => ({
						id: s.id,
						type: s.type,
						statusHint: s.statusHint,
						url: s.url || null,
						query: s.query || null,
						label: s.label,
					})),
				},
				null,
				2,
			),
		);
		process.exit(0);
	}

	if (cmd === "list") {
		const companies = await listCompanies(YC_AGENT.collection, {
			status,
			hiring,
			limit: 50,
		});
		console.log(JSON.stringify({ count: companies.length, companies }, null, 2));
		process.exit(0);
	}

	if (once) {
		await runOnce();
		return;
	}

	const label =
		intervalMs >= 60_000
			? `${intervalMs / 60000} min`
			: `${intervalMs / 1000} sec`;
	console.log(`[yc-cli] looping every ${label} (Ctrl+C to stop)`);
	for (;;) {
		try {
			await runOnce();
		} catch (err) {
			console.error("[yc-cli] run failed:", err?.message || err);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

main().catch((err) => {
	console.error("[yc-cli] fatal:", err?.message || err);
	process.exit(1);
});
