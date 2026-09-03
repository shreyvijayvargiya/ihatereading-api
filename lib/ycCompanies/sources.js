/**
 * Discovery + enrichment for YC companies.
 * Primary: yc-oss JSON (real startups). Google only with site:ycombinator.com/companies.
 */

import { googleSearch } from "../contentResearch/http.js";
import {
	candidateFromYcRecord,
	companyDocId,
	createSeenMap,
	extractEmails,
	guessWebsiteFromText,
	isJunkCandidate,
	mapYcStatus,
	normalizeBatch,
	normalizeName,
	normalizeUrl,
	scrapePage,
	seenKey,
	slugFromYcUrl,
} from "./core.js";

const YC_COMPANY_PATH = /ycombinator\.com\/companies\/([a-z0-9-]+)/i;
const HN_ITEM = /news\.ycombinator\.com\/item\?id=(\d+)/i;

/** In-memory feed cache so we don't re-download 6k companies every tick */
const feedCache = new Map();
const FEED_TTL_MS = 30 * 60 * 1000;

async function fetchJsonFeed(url) {
	const cached = feedCache.get(url);
	if (cached && Date.now() - cached.at < FEED_TTL_MS) {
		return cached.data;
	}
	const res = await fetch(url, {
		signal: AbortSignal.timeout(90_000),
		headers: {
			Accept: "application/json",
			"User-Agent": "ihatereading-yc-agent/1.0 (+https://ihatereading.in)",
		},
	});
	if (!res.ok) throw new Error(`YC feed HTTP ${res.status} for ${url}`);
	const data = await res.json();
	if (!Array.isArray(data)) throw new Error(`YC feed not an array: ${url}`);
	feedCache.set(url, { at: Date.now(), data });
	return data;
}

function pushCandidate(seen, list, raw) {
	if (isJunkCandidate(raw)) return;
	const name = normalizeName(raw.name);
	if (!name) return;
	const c = {
		...raw,
		name,
		ycUrl: raw.ycUrl ? normalizeUrl(raw.ycUrl) : null,
		website: raw.website ? normalizeUrl(raw.website) : null,
		sourceUrl: raw.sourceUrl ? normalizeUrl(raw.sourceUrl) : null,
	};
	const key = seenKey(c);
	if (seen.has(key)) return;
	seen.set(key, true);
	list.push(c);
}

function batchMatches(rowBatch, want) {
	if (!want) return true;
	const a = normalizeBatch(rowBatch);
	const b = normalizeBatch(want);
	if (!a || !b) return false;
	return a === b || String(rowBatch).toLowerCase().includes(String(want).toLowerCase());
}

/**
 * Pull a page of real companies from yc-oss JSON.
 */
export async function discoverFromYcOss(source, opts = {}) {
	const seen = opts.seen || createSeenMap();
	const offset = Number(opts.feedOffset) || 0;
	const pageSize = opts.pageSize || 40;

	console.log(`[yc:oss] ${source.label || source.url} offset=${offset}`);
	const all = await fetchJsonFeed(source.url);
	let rows = all;
	if (source.batch) {
		rows = all.filter((r) => batchMatches(r.batch, source.batch));
	}
	if (source.preferHiring) {
		rows = rows.filter((r) => r.isHiring === true);
	}

	const slice = rows.slice(offset, offset + pageSize);
	const nextOffset =
		offset + pageSize >= rows.length ? 0 : offset + pageSize;

	const out = [];
	for (const row of slice) {
		const c = candidateFromYcRecord(row, {
			sourceType: "yc-oss",
			statusHint: source.statusHint,
			batch: source.batch,
		});
		if (!c) continue;
		pushCandidate(seen, out, c);
	}

	console.log(
		`[yc:oss] → ${out.length} companies (feed ${rows.length}, nextOffset ${nextOffset})`,
	);
	return { companies: out, nextOffset, feedTotal: rows.length };
}

/**
 * Parse YC company detail page for founders + jobs.
 */
export function parseYcCompanyPage(page, company) {
	const text = `${page.title || ""}\n${page.markdown || ""}\n${page.html || ""}`;
	const founders = new Set(company.founders || []);
	const jobs = [];
	const emails = new Set(company.emails || []);

	for (const e of extractEmails(text)) emails.add(e);

	// Founders section patterns
	const founderBlocks = text.match(
		/(?:Founders?|Active Founders?)[:\s]*([\s\S]{0,800}?)(?:\n##|\nJobs|\nHiring|$)/i,
	);
	if (founderBlocks) {
		const names = founderBlocks[1].match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z.-]+)+)\b/g);
		for (const n of names || []) {
			const cleaned = normalizeName(n);
			if (cleaned.length >= 4 && cleaned.length < 50) founders.add(cleaned);
		}
	}

	// Jobs / hiring
	const jobLines = text.match(
		/(?:^|\n)\s*[-*]?\s*((?:Software|Full[- ]?Stack|Backend|Frontend|Engineer|Designer|Product|Sales|Marketing|Ops|Founding)[^\n]{5,80})/gi,
	);
	for (const line of jobLines || []) {
		const title = normalizeName(line.replace(/^[-*\s]+/, ""));
		if (title.length >= 5 && title.length < 80) jobs.push(title);
	}

	const isHiring =
		company.isHiring ||
		/is hiring|we're hiring|open roles|view jobs/i.test(text) ||
		jobs.length > 0;

	let website = company.website;
	const siteMatch = text.match(
		/(?:Website|Company website)[:\s]*(https?:\/\/[^\s)<>]+)/i,
	);
	if (siteMatch) website = normalizeUrl(siteMatch[1]);
	if (!website) website = guessWebsiteFromText(text, website);

	return {
		...company,
		founders: [...founders].slice(0, 8),
		jobs: [...new Set(jobs)].slice(0, 15),
		isHiring,
		emails: [...emails],
		email: [...emails][0] || company.email || null,
		website: website || company.website,
		enrichmentText: text.slice(0, 10_000),
	};
}

export function parseHackerNews(page, meta = {}) {
	const seen = createSeenMap();
	const out = [];
	const text = page.markdown || "";
	const lines = text.split("\n").filter(Boolean);

	for (const line of lines) {
		const lower = line.toLowerCase();
		if (!/\bycombinator\b|\byc [ws]\d{2}\b|launch hn/i.test(line)) continue;

		const linkMatch = line.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
		const title = normalizeName(
			(linkMatch?.[1] || line).replace(/^(Show HN|Launch HN):\s*/i, "").slice(0, 100),
		);
		if (!title || title.length < 4) continue;

		const href = linkMatch?.[2] || "";
		const ycSlug = slugFromYcUrl(href);
		let website = null;
		if (href && !/news\.ycombinator|ycombinator\.com/i.test(href)) {
			website = normalizeUrl(href);
		}

		pushCandidate(seen, out, {
			name: title,
			slug: ycSlug,
			ycUrl: ycSlug
				? `https://www.ycombinator.com/companies/${ycSlug}`
				: null,
			website,
			sourceUrl: href.match(HN_ITEM)
				? href
				: page.url,
			sourceType: "hackernews",
			statusHint: /shut|dead/i.test(lower) ? "shutdown" : meta.statusHint || "unknown",
			batch: null,
			snippet: line.slice(0, 400),
			oneLiner: title,
			industry: null,
			industries: [],
			isHiring: false,
			founders: [],
			emails: [],
		});
	}
	return out.slice(0, 25);
}

/**
 * Google discover — ONLY accept ycombinator.com/companies/{slug} hits.
 */
export function parseGoogleDiscover(results, meta = {}) {
	const seen = createSeenMap();
	const out = [];
	for (const row of results || []) {
		const url = normalizeUrl(row.url || row.link);
		const m = url.match(YC_COMPANY_PATH);
		if (!m) continue;
		const slug = m[1].toLowerCase();
		if (
			["batch", "industry", "region", "team", "jobs", "launch", "founders"].includes(
				slug,
			)
		)
			continue;

		const title = String(row.title || "").trim();
		const name = normalizeName(
			title
				.replace(/\s*[|\-–—].*$/, "")
				.replace(/\s*:\s*Y Combinator.*$/i, "")
				.replace(/\s*\|?\s*Y Combinator.*$/i, "")
				.slice(0, 80),
		);

		pushCandidate(seen, out, {
			name: name || slug.replace(/-/g, " "),
			slug,
			ycUrl: `https://www.ycombinator.com/companies/${slug}`,
			website: null,
			sourceUrl: url,
			sourceType: "google-discover",
			statusHint: mapYcStatus(meta.statusHint),
			batch: normalizeBatch(meta.batch),
			snippet: `${title}. ${row.snippet || ""}`.slice(0, 500),
			oneLiner: "",
			industry: null,
			industries: [],
			isHiring: /hiring/i.test(`${title} ${row.snippet || ""}`),
			founders: [],
			emails: extractEmails(`${title} ${row.snippet || ""}`),
		});
	}
	return out;
}

export async function runDiscoverySource(source, opts = {}) {
	const seen = opts.seen || createSeenMap();
	const baseUrl = opts.baseUrl;
	const meta = {
		statusHint: source.statusHint,
		batch: source.batch || null,
	};

	if (source.type === "yc-oss") {
		return discoverFromYcOss(source, opts);
	}

	if (source.type === "google-discover") {
		console.log(`[yc:discover:google] ${source.query}`);
		const results = await googleSearch(source.query, {
			baseUrl,
			num: 10,
			country: "us",
			language: "en",
		});
		const parsed = parseGoogleDiscover(results, meta);
		const fresh = [];
		for (const c of parsed) {
			const k = seenKey(c);
			if (seen.has(k)) continue;
			seen.set(k, true);
			fresh.push(c);
		}
		console.log(`[yc:discover:google] → ${fresh.length} real YC company pages`);
		return { companies: fresh, nextOffset: 0, feedTotal: fresh.length };
	}

	console.log(`[yc:discover:${source.type}] ${source.url}`);
	const page = await scrapePage(source.url, baseUrl);
	if (page.error) {
		console.warn(`[yc:discover] scrape failed: ${page.error}`);
		return { companies: [], nextOffset: 0, feedTotal: 0 };
	}

	const parsed =
		source.type === "hackernews" ? parseHackerNews(page, meta) : [];

	const fresh = [];
	for (const c of parsed) {
		const k = seenKey(c);
		if (seen.has(k)) continue;
		seen.set(k, true);
		fresh.push(c);
	}
	console.log(`[yc:discover:${source.type}] → ${fresh.length}`);
	return { companies: fresh, nextOffset: 0, feedTotal: fresh.length };
}

/**
 * Deep enrich: scrape YC company page + optional Google for funding/email.
 */
export async function enrichCompany(company, opts = {}) {
	const baseUrl = opts.baseUrl;
	let next = { ...company, id: company.id || companyDocId(company) };

	const ycUrl =
		next.ycUrl ||
		(next.slug
			? `https://www.ycombinator.com/companies/${next.slug}`
			: null);

	if (ycUrl) {
		console.log(`[yc:enrich:page] ${ycUrl}`);
		const page = await scrapePage(ycUrl, baseUrl);
		if (!page.error) {
			next = parseYcCompanyPage(page, { ...next, ycUrl });
		}
	}

	const needGoogle =
		opts.google !== false &&
		(!next.email || !next.investmentAmount || !(next.founders || []).length);

	if (needGoogle && next.name) {
		const q = `"${next.name}" Y Combinator (founder OR raised OR funding OR contact OR email)`;
		try {
			console.log(`[yc:enrich:google] ${q}`);
			const results = await googleSearch(q, {
				baseUrl,
				num: 5,
				country: "us",
				language: "en",
			});
			const blobs = [];
			const emails = new Set(next.emails || []);
			const founders = new Set(next.founders || []);
			for (const row of results) {
				const url = normalizeUrl(row.url || row.link);
				if (/ycfounderlist|techstartupslist|extruct|ycinsight|vcbacked/i.test(url))
					continue;
				const blob = `${row.title || ""}\n${row.snippet || ""}\n${url}`;
				blobs.push(blob);
				for (const e of extractEmails(blob)) emails.add(e);
				const founderLine = blob.match(
					/(?:founded by|co-?founders?)[:\s]+([A-Za-z ,.&-]{4,80})/i,
				);
				if (founderLine) {
					for (const part of founderLine[1].split(/,| and /i)) {
						const n = normalizeName(part);
						if (n.length >= 3 && n.length < 60) founders.add(n);
					}
				}
				const raise = blob.match(
					/(?:raised|raises)\s+\$?\s*([\d.,]+\s*(?:million|billion|m|b|k)?)/i,
				);
				if (raise && !next.investmentAmount) {
					next.investmentAmount = raise[0].slice(0, 80);
				}
			}
			next.emails = [...emails];
			next.email = next.email || [...emails][0] || null;
			next.founders = [...founders].slice(0, 8);
			next.enrichmentText = `${next.enrichmentText || ""}\n${blobs.join("\n")}`.slice(
				0,
				12_000,
			);
		} catch (err) {
			console.warn(`[yc:enrich:google] failed:`, err?.message || err);
		}
	}

	next.enrichedAt = new Date().toISOString();
	return next;
}

export async function enrichCompanies(companies, opts = {}) {
	const limit = opts.limit ?? 8;
	const out = [];
	for (const c of companies.slice(0, limit)) {
		try {
			out.push(await enrichCompany(c, opts));
		} catch (err) {
			out.push({ ...c, enrichError: err?.message || String(err) });
		}
	}
	return [...out, ...companies.slice(limit)];
}
