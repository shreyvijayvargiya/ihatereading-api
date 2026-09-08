/**
 * Discover CRM product websites from Google SERP + scraped list pages.
 * Does not require POST /scrape — direct HTTP + Firecrawl first.
 */

import { googleSearch } from "../contentResearch/http.js";
import { CRM_AGENT, SEED_LIST_URLS } from "./configs.js";
import {
	collectPageLinks,
	createSeenMap,
	domainOf,
	extractCrmBrands,
	extractProductUrlsFromText,
	isDirectoryHost,
	isJunkHost,
	loadAgentState,
	looksLikeCrmText,
	looksLikeListPage,
	nameFromHost,
	nameFromTitle,
	originOf,
	registrableDomain,
	saveAgentState,
	scrapePage,
	seenKey,
} from "./core.js";
import { parseWikiCrmNames } from "./parse.js";

function pushCandidate(seen, list, raw) {
	const website = originOf(raw.website || raw.href || "");
	if (!website || isJunkHost(website)) return;
	const domain = domainOf(website);
	if (!domain) return;
	const nameRaw = String(
		raw.name || nameFromTitle(raw.text || raw.title, domain) || nameFromHost(domain),
	).trim();
	const name = /^(visit site|website|home|learn more|official site|read more|click here)$/i.test(
		nameRaw,
	)
		? nameFromHost(domain)
		: nameRaw;
	if (!name || name.length < 2) return;
	const c = {
		name,
		website,
		domain: registrableDomain(website) || domain,
		sourceUrl: raw.sourceUrl || website,
		sourceQuery: raw.sourceQuery || null,
		snippet: String(raw.snippet || "").slice(0, 400),
	};
	const key = seenKey(c);
	if (seen.has(key)) return;
	seen.set(key, true);
	list.push(c);
}

function harvestText(seen, products, text, query, sourceUrl) {
	const sourceRoot = registrableDomain(sourceUrl);
	for (const url of extractProductUrlsFromText(text)) {
		if (sourceRoot && registrableDomain(url) === sourceRoot) continue;
		pushCandidate(seen, products, {
			website: url,
			sourceUrl,
			sourceQuery: query,
			snippet: String(text).slice(0, 200),
		});
	}
	return extractCrmBrands(text);
}

export function candidateFromSerp(row, query) {
	const url = row.url || row.link || "";
	const title = String(row.title || "");
	const snippet = String(row.snippet || row.description || "");
	if (looksLikeListPage(url, title) || isDirectoryHost(url)) {
		return { kind: "list", url, title, snippet, query };
	}
	if (isJunkHost(url)) return null;
	return { kind: "product", url, title, snippet, query };
}

export async function resolveOfficialSite(name, opts = {}) {
	const brand = String(name || "").trim();
	if (!brand) return null;
	const queries = [
		`"${brand}" official website -site:g2.com -site:capterra.com -site:wikipedia.org -site:forbes.com`,
		`${brand} CRM software`,
	];
	for (const q of queries) {
		let results = [];
		try {
			results = await googleSearch(q, {
				baseUrl: opts.baseUrl,
				num: 8,
				country: "us",
				language: "en",
				skipPuppeteer: true,
			});
		} catch {
			continue;
		}
		for (const row of results || []) {
			const url = row.url || row.link || "";
			const title = String(row.title || "");
			if (!url || isJunkHost(url) || isDirectoryHost(url)) continue;
			const website = originOf(url);
			if (!website || isJunkHost(website)) continue;
			return {
				name: brand,
				website,
				title,
				snippet: String(row.snippet || row.description || ""),
				sourceUrl: url,
				sourceQuery: q,
			};
		}
	}
	return null;
}

export async function resolveBrandSites(names, opts = {}) {
	const seen = opts.seen || createSeenMap();
	const products = [];
	const errors = [];
	const limit = opts.limit ?? CRM_AGENT.resolvePerRun ?? 5;
	for (const name of names.slice(0, limit)) {
		try {
			console.log(`[crm] resolve "${name}"`);
			const hit = await resolveOfficialSite(name, { baseUrl: opts.baseUrl });
			if (!hit?.website) continue;
			pushCandidate(seen, products, {
				name: hit.name,
				website: hit.website,
				title: hit.title,
				snippet: hit.snippet,
				sourceUrl: hit.sourceUrl,
				sourceQuery: hit.sourceQuery,
			});
		} catch (err) {
			errors.push({ name, error: err?.message || String(err) });
		}
	}
	return { products, errors };
}

export async function harvestWikipedia(opts = {}) {
	const seen = opts.seen || createSeenMap();
	const products = [];
	const warnings = [];
	const url = SEED_LIST_URLS[0];
	console.log(`[crm] scrape wiki ${url}`);
	const page = await scrapePage(url, opts.baseUrl);
	if (page.error) {
		warnings.push(`wiki: ${page.error}`);
		return { products, names: [], warnings };
	}
	const names = parseWikiCrmNames(page.html || "");
	console.log(`[crm] wiki via ${page.via || "unknown"} names=${names.length}`);
	return { products, names, warnings, via: page.via };
}

export async function discoverFromQuery(query, opts = {}) {
	const seen = opts.seen || createSeenMap();
	const baseUrl = opts.baseUrl;
	const warnings = [];
	const lists = [];
	const products = [];
	const brands = [];

	console.log(`[crm] google "${query}"`);
	let results = [];
	try {
		results = await googleSearch(query, {
			baseUrl,
			num: 10,
			country: "us",
			language: "en",
			skipPuppeteer: true,
		});
	} catch (err) {
		warnings.push(`google: ${err?.message || err}`);
		return { products, lists, brands, warnings, serpCount: 0 };
	}

	for (const row of results || []) {
		const title = String(row.title || "");
		const snippet = String(row.snippet || row.description || "");
		const url = row.url || row.link || "";
		brands.push(...harvestText(seen, products, `${title} ${snippet} ${url}`, query, url));

		const parsed = candidateFromSerp(row, query);
		if (!parsed) continue;
		if (parsed.kind === "list") {
			lists.push(parsed);
			continue;
		}
		pushCandidate(seen, products, {
			website: parsed.url,
			title: parsed.title,
			snippet: parsed.snippet,
			sourceUrl: parsed.url,
			sourceQuery: query,
			text: parsed.title,
		});
	}

	return {
		products,
		lists,
		brands: [...new Set(brands)],
		warnings,
		serpCount: (results || []).length,
	};
}

export async function scrapeListPages(lists, opts = {}) {
	const seen = opts.seen || createSeenMap();
	const limit = opts.limit ?? 2;
	const baseUrl = opts.baseUrl;
	const products = [];
	const errors = [];

	for (const list of lists.slice(0, limit)) {
		console.log(`[crm] scrape list ${list.url}`);
		const page = await scrapePage(list.url, baseUrl);
		if (page.error) {
			errors.push({ url: list.url, error: page.error });
			continue;
		}
		console.log(`[crm] list via ${page.via || "unknown"} links=${(page.links || []).length}`);
		const crmPage = looksLikeCrmText(`${page.title} ${page.markdown} ${page.html || ""} ${list.query || ""}`);
		for (const link of collectPageLinks(page)) {
			if (isJunkHost(link.href) || isDirectoryHost(link.href)) continue;
			if (!crmPage && !looksLikeCrmText(`${link.text} ${link.href}`)) continue;
			pushCandidate(seen, products, {
				website: link.href,
				text: link.text,
				title: link.text,
				snippet: list.title || "",
				sourceUrl: list.url,
				sourceQuery: list.query || null,
			});
		}
	}

	return { products, errors };
}

export async function enrichHomepages(candidates, opts = {}) {
	const limit = opts.limit ?? 4;
	const baseUrl = opts.baseUrl;
	const out = [];
	for (const c of candidates.slice(0, limit)) {
		const page = await scrapePage(c.website, baseUrl);
		if (page.error) {
			out.push({ ...c, enrichError: page.error });
			continue;
		}
		const name = nameFromTitle(page.title, c.domain) || c.name;
		out.push({
			...c,
			name,
			website: originOf(page.url) || c.website,
			description: String(page.markdown || page.html || "")
				.replace(/<script[\s\S]*?<\/script>/gi, " ")
				.replace(/<style[\s\S]*?<\/style>/gi, " ")
				.replace(/<[^>]+>/g, " ")
				.replace(/^#+\s+/gm, "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 400),
			pageTitle: page.title || "",
			enrichedAt: new Date().toISOString(),
		});
	}
	return [...out, ...candidates.slice(limit)];
}

export async function resolvePendingNames(names, opts = {}) {
	if (!names.length) return { products: [], errors: [], nextIndex: 0 };
	const state = await loadAgentState();
	const start = state.lastWikiNameIndex || 0;
	const batch = [];
	for (let i = 0; i < (opts.limit ?? CRM_AGENT.resolvePerRun); i++) {
		batch.push(names[(start + i) % names.length]);
	}
	const nextIndex = (start + batch.length) % names.length;
	const unresolved = batch;
	const resolved = await resolveBrandSites(unresolved.length ? unresolved : batch, {
		seen: opts.seen,
		baseUrl: opts.baseUrl,
		limit: opts.limit ?? CRM_AGENT.resolvePerRun,
	});
	await saveAgentState({ lastWikiNameIndex: nextIndex });
	return { ...resolved, nextIndex };
}
