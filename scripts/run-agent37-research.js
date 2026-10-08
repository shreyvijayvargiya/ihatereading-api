#!/usr/bin/env node
/**
 * Agent37.com multi-source topic research CLI.
 *
 *   npm run agent37:research
 *   npm run agent37:research -- --site agent37-com --limit 20
 *   npm run agent37:research -- --sources reddit,linkedin,x,web
 */

import "dotenv/config";
import { hasOpenRouterKey } from "../lib/useAi.js";
import { resolveResearchBaseUrl } from "../lib/contentResearch/http.js";
import { runAgent37MultiSourceResearch } from "../lib/content/services/agent37-multi-source-research.js";

const args = process.argv.slice(2);
const hasLoop = args.includes("--loop");
const intervalMs = Number(process.env.AGENT37_RESEARCH_INTERVAL_MS || 3_600_000);

function flag(name) {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

const baseUrl =
	process.env.SCRAPE_API_BASE_URL ||
	process.env.INKGEST_SCRAPE_BASE_URL ||
	`http://127.0.0.1:${process.env.PORT || 3002}`;

async function runOnce() {
	if (!hasOpenRouterKey()) {
		console.error("OPENROUTER_API_KEY is required");
		process.exit(1);
	}

	const siteId = flag("--site") || flag("--siteId") || "agent37-com";
	const limit = Number(flag("--limit") || 20);
	const sourcesRaw = flag("--sources");
	const sources = sourcesRaw
		? sourcesRaw.split(",").map((s) => s.trim()).filter(Boolean)
		: undefined;

	console.log(
		`[agent37] site=${siteId} limit=${limit} sources=${sources?.join("+") || "all"} base=${baseUrl}`,
	);

	const summary = await runAgent37MultiSourceResearch(siteId, {
		baseUrl,
		limit,
		sources,
		refreshContent: !args.includes("--no-refresh"),
		scrapeLimit: flag("--scrape-limit") ? Number(flag("--scrape-limit")) : undefined,
	});

	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`Agent37 multi-source topic research

Enroll first:
  npm run content:intelligence -- enroll --name "Agent37" --domain https://agent37.com

Run:
  npm run agent37:research
  npm run agent37:research -- --site agent37-com --limit 20
  npm run agent37:research -- --sources reddit,linkedin,x,web
  npm run agent37:research -- --loop

HTTP:
  POST /agent37-research-topics
  { "siteId": "agent37-com", "limit": 20, "sources": ["reddit","linkedin","x","web"] }
`);
		return;
	}

	if (!hasLoop) {
		await runOnce();
		return;
	}

	console.log(`[agent37] loop every ${intervalMs / 1000}s (Ctrl+C to stop)`);
	for (;;) {
		try {
			await runOnce();
		} catch (err) {
			console.error("[agent37]", err?.message || err);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
