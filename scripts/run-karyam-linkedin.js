#!/usr/bin/env node
/**
 * Karyam LinkedIn leads — ONE CLI (loops by default).
 *
 *   npm run karyam:linkedin
 *   npm run karyam:linkedin -- once
 *   npm run karyam:linkedin -- --geo world
 *   npm run karyam:linkedin -- --geo us --city sf
 *   npm run karyam:linkedin -- --city bangalore
 *   npm run karyam:linkedin -- list --geo in
 */

import "dotenv/config";
import {
	AGENT,
	CITIES,
	GEOS,
	buildQueries,
	listLeads,
	resolveCity,
	resolveGeo,
	runKaryamLinkedInAgent,
} from "../lib/karyamLinkedIn/agent.js";
import { cliWantsUseAi, hasOpenRouterKey, useAiOpts } from "../lib/useAi.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "").toLowerCase();

function flag(name) {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

const once = cmd === "once" || args.includes("--once");
const useAI = cliWantsUseAi(args);
const geo = flag("--geo") || process.env.KARYAM_LI_GEO || "in";
const city = flag("--city") || process.env.KARYAM_LI_CITY || undefined;
const queriesPerRun = flag("--queries") ? Number(flag("--queries")) : undefined;
const intervalMs = Number(process.env.KARYAM_LI_INTERVAL_MS || 30_000);

async function runOnce() {
	if (useAI && !hasOpenRouterKey()) {
		console.error("OPENROUTER_API_KEY required with --use-ai");
		process.exit(1);
	}
	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;
	const g = resolveGeo(geo);
	const c = city ? resolveCity(city) : null;
	console.log(
		`[karyam-li] run geo=${g?.id || geo} city=${c?.id || city || "-"} llm=${useAI ? "on" : "off"} base=${baseUrl}`,
	);
	const summary = await runKaryamLinkedInAgent({
		baseUrl,
		geo,
		city,
		queriesPerRun,
		...useAiOpts(useAI),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "geos" || cmd === "cities") {
		console.log(
			JSON.stringify(
				{
					defaultGeo: "in",
					geos: GEOS,
					cities: CITIES,
				},
				null,
				2,
			),
		);
		return;
	}

	if (cmd === "queries") {
		const qs = buildQueries({ geo, city });
		console.log(
			JSON.stringify(
				{
					geo: resolveGeo(geo),
					city: city ? resolveCity(city) : null,
					count: qs.length,
					queries: qs.slice(0, 20),
				},
				null,
				2,
			),
		);
		return;
	}

	if (cmd === "list") {
		const leads = await listLeads({
			minScore: 0,
			limit: 50,
			geo,
			city,
		});
		console.log(JSON.stringify({ count: leads.length, leads }, null, 2));
		return;
	}

	if (cmd === "help" || cmd === "--help") {
		console.log(`Karyam LinkedIn leads (${AGENT.collection})

Default is scrape-only. Pass --use-ai to score.

  npm run karyam:linkedin                    # loop, geo=in (India default)
  npm run karyam:linkedin -- once
  npm run karyam:linkedin -- --use-ai
  npm run karyam:linkedin -- --geo world     # worldwide
  npm run karyam:linkedin -- --geo us
  npm run karyam:linkedin -- --geo uk --city london
  npm run karyam:linkedin -- --city bangalore
  npm run karyam:linkedin -- list --geo in
  npm run karyam:linkedin -- geos
  npm run karyam:linkedin -- queries --geo world

Geos: ${GEOS.map((g) => g.id).join(", ")}
Cities: ${CITIES.map((c) => c.id).join(", ")}

Env: KARYAM_LI_GEO=in  KARYAM_LI_CITY=  KARYAM_LI_INTERVAL_MS=30000  USE_AI=1
API: POST /karyam-linkedin { "geo": "world", "city": "sf", "useAI": true }
`);
		return;
	}

	if (once) {
		await runOnce();
		return;
	}

	console.log(
		`[karyam-li] loop every ${intervalMs / 1000}s geo=${geo} city=${city || "-"} (Ctrl+C stop)`,
	);
	for (;;) {
		try {
			await runOnce();
		} catch (err) {
			console.error("[karyam-li]", err?.message || err);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

main().catch((err) => {
	console.error(err?.message || err);
	process.exit(1);
});
