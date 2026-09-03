/**
 * Top Mobile Apps orchestrator — App Store + Google Play only.
 */

import { isUseAiOn } from "../useAi.js";
import { ALL_SOURCES, TOP_MOBILE_APPS_AGENT } from "./configs.js";
import {
	appDocId,
	appExists,
	countApps,
	createSeenMap,
	listApps,
	loadCursor,
	saveApp,
	saveCursor,
	seenKey,
} from "./core.js";
import { enrichFoundersAndSocials, enrichMobileApps, runDiscoverySource } from "./discovery.js";

/**
 * @param {{
 *   baseUrl?: string,
 *   sourcesPerRun?: number,
 *   category?: string,
 *   platform?: "ios" | "android",
 *   enrich?: boolean,
 *   useAI?: boolean,
 * }} [opts]
 */
export async function runTopMobileAppsAgent(opts = {}) {
	const agent = TOP_MOBILE_APPS_AGENT;
	const baseUrl = opts.baseUrl;
	const perRun = opts.sourcesPerRun ?? agent.sourcesPerRun ?? 3;
	const doEnrich = opts.enrich !== false;
	const useAI = isUseAiOn(opts);

	const existingCount = await countApps(agent.collection);
	const summary = {
		agentId: agent.id,
		collection: agent.collection,
		existingCount,
		targetCount: agent.targetCount,
		atCapacity: existingCount >= agent.targetCount,
		sourcesRun: [],
		queries: [],
		discovered: 0,
		newApps: 0,
		useAI,
		enriched: 0,
		saved: 0,
		skippedDupes: 0,
		rejected: 0,
		apps: [],
		errors: [],
	};

	if (existingCount >= agent.targetCount) {
		console.log(
			`[top-mobile-apps] at capacity (${existingCount}/${agent.targetCount})`,
		);
		return summary;
	}

	let sourcePool = ALL_SOURCES;
	if (opts.category) {
		const c = String(opts.category).toLowerCase();
		sourcePool = ALL_SOURCES.filter((s) =>
			String(s.category || "")
				.toLowerCase()
				.includes(c),
		);
		if (!sourcePool.length) sourcePool = ALL_SOURCES;
	}
	if (opts.platform === "ios") {
		sourcePool = sourcePool.filter((s) => s.platform === "ios");
	} else if (opts.platform === "android") {
		sourcePool = sourcePool.filter((s) => s.platform === "android");
	}

	const cursor = await loadCursor(agent.stateCollection, agent.id);
	const start = cursor.sourceIndex % sourcePool.length;
	const batch = [];
	for (let i = 0; i < perRun; i++) {
		batch.push(sourcePool[(start + i) % sourcePool.length]);
	}
	const nextIndex = (start + perRun) % sourcePool.length;
	await saveCursor(agent.stateCollection, agent.id, { sourceIndex: nextIndex });
	summary.sourcesRun = batch.map((s) => s.id);
	summary.sourceCursor = { from: start, to: nextIndex, total: sourcePool.length };

	const seen = createSeenMap();
	const discovered = [];

	for (const src of batch) {
		try {
			const result = await runDiscoverySource(src, { baseUrl, seen });
			discovered.push(...(result.apps || []));
			summary.queries.push(...(result.queries || []));
		} catch (err) {
			summary.errors.push({ source: src.id, error: err?.message || String(err) });
		}
	}
	summary.discovered = discovered.length;

	const slotsLeft = Math.max(0, agent.targetCount - existingCount);
	const fresh = [];
	for (const app of discovered) {
		if (fresh.length >= slotsLeft) break;
		try {
			if (await appExists(agent.collection, app)) {
				summary.skippedDupes += 1;
				continue;
			}
			const k = seenKey(app);
			if (fresh.some((f) => seenKey(f) === k)) {
				summary.skippedDupes += 1;
				continue;
			}
			fresh.push(app);
		} catch (err) {
			summary.errors.push({ app: app.name, error: err?.message || String(err) });
		}
	}
	summary.newApps = fresh.length;

	let enriched = fresh;
	if (doEnrich && fresh.length) {
		const enrichLimit = fresh.length;
		console.log(`[top-mobile-apps] scraping ${enrichLimit} store listings`);
		enriched = await enrichMobileApps(fresh, {
			baseUrl,
			limit: enrichLimit,
		});
		summary.enriched = enrichLimit;

		console.log(`[top-mobile-apps] google founders/socials for ${enrichLimit}`);
		try {
			enriched = await enrichFoundersAndSocials(enriched, {
				baseUrl,
				limit: enrichLimit,
			});
		} catch (err) {
			summary.errors.push({
				stage: "founders",
				error: err?.message || String(err),
			});
		}
	}

	for (const app of enriched) {
		if (existingCount + summary.saved >= agent.targetCount) break;
		const id = appDocId(app);
		const doc = {
			...app,
			id,
			name: app.name,
			category: app.category || "Mobile",
			oneLiner: app.oneLiner || app.snippet || "",
			platform: app.platform,
			store: app.store,
			appStoreUrl: app.appStoreUrl || null,
			playStoreUrl: app.playStoreUrl || null,
			appStoreId: app.appStoreId || null,
			playStoreId: app.playStoreId || null,
			developer: app.developer || app.storeMetadata?.developer || null,
			developerUrl: app.developerUrl || app.website || null,
			website: app.website || app.developerUrl || null,
			rating: app.rating ?? null,
			reviewCount: app.reviewCount ?? null,
			downloads: app.downloads ?? null,
			priceLabel: app.priceLabel || null,
			reviewsUrl: app.appStoreUrl || app.playStoreUrl,
			relevanceScore: Number(app.relevanceScore) || 3,
			relevanceReason: app.relevanceReason || "store_listing",
			draftPitch: app.draftPitch || "",
			tags: Array.isArray(app.tags) ? app.tags : [],
			images: app.images || [],
			iconUrl: app.iconUrl || null,
			screenshots: Array.isArray(app.screenshots) ? app.screenshots : [],
			pageScreenshotUrl: app.pageScreenshotUrl || null,
			socials: app.socials || {},
			founders: app.founders || [],
			creators: app.creators || [],
			emails: app.emails || [],
			email: app.email || null,
			githubUrl: app.githubUrl || app.socials?.github || null,
			companyTwitter: app.companyTwitter || app.socials?.twitter || null,
			companyLinkedIn: app.companyLinkedIn || app.socials?.linkedin || null,
			companyGithub: app.companyGithub || app.socials?.github || null,
			storeMetadata: app.storeMetadata || {},
			mobileOnly: true,
			fetchedAt: new Date().toISOString(),
			agentId: agent.id,
		};
		delete doc.enrichmentPreview;
		delete doc.founderScrapePreview;

		try {
			if (await appExists(agent.collection, doc)) {
				summary.skippedDupes += 1;
				continue;
			}
			await saveApp(agent.collection, doc);
			summary.saved += 1;
			summary.apps.push({
				id: doc.id,
				name: doc.name,
				platform: doc.platform,
				category: doc.category,
				appStoreUrl: doc.appStoreUrl,
				playStoreUrl: doc.playStoreUrl,
				developer: doc.developer,
				website: doc.website,
				rating: doc.rating,
				reviewCount: doc.reviewCount,
				downloads: doc.downloads,
				iconUrl: doc.iconUrl,
				screenshotCount: (doc.screenshots || []).length,
				founders: (doc.founders || []).map((f) => f.name).filter(Boolean),
				socials: Object.keys(doc.socials || {}).filter((k) => doc.socials[k] && !k.endsWith("Handle")),
			});
		} catch (err) {
			summary.errors.push({ app: app.name, error: err?.message || String(err) });
		}
	}

	summary.finalCount = existingCount + summary.saved;
	console.log(
		`[top-mobile-apps] done — discovered ${summary.discovered}, saved ${summary.saved} → ${agent.collection} (${summary.finalCount}/${agent.targetCount})`,
	);
	return summary;
}

/** @deprecated */
export const runTopAppsDiscoveryAgent = runTopMobileAppsAgent;

export {
	listApps,
	ALL_SOURCES,
	TOP_MOBILE_APPS_AGENT,
	TOP_MOBILE_APPS_AGENT as TOP_APPS_AGENT,
	countApps,
};
