/**
 * Platform agents — Google SERP discover, then in-process IG / X / YouTube scrapers.
 * Does not call /scrape-x HTTP (that 404s if the API process is stale).
 */

import { googleSearch } from "../contentResearch/http.js";
import { scrapeInstagramProfile } from "../socialScrapers/instagram.js";
import { scrapeXProfile } from "../socialScrapers/x.js";
import { scrapeYoutubeChannel } from "../socialScrapers/youtube.js";
import {
	candidateFromSerp,
	createSeenMap,
	seenKey,
} from "./core.js";

async function enrichOne(c) {
	if (c.platform === "instagram") {
		return scrapeInstagramProfile({
			username: c.handle,
			url: c.profileUrl,
		});
	}
	if (c.platform === "x") {
		return scrapeXProfile({
			handle: c.handle,
			url: c.profileUrl,
		});
	}
	if (c.platform === "youtube") {
		return scrapeYoutubeChannel({
			handle: c.handle,
			channelId: c.channelId,
			url: c.profileUrl,
		});
	}
	return null;
}

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
			niche: job.niche,
			query: job.query,
		});
		if (!c) continue;
		const key = seenKey(c);
		if (seen.has(key)) continue;
		seen.set(key, true);
		candidates.push(c);
	}
	return candidates;
}

export async function runXAgent(jobs, opts = {}) {
	const seen = opts.seen || createSeenMap();
	const all = [];
	for (const job of jobs.filter((j) => j.platform === "x")) {
		try {
			console.log(`[influencers:x] ${job.query}`);
			const rows = await scrapePlatformQuery(job, { ...opts, seen });
			console.log(`[influencers:x] → ${rows.length} candidates`);
			all.push(...rows);
		} catch (err) {
			console.error(`[influencers:x] failed:`, err?.message || err);
		}
	}
	return all;
}

export async function runInstagramAgent(jobs, opts = {}) {
	const seen = opts.seen || createSeenMap();
	const all = [];
	for (const job of jobs.filter((j) => j.platform === "instagram")) {
		try {
			console.log(`[influencers:ig] ${job.query}`);
			const rows = await scrapePlatformQuery(job, { ...opts, seen });
			console.log(`[influencers:ig] → ${rows.length} candidates`);
			all.push(...rows);
		} catch (err) {
			console.error(`[influencers:ig] failed:`, err?.message || err);
		}
	}
	return all;
}

export async function runYoutubeAgent(jobs, opts = {}) {
	const seen = opts.seen || createSeenMap();
	const all = [];
	for (const job of jobs.filter((j) => j.platform === "youtube")) {
		try {
			console.log(`[influencers:yt] ${job.query}`);
			const rows = await scrapePlatformQuery(job, { ...opts, seen });
			console.log(`[influencers:yt] → ${rows.length} candidates`);
			all.push(...rows);
		} catch (err) {
			console.error(`[influencers:yt] failed:`, err?.message || err);
		}
	}
	return all;
}

function applyProfile(c, extra) {
	if (!extra || extra.success === false) return c;
	return {
		...c,
		name: extra.name || c.name,
		bio: extra.bio || c.bio,
		avatar: extra.avatar || c.avatar || null,
		website: extra.website || c.website || null,
		followersCount:
			extra.followersCount != null ? extra.followersCount : c.followersCount,
		followingCount: extra.followingCount ?? c.followingCount ?? null,
		postsCount: extra.postsCount ?? c.postsCount ?? null,
		verified: Boolean(extra.verified || c.verified),
		handle: extra.handle || c.handle,
		channelId: extra.channelId || c.channelId || null,
		profileUrl: extra.profileUrl || c.profileUrl,
		loginWall: Boolean(extra.loginWall),
		enrichSource: extra.source || null,
		enrichedFrom: extra.profileUrl || extra.finalUrl || null,
	};
}

export async function enrichCandidates(candidates, opts = {}) {
	const limit = opts.limit ?? 8;
	const out = [];

	for (const c of candidates.slice(0, limit)) {
		try {
			const extra = await enrichOne(c);
			out.push(extra ? applyProfile(c, extra) : c);
		} catch (err) {
			console.warn(
				`[influencers] enrich ${c.platform}:${c.handle} failed:`,
				err?.message || err,
			);
			out.push({ ...c, enrichError: err?.message || String(err) });
		}
	}

	return [...out, ...candidates.slice(limit)];
}
