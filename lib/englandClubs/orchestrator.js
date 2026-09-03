/**
 * England clubs orchestrator.
 * Scrape one Soccer Wiki page per tick, store, advance offset.
 * Loops (CLI or dashboard) until Firestore has 333 clubs. No LLM.
 */

import { scrapeUrl } from "../scrapefast.js";
import {
	ENGLAND_CLUBS_AGENT,
	LAST_OFFSET,
	PAGE_SIZE,
	TOTAL_CLUBS,
	listingUrl,
} from "./configs.js";
import {
	countClubs,
	enrichClub,
	loadCursor,
	saveClub,
	saveCursor,
} from "./core.js";
import { parseClubsPage } from "./parse.js";

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function scrapeListing(offset, baseUrl) {
	const url = listingUrl(offset);
	const row = await scrapeUrl(url, {
		baseUrl,
		timeoutMs: 90_000,
		waitForSelector: "table",
		includeImages: false,
	});
	const clubs = parseClubsPage({
		html: row.html || row.data?.html || "",
		markdown: row.markdown || "",
		links: row.links || row.data?.links || [],
	});
	return { url, clubs };
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
		? { offset: 0, done: false, listed: 0, pass: 0 }
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
			const { clubs } = await scrapeListing(offset, baseUrl);
			page.count = clubs.length;
			summary.fetched += clubs.length;

			if (!clubs.length) {
				summary.errors.push({ offset, error: "no clubs parsed — will retry this offset" });
				summary.pages.push(page);
				break;
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
				if (doEnrich && summary.enriched < agent.enrichPerPage) {
					try {
						club = await enrichClub(club, { baseUrl });
						if (club.website || club.email) summary.enriched += 1;
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

			const lastPage = offset >= LAST_OFFSET || clubs.length < PAGE_SIZE;
			offset = lastPage ? 0 : offset + PAGE_SIZE;
			pages += 1;
			summary.pages.push(page);
			if (pages < pagesPerRun) await sleep(800);
		} catch (err) {
			summary.errors.push({ offset, error: err?.message || String(err) });
			summary.pages.push(page);
			break;
		}
	}

	const stored = await countClubs().catch(() => storedStart + summary.saved);
	const done = stored >= TOTAL_CLUBS;
	await saveCursor({
		offset: done ? 0 : offset,
		done,
		listed: stored,
		pass: cursor.pass || 0,
	});
	summary.offsetTo = offset;
	summary.listed = stored;
	summary.stored = stored;
	summary.done = done;

	console.log(
		`[england-clubs] stored ${summary.saved} new (${summary.skipped} skipped) ${stored}/${TOTAL_CLUBS}${done ? " done" : ""}`,
	);
	return summary;
}

export { countClubs, listClubs } from "./core.js";
