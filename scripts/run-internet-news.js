#!/usr/bin/env node
/**
 * iHateReading internet news — programming, startups, SaaS, funding.
 *
 *   npm run news:ihatereading
 *   npm run news:ihatereading:once
 *   npm run news:ihatereading -- --platform hackernews
 *   npm run news:ihatereading -- --keyword "series A"
 */

import "dotenv/config";
import {
	INTERNET_NEWS_AGENT,
	NEWS_KEYWORDS,
	NEWS_PLATFORMS,
	keywordQuery,
	listPlatformIds,
	resolvePlatform,
} from "../lib/internetNews/configs.js";
import {
	countArticles,
	listArticles,
	runInternetNewsAgent,
} from "../lib/internetNews/orchestrator.js";
import { cliWantsUseAi } from "../lib/useAi.js";

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
const keyword = flag("--keyword");
const urlsPerPlatform = flag("--urls") ? Number(flag("--urls")) : undefined;
const platformsPerRun = flag("--platforms")
	? Number(flag("--platforms"))
	: undefined;
const intervalMs = Number(process.env.NEWS_INTERVAL_MS || 30 * 1000);

async function runOnce() {
	if (platform && !resolvePlatform(platform)) {
		console.error(
			`Unknown platform "${platform}". Use: ${listPlatformIds().join(", ")} (techbase → techcrunch)`,
		);
		process.exit(1);
	}
	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;
	console.log(
		`[internet-news] platform=${platform || "rotate-4"} keyword=${keyword || "auto"} urls=${urlsPerPlatform || INTERNET_NEWS_AGENT.urlsPerPlatform} llm=${useAI ? "ignored (no LLM layer)" : "off"} base=${baseUrl}`,
	);
	const summary = await runInternetNewsAgent({
		baseUrl,
		platform,
		keyword,
		urlsPerPlatform,
		platformsPerRun,
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		console.log(`iHateReading internet news

  npm run news:ihatereading
  npm run news:ihatereading:once
  npm run news:ihatereading -- --platform hackernews
  npm run news:ihatereading -- --platform techbase
  npm run news:ihatereading -- --keyword "ihatereading.in"
  npm run news:ihatereading -- once --urls 20 --platforms 4
  npm run news:ihatereading -- list
  npm run news:ihatereading -- platforms

Collection: ${INTERNET_NEWS_AGENT.collection}
No AI — tags/category come from the platform and Google News keyword. --use-ai is ignored.
Platforms (${NEWS_PLATFORMS.length}): ${listPlatformIds().join(", ")}
Google News keywords rotate: ${NEWS_KEYWORDS.slice(0, 6).map(keywordQuery).join("; ")}…

Env:
  NEWS_INTERVAL_MS=30000
  NEWS_PLATFORMS_PER_RUN=4
  NEWS_URLS_PER_PLATFORM=15   (clamped 10–20)
  SCRAPE_API_BASE_URL=http://localhost:3002
`);
		process.exit(0);
	}

	if (cmd === "platforms") {
		console.log(
			JSON.stringify(
				NEWS_PLATFORMS.map((p) => ({
					id: p.id,
					name: p.name,
					listUrl: p.listUrl,
					aliases: p.aliases || [],
					category: p.category,
					tags: p.tags || [],
				})),
				null,
				2,
			),
		);
		process.exit(0);
	}

	if (cmd === "count") {
		const n = await countArticles();
		console.log(
			JSON.stringify({ collection: INTERNET_NEWS_AGENT.collection, count: n }, null, 2),
		);
		process.exit(0);
	}

	if (cmd === "list") {
		const articles = await listArticles(INTERNET_NEWS_AGENT.collection, {
			platform: flag("--platform") || platform,
			tag: flag("--tag"),
			category: flag("--category"),
			limit: 40,
		});
		console.log(JSON.stringify({ count: articles.length, articles }, null, 2));
		process.exit(0);
	}

	if (!once) {
		console.log(
			`[internet-news] loop every ${intervalMs / 1000}s × ${INTERNET_NEWS_AGENT.platformsPerRun} platforms (Ctrl+C stop)`,
		);
		for (;;) {
			const started = Date.now();
			try {
				await runOnce();
			} catch (err) {
				console.error("[internet-news] run failed:", err?.message || err);
			}
			const elapsed = Date.now() - started;
			console.log(
				`[internet-news] sleeping ${intervalMs / 1000}s (last tick ${Math.round(elapsed / 1000)}s)…`,
			);
			await new Promise((r) => setTimeout(r, intervalMs));
		}
	}

	await runOnce();
}

main().catch((err) => {
	console.error("[internet-news] fatal:", err?.message || err);
	process.exit(1);
});
