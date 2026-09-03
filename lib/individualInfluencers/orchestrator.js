/**
 * Individual influencers orchestrator.
 * Discover (Google) → enrich (/scrape-instagram, /scrape-x, /scrape-youtube-channel)
 * → LLM person+tags → Firestore individual-influencers.
 * CLI / POST only — does NOT auto-start on npm run dev.
 */

import { isUseAiOn } from "../useAi.js";
import { ALL_QUERIES, INFLUENCER_AGENT } from "./configs.js";
import {
	countInfluencers,
	createSeenMap,
	influencerDocId,
	influencerExists,
	listInfluencers,
	loadQueryCursor,
	looksLikeBrandHandle,
	purifyInfluencersWithLlm,
	saveInfluencer,
	saveQueryCursor,
	seenKey,
} from "./core.js";
import {
	enrichCandidates,
	runInstagramAgent,
	runXAgent,
	runYoutubeAgent,
} from "./platforms.js";

/**
 * @param {{
 *   baseUrl?: string,
 *   queriesPerRun?: number,
 *   platform?: "x" | "instagram" | "youtube",
 *   niche?: string,
 *   enrich?: boolean,
 *   useAI?: boolean,
 * }} [opts]
 */
export async function runIndividualInfluencersAgent(opts = {}) {
	const agent = INFLUENCER_AGENT;
	const baseUrl = opts.baseUrl;
	const perRun = opts.queriesPerRun ?? agent.queriesPerRun ?? 3;
	const doEnrich = opts.enrich !== false;
	const useAI = isUseAiOn(opts);
	const minFollowers = agent.minFollowers;

	const existingCount = await countInfluencers(agent.collection);
	const summary = {
		agentId: agent.id,
		collection: agent.collection,
		existingCount,
		targetCount: agent.targetCount,
		atCapacity: existingCount >= agent.targetCount,
		queriesRun: 0,
		platforms: { x: 0, instagram: 0, youtube: 0 },
		candidates: 0,
		newProfiles: 0,
		useAI,
		enriched: 0,
		saved: 0,
		rejected: 0,
		belowFollowers: 0,
		people: [],
		errors: [],
	};

	if (existingCount >= agent.targetCount) {
		console.log(
			`[influencers] at capacity (${existingCount}/${agent.targetCount})`,
		);
		return summary;
	}

	let queryPool = ALL_QUERIES;
	if (opts.platform) {
		const p = String(opts.platform).toLowerCase();
		queryPool = queryPool.filter((q) => q.platform === p);
	}
	if (opts.niche) {
		const n = String(opts.niche).toLowerCase();
		queryPool = queryPool.filter((q) =>
			String(q.niche || "").toLowerCase().includes(n),
		);
		if (!queryPool.length) queryPool = ALL_QUERIES;
	}
	if (!queryPool.length) {
		throw new Error("No influencer search queries for selected platform");
	}

	const cursor = await loadQueryCursor(agent.stateCollection, agent.id);
	const batch = [];
	for (let i = 0; i < perRun; i++) {
		const idx = (cursor + i) % queryPool.length;
		batch.push({ ...queryPool[idx], queryIndex: idx });
	}
	const nextCursor = (cursor + perRun) % queryPool.length;
	await saveQueryCursor(agent.stateCollection, agent.id, nextCursor);
	summary.queriesRun = batch.length;
	summary.queryCursor = { from: cursor, to: nextCursor, total: queryPool.length };

	const seen = createSeenMap();
	const agentOpts = { baseUrl, seen };

	let fromX = [];
	let fromIg = [];
	let fromYt = [];
	try {
		fromX = await runXAgent(batch, agentOpts);
		summary.platforms.x = fromX.length;
	} catch (err) {
		summary.errors.push({ platform: "x", error: err?.message || String(err) });
	}
	try {
		fromIg = await runInstagramAgent(batch, agentOpts);
		summary.platforms.instagram = fromIg.length;
	} catch (err) {
		summary.errors.push({
			platform: "instagram",
			error: err?.message || String(err),
		});
	}
	try {
		fromYt = await runYoutubeAgent(batch, agentOpts);
		summary.platforms.youtube = fromYt.length;
	} catch (err) {
		summary.errors.push({
			platform: "youtube",
			error: err?.message || String(err),
		});
	}

	const merged = [];
	const mergeSeen = createSeenMap();
	for (const c of [...fromX, ...fromIg, ...fromYt]) {
		const k = seenKey(c);
		if (mergeSeen.has(k)) continue;
		mergeSeen.set(k, true);
		merged.push(c);
	}
	summary.candidates = merged.length;

	const fresh = [];
	for (const c of merged) {
		if (looksLikeBrandHandle(c.handle, c.name)) continue;
		const exists = await influencerExists(agent.collection, c);
		if (exists) continue;
		fresh.push(c);
	}

	let enriched = fresh;
	if (doEnrich && fresh.length) {
		console.log(
			`[influencers] enriching up to ${agent.enrichPerRun} of ${fresh.length} new`,
		);
		enriched = await enrichCandidates(fresh, {
			baseUrl,
			limit: agent.enrichPerRun,
		});
		summary.enriched = Math.min(agent.enrichPerRun, fresh.length);
	}

	const toScore = [];
	for (const c of enriched) {
		if (
			c.followersCount != null &&
			Number(c.followersCount) < minFollowers
		) {
			summary.belowFollowers += 1;
			continue;
		}
		toScore.push({
			...c,
			id: influencerDocId(c),
			fetchedAt: new Date().toISOString(),
			relevanceScore: 0,
			relevanceReason: "",
			tags: c.niche ? [c.niche] : [],
			category: c.niche || "",
			isPerson: true,
			reject: false,
			scored: false,
		});
	}
	summary.newProfiles = toScore.length;

	for (let i = 0; i < toScore.length; i += agent.scoreBatchSize) {
		const chunk = toScore.slice(i, i + agent.scoreBatchSize);
		const scored = useAI
			? await purifyInfluencersWithLlm(chunk, agent)
			: [];
		if (!useAI) {
			console.log(
				`[influencers] scrape-only ${chunk.length} (pass --use-ai to purify)`,
			);
		}
		for (const row of chunk) {
			const match = scored.find((s) => s.id === row.id) || {};
			const reject = useAI
				? Boolean(match?.reject) || match?.isPerson === false
				: false;
			row.name = match?.name || row.name;
			row.bio = match?.bio || row.bio;
			row.tags = Array.isArray(match?.tags) && match.tags.length
				? match.tags
				: row.tags;
			row.category = match?.category || row.category;
			row.isPerson = reject ? false : match?.isPerson !== false;
			row.reject = reject;
			row.rejectReason = match?.rejectReason || "";
			row.relevanceScore = Number(match?.relevanceScore) || 0;
			row.relevanceReason = match?.relevanceReason || (useAI ? "" : "scrape_only");
			row.scored = useAI;
			row.scoredAt = useAI ? new Date().toISOString() : null;

			if (reject || row.isPerson === false) {
				summary.rejected += 1;
				continue;
			}

			await saveInfluencer(agent.collection, row);
			summary.saved += 1;
			if (!useAI || row.relevanceScore >= (agent.relevanceMin ?? 3)) {
				summary.people.push({
					id: row.id,
					name: row.name,
					handle: row.handle,
					platform: row.platform,
					profileUrl: row.profileUrl,
					followersCount: row.followersCount,
					tags: row.tags,
					category: row.category,
					relevanceScore: row.relevanceScore,
					bio: row.bio,
				});
			}
		}
	}

	summary.finalCount = await countInfluencers(agent.collection);
	console.log(
		`[influencers] done — discovered ${summary.candidates}, saved ${summary.saved} → ${agent.collection} (${summary.finalCount}/${agent.targetCount})`,
	);
	return summary;
}

export { listInfluencers, countInfluencers, ALL_QUERIES, INFLUENCER_AGENT };
