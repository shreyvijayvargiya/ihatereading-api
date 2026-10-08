/**
 * Google Search + Google Maps discovery for outbound prospects.
 */

import { googleSearch } from "../contentResearch/http.js";
import { fetchMapsPlaces } from "../mapsAgents/core.js";
import {
	candidateFromMapsPlace,
	candidateFromSerp,
	createSeenMap,
	isJunkHost,
	seenKey,
} from "./core.js";

export async function discoverGoogleJob(job, opts = {}) {
	const results = await googleSearch(job.query, {
		baseUrl: opts.baseUrl,
		num: opts.num || 8,
		country: job.country || "us",
		language: "en",
		skipPuppeteer: opts.skipPuppeteer !== false,
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
		c.brand = job.brand;
		c.channel = "google";
		c.jobId = job.id;
		if (!c.sourceUrl) continue;
		if (isJunkHost(c.sourceUrl) && !c.linkedinUrl && !c.email) continue;
		const key = seenKey(c);
		if (seen.has(key)) continue;
		seen.set(key, true);
		candidates.push(c);
	}

	return candidates;
}

export async function discoverMapsJob(job, opts = {}) {
	const places = await fetchMapsPlaces(job.query, opts.baseUrl);
	const seen = opts.seen || createSeenMap();
	const candidates = [];

	for (const raw of places) {
		const c = candidateFromMapsPlace(raw, job);
		if (!c.name && !c.phone && !c.website) continue;
		const key = seenKey(c);
		if (seen.has(key)) continue;
		seen.set(key, true);
		candidates.push(c);
	}

	return candidates;
}

export async function runDiscoveryJobs(jobs, opts = {}) {
	const seen = opts.seen || createSeenMap();
	const all = [];

	for (const job of jobs) {
		try {
			console.log(
				`[outbound-prospects] ${job.channel} ${job.id} (${job.country}): ${job.query}`,
			);
			const rows =
				job.channel === "maps"
					? await discoverMapsJob(job, { ...opts, seen })
					: await discoverGoogleJob(job, { ...opts, seen });
			console.log(`[outbound-prospects] → ${rows.length} candidates`);
			all.push(...rows);
		} catch (err) {
			console.error(
				`[outbound-prospects] job failed ${job.id}:`,
				err?.message || err,
			);
		}
	}

	return all;
}
