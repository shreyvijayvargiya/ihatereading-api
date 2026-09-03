/**
 * YC companies agent — real YC startups (not listicle SERP junk).
 * Primary: yc-oss public JSON (same Algolia-backed directory as ycombinator.com).
 */

export const YC_COLLECTION = "yc-companies";
export const YC_STATE_COLLECTION = "ycCompaniesState";

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
export function buildDiscoverySources() {
	const batches = [
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
