/**
 * YC companies agent — real YC startups (not listicle SERP junk).
 * Primary: yc-oss public JSON (same Algolia-backed directory as ycombinator.com).
 */

export const YC_COLLECTION = "yc-companies";
export const YC_STATE_COLLECTION = "ycCompaniesState";
export const SITE_ENRICH_STATE_DOC = "yc-companies-site-enrich";
export const SITE_ENRICH_BATCH_SIZE = 4;
export const SITE_ENRICH_INTERVAL_MS = 8_000;

export const LAUNCH_ENRICH_STATE_DOC = "yc-companies-launch-enrich";
export const LAUNCH_ENRICH_BATCH_SIZE = Number(
	process.env.YC_LAUNCH_ENRICH_BATCH || "2",
);
export const LAUNCH_ENRICH_INTERVAL_MS = Number(
	process.env.YC_LAUNCH_ENRICH_INTERVAL_MS || "12_000",
);

/** Newest-first batch walk: W26 → S26 → P26 → F26 → W25 → … */
export function buildLaunchEnrichBatchOrder(endYear = new Date().getFullYear()) {
	const batches = [];
	for (let year = endYear; year >= 2005; year -= 1) {
		const yy = String(year % 100).padStart(2, "0");
		batches.push(`W${yy}`, `S${yy}`, `P${yy}`, `F${yy}`);
	}
	return batches;
}

export const LAUNCH_ENRICH_BATCH_ORDER = buildLaunchEnrichBatchOrder();
export const LOCAL_API_BASE = "http://127.0.0.1:3002";

export const YC_AGENT = {
	id: "yc-companies",
	name: "YC Companies Scraper",
	collection: YC_COLLECTION,
	stateCollection: YC_STATE_COLLECTION,
	/** Discovery feeds processed per loop tick */
	sourcesPerRun: Number(process.env.YC_SOURCES_PER_RUN || "1"),
	/** Max NEW companies to deep-enrich per run */
	enrichPerRun: Number(process.env.YC_ENRICH_PER_RUN || "8"),
	/** How many companies to pull from a feed page per run */
	pageSize: Number(process.env.YC_PAGE_SIZE || "40"),
	scoreBatchSize: Number(process.env.YC_SCORE_BATCH || "8"),
	relevanceMin: 1,
};

export const STATUSES = ["Active", "Inactive", "Acquired", "Public", "shutdown", "rejected", "unknown"];

/** Official-ish public mirrors of the YC company directory */
export const YC_OSS_BASE = "https://yc-oss.github.io/api";

/**
 * Rotating discovery sources — prefer structured YC company data.
 * type: yc-oss | yc-company-page | google-discover | hackernews
 */
/** Recent YC batch codes (Winter/Summer + 2-digit year). */
export const YC_BATCH_CODES = [
	"W26",
	"S25",
	"W25",
	"S24",
	"W24",
	"S23",
	"W23",
	"S22",
	"W22",
	"S21",
	"W21",
	"S20",
	"W20",
];

export function normalizeBatchCode(raw) {
	const s = String(raw || "").trim();
	if (!s) return null;
	const short = s.match(/^([WSF])(\d{2})$/i);
	if (short) return `${short[1].toUpperCase()}${short[2]}`;
	const long = s.match(/^(Winter|Summer|Fall|Spring)\s+20(\d{2})$/i);
	if (long) {
		const letter = /^Winter/i.test(long[1])
			? "W"
			: /^Summer/i.test(long[1])
				? "S"
				: /^Fall/i.test(long[1])
					? "F"
					: "P";
		return `${letter}${long[2]}`;
	}
	return s.toUpperCase();
}

/** e.g. year 2026 → W26, S26; year 2025 → W25, S25 */
export function batchesForYear(year) {
	const y = Number(year);
	if (!Number.isFinite(y) || y < 2005 || y > 2100) return [];
	const yy = String(y % 100).padStart(2, "0");
	return [`W${yy}`, `S${yy}`];
}

export function parseBatchFilters(opts = {}) {
	const out = new Set();
	if (opts.year != null && opts.year !== "") {
		for (const b of batchesForYear(opts.year)) out.add(b);
	}
	const listRaw = opts.batches ?? opts.batch;
	if (listRaw != null && listRaw !== "") {
		for (const part of String(listRaw).split(/[,;\s]+/)) {
			const norm = normalizeBatchCode(part);
			if (norm) out.add(norm);
		}
	}
	return [...out];
}

function makeBatchSources(batch) {
	const b = normalizeBatchCode(batch);
	if (!b) return [];
	return [
		{
			id: `yc-oss-batch-${b.toLowerCase()}`,
			type: "yc-oss",
			statusHint: "funded",
			url: `${YC_OSS_BASE}/companies/all.json`,
			label: `YC batch ${b}`,
			batch: b,
		},
		{
			id: `g-batch-site-${b.toLowerCase()}`,
			type: "google-discover",
			statusHint: "funded",
			query: `site:ycombinator.com/companies ${b}`,
			label: `Google YC ${b} company pages only`,
			batch: b,
		},
	];
}

/** Discovery sources limited to specific batches (yc-oss + Google site). */
export function sourcesForBatches(batchCodes) {
	const want = new Set(batchCodes.map((b) => normalizeBatchCode(b)).filter(Boolean));
	if (!want.size) return [];

	const matched = ALL_SOURCES.filter(
		(s) => s.batch && want.has(normalizeBatchCode(s.batch)),
	);
	const have = new Set(matched.map((s) => normalizeBatchCode(s.batch)));
	for (const code of want) {
		if (!have.has(code)) {
			matched.push(...makeBatchSources(code));
		}
	}
	return matched;
}

export function buildDiscoverySources() {
	const batches = YC_BATCH_CODES;

	const sources = [
		{
			id: "yc-oss-hiring",
			type: "yc-oss",
			statusHint: "Active",
			url: `${YC_OSS_BASE}/companies/hiring.json`,
			label: "YC companies currently hiring",
			preferHiring: true,
		},
		{
			id: "yc-oss-all",
			type: "yc-oss",
			statusHint: "funded",
			url: `${YC_OSS_BASE}/companies/all.json`,
			label: "All YC launched companies",
		},
		{
			id: "yc-oss-top",
			type: "yc-oss",
			statusHint: "Active",
			url: `${YC_OSS_BASE}/companies/top.json`,
			label: "YC top companies",
		},
		{
			id: "hn-launch",
			type: "hackernews",
			statusHint: "unknown",
			url: "https://news.ycombinator.com/show",
			label: "HN Show (YC/startup signals)",
		},
		{
			id: "g-shutdown-site",
			type: "google-discover",
			statusHint: "shutdown",
			query:
				'site:ycombinator.com/companies ("Inactive" OR shutdown OR deadpooled) YC',
			label: "Google YC inactive (site only)",
		},
		{
			id: "g-hiring-site",
			type: "google-discover",
			statusHint: "Active",
			query: "site:ycombinator.com/companies hiring jobs careers",
			label: "Google YC hiring pages (site only)",
		},
	];

	for (const batch of batches) {
		sources.push({
			id: `yc-oss-batch-${batch.toLowerCase()}`,
			type: "yc-oss",
			statusHint: "funded",
			// all.json filtered client-side by batch; keep url as all for reuse
			url: `${YC_OSS_BASE}/companies/all.json`,
			label: `YC batch ${batch}`,
			batch,
		});
		sources.push({
			id: `g-batch-site-${batch.toLowerCase()}`,
			type: "google-discover",
			statusHint: "funded",
			query: `site:ycombinator.com/companies ${batch}`,
			label: `Google YC ${batch} company pages only`,
			batch,
		});
	}

	return sources;
}

export const ALL_SOURCES = buildDiscoverySources();

/** Domains / titles that are directories, not companies */
export const JUNK_HOST_RE =
	/ycfounderlist|techstartupslist|extruct\.ai|ycinsight|vcbacked|crunchbase\.com\/lists|failory|failory|seedtable|wellfound\.com\/startups|angel\.co\/companies|forbes\.com|medium\.com|substack\.com|wikipedia\.org/i;

export const JUNK_NAME_RE =
	/^(y combinator|yc founder list|tech startups? list|extruct|yc insight|vc backed|y combinator founders? directory|y combinator fund|best yc|top yc|list of)/i;
