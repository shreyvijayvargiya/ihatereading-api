/**
 * a16z portfolio companies — stored in the same Firestore collection as YC (`yc-companies`).
 * Listing: https://a16z.com/portfolio/?status=Active
 * Each tick: 4 companies, then wait 8000ms. Site enrich runs in-process.
 */

export const A16Z_COLLECTION = "yc-companies";
/** Legacy collection from the first a16z scrape — merge CLI copies these into yc-companies. */
export const A16Z_LEGACY_COLLECTION = "a16z-companies";
export const A16Z_STATE_COLLECTION = "a16zCompaniesState";
export const A16Z_STATE_DOC = "a16z-companies";
export const BATCH_SIZE = 4;
export const INTERVAL_MS = 8_000;
export const LOCAL_API_BASE = "http://127.0.0.1:3002";

export const A16Z_PORTFOLIO_URL = "https://a16z.com/portfolio/?status=Active";

export const A16Z_AGENT = {
	id: "a16z-companies",
	name: "a16z Companies Scraper",
	collection: A16Z_COLLECTION,
	stateCollection: A16Z_STATE_COLLECTION,
	batchSize: Number(process.env.A16Z_BATCH_SIZE || String(BATCH_SIZE)),
	intervalMs: Number(process.env.A16Z_INTERVAL_MS || String(INTERVAL_MS)),
};
