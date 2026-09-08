/**
 * a16z companies orchestrator.
 *
 * Each tick:
 *   1. Fetch https://a16z.com/portfolio/?status=Active (HTML cache ~10 min)
 *   2. Parse data-companies JSON (modal fields — no click / Chrome)
 *   3. Take next 4 unseen / un-enriched companies
 *   4. Save YC-shaped docs, then enrichCompanySite when a website exists
 */

import { A16Z_AGENT, A16Z_PORTFOLIO_URL, BATCH_SIZE, LOCAL_API_BASE } from "./configs.js";
import {
	companyDocId,
	companyExists,
	computeConfidence,
	countCompanies,
	getCompany,
	isSiteEnriched,
	listCompanies,
	loadListingCursor,
	saveCompany,
	saveListingCursor,
} from "./core.js";
import { parseA16zPortfolioHtml } from "./parse.js";
import { enrichCompanySite } from "../ycCompanies/siteEnrich.js";

const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const LISTING_TTL_MS = 10 * 60 * 1000;
let listingCache = { at: 0, html: "", url: "" };

async function fetchPortfolioHtml(url = A16Z_PORTFOLIO_URL) {
	if (listingCache.html && listingCache.url === url && Date.now() - listingCache.at < LISTING_TTL_MS) {
		return listingCache.html;
	}
	const res = await fetch(url, {
		signal: AbortSignal.timeout(90_000),
		redirect: "follow",
		headers: {
			"User-Agent": BROWSER_UA,
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		},
	});
	if (!res.ok) throw new Error(`a16z portfolio HTTP ${res.status}`);
	const html = await res.text();
	listingCache = { at: Date.now(), html, url };
	return html;
}

function publicCompany(doc) {
	return {
		id: doc.id,
		name: doc.name,
		status: doc.status,
		batch: doc.batch,
		stage: doc.stage,
		industry: doc.industry,
		isHiring: doc.isHiring,
		website: doc.website,
		ycUrl: doc.ycUrl,
		a16zUrl: doc.a16zUrl,
		email: doc.email,
		founders: doc.founders,
		logoUrl: doc.logoUrl,
		socials: doc.socials,
		linkedinUrl: doc.linkedinUrl,
		twitterUrl: doc.twitterUrl,
		githubUrl: doc.githubUrl,
		oneLiner: doc.oneLiner,
		summary: doc.summary,
		confidence: doc.confidence,
		score: doc.score,
		siteEnrichStatus: doc.siteEnrichStatus,
		sitePageCount: doc.sitePageCount,
		address: doc.address,
		latitude: doc.latitude ?? null,
		longitude: doc.longitude ?? null,
		mapsUrl: doc.mapsUrl,
	};
}

/**
 * @param {{
 *   status?: string,
 *   reset?: boolean,
 *   enrich?: boolean,
 *   baseUrl?: string,
 * }} [opts]
 */
export async function runA16zCompaniesAgent(opts = {}) {
	const agent = A16Z_AGENT;
	const batchSize = agent.batchSize || BATCH_SIZE;
	const doEnrich = opts.enrich !== false;
	const status = opts.status || "Active";
	const listingUrl = A16Z_PORTFOLIO_URL;

	if (opts.reset) {
		await saveListingCursor({ offset: 0, saved: 0, enriched: 0, done: false });
		listingCache = { at: 0, html: "", url: "" };
	}

	const cursor = await loadListingCursor();
	const stored = await countCompanies().catch(() => 0);

	const summary = {
		agentId: agent.id,
		collection: agent.collection,
		listingUrl,
		status,
		batchSize,
		offsetFrom: cursor.offset,
		discovered: 0,
		feedTotal: 0,
		newCompanies: 0,
		enriched: 0,
		saved: 0,
		skipped: 0,
		done: false,
		companies: [],
		errors: [],
	};

	const html = await fetchPortfolioHtml(listingUrl);
	const parsed = parseA16zPortfolioHtml(html, {
		status,
		sourceUrl: listingUrl,
	});
	const list = parsed.companies;
	summary.feedTotal = parsed.totalRaw;
	summary.discovered = list.length;

	if (!list.length) {
		throw new Error("No a16z companies parsed from portfolio HTML");
	}

	let i = cursor.offset % list.length;
	const batch = [];
	let scanned = 0;
	while (batch.length < batchSize && scanned < list.length) {
		const c = list[i];
		i = (i + 1) % list.length;
		scanned += 1;
		try {
			const existing = await getCompany(c);
			const hashedId = companyDocId(c);
			if (existing && isSiteEnriched(existing) && doEnrich) {
				summary.skipped += 1;
				continue;
			}
			if (existing && !doEnrich) {
				summary.skipped += 1;
				continue;
			}
			batch.push({
				...c,
				...(existing || {}),
				...c,
				id: hashedId,
			});
		} catch (err) {
			summary.errors.push({ company: c.name, error: err?.message || String(err) });
		}
	}

	const nextOffset = i;
	const nothingLeft = batch.length === 0;

	if (nothingLeft) {
		await saveListingCursor({
			offset: 0,
			saved: cursor.saved,
			enriched: cursor.enriched,
			done: true,
		});
		summary.done = true;
		summary.offsetTo = 0;
		summary.stored = stored;
		summary.note = `All ${list.length} ${status} companies already stored and site-enriched. Pass --reset to run again.`;
		console.log(`[a16z] done — ${summary.note}`);
		return summary;
	}

	console.log(
		`[a16z] ${status} ${list.length}/${parsed.totalRaw} offset=${cursor.offset} → ${batch.map((c) => c.name).join(", ")}`,
	);

	const settled = await Promise.allSettled(
		batch.map(async (company) => {
			const exists = await companyExists(company);
			const fetchedAt = new Date().toISOString();
			const confidence = computeConfidence(company);
			let doc = {
				...company,
				id: companyDocId(company),
				summary: company.oneLiner || company.summary || "",
				confidence,
				score: confidence,
				fetchedAt,
			};
			if (!exists) await saveCompany(doc);

			if (doEnrich && company.website) {
				console.log(`[a16z:site] ${company.name} ${company.website}`);
				const patch = await enrichCompanySite(doc, {
					baseUrl: opts.baseUrl || LOCAL_API_BASE,
				});
				doc = { ...doc, ...patch };
			} else if (doEnrich && !company.website) {
				doc.siteEnrichStatus = "skipped";
				doc.siteEnrichError = "no_website";
				doc.siteEnrichedAt = new Date().toISOString();
			}

			await saveCompany(doc);
			return {
				isNew: !exists,
				didEnrich: Boolean(doEnrich && company.website),
				company: publicCompany(doc),
			};
		}),
	);

	for (let n = 0; n < settled.length; n++) {
		const row = settled[n];
		const company = batch[n];
		if (row.status === "fulfilled") {
			if (row.value.isNew) summary.newCompanies += 1;
			if (row.value.didEnrich) summary.enriched += 1;
			summary.saved += 1;
			summary.companies.push(row.value.company);
			console.log(
				`[a16z] ${row.value.company.name} site=${row.value.company.siteEnrichStatus || "pending"} pages=${row.value.company.sitePageCount || 0} ${row.value.company.website || ""}`,
			);
		} else {
			const message = row.reason?.message || String(row.reason);
			summary.errors.push({ company: company.name, error: message });
			try {
				await saveCompany({
					...company,
					id: companyDocId(company),
					siteEnrichStatus: "error",
					siteEnrichError: message,
					siteEnrichedAt: new Date().toISOString(),
					fetchedAt: new Date().toISOString(),
					confidence: computeConfidence(company),
					score: computeConfidence(company),
					summary: company.oneLiner || "",
				});
			} catch {
				/* ignore */
			}
		}
	}

	await saveListingCursor({
		offset: nextOffset,
		saved: (cursor.saved || 0) + summary.newCompanies,
		enriched: (cursor.enriched || 0) + summary.enriched,
		done: false,
	});
	summary.offsetTo = nextOffset;
	summary.done = false;
	summary.stored = stored + summary.newCompanies;

	console.log(
		`[a16z] saved ${summary.saved} new ${summary.newCompanies} enriched ${summary.enriched} skipped ${summary.skipped} → ${agent.collection}`,
	);
	return summary;
}

export { listCompanies, A16Z_AGENT };
