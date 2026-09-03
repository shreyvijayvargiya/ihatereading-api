/**
 * Discover magazine creators (Google → YT/X scrape → LLM) then latest videos.
 */

import { isUseAiOn } from "../useAi.js";
import { googleSearch } from "../contentResearch/http.js";
import { scrapeXProfile } from "../socialScrapers/x.js";
import { scrapeYoutubeChannel } from "../socialScrapers/youtube.js";
import {
	candidateFromSerp,
	createSeenMap,
	seenKey,
} from "../individualInfluencers/core.js";
import {
	ALL_MAGAZINE_QUERIES,
	MAGAZINE_AGENT,
	filterMagazineQueries,
	listCategoryIds,
	resolveCategory,
	resolveTopic,
} from "./configs.js";
import {
	channelDocId,
	channelExists,
	classifyMagazineCreators,
	countChannels,
	listChannels,
	loadQueryCursor,
	saveChannel,
	saveQueryCursor,
	saveVideo,
} from "./core.js";
import { fetchLatestYoutubeVideos } from "./videos.js";

async function discoverQuery(job, opts) {
	const results = await googleSearch(job.query, {
		baseUrl: opts.baseUrl,
		num: 8,
		country: "us",
		language: "en",
	});
	const seen = opts.seen;
	const candidates = [];
	for (const row of results) {
		const c = candidateFromSerp(row, {
			platform: job.platform,
			niche: job.topic,
			query: job.query,
		});
		if (!c) continue;
		c.categoryId = job.categoryId;
		c.category = job.category;
		c.topic = job.topic;
		c.topics = [job.topic];
		const key = seenKey(c);
		if (seen.has(key)) continue;
		seen.set(key, true);
		candidates.push(c);
	}
	return candidates;
}

async function enrichOne(c) {
	if (c.platform === "x") {
		return scrapeXProfile({ handle: c.handle, url: c.profileUrl });
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

function applyProfile(c, extra) {
	if (!extra || extra.success === false) return c;
	return {
		...c,
		name: extra.name || c.name,
		bio: extra.bio || extra.description || c.bio,
		avatar: extra.avatar || c.avatar || null,
		followersCount:
			extra.followersCount != null ? extra.followersCount : c.followersCount,
		postsCount: extra.postsCount ?? c.postsCount ?? null,
		handle: extra.handle || c.handle,
		channelId: extra.channelId || c.channelId || null,
		profileUrl: extra.profileUrl || c.profileUrl,
		enrichSource: extra.source || null,
	};
}

async function storeVideosForChannel(channel, meta = {}) {
	if (channel.platform !== "youtube") return { saved: 0, videos: [] };
	const got = await fetchLatestYoutubeVideos({
		handle: channel.handle,
		channelId: channel.channelId,
		max: MAGAZINE_AGENT.videosPerChannel,
	});
	const saved = [];
	const channelId = channelDocId(channel);
	for (const v of got.videos || []) {
		await saveVideo({
			...v,
			channelDocId: channelId,
			channelHandle: channel.handle || null,
			channelName: channel.name || null,
			ytChannelId: got.channelId || channel.channelId || null,
			categoryId: meta.categoryId || channel.categoryId,
			topic: meta.topic || channel.topic || null,
			platform: "youtube",
		});
		saved.push(v.videoId);
	}
	if (got.channelId && !channel.channelId) {
		await saveChannel({ ...channel, channelId: got.channelId });
	}
	return { saved: saved.length, videos: saved, source: got.source };
}

/**
 * @param {{
 *   baseUrl?: string,
 *   category?: string,
 *   topic?: string,
 *   platform?: "youtube" | "x",
 *   enrich?: boolean,
 *   fetchVideos?: boolean,
 *   videosOnly?: boolean,
 *   useAI?: boolean,
 * }} [opts]
 */
export async function runDevMagazineAgent(opts = {}) {
	const agent = MAGAZINE_AGENT;
	const useAI = isUseAiOn(opts);
	const cat = opts.category ? resolveCategory(opts.category) : null;
	if (opts.category && !cat) {
		throw new Error(
			`Unknown category "${opts.category}". Use: ${listCategoryIds().join(", ")}`,
		);
	}
	if (opts.topic && cat && !resolveTopic(cat, opts.topic)) {
		throw new Error(
			`Unknown topic "${opts.topic}" for ${cat.id}. Topics: ${cat.topics.join(", ")}`,
		);
	}

	if (opts.videosOnly) {
		const videoPass = await runMagazineVideosPass(opts);
		if (videoPass.channels > 0) return videoPass;
		console.log(
			"[dev-magazine] no YouTube channels in Firestore yet — discovering via Google (YouTube + X). Omit --videos to do this every tick.",
		);
	}

	const queryPool = filterMagazineQueries(ALL_MAGAZINE_QUERIES, {
		category: opts.category,
		topic: opts.topic,
		platform: opts.platform,
	});
	if (!queryPool.length) {
		throw new Error("No magazine queries for that category/topic/platform");
	}

	const stateId = [
		agent.id,
		cat?.id || "all",
		opts.topic || "all",
		opts.platform || "all",
	].join(":");
	const perRun = opts.queriesPerRun ?? agent.queriesPerRun;
	const cursor = await loadQueryCursor(stateId);
	const batch = [];
	for (let i = 0; i < perRun; i++) {
		const idx = (cursor + i) % queryPool.length;
		batch.push({ ...queryPool[idx], queryIndex: idx });
	}
	await saveQueryCursor(stateId, (cursor + perRun) % queryPool.length);

	const summary = {
		agentId: agent.id,
		collection: agent.channelsCollection,
		videosCollection: agent.videosCollection,
		category: cat?.id || null,
		topic: opts.topic || null,
		platform: opts.platform || null,
		queriesRun: batch.map((q) => q.query),
		candidates: 0,
		saved: 0,
		rejected: 0,
		videosSaved: 0,
		channels: [],
		errors: [],
	};

	const seen = createSeenMap();
	const merged = [];
	for (const job of batch) {
		try {
			console.log(
				`[dev-magazine] google ${job.platform} ${job.categoryId}/${job.topic}: ${job.query}`,
			);
			const rows = await discoverQuery(job, { baseUrl: opts.baseUrl, seen });
			merged.push(...rows);
		} catch (err) {
			summary.errors.push({
				query: job.query,
				error: err?.message || String(err),
			});
		}
	}
	summary.candidates = merged.length;

	const fresh = [];
	for (const c of merged) {
		if (await channelExists(c)) continue;
		fresh.push(c);
	}

	let enriched = fresh;
	if (opts.enrich !== false && fresh.length) {
		const limit = agent.enrichPerRun;
		const out = [];
		for (const c of fresh.slice(0, limit)) {
			try {
				const extra = await enrichOne(c);
				out.push(extra ? applyProfile(c, extra) : c);
			} catch (err) {
				out.push({ ...c, enrichError: err?.message || String(err) });
			}
		}
		enriched = [...out, ...fresh.slice(limit)];
	}

	const minF = agent.minFollowers;
	const toScore = [];
	for (const c of enriched) {
		if (
			minF > 0 &&
			c.followersCount != null &&
			Number(c.followersCount) < minF
		) {
			continue;
		}
		toScore.push({ ...c, id: channelDocId(c) });
	}
	console.log(
		`[dev-magazine] google hits=${merged.length} fresh=${fresh.length} toStore=${toScore.length}`,
	);

	for (let i = 0; i < toScore.length; i += agent.scoreBatchSize) {
		const chunk = toScore.slice(i, i + agent.scoreBatchSize);
		const scored = useAI
			? await classifyMagazineCreators(chunk)
			: chunk.map((r) => ({
					id: r.id,
					keep: true,
					name: r.name,
					categoryId: r.categoryId,
					topics: r.topic ? [r.topic] : [],
					relevanceScore: 0,
					reason: "scrape_only",
					oneLiner: "",
				}));
		for (const row of chunk) {
			const match = scored.find((s) => s.id === row.id);
			const keep = match?.keep !== false;
			if (!keep) {
				summary.rejected += 1;
				continue;
			}
			row.name = match?.name || row.name;
			row.categoryId = match?.categoryId || row.categoryId;
			row.topics = Array.isArray(match?.topics) && match.topics.length
				? match.topics
				: row.topics || [row.topic].filter(Boolean);
			row.relevanceScore = Number(match?.relevanceScore) || 3;
			row.relevanceReason = match?.reason || "";
			row.oneLiner = match?.oneLiner || "";
			row.kind = "magazine-creator";
			await saveChannel(row);
			summary.saved += 1;
			summary.channels.push({
				id: row.id,
				name: row.name,
				handle: row.handle,
				platform: row.platform,
				categoryId: row.categoryId,
				topics: row.topics,
				profileUrl: row.profileUrl,
				followersCount: row.followersCount,
			});

			if (opts.fetchVideos !== false && row.platform === "youtube") {
				try {
					const v = await storeVideosForChannel(row, {
						categoryId: row.categoryId,
						topic: row.topic,
					});
					summary.videosSaved += v.saved;
				} catch (err) {
					summary.errors.push({
						videos: row.handle,
						error: err?.message || String(err),
					});
				}
			}
		}
	}

	summary.channelCount = await countChannels();
	console.log(
		`[dev-magazine] saved ${summary.saved} channels, ${summary.videosSaved} videos → ${agent.channelsCollection}`,
	);
	return summary;
}

export async function runMagazineVideosPass(opts = {}) {
	const cat = opts.category ? resolveCategory(opts.category) : null;
	const yt = await listChannels({
		category: cat?.id,
		topic: opts.topic,
		platform: "youtube",
		limit: MAGAZINE_AGENT.channelsForVideosPerRun * 4,
	});
	const batch = yt.slice(0, MAGAZINE_AGENT.channelsForVideosPerRun);
	const summary = {
		agentId: MAGAZINE_AGENT.id,
		mode: "videos",
		category: cat?.id || null,
		channels: batch.length,
		videosSaved: 0,
		errors: [],
	};
	for (const ch of batch) {
		try {
			const v = await storeVideosForChannel(ch, {
				categoryId: ch.categoryId || cat?.id,
				topic: opts.topic || ch.topic,
			});
			summary.videosSaved += v.saved;
			console.log(
				`[dev-magazine] videos @${ch.handle || ch.channelId} → ${v.saved} (${v.source})`,
			);
		} catch (err) {
			summary.errors.push({
				handle: ch.handle,
				error: err?.message || String(err),
			});
		}
	}
	return summary;
}

export { listChannels, countChannels };
