/**
 * Angel / seed investor discovery — X, LinkedIn, Google.
 * Focus: tech, AI, food, agri, deep tech, SaaS, indie hackers who write cheques.
 */

export const ANGEL_COLLECTION = "angel-seed-investors";
export const ANGEL_STATE_COLLECTION = "angelSeedInvestorState";

export const ANGEL_AGENT = {
	id: "angel-seed",
	name: "Angel & Seed Investor Finder",
	collection: ANGEL_COLLECTION,
	stateCollection: ANGEL_STATE_COLLECTION,
	relevanceMin: 4,
	scoreBatchSize: 10,
	queriesPerRun: Number(process.env.ANGEL_QUERIES_PER_RUN || "3"),
	/** Enrich up to N new candidates per run by scraping profile/site pages */
	enrichPerRun: Number(process.env.ANGEL_ENRICH_PER_RUN || "8"),
};

export const SECTORS = [
	"AI",
	"SaaS",
	"deep tech",
	"food tech",
	"agriculture tech",
	"indie hackers",
	"fintech",
	"climate tech",
	"consumer tech",
];

/**
 * Rotating search jobs — platform agents use Google SERP (site: filters)
 * then optional page scrape for email / phone / socials.
 */
export function buildSearchQueries() {
	const out = [];

	for (const sector of SECTORS) {
		out.push({
			id: `x-${sector.replace(/\s+/g, "-")}`,
			platform: "x",
			sector,
			query: `angel investor ${sector} site:x.com OR site:twitter.com`,
		});
		out.push({
			id: `x-check-${sector.replace(/\s+/g, "-")}`,
			platform: "x",
			sector,
			query: `"angel investor" OR "seed investor" "${sector}" writing checks site:x.com`,
		});

		out.push({
			id: `li-${sector.replace(/\s+/g, "-")}`,
			platform: "linkedin",
			sector,
			query: `angel investor ${sector} site:linkedin.com/in`,
		});
		out.push({
			id: `li-seed-${sector.replace(/\s+/g, "-")}`,
			platform: "linkedin",
			sector,
			query: `"seed investor" OR "angel investor" ${sector} "open to" site:linkedin.com/in`,
		});

		out.push({
			id: `g-${sector.replace(/\s+/g, "-")}`,
			platform: "google",
			sector,
			query: `${sector} angel investor email OR contact OR portfolio`,
		});
		out.push({
			id: `g-list-${sector.replace(/\s+/g, "-")}`,
			platform: "google",
			sector,
			query: `best angel investors ${sector} 2024 2025 who write checks`,
		});
	}

	// Broad evergreen queries
	out.push(
		{
			id: "x-broad-angel",
			platform: "x",
			sector: "general",
			query: `"angel investor" OR "seed checks" OR "happy to intro" site:x.com`,
		},
		{
			id: "li-broad-angel",
			platform: "linkedin",
			sector: "general",
			query: `"angel investor" OR "seed stage investor" site:linkedin.com/in`,
		},
		{
			id: "g-angel-list",
			platform: "google",
			sector: "general",
			query: "angel investor directory email contact tech SaaS AI",
		},
		{
			id: "g-seed-india",
			platform: "google",
			sector: "general",
			query: "angel seed investors India tech startups email LinkedIn Twitter",
		},
	);

	return out;
}

export const ALL_QUERIES = buildSearchQueries();
