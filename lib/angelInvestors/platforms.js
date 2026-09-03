/**
 * Platform scrapers — X, LinkedIn, Google via Google SERP (+ optional page enrich).
 */

import { googleSearch } from "../contentResearch/http.js";
import {
	candidateFromSerp,
	createSeenMap,
	enrichFromUrl,
	seenKey,
} from "./core.js";

/**
 * Run Google SERP for one query and return normalized candidates.
 */
export async function scrapePlatformQuery(job, opts = {}) {
	const results = await googleSearch(job.query, {
		baseUrl: opts.baseUrl,
		num: opts.num || 8,
		country: opts.country || "us",
		language: "en",
	});

	const seen = opts.seen || createSeenMap();
	const candidates = [];

	for (const row of results) {
		const c = candidateFromSerp(row, {
			platform: job.platform,
			sector: job.sector,
			query: job.query,
		});
		if (!c.sourceUrl && !c.xHandle && !c.linkedinHandle) continue;

		const key = seenKey(c);
		if (seen.has(key)) continue;
		seen.set(key, true);
		candidates.push(c);
	}

	return candidates;
}

/**
 * X.com agent — site:x.com / twitter angel investor searches.
 */
export async function runXAgent(jobs, opts = {}) {
	const seen = opts.seen || createSeenMap();
	const all = [];
	for (const job of jobs.filter((j) => j.platform === "x")) {
		try {
			console.log(`[angel:x] ${job.query}`);
			const rows = await scrapePlatformQuery(job, { ...opts, seen });
			console.log(`[angel:x] → ${rows.length} candidates`);
			all.push(...rows);
		} catch (err) {
			console.error(`[angel:x] failed:`, err?.message || err);
		}
	}
	return all;
}

/**
 * LinkedIn agent — site:linkedin.com/in angel / seed searches.
 */
export async function runLinkedInAgent(jobs, opts = {}) {
	const seen = opts.seen || createSeenMap();
	const all = [];
	for (const job of jobs.filter((j) => j.platform === "linkedin")) {
		try {
			console.log(`[angel:linkedin] ${job.query}`);
			const rows = await scrapePlatformQuery(job, { ...opts, seen });
			console.log(`[angel:linkedin] → ${rows.length} candidates`);
			all.push(...rows);
		} catch (err) {
			console.error(`[angel:linkedin] failed:`, err?.message || err);
		}
	}
	return all;
}

/**
 * Google agent — broader directories / contact pages, then scrape pages for contacts.
 */
export async function runGoogleAgent(jobs, opts = {}) {
	const seen = opts.seen || createSeenMap();
	const all = [];
	for (const job of jobs.filter((j) => j.platform === "google")) {
		try {
			console.log(`[angel:google] ${job.query}`);
			const rows = await scrapePlatformQuery(job, { ...opts, seen });
			console.log(`[angel:google] → ${rows.length} candidates`);
			all.push(...rows);
		} catch (err) {
			console.error(`[angel:google] failed:`, err?.message || err);
		}
	}
	return all;
}

/**
 * Enrich candidates: prefer personal website, else LinkedIn/X URL via /scrape.
 */
export async function enrichCandidates(candidates, opts = {}) {
	const limit = opts.limit ?? 8;
	const baseUrl = opts.baseUrl;
	const out = [];

	for (const c of candidates.slice(0, limit)) {
		const targets = [
			c.website,
			c.linkedinUrl,
			c.xUrl,
			c.sourceUrl,
		].filter(Boolean);

		let enriched = { ...c };
		for (const url of targets.slice(0, 2)) {
			const extra = await enrichFromUrl(url, baseUrl);
			if (extra.enrichError) continue;
			enriched = {
				...enriched,
				emails: [...new Set([...(enriched.emails || []), ...(extra.emails || [])])],
				email: enriched.email || extra.email || null,
				phones: [...new Set([...(enriched.phones || []), ...(extra.phones || [])])],
				phone: enriched.phone || extra.phone || null,
				xHandle: enriched.xHandle || extra.xHandle || null,
				xUrl: enriched.xUrl || extra.xUrl || null,
				linkedinHandle: enriched.linkedinHandle || extra.linkedinHandle || null,
				linkedinUrl: enriched.linkedinUrl || extra.linkedinUrl || null,
				website: enriched.website || extra.website || null,
				enrichedFrom: extra.enrichedFrom || enriched.enrichedFrom || null,
			};
			if (enriched.email || enriched.phone) break;
		}
		out.push(enriched);
	}

	// Pass through remaining without enrich (still score/store)
	return [...out, ...candidates.slice(limit)];
}
