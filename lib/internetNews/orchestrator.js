/**
 * iHateReading internet news orchestrator.
 * 4 platforms / tick → 10–20 top list URLs → tag/category → Firestore.
 * No OpenRouter / LLM.
 */

import {
	INTERNET_NEWS_AGENT,
	NEWS_KEYWORDS,
	NEWS_PLATFORMS,
	classifyStory,
	clampUrlsPerPlatform,
	keywordQuery,
	resolvePlatform,
} from "./configs.js";
import {
	articleExists,
	countArticles,
	listArticles,
	loadNewsCursor,
	saveArticle,
	saveNewsCursor,
} from "./core.js";
import { discoverPlatformStories } from "./platforms.js";

function pickBatch(pool, start, count) {
	const take = Math.min(Math.max(1, count), pool.length);
	const out = [];
	if (!pool.length) return out;
	for (let i = 0; i < take; i++) {
		out.push(pool[(start + i) % pool.length]);
	}
	return out;
}

/**
 * @param {{
 *   baseUrl?: string,
 *   platformsPerRun?: number,
 *   urlsPerPlatform?: number,
 *   platform?: string,
 *   keyword?: string,
 * }} [opts]
 */
export async function runInternetNewsAgent(opts = {}) {
	const agent = INTERNET_NEWS_AGENT;
	const baseUrl = opts.baseUrl;
	const perRun = opts.platformsPerRun ?? agent.platformsPerRun ?? 4;
	const urlsPer = clampUrlsPerPlatform(
		opts.urlsPerPlatform ?? agent.urlsPerPlatform,
	);

	let pool = NEWS_PLATFORMS;
	if (opts.platform) {
		const p = resolvePlatform(opts.platform);
		if (!p) throw new Error(`Unknown news platform: ${opts.platform}`);
		pool = [p];
	}

	const cursor = await loadNewsCursor(agent.stateCollection, agent.id);
	const batch = pickBatch(pool, cursor.platformIndex, perRun);
	const nextPlatform = (cursor.platformIndex + batch.length) % pool.length;
	let keywordIndex = cursor.keywordIndex || 0;

	const summary = {
		agentId: agent.id,
		collection: agent.collection,
		platformsRun: batch.map((p) => p.id),
		cursor: {
			from: cursor.platformIndex,
			to: nextPlatform,
			keywordIndex,
			totalPlatforms: pool.length,
		},
		urlsPerPlatform: urlsPer,
		discovered: 0,
		newArticles: 0,
		saved: 0,
		skippedDupes: 0,
		articles: [],
		errors: [],
	};

	for (const platform of batch) {
		const keyword =
			platform.kind === "google-news"
				? opts.keyword ||
					keywordQuery(NEWS_KEYWORDS[keywordIndex % NEWS_KEYWORDS.length])
				: opts.keyword || null;
		if (platform.kind === "google-news") {
			keywordIndex = (keywordIndex + 1) % NEWS_KEYWORDS.length;
		}

		console.log(
			`[internet-news] ${platform.id}${keyword ? ` keyword="${keyword}"` : ""} × ${urlsPer}`,
		);

		let discovered;
		try {
			discovered = await discoverPlatformStories(platform, {
				baseUrl,
				limit: urlsPer,
				keyword,
			});
		} catch (err) {
			summary.errors.push({
				platform: platform.id,
				stage: "discover",
				error: err?.message || String(err),
			});
			continue;
		}

		const items = (discovered.items || []).filter((i) => i.url);
		summary.discovered += items.length;
		if (discovered.errors?.length) {
			for (const e of discovered.errors) {
				summary.errors.push({ platform: platform.id, error: e });
			}
		}

		for (const item of items) {
			try {
				if (await articleExists(agent.collection, item)) {
					summary.skippedDupes += 1;
					continue;
				}
				summary.newArticles += 1;
				const { category, tags } = classifyStory({
					platform,
					keyword: keyword || item.keyword,
					title: item.title,
					url: item.url,
				});
				const doc = {
					...item,
					platform: platform.id,
					platformName: platform.name,
					keyword: keyword || item.keyword || null,
					source: item.source || platform.id,
					agentId: agent.id,
					category,
					tags,
					fetchedAt: new Date().toISOString(),
				};
				await saveArticle(agent.collection, doc);
				summary.saved += 1;
				summary.articles.push({
					id: doc.url,
					title: doc.title,
					url: doc.url,
					platform: doc.platform,
					category: doc.category,
					tags: doc.tags,
				});
			} catch (err) {
				summary.errors.push({
					platform: platform.id,
					url: item.url,
					error: err?.message || String(err),
				});
			}
		}
	}

	await saveNewsCursor(agent.stateCollection, agent.id, {
		platformIndex: opts.platform ? cursor.platformIndex : nextPlatform,
		keywordIndex,
	});

	summary.finalCount = await countArticles(agent.collection);
	console.log(
		`[internet-news] saved ${summary.saved} new, skipped ${summary.skippedDupes} already in DB, discovered ${summary.discovered} → ${agent.collection} (${summary.finalCount})`,
	);
	return summary;
}

export { listArticles, countArticles, INTERNET_NEWS_AGENT, NEWS_PLATFORMS };
