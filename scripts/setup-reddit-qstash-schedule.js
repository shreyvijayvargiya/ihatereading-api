/**
 * Create (or list) an Upstash QStash schedule that POSTs /reddit/run every 30 minutes.
 *
 * Usage:
 *   REDDIT_MONITOR_URL=https://your-api.vercel.app/reddit/run \
 *   QSTASH_TOKEN=... \
 *   node scripts/setup-reddit-qstash-schedule.js
 *
 * Env (from Upstash Console → QStash):
 *   QSTASH_TOKEN
 *   QSTASH_CURRENT_SIGNING_KEY  (for the API to verify — set on Vercel)
 *   QSTASH_NEXT_SIGNING_KEY     (for the API to verify — set on Vercel)
 *   REDDIT_MONITOR_URL          (public URL of POST /reddit/run)
 */

import "dotenv/config";
import { Client } from "@upstash/qstash";

const destination = (
	process.env.REDDIT_MONITOR_URL ||
	process.env.API_BASE_URL ||
	""
)
	.trim()
	.replace(/\/$/, "");

const cron = process.env.REDDIT_QSTASH_CRON || "*/30 * * * *";
const token = process.env.QSTASH_TOKEN?.trim();

async function main() {
	if (!token) {
		console.error("Missing QSTASH_TOKEN (Upstash Console → QStash → API key)");
		process.exit(1);
	}
	if (!destination || !/^https:\/\//i.test(destination)) {
		console.error(
			"Set REDDIT_MONITOR_URL to your public HTTPS endpoint, e.g. https://api.example.com/reddit/run",
		);
		process.exit(1);
	}

	const url = destination.endsWith("/reddit/run")
		? destination
		: `${destination}/reddit/run`;

	const client = new Client({ token });

	const existing = await client.schedules.list();
	const already = existing.filter(
		(s) => s.destination === url || s.cron === cron,
	);
	if (already.length) {
		console.log("Existing schedule(s) matching this destination/cron:");
		for (const s of already) {
			console.log(`  - ${s.scheduleId} cron=${s.cron} → ${s.destination}`);
		}
		const sameDest = already.find((s) => s.destination === url);
		if (sameDest) {
			console.log(
				`\nAlready scheduled. To recreate, delete ${sameDest.scheduleId} in the Upstash console first.`,
			);
			return;
		}
	}

	const schedule = await client.schedules.create({
		destination: url,
		cron,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ source: "qstash-reddit-monitor" }),
		retries: 2,
	});

	console.log("Created QStash schedule:");
	console.log(`  scheduleId: ${schedule.scheduleId}`);
	console.log(`  cron:       ${cron}`);
	console.log(`  destination:${url}`);
	console.log(
		"\nEnsure Vercel env has QSTASH_CURRENT_SIGNING_KEY + QSTASH_NEXT_SIGNING_KEY",
	);
	console.log("and functions.maxDuration is high enough (vercel.json → 300).");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
