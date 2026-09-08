/**
 * England clubs orchestrator.
 * Scrape one Soccer Wiki page per tick, store, advance offset.
 * Loops (CLI or dashboard) until Firestore has 333 clubs. No LLM.
 */

import { scrapeUrl } from "../scrapefast.js";
import {
	ENGLAND_CLUBS_AGENT,
	ENRICH_BATCH_SIZE,
	LAST_OFFSET,
	PAGE_SIZE,
	TOTAL_CLUBS,
	expectedCountForOffset,
	listingUrl,
} from "./configs.js";
import {
	countClubs,
	loadCursor,
	saveClub,
	saveCursor,
} from "./core.js";
import { enrichClub } from "./enrich.js";
import { parseClubsPage } from "./parse.js";

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function fetchListingHtml(url) {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(30_000),
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-GB,en;q=0.9",
		},
	});
	if (!res.ok) throw new Error(`Soccer Wiki HTTP ${res.status}`);
	return res.text();
}

async function scrapeListing(offset, baseUrl) {
	const url = listingUrl(offset);
	const expected = expectedCountForOffset(offset);
	let html = "";
	try {
		html = await fetchListingHtml(url);
	} catch (err) {
		console.warn(
			"[england-clubs] direct listing fetch failed, falling back to /scrape:",
			err?.message || err,
		);
	}

	let clubs = parseClubsPage({ html });
	if (clubs.length < expected) {
		try {
			const row = await scrapeUrl(url, {
				baseUrl,
				timeoutMs: 90_000,
				waitForSelector: "table",
				includeImages: false,
			});
			clubs = parseClubsPage({
				html: html || row.html || row.data?.html || "",
				markdown: row.markdown || "",
				links: row.links || row.data?.links || [],
			});
		} catch (err) {
			if (!clubs.length) throw err;
			console.warn(
				"[england-clubs] /scrape fallback failed:",
				err?.message || err,
			);
		}
	}
	return { url, clubs, expected };
}

/**
 * @param {{
 *   baseUrl?: string,
 *   reset?: boolean,
 *   enrich?: boolean,
 *   pagesPerRun?: number,
 * }} [opts]
 */
export async function runEnglandClubsAgent(opts = {}) {
	const agent = ENGLAND_CLUBS_AGENT;
	const baseUrl = opts.baseUrl;
	const pagesPerRun = Math.max(
		1,
		Number(opts.pagesPerRun || process.env.CLUBS_PAGES_PER_RUN || 1),
	);
	const doEnrich = opts.enrich === true;
	let cursor = opts.reset
		? { offset: 0, done: false, listed: 0, pass: 0, savedThisPass: 0 }
		: await loadCursor();

	const storedStart = await countClubs().catch(() => 0);
	const summary = {
		agentId: agent.id,
		collection: agent.collection,
		country: agent.country,
		target: TOTAL_CLUBS,
		enrich: doEnrich,
		offsetFrom: cursor.offset,
		pages: [],
		fetched: 0,
		saved: 0,
		skipped: 0,
		enriched: 0,
		done: false,
		errors: [],
		clubs: [],
	};

	if (storedStart >= TOTAL_CLUBS && !opts.reset) {
		summary.done = true;
		summary.stored = storedStart;
		summary.listed = storedStart;
		summary.note = `Already have ${storedStart} clubs (target ${TOTAL_CLUBS}). Pass --reset to crawl again.`;
		await saveCursor({ offset: 0, done: true, listed: storedStart, pass: cursor.pass || 0 });
		console.log(`[england-clubs] done — ${storedStart}/${TOTAL_CLUBS} stored`);
		return summary;
	}

	if (cursor.done && storedStart < TOTAL_CLUBS) {
		cursor = { ...cursor, done: false };
	}

	let offset = cursor.offset || 0;
	if (offset > LAST_OFFSET) offset = 0;
	let pages = 0;

	while (pages < pagesPerRun) {
		const storedNow = await countClubs().catch(() => storedStart);
		if (storedNow >= TOTAL_CLUBS) break;

		const page = { offset, url: listingUrl(offset), count: 0, saved: 0 };
		try {
			console.log(`[england-clubs] page offset=${offset} ${page.url}`);
			const { clubs, expected } = await scrapeListing(offset, baseUrl);
			page.count = clubs.length;
			page.expected = expected;
			summary.fetched += clubs.length;

			if (!clubs.length) {
				summary.errors.push({ offset, error: "no clubs parsed — will retry this offset" });
				summary.pages.push(page);
				break;
			}

			const shortPage = clubs.length < expected;
			if (shortPage) {
				summary.errors.push({
					offset,
					error: `parsed ${clubs.length}/${expected} clubs — not advancing until the page is complete`,
				});
			}

			for (const raw of clubs) {
				let club = {
					...raw,
					sourceUrl: page.url,
					fetchedAt: new Date().toISOString(),
					snippet: [raw.league, raw.manager, raw.stadium, raw.location]
						.filter(Boolean)
						.join(" · "),
				};
				if (doEnrich && summary.enriched < ENRICH_BATCH_SIZE) {
					try {
						const extra = await enrichClub(club, { baseUrl });
						club = { ...club, ...extra };
						if (club.website || club.email || club.latitude) summary.enriched += 1;
					} catch (err) {
						summary.errors.push({
							club: club.name,
							error: err?.message || String(err),
						});
					}
				}
				const result = await saveClub(club, { mode: doEnrich ? "merge" : "once" });
				if (result.skipped) summary.skipped += 1;
				else {
					summary.saved += 1;
					page.saved += 1;
				}
				summary.clubs.push({
					id: result.id,
					name: club.name,
					league: club.league,
					manager: club.manager,
					skipped: result.skipped,
				});
			}

			const wrapped = !shortPage && offset >= LAST_OFFSET;
			if (!shortPage) {
				offset = wrapped ? 0 : offset + PAGE_SIZE;
			}
			pages += 1;
			summary.pages.push(page);
			if (wrapped) summary.wrapped = true;
			if (shortPage) break;
			if (pages < pagesPerRun) await sleep(800);
		} catch (err) {
			summary.errors.push({ offset, error: err?.message || String(err) });
			summary.pages.push(page);
			break;
		}
	}

	const stored = await countClubs().catch(() => storedStart + summary.saved);
	const wrappedThisTick = Boolean(summary.wrapped);
	const pass = (cursor.pass || 0) + (wrappedThisTick ? 1 : 0);
	const savedThisPass = wrappedThisTick
		? 0
		: (Number(cursor.savedThisPass) || 0) + summary.saved;
	const pagesComplete = summary.pages.every(
		(p) => Number(p.count) >= Number(p.expected || PAGE_SIZE),
	);
	const stalled =
		stored < TOTAL_CLUBS &&
		wrappedThisTick &&
		pagesComplete &&
		(Number(cursor.savedThisPass) || 0) + summary.saved === 0 &&
		pass >= 3;
	const done = stored >= TOTAL_CLUBS;
	await saveCursor({
		offset: stored >= TOTAL_CLUBS ? 0 : offset,
		done: stored >= TOTAL_CLUBS,
		listed: stored,
		pass,
		savedThisPass,
	});
	summary.offsetTo = offset;
	summary.listed = stored;
	summary.stored = stored;
	summary.done = done;
	summary.pass = pass;
	if (stalled) {
		summary.note = `Listing wrapped with complete pages and 0 new clubs — still ${stored}/${TOTAL_CLUBS}.`;
	}

	console.log(
		`[england-clubs] stored ${summary.saved} new (${summary.skipped} skipped) ${stored}/${TOTAL_CLUBS}${done ? " done" : ""}`,
	);
	return summary;
}

export { countClubs, listClubs } from "./core.js";
