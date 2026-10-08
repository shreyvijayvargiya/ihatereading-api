#!/usr/bin/env node
/**
 * Scrape longer videos from a YouTube channel, join each transcript into one
 * script, and store it in Firestore. Loops every 8 seconds, 4–10 videos per tick.
 *
 *   npm run yt:scripts -- --channel https://www.youtube.com/@channel
 *   npm run yt:scripts:once -- --channel https://www.youtube.com/@channel
 *   npm run yt:scripts -- --channel URL --batch 6 --min-seconds 180
 */

import "dotenv/config";
import {
	GREG_ISENBERG_CHANNEL,
	GREG_ISENBERG_COLLECTION,
	clampBatch,
	intervalMs,
	listYoutubeScripts,
	minDurationSeconds,
	resolveYoutubeChannel,
	runYoutubeChannelScriptsBatch,
} from "../lib/youtubeChannelScripts/core.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "run").toLowerCase();

function flag(name) {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

const once = args.includes("--once") || cmd === "once" || args.includes("--no-loop");
const resolvedChannel = resolveYoutubeChannel({
	collection: flag("--collection") || process.env.YT_SCRIPTS_COLLECTION,
	channelUrl: flag("--channel") || flag("--url") || process.env.YT_CHANNEL_URL,
});
const channelUrl = resolvedChannel.channelUrl;
const collection = resolvedChannel.collection;
const batchSize = clampBatch(flag("--batch") || process.env.YT_SCRIPTS_BATCH);
const minSeconds = minDurationSeconds(
	flag("--min-seconds") || process.env.YT_SCRIPTS_MIN_SECONDS,
);
const waitMs = intervalMs(flag("--interval") || process.env.YT_SCRIPTS_INTERVAL_MS || 8000);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce() {
	if (!channelUrl) {
		console.error("Pass --channel https://www.youtube.com/@handle");
		process.exit(1);
	}
	console.log(
		`[yt-scripts] channel=${channelUrl} batch=${batchSize} min=${minSeconds}s collection=${collection}`,
	);
	const summary = await runYoutubeChannelScriptsBatch({
		channelUrl,
		collection,
		batchSize,
		minSeconds,
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function main() {
	if (cmd === "help" || cmd === "--help" || args.includes("--help")) {
		console.log(`YouTube channel transcripts → Firestore

  npm run yt:scripts -- --channel https://www.youtube.com/@channel
  npm run yt:scripts:once -- --channel https://www.youtube.com/@channel
  npm run yt:scripts -- --channel URL --batch 8 --min-seconds 180
  npm run yt:scripts:greg
  npm run yt:scripts:greg:once
  npm run yt:scripts -- list --collection GregIsenberg

Collections:
  sir-deepanshu-giri-videos-scripts
  ${GREG_ISENBERG_COLLECTION}  ${GREG_ISENBERG_CHANNEL}
Each tick fetches 4–10 longer videos and requests transcripts in parallel.
Caption lines are joined into one script field per video.
Loop interval is 8 seconds. Does not start with the API server.

Env:
  YT_CHANNEL_URL   default Lunar Astro (Deepanshu Giri)
  YT_SCRIPTS_BATCH=8          (clamped 4–10)
  YT_SCRIPTS_MIN_SECONDS=180  (skip shorter videos when duration is known)
  YT_SCRIPTS_INTERVAL_MS=8000
`);
		process.exit(0);
	}

	if (cmd === "list") {
		const listed = await listYoutubeScripts({
			limit: flag("--limit") || 40,
			collection,
		});
		console.log(JSON.stringify(listed, null, 2));
		process.exit(0);
	}

	if (!once) {
		console.log(
			`[yt-scripts] loop every ${waitMs / 1000}s, ${batchSize} videos (Ctrl+C to stop)`,
		);
		for (;;) {
			const started = Date.now();
			try {
				const summary = await runOnce();
				if (summary.exhausted && summary.pending === 0 && summary.batch === 0) {
					console.log("[yt-scripts] channel caught up — still polling for new uploads");
				}
			} catch (err) {
				console.error("[yt-scripts] run failed:", err?.message || err);
			}
			const elapsed = Date.now() - started;
			console.log(
				`[yt-scripts] sleeping ${waitMs / 1000}s (last tick ${Math.round(elapsed / 1000)}s)…`,
			);
			await sleep(waitMs);
		}
	}

	await runOnce();
}

main().catch((err) => {
	console.error("[yt-scripts] fatal:", err?.message || err);
	process.exit(1);
});
