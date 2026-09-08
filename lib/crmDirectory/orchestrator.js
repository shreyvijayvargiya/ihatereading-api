/**
 * Business CRM directory orchestrator — scrape only, no LLM.
 * Each tick: next Google keyword(s) → scrape list pages → hash-save unique product sites.
 */

import { CRM_AGENT, CRM_QUERIES } from "./configs.js";
import {
	countCrms,
	createSeenMap,
	crmExists,
	listCrms,
	loadQueryCursor,
	saveCrm,
	saveQueryCursor,
	seenKey,
} from "./core.js";
import {
	discoverFromQuery,
	enrichHomepages,
	harvestWikipedia,
	resolvePendingNames,
	scrapeListPages,
} from "./discover.js";

/**
 * @param {{
 *   baseUrl?: string,
 *   queriesPerRun?: number,
 *   enrich?: boolean,
 * }} [opts]
 */
export async function runCrmDirectoryAgent(opts = {}) {
	const agent = CRM_AGENT;
	const perRun = opts.queriesPerRun ?? agent.queriesPerRun ?? 1;
	const doEnrich = opts.enrich !== false;
	const queries = CRM_QUERIES;
	const cursor = await loadQueryCursor();

	const batch = [];
	for (let i = 0; i < perRun; i++) {
		const idx = (cursor + i) % queries.length;
		batch.push({ query: queries[idx], queryIndex: idx });
	}
	const nextCursor = (cursor + perRun) % queries.length;
	await saveQueryCursor(nextCursor);

	const summary = {
		agentId: agent.id,
		collection: agent.collection,
		queriesRun: batch.map((q) => q.query),
		queryCursor: { from: cursor, to: nextCursor, total: queries.length },
		serpHits: 0,
		listsScraped: 0,
		wikiNames: 0,
		resolved: 0,
		candidates: 0,
		saved: 0,
		skipped: 0,
		crms: [],
		errors: [],
	};

	const seen = createSeenMap();
	const found = [];
	const lists = [];
	const brands = [];

	for (const row of batch) {
		try {
			const d = await discoverFromQuery(row.query, { baseUrl: opts.baseUrl, seen });
			summary.serpHits += d.serpCount || 0;
			found.push(...(d.products || []));
			lists.push(...(d.lists || []).map((l) => ({ ...l, query: row.query })));
			brands.push(...(d.brands || []));
			summary.errors.push(...(d.warnings || []).map((w) => ({ query: row.query, error: w })));
		} catch (err) {
			summary.errors.push({ query: row.query, error: err?.message || String(err) });
		}
	}

	try {
		const wiki = await harvestWikipedia({ baseUrl: opts.baseUrl, seen });
		found.push(...(wiki.products || []));
		summary.wikiNames = (wiki.names || []).length;
		summary.errors.push(...(wiki.warnings || []).map((w) => ({ stage: "wiki", error: w })));
		const toResolve = [...(wiki.names || []), ...brands].filter(Boolean);
		if (toResolve.length) {
			const resolved = await resolvePendingNames(toResolve, {
				baseUrl: opts.baseUrl,
				seen,
				limit: agent.resolvePerRun,
			});
			found.push(...(resolved.products || []));
			summary.resolved = (resolved.products || []).length;
			summary.errors.push(...(resolved.errors || []));
		}
	} catch (err) {
		summary.errors.push({ stage: "wiki", error: err?.message || String(err) });
	}

	try {
		const scraped = await scrapeListPages(lists, {
			baseUrl: opts.baseUrl,
			seen,
			limit: agent.scrapeListsPerRun,
		});
		summary.listsScraped = scraped.products ? Math.min(lists.length, agent.scrapeListsPerRun) : 0;
		found.push(...(scraped.products || []));
		summary.errors.push(...(scraped.errors || []));
	} catch (err) {
		summary.errors.push({ stage: "list-scrape", error: err?.message || String(err) });
	}

	const unique = [];
	const mergeSeen = createSeenMap();
	for (const c of found) {
		const k = seenKey(c);
		if (mergeSeen.has(k)) continue;
		mergeSeen.set(k, true);
		unique.push(c);
	}
	summary.candidates = unique.length;

	const fresh = [];
	for (const c of unique) {
		try {
			if (await crmExists(c)) {
				summary.skipped += 1;
				continue;
			}
			fresh.push(c);
		} catch (err) {
			summary.errors.push({ crm: c.name, error: err?.message || String(err) });
		}
	}

	let toSave = fresh;
	if (doEnrich && fresh.length) {
		toSave = await enrichHomepages(fresh, {
			baseUrl: opts.baseUrl,
			limit: agent.enrichPerRun,
		});
	}

	const fetchedAt = new Date().toISOString();
	for (const c of toSave) {
		const doc = {
			...c,
			sourceType: "google-scrape",
			source: c.sourceQuery || "google-scrape",
			fetchedAt,
		};
		try {
			await saveCrm(doc);
			summary.saved += 1;
			summary.crms.push({
				name: doc.name,
				website: doc.website,
				domain: doc.domain,
				sourceQuery: doc.sourceQuery,
			});
			console.log(`[crm] saved ${doc.name} ${doc.website}`);
		} catch (err) {
			summary.errors.push({ crm: c.name, error: err?.message || String(err) });
		}
	}

	summary.stored = await countCrms().catch(() => null);
	console.log(
		`[crm] tick saved ${summary.saved} skipped ${summary.skipped} stored=${summary.stored} → ${agent.collection}`,
	);
	return summary;
}

export { listCrms, CRM_AGENT, CRM_QUERIES };
