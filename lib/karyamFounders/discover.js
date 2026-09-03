/**
 * Google SERP discovery for Karyam founder leads.
 */

import { googleSearch } from "../contentResearch/http.js";
import {
	candidateFromSerp,
	createSeenMap,
	isJunkHost,
	seenKey,
} from "./core.js";

export async function scrapeQuery(job, opts = {}) {
	const results = await googleSearch(job.query, {
		baseUrl: opts.baseUrl,
		num: opts.num || 8,
		country: job.country || opts.country || "us",
		language: "en",
	});

	const seen = opts.seen || createSeenMap();
	const candidates = [];

	for (const row of results) {
		const c = candidateFromSerp(row, {
			intent: job.intent,
			query: job.query,
			queryId: job.id,
			country: job.country,
		});
		if (!c.sourceUrl) continue;
		if (isJunkHost(c.sourceUrl) && !c.linkedinUrl && !c.email) continue;

		const key = seenKey(c);
		if (seen.has(key)) continue;
		seen.set(key, true);
		candidates.push(c);
	}

	return candidates;
}

export async function runGoogleDiscovery(jobs, opts = {}) {
	const seen = opts.seen || createSeenMap();
	const all = [];
	for (const job of jobs) {
		try {
			console.log(`[karyam-founders] google ${job.id}: ${job.query}`);
			const rows = await scrapeQuery(job, { ...opts, seen });
			console.log(`[karyam-founders] → ${rows.length} candidates`);
			all.push(...rows);
		} catch (err) {
			console.error(
				`[karyam-founders] query failed ${job.id}:`,
				err?.message || err,
			);
		}
	}
	return all;
}
