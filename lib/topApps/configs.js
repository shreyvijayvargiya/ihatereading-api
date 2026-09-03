/**
 * Top Mobile Apps — Apple App Store + Google Play via our /scrape only (no SERP).
 */

export const TOP_MOBILE_APPS_COLLECTION = "top-mobile-apps";
export const TOP_MOBILE_APPS_STATE_COLLECTION = "topMobileAppsAgentState";

/** @deprecated */
export const TOP_APPS_COLLECTION = TOP_MOBILE_APPS_COLLECTION;
export const TOP_APPS_STATE_COLLECTION = TOP_MOBILE_APPS_STATE_COLLECTION;

export const TOP_MOBILE_APPS_AGENT = {
	id: "discovery-top-mobile-apps",
	name: "Top Mobile Apps Discovery (App Store + Google Play)",
	collection: TOP_MOBILE_APPS_COLLECTION,
	stateCollection: TOP_MOBILE_APPS_STATE_COLLECTION,
	targetCount: Number(
		process.env.TOP_MOBILE_APPS_TARGET || process.env.TOP_APPS_TARGET || "10000",
	),
	sourcesPerRun: Number(
		process.env.TOP_MOBILE_APPS_SOURCES_PER_RUN ||
			process.env.TOP_APPS_SOURCES_PER_RUN ||
			"2",
	),
	enrichPerRun: Number(
		process.env.TOP_MOBILE_APPS_ENRICH_PER_RUN ||
			process.env.TOP_APPS_ENRICH_PER_RUN ||
			"40",
	),
	/** Max app listing URLs to keep per scraped category/chart page */
	listingsPerSource: Number(process.env.TOP_MOBILE_APPS_LISTINGS_PER_SOURCE || "40"),
	scoreBatchSize: Number(
		process.env.TOP_MOBILE_APPS_SCORE_BATCH ||
			process.env.TOP_APPS_SCORE_BATCH ||
			"8",
	),
	relevanceMin: 0,
};

/** @deprecated */
export const TOP_APPS_AGENT = TOP_MOBILE_APPS_AGENT;

/** Apple iOS genre ids — scraped as apps.apple.com/us/genre/ios-…/idXXXX */
const APPLE_GENRES = [
	{ category: "Finance", genreId: 6015, slug: "ios-finance" },
	{ category: "Fitness", genreId: 6013, slug: "ios-health-fitness" },
	{ category: "Health", genreId: 6013, slug: "ios-health-fitness" },
	{ category: "Social Networking", genreId: 6005, slug: "ios-social-networking" },
	{ category: "Photo & Video", genreId: 6008, slug: "ios-photo-video" },
	{ category: "Productivity", genreId: 6007, slug: "ios-productivity" },
	{ category: "Education", genreId: 6017, slug: "ios-education" },
	{ category: "Shopping", genreId: 6024, slug: "ios-shopping" },
	{ category: "Food & Drink", genreId: 6023, slug: "ios-food-drink" },
	{ category: "Travel", genreId: 6003, slug: "ios-travel" },
	{ category: "Music", genreId: 6011, slug: "ios-music" },
	{ category: "News", genreId: 6009, slug: "ios-news" },
	{ category: "Weather", genreId: 6001, slug: "ios-weather" },
	{ category: "Utilities", genreId: 6002, slug: "ios-utilities" },
	{ category: "Lifestyle", genreId: 6012, slug: "ios-lifestyle" },
	{ category: "Business", genreId: 6000, slug: "ios-business" },
	{ category: "Entertainment", genreId: 6016, slug: "ios-entertainment" },
	{ category: "Games", genreId: 6014, slug: "ios-games" },
	{ category: "Medical", genreId: 6020, slug: "ios-medical" },
	{ category: "Sports", genreId: 6004, slug: "ios-sports" },
	{ category: "Reference", genreId: 6006, slug: "ios-reference" },
	{ category: "Navigation", genreId: 6010, slug: "ios-navigation" },
];

/** Google Play category path segments */
const PLAY_CATEGORIES = [
	{ category: "Finance", play: "FINANCE" },
	{ category: "Fitness", play: "HEALTH_AND_FITNESS" },
	{ category: "Health", play: "HEALTH_AND_FITNESS" },
	{ category: "Social Networking", play: "SOCIAL" },
	{ category: "Photo & Video", play: "PHOTOGRAPHY" },
	{ category: "Productivity", play: "PRODUCTIVITY" },
	{ category: "Education", play: "EDUCATION" },
	{ category: "Shopping", play: "SHOPPING" },
	{ category: "Food & Drink", play: "FOOD_AND_DRINK" },
	{ category: "Travel", play: "TRAVEL_AND_LOCAL" },
	{ category: "Music", play: "MUSIC_AND_AUDIO" },
	{ category: "News", play: "NEWS_AND_MAGAZINES" },
	{ category: "Weather", play: "WEATHER" },
	{ category: "Utilities", play: "TOOLS" },
	{ category: "Lifestyle", play: "LIFESTYLE" },
	{ category: "Business", play: "BUSINESS" },
	{ category: "Entertainment", play: "ENTERTAINMENT" },
	{ category: "Games", play: "GAME" },
	{ category: "Medical", play: "MEDICAL" },
	{ category: "Sports", play: "SPORTS" },
	{ category: "Reference", play: "BOOKS_AND_REFERENCE" },
	{ category: "Navigation", play: "MAPS_AND_NAVIGATION" },
	{ category: "Dating", play: "DATING" },
	{ category: "Kids", play: "FAMILY" },
];

export const MOBILE_CATEGORIES = [
	...new Set([...APPLE_GENRES, ...PLAY_CATEGORIES].map((c) => c.category)),
];

/**
 * Discovery sources — scrape these store pages with POST /scrape (no Google SERP).
 */
export function buildDiscoverySources() {
	const sources = [];

	for (const g of APPLE_GENRES) {
		sources.push({
			id: `apple-${g.slug}`,
			store: "apple_app_store",
			platform: "ios",
			category: g.category,
			label: `App Store — ${g.category}`,
			scrapeUrls: [
				`https://apps.apple.com/us/genre/${g.slug}/id${g.genreId}`,
				`https://apps.apple.com/in/genre/${g.slug}/id${g.genreId}`,
			],
			itunesRssUrls: [
				`https://itunes.apple.com/us/rss/topfreeapplications/limit=50/genre=${g.genreId}/json`,
				`https://itunes.apple.com/us/rss/toppaidapplications/limit=25/genre=${g.genreId}/json`,
				`https://itunes.apple.com/in/rss/topfreeapplications/limit=50/genre=${g.genreId}/json`,
			],
			googleQueries: [
				`site:apps.apple.com/app ${g.category} iphone`,
			],
		});
	}

	for (const p of PLAY_CATEGORIES) {
		sources.push({
			id: `play-${p.play.toLowerCase()}`,
			store: "google_play",
			platform: "android",
			category: p.category,
			label: `Google Play — ${p.category}`,
			scrapeUrls: [
				`https://play.google.com/store/apps/category/${p.play}`,
				`https://play.google.com/store/apps/category/${p.play}?hl=en&gl=in`,
			],
			itunesRssUrls: [],
			googleQueries: [
				`site:play.google.com/store/apps/details ${p.category} app`,
			],
		});
	}

	sources.push(
		{
			id: "apple-charts-free",
			store: "apple_app_store",
			platform: "ios",
			category: "Top Charts",
			label: "App Store charts — top free",
			scrapeUrls: [
				"https://apps.apple.com/us/charts/iphone/top-free-apps/36",
				"https://apps.apple.com/in/charts/iphone/top-free-apps/36",
			],
			itunesRssUrls: [
				"https://itunes.apple.com/us/rss/topfreeapplications/limit=50/json",
				"https://itunes.apple.com/in/rss/topfreeapplications/limit=50/json",
			],
			googleQueries: ["site:apps.apple.com/app top free iphone"],
		},
		{
			id: "apple-charts-paid",
			store: "apple_app_store",
			platform: "ios",
			category: "Top Charts",
			label: "App Store charts — top paid",
			scrapeUrls: [
				"https://apps.apple.com/us/charts/iphone/top-paid-apps/36",
			],
			itunesRssUrls: [
				"https://itunes.apple.com/us/rss/toppaidapplications/limit=50/json",
			],
			googleQueries: ["site:apps.apple.com/app top paid iphone"],
		},
		{
			id: "play-top",
			store: "google_play",
			platform: "android",
			category: "Top Charts",
			label: "Google Play — top charts",
			scrapeUrls: [
				"https://play.google.com/store/apps/top",
				"https://play.google.com/store/apps/top?hl=en&gl=us",
			],
			itunesRssUrls: [],
			googleQueries: ["site:play.google.com/store/apps/details top free android"],
		},
		{
			id: "play-games",
			store: "google_play",
			platform: "android",
			category: "Games",
			label: "Google Play — games",
			scrapeUrls: ["https://play.google.com/store/games"],
			itunesRssUrls: [],
			googleQueries: ["site:play.google.com/store/apps/details android game"],
		},
	);

	return sources;
}

export const ALL_SOURCES = buildDiscoverySources();

/** @deprecated */
export const CATEGORIES = MOBILE_CATEGORIES;

export const JUNK_NAME_RE =
	/^(best |top \d+|list of|comparison|charts|category|collection|google play|app store|see all)$/i;
