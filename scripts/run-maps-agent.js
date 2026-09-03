#!/usr/bin/env node
/**
 * Google Maps lead agent CLI (Karyam — multi-city local businesses).
 *
 * Usage:
 *   npm run maps:karyam -- --city bangalore
 *   npm run maps:karyam -- --city sf
 *   npm run maps:karyam -- --city "San Francisco"
 *   npm run maps:karyam -- --loop --city mumbai
 *   npm run maps:karyam -- leads --city kota
 *   npm run maps:karyam -- cities
 *   npm run maps:karyam -- queries --city bangalore
 */

import "dotenv/config";
import {
	MAPS_KARYAM_AGENT,
	buildSearchQueries,
	filterQueriesByCity,
	listCityIds,
	resolveCity,
} from "../lib/mapsAgents/configs.js";
import { listMapsLeads } from "../lib/mapsAgents/core.js";
import { runKaryamMapsLeadsAgent } from "../lib/mapsAgents/karyamLocal.js";
import { cliWantsUseAi, hasOpenRouterKey, useAiOpts } from "../lib/useAi.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "run").toLowerCase();

function flag(name) {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

const hasLoop = args.includes("--loop");
const allKeywords = args.includes("--all-keywords");
const useAI = cliWantsUseAi(args);
const city = flag("--city");
const queriesPerRun = flag("--queries") ? Number(flag("--queries")) : undefined;
const intervalMs = Number(
	process.env.MAPS_KARYAM_INTERVAL_MS || 30 * 1000,
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
	const scrapeMode =
		process.env.MAPS_USE_HTTP_SCRAPE === "true" ? `http ${baseUrl}` : "in-process";

	const resolved = city ? resolveCity(city) : null;
	console.log(
		`[maps-cli] karyam — city=${resolved?.id || city || "all"} llm=${useAI ? "on" : "off"} scrape=${scrapeMode}`,
	);
	const summary = await runKaryamMapsLeadsAgent({
		baseUrl,
		city,
		queriesPerRun,
		allKeywords,
		...useAiOpts(useAI),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		const cities = MAPS_KARYAM_AGENT.cities
			.map((c) => `  ${c.id.padEnd(12)} ${c.name}, ${c.state}, ${c.country}`)
			.join("\n");
		console.log(`Maps lead agent — karyam.xyz (multi-city)

Default is scrape-only (no OpenRouter). 5 Maps keywords: ${MAPS_KARYAM_AGENT.categories.join(", ")}.
Pass --use-ai to score leads. Pass --all-keywords for the full category list.

  npm run maps:karyam -- --city bangalore
  npm run maps:karyam -- --city sf --queries 4
  npm run maps:karyam -- --city mumbai --loop
  npm run maps:karyam -- --city kota --use-ai
  npm run maps:karyam -- leads --city kota
  npm run maps:karyam -- queries --city bangalore
  npm run maps:karyam -- cities

Cities:
${cities}

Env:
  MAPS_KARYAM_QUERIES_PER_RUN=4
  MAPS_KARYAM_INTERVAL_MS=30000
  MAPS_USE_HTTP_SCRAPE=true
  USE_AI=1
  SCRAPE_API_BASE_URL=http://localhost:3002

Firestore: ${MAPS_KARYAM_AGENT.collection}  (filter by cityId / city field)
`);
		process.exit(0);
	}

	if (cmd === "cities") {
		console.log(
			JSON.stringify(
				{
					count: MAPS_KARYAM_AGENT.cities.length,
					cities: MAPS_KARYAM_AGENT.cities,
					ids: listCityIds(),
				},
				null,
				2,
			),
		);
		process.exit(0);
	}

	if (cmd === "queries") {
		const agent = {
			...MAPS_KARYAM_AGENT,
			categories: allKeywords
				? MAPS_KARYAM_AGENT.allCategories
				: MAPS_KARYAM_AGENT.categories,
		};
		let qs = buildSearchQueries(agent);
		qs = filterQueriesByCity(qs, city);
		console.log(
			JSON.stringify(
				{
					city: city ? resolveCity(city) : null,
					keywords: agent.categories,
					count: qs.length,
					queries: qs,
				},
				null,
				2,
			),
		);
		process.exit(0);
	}

	if (cmd === "leads") {
		const resolved = city ? resolveCity(city) : null;
		const leads = await listMapsLeads(MAPS_KARYAM_AGENT.collection, {
			minScore: 0,
			city: resolved?.name || city,
			cityId: resolved?.id,
			limit: 50,
		});
		console.log(JSON.stringify({ count: leads.length, leads }, null, 2));
		process.exit(0);
	}

	if (hasLoop) {
		const intervalLabel =
			intervalMs >= 60_000
				? `${intervalMs / 60000} min`
				: `${intervalMs / 1000} sec`;
		console.log(
			`[maps-cli] loop every ${intervalLabel} city=${city || "all"} (Ctrl+C to stop)`,
		);
		for (;;) {
			try {
				await runOnce();
			} catch (err) {
				console.error("[maps-cli] run failed:", err?.message || err);
			}
			await new Promise((r) => setTimeout(r, intervalMs));
		}
	}

	await runOnce();
}

main().catch((err) => {
	console.error("[maps-cli] fatal:", err?.message || err);
	process.exit(1);
});
