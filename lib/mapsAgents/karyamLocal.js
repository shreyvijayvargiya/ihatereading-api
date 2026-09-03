/**
 * Karyam local Maps lead agent — multi-city physical businesses.
 * CLI / POST /maps-agents/karyam-local/run — does NOT auto-start on npm run dev.
 *
 * Pass city (id, name, or alias): bangalore | "new delhi" | york | nyc | london | …
 */

import { isUseAiOn } from "../useAi.js";
import {
	buildSearchQueries,
	filterQueriesByCity,
	getMapsAgent,
	MAPS_KARYAM_AGENT,
	resolveCity,
} from "./configs.js";
import {
	enrichEmailFromWebsite,
	fetchMapsPlacesBatch,
	leadExists,
	listMapsLeads,
	loadQueryCursor,
	normalizePlace,
	placeDocId,
	saveLead,
	saveQueryCursor,
	scoreLeadsWithLlm,
} from "./core.js";

const DEFAULT_QUERIES = buildSearchQueries(MAPS_KARYAM_AGENT);
const ALL_KEYWORD_QUERIES = buildSearchQueries({
	...MAPS_KARYAM_AGENT,
	categories: MAPS_KARYAM_AGENT.allCategories,
});

/**
 * @param {{ baseUrl?: string, queriesPerRun?: number, city?: string, enrichWebsites?: boolean, useAI?: boolean, allKeywords?: boolean }} [opts]
 */
export async function runKaryamMapsLeadsAgent(opts = {}) {
	const agent = getMapsAgent("karyam-local");
	if (!agent) throw new Error("karyam-local maps agent config missing");

	const baseUrl = opts.baseUrl;
	const perRun = opts.queriesPerRun ?? agent.queriesPerRun ?? 4;
	const enrichWebsites = opts.enrichWebsites !== false;
	const useAI = isUseAiOn(opts);

	const resolvedCity = opts.city ? resolveCity(opts.city, agent) : null;
	if (opts.city && !resolvedCity) {
		const known = agent.cities.map((c) => c.id).join(", ");
		throw new Error(
			`Unknown city "${opts.city}". Use one of: ${known} (or full name / alias)`,
		);
	}

	const queryPool = filterQueriesByCity(
		opts.allKeywords ? ALL_KEYWORD_QUERIES : DEFAULT_QUERIES,
		opts.city,
		agent,
	);
	if (!queryPool.length) {
		throw new Error(`No Maps queries for city="${opts.city}"`);
	}

	// Per-city cursor so --city bangalore doesn't share rotation with kota
	const cursorKey = resolvedCity
		? `${agent.id}:${resolvedCity.id}`
		: agent.id;
	const cursor = await loadQueryCursor(agent.stateCollection, cursorKey);
	const batch = [];
	for (let i = 0; i < perRun; i++) {
		const idx = (cursor + i) % queryPool.length;
		batch.push({ ...queryPool[idx], queryIndex: idx });
	}
	const nextCursor = (cursor + perRun) % queryPool.length;
	await saveQueryCursor(agent.stateCollection, cursorKey, nextCursor);

	const summary = {
		agentId: agent.id,
		collection: agent.collection,
		city: resolvedCity
			? {
					id: resolvedCity.id,
					name: resolvedCity.name,
					state: resolvedCity.state,
					country: resolvedCity.country,
				}
			: null,
		queriesRun: batch.length,
		queryCursor: { from: cursor, to: nextCursor, total: queryPool.length },
		useAI,
		keywords: opts.allKeywords ? agent.allCategories : agent.categories,
		newLeads: 0,
		scored: 0,
		relevant: [],
		errors: [],
	};

	const toScore = [];

	console.log(
		`[maps-agent] city=${resolvedCity?.id || "all"} scraping ${batch.length} queries (in-process Puppeteer)`,
	);
	const scrapeResults = await fetchMapsPlacesBatch(
		batch.map((j) => j.query),
		baseUrl,
	);

	for (let i = 0; i < batch.length; i++) {
		const job = batch[i];
		const result = scrapeResults[i];
		if (result?.error) {
			console.error(`[maps-agent] query failed (${job.query}):`, result.error);
			summary.errors.push({ query: job.query, error: result.error });
			continue;
		}

		console.log(
			`[maps-agent] ${job.query}: ${result.places?.length || 0} places`,
		);

		for (const raw of result.places || []) {
			const place = normalizePlace(raw, {
				cityId: job.cityId,
				city: job.city,
				state: job.state,
				country: job.country,
				category: job.category,
				query: job.query,
			});
			if (!place.name) continue;

			const exists = await leadExists(agent.collection, place);
			if (exists) continue;

			let emails = [];
			if (enrichWebsites && place.website) {
				emails = await enrichEmailFromWebsite(place.website, baseUrl);
			}

			const lead = {
				...place,
				id: placeDocId(place),
				emails,
				email: emails[0] || null,
				fetchedAt: new Date().toISOString(),
				relevanceScore: 0,
				relevanceReason: "",
				draftMessage: "",
				websiteStatus: "unknown",
				outreachChannel: "call",
				scored: false,
			};

			toScore.push(lead);
			summary.newLeads += 1;
		}
	}

	function relevantRow(lead) {
		return {
			id: lead.id,
			name: lead.name,
			cityId: lead.cityId,
			city: lead.city,
			country: lead.country,
			category: lead.category,
			phone: lead.phone,
			website: lead.website,
			emails: lead.emails,
			address: lead.address,
			mapsUrl: lead.mapsUrl,
			image: lead.image,
			rating: lead.rating,
			relevanceScore: lead.relevanceScore,
			relevanceReason: lead.relevanceReason,
			draftMessage: lead.draftMessage,
			websiteStatus: lead.websiteStatus,
			outreachChannel: lead.outreachChannel,
		};
	}

	if (!useAI) {
		console.log(
			`[maps-agent] scrape-only — saving ${toScore.length} leads (pass --use-ai to score)`,
		);
		for (const lead of toScore) {
			lead.relevanceScore = 0;
			lead.relevanceReason = "scrape_only";
			lead.scored = false;
			await saveLead(agent.collection, lead);
			summary.relevant.push(relevantRow(lead));
		}
	} else {
		for (let i = 0; i < toScore.length; i += agent.scoreBatchSize) {
			const chunk = toScore.slice(i, i + agent.scoreBatchSize);
			const scored = await scoreLeadsWithLlm(chunk, agent);
			for (const lead of chunk) {
				const match = scored.find((s) => s.id === lead.id);
				const score = Number(match?.score) || 0;
				lead.relevanceScore = score;
				lead.relevanceReason = match?.reason || "";
				lead.draftMessage = match?.draftMessage || "";
				lead.websiteStatus = match?.websiteStatus || "unknown";
				lead.outreachChannel = match?.outreachChannel || "call";
				lead.scored = true;
				lead.scoredAt = new Date().toISOString();

				await saveLead(agent.collection, lead);
				summary.scored += 1;

				if (score >= (agent.relevanceMin ?? 4)) {
					summary.relevant.push(relevantRow(lead));
				}
			}
		}
	}

	console.log(
		`[maps-agent] done — ${summary.newLeads} new, ${summary.scored} scored, ${summary.relevant.length} relevant${useAI ? ` (≥${agent.relevanceMin})` : " (scrape-only)"} → ${agent.collection}`,
	);
	return summary;
}

export { listMapsLeads, DEFAULT_QUERIES as ALL_QUERIES, ALL_KEYWORD_QUERIES };
