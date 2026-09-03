/**
 * England football clubs — Soccer Wiki listing (countryId=ENG only).
 * Scrape-only. No LLM. Optional Google + site enrich via --enrich.
 */

export const CLUBS_COLLECTION = "clubs";
export const CLUBS_STATE_COLLECTION = "englandClubsState";

export const WIKI_ORIGIN = "https://en.soccerwiki.org";
export const COUNTRY_ID = "ENG";
export const COUNTRY_NAME = "England";
export const PAGE_SIZE = 50;
export const TOTAL_CLUBS = 333;
/** Last listing page starts at offset 300 (clubs 301–333). */
export const LAST_OFFSET = 300;

export const ENGLAND_CLUBS_AGENT = {
	id: "england-clubs",
	name: "England football clubs",
	collection: CLUBS_COLLECTION,
	stateCollection: CLUBS_STATE_COLLECTION,
	countryId: COUNTRY_ID,
	country: COUNTRY_NAME,
	pageSize: PAGE_SIZE,
	total: TOTAL_CLUBS,
	enrichPerPage: Number(process.env.CLUBS_ENRICH_PER_PAGE || "8"),
};

export function listingUrl(offset = 0) {
	const n = Math.max(0, Number(offset) || 0);
	if (n <= 0) {
		return `${WIKI_ORIGIN}/country.php?action=clubs&countryId=${COUNTRY_ID}`;
	}
	return `${WIKI_ORIGIN}/country.php?countryId=${COUNTRY_ID}&action=clubs&offset=${n}`;
}

export function absoluteWikiUrl(href) {
	const s = String(href || "").trim();
	if (!s) return "";
	try {
		return new URL(s, WIKI_ORIGIN).href;
	} catch {
		return s;
	}
}
