/**
 * Nested scrape enrichment.
 * Homepage / SERP URL → contact/about/team pages → optional Google follow-up.
 */

import { googleSearch } from "../contentResearch/http.js";
import { scrapeUrl } from "../scrapefast.js";
import { KARYAM_AGENT } from "./configs.js";
import {
	candidateFromSerp,
	contactsFromText,
	extractLinks,
	hostnameOf,
	isJunkHost,
	mergeContacts,
	normalizeUrl,
	pickNestedContactUrls,
	pickOutboundCompanyUrls,
	seenKey,
} from "./core.js";

function pageText(row) {
	return [
		row.markdown || "",
		row.title || row.data?.title || "",
		row.html || row.data?.html || "",
	]
		.join("\n")
		.slice(0, 60_000);
}

async function scrapeContacts(url, baseUrl) {
	const target = normalizeUrl(url);
	if (!target) return { contacts: {}, links: [], error: "empty_url" };
	try {
		const row = await scrapeUrl(target, {
			baseUrl,
			timeoutMs: 45_000,
			includeImages: false,
			includeLinks: true,
		});
		const text = pageText(row);
		const contacts = contactsFromText(text, target);
		if (!contacts.name) contacts.name = String(row.title || "").split(/[|\-–—]/)[0].trim();
		return {
			contacts,
			links: extractLinks(row),
			title: row.title || row.data?.title || "",
		};
	} catch (err) {
		return { contacts: {}, links: [], error: err?.message || String(err) };
	}
}

function followupQueries(lead) {
	const host = hostnameOf(lead.website || lead.sourceUrl);
	const company = String(lead.company || lead.name || "").trim();
	const qs = [];
	if (host) {
		qs.push({
			id: `fu-site-${host}`,
			intent: lead.intent || "mvp",
			country: lead.country || "us",
			query: `site:${host} (contact OR email OR founder OR team)`,
		});
	}
	if (company && company.length > 2) {
		qs.push({
			id: `fu-founder-${company.slice(0, 40)}`,
			intent: lead.intent || "mvp",
			country: lead.country || "us",
			query: `"${company}" founder (email OR linkedin OR contact)`,
		});
	}
	return qs;
}

/**
 * Enrich one lead: scrape URL, nested contact pages, listicle outbound, Google follow-up.
 */
export async function enrichLead(lead, opts = {}) {
	const baseUrl = opts.baseUrl;
	const nestedLimit = opts.nestedPages ?? KARYAM_AGENT.nestedPagesPerLead;
	const followLimit = opts.followupQueries ?? KARYAM_AGENT.followupQueriesPerLead;
	const seedUrl = lead.website || lead.sourceUrl;
	let out = { ...lead };
	const scraped = [];

	if (seedUrl && !isJunkHost(seedUrl)) {
		const first = await scrapeContacts(seedUrl, baseUrl);
		if (first.error) out.enrichError = first.error;
		else {
			out = mergeContacts(out, first.contacts);
			if (first.title && !out.title) out.title = first.title;
			scraped.push(seedUrl);

			const nested = pickNestedContactUrls(first.links, seedUrl, nestedLimit);
			for (const url of nested) {
				if (scraped.includes(url)) continue;
				const page = await scrapeContacts(url, baseUrl);
				if (!page.error) out = mergeContacts(out, page.contacts);
				scraped.push(url);
			}

			const outbound = pickOutboundCompanyUrls(first.links, seedUrl, 3);
			out.relatedUrls = outbound;
		}
	}

	if (followLimit > 0) {
		const jobs = followupQueries(out).slice(0, followLimit);
		for (const job of jobs) {
			try {
				const rows = await googleSearch(job.query, {
					baseUrl,
					num: 5,
					country: job.country || "us",
					language: "en",
				});
				for (const row of rows.slice(0, 4)) {
					const extra = candidateFromSerp(row, {
						intent: lead.intent,
						query: job.query,
						queryId: job.id,
						country: job.country,
					});
					out = mergeContacts(out, extra);
					const nextUrl = extra.website || extra.sourceUrl;
					if (
						nextUrl &&
						!isJunkHost(nextUrl) &&
						hostnameOf(nextUrl) === hostnameOf(out.website || seedUrl || nextUrl) &&
						!scraped.includes(normalizeUrl(nextUrl)) &&
						scraped.length < nestedLimit + 2
					) {
						const page = await scrapeContacts(nextUrl, baseUrl);
						if (!page.error) out = mergeContacts(out, page.contacts);
						scraped.push(normalizeUrl(nextUrl));
					}
				}
			} catch (err) {
				console.warn(
					`[karyam-founders] follow-up failed:`,
					err?.message || err,
				);
			}
		}
	}

	out.enrichedAt = new Date().toISOString();
	out.enrichedFrom = scraped;
	return out;
}

/**
 * If a directory/listicle yielded related company URLs, turn them into extra candidates.
 */
export function expandRelated(leads, seen, limit = 8) {
	const extra = [];
	for (const lead of leads) {
		for (const url of lead.relatedUrls || []) {
			if (extra.length >= limit) return extra;
			if (isJunkHost(url)) continue;
			const c = {
				name: "",
				company: "",
				title: "",
				snippet: `Related from ${lead.sourceUrl || ""}`,
				sourceUrl: url,
				sourcePlatform: "nested",
				intent: lead.intent || null,
				searchQuery: lead.searchQuery || null,
				queryId: lead.queryId || null,
				country: lead.country || null,
				website: url,
				emails: [],
				phones: [],
				outreachStatus: "new",
				role: "unknown",
			};
			const key = seenKey(c);
			if (seen.has(key)) continue;
			seen.set(key, true);
			extra.push(c);
		}
	}
	return extra;
}

export async function enrichCandidates(candidates, opts = {}) {
	const limit = opts.limit ?? KARYAM_AGENT.enrichPerRun;
	const out = [];
	for (const c of candidates.slice(0, limit)) {
		console.log(`[karyam-founders] enrich ${c.website || c.sourceUrl}`);
		out.push(await enrichLead(c, opts));
	}
	return [...out, ...candidates.slice(limit)];
}
