#!/usr/bin/env node
/**
 * Programming magazine creators (YouTube + X) by cover category.
 *
 *   npm run magazine:creators -- --category frontend
 *   npm run magazine:creators -- --category frontend --topic react --platform youtube
 *   npm run magazine:creators -- --videos --category backend
 *   npm run magazine:creators -- once --category mobile
 *   npm run magazine:creators -- list --category frontend
 *   npm run magazine:creators -- videos-list --category frontend
 */

import "dotenv/config";
import {
	ALL_MAGAZINE_QUERIES,
	MAGAZINE_AGENT,
	MAGAZINE_CATEGORIES,
	filterMagazineQueries,
	listCategoryIds,
	resolveCategory,
} from "../lib/devMagazine/configs.js";
import { listVideos } from "../lib/devMagazine/core.js";
import {
	countChannels,
	listChannels,
	runDevMagazineAgent,
} from "../lib/devMagazine/orchestrator.js";
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
const videosOnly = args.includes("--videos") || cmd === "videos";
const category = flag("--category") || flag("--cover");
const topic = flag("--topic");
const platform = flag("--platform");
const queriesPerRun = flag("--queries") ? Number(flag("--queries")) : undefined;
const intervalMs = Number(process.env.MAGAZINE_INTERVAL_MS || 30 * 1000);

async function runOnce() {
	if (useAI && !hasOpenRouterKey()) {
		console.error("OPENROUTER_API_KEY required with --use-ai");
		process.exit(1);
	}
	if (category && !resolveCategory(category)) {
		console.error(`Unknown category "${category}". Use: ${listCategoryIds().join(", ")}`);
		process.exit(1);
	}
	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;
	console.log(
		`[magazine] category=${category || "all"} topic=${topic || "all"} platform=${platform || "yt+x"} videosOnly=${videosOnly} llm=${useAI ? "on" : "off"}`,
	);
	const summary = await runDevMagazineAgent({
		baseUrl,
		category,
		topic,
		platform,
		queriesPerRun,
		videosOnly,
		enrich: !args.includes("--no-enrich"),
		fetchVideos: !args.includes("--no-videos"),
		...useAiOpts(useAI),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		const covers = MAGAZINE_CATEGORIES.map(
			(c) => `  ${c.id.padEnd(16)} ${c.topics.join(", ")}`,
		).join("\n");
		console.log(`Programming magazine creators — YouTube + X

Default is scrape-only. Pass --use-ai to classify with OpenRouter.

  npm run magazine:creators -- --category backend
  npm run magazine:creators -- --category frontend --topic react --platform youtube
  npm run magazine:creators -- once --category backend
  npm run magazine:creators -- --use-ai --category frontend
  npm run magazine:creators -- --videos --category backend   # after channels exist

No YouTube API key or X login. Google finds youtube.com / x.com URLs, then we scrape public profiles.
--videos only refreshes uploads for channels already in Firestore; if none exist it now discovers first.
  npm run magazine:creators -- list --category frontend
  npm run magazine:creators -- videos-list --topic react
  npm run magazine:creators -- categories

Covers:
${covers}

Collections: ${MAGAZINE_AGENT.channelsCollection} · ${MAGAZINE_AGENT.videosCollection}
Queries: ${ALL_MAGAZINE_QUERIES.length}

HTTP: POST /dev-magazine/run  { "category": "frontend", "topic": "react" }

Env:
  MAGAZINE_INTERVAL_MS=30000
  MAGAZINE_QUERIES_PER_RUN=3
  MAGAZINE_VIDEOS_PER_CHANNEL=10
  YOUTUBE_API_KEY=   (better latest-video lists)
  SCRAPE_API_BASE_URL=http://localhost:3002
`);
		process.exit(0);
	}

	if (cmd === "categories") {
		console.log(
			JSON.stringify(
				{ ids: listCategoryIds(), categories: MAGAZINE_CATEGORIES },
				null,
				2,
			),
		);
		process.exit(0);
	}

	if (cmd === "count") {
		const n = await countChannels();
		console.log(JSON.stringify({ collection: MAGAZINE_AGENT.channelsCollection, count: n }, null, 2));
		process.exit(0);
	}

	if (cmd === "queries") {
		const qs = filterMagazineQueries(ALL_MAGAZINE_QUERIES, {
			category,
			topic,
			platform,
		});
		console.log(JSON.stringify({ count: qs.length, queries: qs }, null, 2));
		process.exit(0);
	}

	if (cmd === "list") {
		const channels = await listChannels({
			category,
			topic,
			platform,
			limit: 50,
		});
		console.log(JSON.stringify({ count: channels.length, channels }, null, 2));
		process.exit(0);
	}

	if (cmd === "videos-list") {
		const videos = await listVideos({ category, topic, limit: 50 });
		console.log(JSON.stringify({ count: videos.length, videos }, null, 2));
		process.exit(0);
	}

	const shouldLoop = !once && cmd !== "once" && cmd !== "videos";
	if (shouldLoop) {
		const label =
			intervalMs >= 60_000
				? `${intervalMs / 60000} min`
				: `${intervalMs / 1000} sec`;
		console.log(`[magazine] loop every ${label} (Ctrl+C stop)`);
		for (;;) {
			try {
				await runOnce();
			} catch (err) {
				console.error("[magazine] run failed:", err?.message || err);
			}
			await new Promise((r) => setTimeout(r, intervalMs));
		}
		return;
	}

	await runOnce();
}

main().catch((err) => {
	console.error("[magazine] fatal:", err?.message || err);
	process.exit(1);
});
