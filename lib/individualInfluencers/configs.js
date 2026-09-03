/**
 * Individual influencers — X, Instagram, YouTube.
 * People only (not brands / companies / agencies). Client filters via tags.
 */

export const INFLUENCERS_COLLECTION = "individual-influencers";
export const INFLUENCERS_STATE_COLLECTION = "individualInfluencersState";

export const INFLUENCER_NICHES = [
	"Spirituality",
	"Fitness",
	"Tech",
	"Finance",
	"Education",
	"Comedy",
	"Food",
	"Fashion",
	"Travel",
	"Music",
	"Gaming",
	"Health",
	"Business",
	"Parenting",
	"Art",
	"Sports",
	"Lifestyle",
	"Beauty",
];

export const INFLUENCER_AGENT = {
	id: "individual-influencers",
	name: "Individual social creators",
	collection: INFLUENCERS_COLLECTION,
	stateCollection: INFLUENCERS_STATE_COLLECTION,
	minFollowers: Number(process.env.INFLUENCERS_MIN_FOLLOWERS || "10000"),
	queriesPerRun: Number(process.env.INFLUENCERS_QUERIES_PER_RUN || "3"),
	enrichPerRun: Number(process.env.INFLUENCERS_ENRICH_PER_RUN || "8"),
	scoreBatchSize: Number(process.env.INFLUENCERS_SCORE_BATCH || "8"),
	relevanceMin: 3,
	targetCount: Number(process.env.INFLUENCERS_TARGET || "500"),
};

export function buildSearchQueries() {
	const out = [];
	for (const niche of INFLUENCER_NICHES) {
		out.push({
			id: `x-${niche.toLowerCase()}`,
			platform: "x",
			niche,
			query: `${niche} creator OR influencer OR writer site:x.com OR site:twitter.com`,
		});
		out.push({
			id: `x-top-${niche.toLowerCase()}`,
			platform: "x",
			niche,
			query: `top ${niche} twitter accounts OR X creators 10k followers`,
		});
		out.push({
			id: `ig-${niche.toLowerCase()}`,
			platform: "instagram",
			niche,
			query: `${niche} influencer creator site:instagram.com`,
		});
		out.push({
			id: `ig-person-${niche.toLowerCase()}`,
			platform: "instagram",
			niche,
			query: `"${niche}" instagram creator person -agency -official -brand`,
		});
		out.push({
			id: `yt-${niche.toLowerCase()}`,
			platform: "youtube",
			niche,
			query: `${niche} youtuber creator site:youtube.com/@`,
		});
		out.push({
			id: `yt-channel-${niche.toLowerCase()}`,
			platform: "youtube",
			niche,
			query: `best ${niche} YouTube channels individual creator`,
		});
	}

	out.push(
		{
			id: "x-spirituality-focus",
			platform: "x",
			niche: "Spirituality",
			query: `spirituality meditation yoga teacher site:x.com`,
		},
		{
			id: "ig-spirituality-focus",
			platform: "instagram",
			niche: "Spirituality",
			query: `spirituality meditation healer site:instagram.com`,
		},
		{
			id: "yt-spirituality-focus",
			platform: "youtube",
			niche: "Spirituality",
			query: `spirituality meditation teacher site:youtube.com/@`,
		},
	);

	return out;
}

export const ALL_QUERIES = buildSearchQueries();
