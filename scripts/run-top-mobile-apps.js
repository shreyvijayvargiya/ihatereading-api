#!/usr/bin/env node
/**
 * Top Mobile Apps — App Store + Google Play discovery CLI.
 *
 *   npm run top:mobile-apps
 *   npm run top:mobile-apps -- once
 *   npm run top:mobile-apps -- --category Finance
 *   npm run top:mobile-apps -- --platform ios
 *   npm run top:mobile-apps -- list
 */

import "dotenv/config";
import {
	ALL_SOURCES,
	MOBILE_CATEGORIES,
	TOP_MOBILE_APPS_AGENT,
} from "../lib/topApps/configs.js";
import {
	countApps,
	listApps,
	runTopMobileAppsAgent,
} from "../lib/topApps/orchestrator.js";
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
const category = flag("--category");
const platform = flag("--platform");
const sourcesPerRun = flag("--sources") ? Number(flag("--sources")) : undefined;
const intervalMs = Number(
	process.env.TOP_MOBILE_APPS_INTERVAL_MS ||
		process.env.TOP_APPS_INTERVAL_MS ||
		30 * 1000,
);

async function runOnce() {
	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;

	if (useAI && !hasOpenRouterKey()) {
		console.error("OPENROUTER_API_KEY required with --use-ai");
		process.exit(1);
	}

	console.log(
		`[top-mobile-apps] category=${category || "all"} platform=${platform || "both"} llm=${useAI ? "on" : "off"} base=${baseUrl}`,
	);
	const summary = await runTopMobileAppsAgent({
		baseUrl,
		category,
		platform,
		sourcesPerRun,
		enrich: !args.includes("--no-enrich"),
		...useAiOpts(useAI),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`Top Mobile Apps — App Store + Google Play only

Default is scrape-only. Pass --use-ai for optional LLM founder extract.

  npm run top:mobile-apps
  npm run top:mobile-apps -- once
  npm run top:mobile-apps -- --use-ai
  npm run top:mobile-apps -- --category Finance
  npm run top:mobile-apps -- --platform ios
  npm run top:mobile-apps -- --platform android
  npm run top:mobile-apps -- list
  npm run top:mobile-apps -- sources
  npm run top:mobile-apps -- count

Collection: ${TOP_MOBILE_APPS_AGENT.collection}
Uses HTTP fetch of Play category pages + iTunes RSS (no Puppeteer required).
Then visits each listing for screenshots/details and Google-searches founders/socials.
Stores whatever is fetched. Target: ${TOP_MOBILE_APPS_AGENT.targetCount} unique mobile apps
Categories (${MOBILE_CATEGORIES.length}): ${MOBILE_CATEGORIES.slice(0, 8).join(", ")}…
Sources: ${ALL_SOURCES.length} (Apple + Play per category)

Env:
  TOP_MOBILE_APPS_INTERVAL_MS=30000   (30 sec between ticks, default)
  TOP_MOBILE_APPS_TARGET=10000
  SCRAPE_API_BASE_URL=http://localhost:3002  (optional /google-search + /scrape)
`);
		process.exit(0);
	}

	if (cmd === "count") {
		const n = await countApps(TOP_MOBILE_APPS_AGENT.collection);
		console.log(
			JSON.stringify(
				{ collection: TOP_MOBILE_APPS_AGENT.collection, count: n, target: TOP_MOBILE_APPS_AGENT.targetCount },
				null,
				2,
			),
		);
		process.exit(0);
	}

	if (cmd === "sources") {
		console.log(
			JSON.stringify(
				{ categories: MOBILE_CATEGORIES, count: ALL_SOURCES.length, sample: ALL_SOURCES.slice(0, 5) },
				null,
				2,
			),
		);
		process.exit(0);
	}

	if (cmd === "list") {
		const apps = await listApps(TOP_MOBILE_APPS_AGENT.collection, {
			minScore: 0,
			category,
			limit: 50,
		});
		console.log(JSON.stringify({ count: apps.length, apps }, null, 2));
		process.exit(0);
	}

	if (!once) {
		const label =
			intervalMs >= 60_000
				? `${intervalMs / 60000} min`
				: `${intervalMs / 1000} sec`;
		console.log(
			`[top-mobile-apps] loop every ${label} (Ctrl+C stop) — keeps running even if SERP returns 0`,
		);
		for (;;) {
			const started = Date.now();
			try {
				const summary = await runOnce();
				if (summary?.atCapacity) {
					console.log(
						`[top-mobile-apps] at capacity ${TOP_MOBILE_APPS_AGENT.targetCount} — still looping; Ctrl+C to stop`,
					);
				}
			} catch (err) {
				console.error("[top-mobile-apps] run failed:", err?.message || err);
			}
			const elapsed = Date.now() - started;
			console.log(
				`[top-mobile-apps] sleeping ${intervalMs / 1000}s before next tick (last run ${Math.round(elapsed / 1000)}s)…`,
			);
			await new Promise((r) => setTimeout(r, intervalMs));
		}
		return;
	}

	await runOnce();
}

main().catch((err) => {
	console.error("[top-mobile-apps] fatal:", err?.message || err);
	process.exit(1);
});
