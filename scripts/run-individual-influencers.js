#!/usr/bin/env node
/**
 * Individual influencers — X + Instagram + YouTube. Loops by default.
 *
 *   npm run top:influencers
 *   npm run top:influencers -- once
 *   npm run top:influencers -- --platform instagram
 *   npm run top:influencers -- --niche Spirituality
 *   npm run top:influencers -- list
 */

import "dotenv/config";
import {
	ALL_QUERIES,
	INFLUENCER_AGENT,
	INFLUENCER_NICHES,
} from "../lib/individualInfluencers/configs.js";
import {
	countInfluencers,
	listInfluencers,
	runIndividualInfluencersAgent,
} from "../lib/individualInfluencers/orchestrator.js";
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
const platform = flag("--platform");
const niche = flag("--niche") || flag("--tag");
const queriesPerRun = flag("--queries") ? Number(flag("--queries")) : undefined;
const intervalMs = Number(process.env.INFLUENCERS_INTERVAL_MS || 30 * 1000);

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
		`[influencers] platform=${platform || "all"} niche=${niche || "all"} llm=${useAI ? "on" : "off"} base=${baseUrl}`,
	);
	const summary = await runIndividualInfluencersAgent({
		baseUrl,
		platform,
		niche,
		queriesPerRun,
		enrich: !args.includes("--no-enrich"),
		...useAiOpts(useAI),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`Individual influencers — people only (X, Instagram, YouTube)

Default is scrape-only. Pass --use-ai to purify/score with OpenRouter.

  npm run top:influencers
  npm run top:influencers -- once
  npm run top:influencers -- --use-ai
  npm run top:influencers -- --platform x
  npm run top:influencers -- --platform instagram
  npm run top:influencers -- --platform youtube
  npm run top:influencers -- --niche Spirituality
  npm run top:influencers -- list
  npm run top:influencers -- list --tag Spirituality
  npm run top:influencers -- queries
  npm run top:influencers -- count

Collection: ${INFLUENCER_AGENT.collection}
Min followers: ${INFLUENCER_AGENT.minFollowers}
Niches: ${INFLUENCER_NICHES.join(", ")}
Queries: ${ALL_QUERIES.length}

Needs API server for Google search only (POST /google-search).
Profile enrich runs in-process (IG / X / YouTube scrapers) — no RapidAPI, no login-modal clicks.

Env:
  INFLUENCERS_INTERVAL_MS=30000
  INFLUENCERS_MIN_FOLLOWERS=10000
  INFLUENCERS_TARGET=500
  INFLUENCERS_QUERIES_PER_RUN=3
  YOUTUBE_API_KEY=   (optional; otherwise channel HTML)
  SCRAPE_API_BASE_URL=http://localhost:3002
`);
		process.exit(0);
	}

	if (cmd === "count") {
		const n = await countInfluencers(INFLUENCER_AGENT.collection);
		console.log(
			JSON.stringify(
				{
					collection: INFLUENCER_AGENT.collection,
					count: n,
					target: INFLUENCER_AGENT.targetCount,
				},
				null,
				2,
			),
		);
		process.exit(0);
	}

	if (cmd === "queries") {
		let qs = ALL_QUERIES;
		if (platform) qs = qs.filter((q) => q.platform === platform);
		if (niche) {
			const n = String(niche).toLowerCase();
			qs = qs.filter((q) => String(q.niche || "").toLowerCase().includes(n));
		}
		console.log(JSON.stringify({ count: qs.length, queries: qs }, null, 2));
		process.exit(0);
	}

	if (cmd === "list") {
		const people = await listInfluencers(INFLUENCER_AGENT.collection, {
			minScore: 0,
			platform,
			tag: niche,
			limit: 50,
		});
		console.log(JSON.stringify({ count: people.length, people }, null, 2));
		process.exit(0);
	}

	if (!once) {
		const label =
			intervalMs >= 60_000
				? `${intervalMs / 60000} min`
				: `${intervalMs / 1000} sec`;
		console.log(
			`[influencers] loop every ${label} (Ctrl+C stop)`,
		);
		for (;;) {
			const started = Date.now();
			try {
				const summary = await runOnce();
				if (summary?.atCapacity) {
					console.log(
						`[influencers] at capacity ${INFLUENCER_AGENT.targetCount} — still looping; Ctrl+C to stop`,
					);
				}
			} catch (err) {
				console.error("[influencers] run failed:", err?.message || err);
			}
			const elapsed = Date.now() - started;
			console.log(
				`[influencers] sleeping ${intervalMs / 1000}s before next tick (last run ${Math.round(elapsed / 1000)}s)…`,
			);
			await new Promise((r) => setTimeout(r, intervalMs));
		}
		return;
	}

	await runOnce();
}

main().catch((err) => {
	console.error("[influencers] fatal:", err?.message || err);
	process.exit(1);
});
