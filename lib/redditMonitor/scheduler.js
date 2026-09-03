/**
 * Reddit monitor in-process scheduler (local / long-running Node only).
 * On Vercel, use Upstash QStash → POST /reddit/run every 30 min instead.
 */

import { runRedditMonitor } from "../jobs/redditMonitor.js";

const FETCH_INTERVAL_MS = Number(
	process.env.REDDIT_FETCH_INTERVAL_MS || 30 * 60 * 1000,
);

let fetchTimer = null;

function isEnabled() {
	// Serverless: Vercel Cron owns the schedule
	if (process.env.VERCEL === "1") return false;
	if (process.env.REDDIT_SIGNAL_ENABLED === "false") return false;
	return true;
}

export function startRedditMonitorScheduler() {
	if (!isEnabled()) {
		const reason =
			process.env.VERCEL === "1"
				? "VERCEL=1 — use Upstash QStash → POST /reddit/run"
				: "REDDIT_SIGNAL_ENABLED=false";
		console.log(`[reddit-monitor] in-process scheduler skipped (${reason})`);
		return;
	}
	if (fetchTimer) return;

	console.log(
		`[reddit-monitor] scheduler starting (every ${FETCH_INTERVAL_MS / 60000} min)`,
	);

	fetchTimer = setInterval(() => {
		runRedditMonitor().catch((err) => {
			console.error("[reddit-monitor] scheduled run failed:", err?.message || err);
		});
	}, FETCH_INTERVAL_MS);

	setTimeout(() => {
		runRedditMonitor().catch((err) => {
			console.error("[reddit-monitor] initial run failed:", err?.message || err);
		});
	}, 8_000);
}

export function stopRedditMonitorScheduler() {
	if (fetchTimer) clearInterval(fetchTimer);
	fetchTimer = null;
}

export function isRedditMonitorSchedulerRunning() {
	return Boolean(fetchTimer);
}

/** @deprecated use startRedditMonitorScheduler */
export const startRedditSignalScheduler = startRedditMonitorScheduler;
