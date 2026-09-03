/**
 * iHateReading internet news — programming, startups, SaaS, funding, ihatereading.in.
 * 20 list platforms; 4 per tick; 10–20 top URLs from each list.
 */

export const INTERNET_NEWS_COLLECTION = "ihatereading-internet-news";
export const INTERNET_NEWS_STATE = "ihatereadingInternetNewsState";

export const INTERNET_NEWS_AGENT = {
	id: "ihatereading-internet-news",
	name: "iHateReading internet news",
	collection: INTERNET_NEWS_COLLECTION,
	stateCollection: INTERNET_NEWS_STATE,
	platformsPerRun: Number(process.env.NEWS_PLATFORMS_PER_RUN || "4"),
	urlsPerPlatform: Number(process.env.NEWS_URLS_PER_PLATFORM || "15"),
};

/** Google News keywords (rotated when the google-news platform runs). */
export const NEWS_KEYWORDS = [
	{ q: "programming", category: "programming", tags: ["programming"] },
	{ q: "software engineering", category: "programming", tags: ["programming"] },
	{ q: "javascript OR next.js", category: "programming", tags: ["programming", "javascript"] },
	{ q: "SaaS startup", category: "saas", tags: ["saas", "startups"] },
	{ q: "startup funding", category: "funding", tags: ["funding", "startups"] },
	{ q: "seed round OR series A venture capital", category: "funding", tags: ["funding", "investment"] },
	{ q: "Y Combinator", category: "startups", tags: ["startups", "funding"] },
	{ q: "AI coding agents OR cursor IDE", category: "programming", tags: ["programming", "ai"] },
	{ q: "ihatereading", category: "ihatereading", tags: ["ihatereading"] },
	{ q: "ihatereading.in", category: "ihatereading", tags: ["ihatereading"] },
	{ q: "open source", category: "programming", tags: ["programming", "opensource"] },
	{ q: "venture capital technology", category: "investment", tags: ["investment", "funding"] },
	{ q: "indie hacker SaaS", category: "saas", tags: ["saas", "startups"] },
	{ q: "developer tools", category: "programming", tags: ["programming"] },
];

/**
 * 20 list sources. `techbase` is an alias of TechCrunch.
 * hostAllow empty + allowOffsite = keep outbound article URLs (HN, Lobsters).
 */
export const NEWS_PLATFORMS = [
	{
		id: "google-news",
		name: "Google News",
		listUrl: null,
		kind: "google-news",
		category: "programming",
		tags: ["google-news"],
	},
	{
		id: "hackernews",
		name: "Hacker News",
		listUrl: "https://news.ycombinator.com/",
		feedUrl: "https://news.ycombinator.com/rss",
		allowOffsite: true,
		pathDeny: [/\/login/i, /\/vote/i, /\/hide/i, /\/fave/i],
		category: "programming",
		tags: ["programming", "startups"],
	},
	{
		id: "techcrunch",
		aliases: ["techbase"],
		name: "TechCrunch",
		listUrl: "https://techcrunch.com/",
		feedUrl: "https://techcrunch.com/feed/",
		hostAllow: ["techcrunch.com"],
		category: "startups",
		tags: ["startups", "saas", "funding"],
	},
	{
		id: "theverge",
		name: "The Verge",
		listUrl: "https://www.theverge.com/tech",
		feedUrl: "https://www.theverge.com/rss/index.xml",
		hostAllow: ["theverge.com"],
		category: "programming",
		tags: ["programming"],
	},
	{
		id: "wired",
		name: "Wired",
		listUrl: "https://www.wired.com/category/business/",
		feedUrl: "https://www.wired.com/feed/rss",
		hostAllow: ["wired.com"],
		category: "startups",
		tags: ["startups", "programming"],
	},
	{
		id: "arstechnica",
		name: "Ars Technica",
		listUrl: "https://arstechnica.com/",
		feedUrl: "https://feeds.arstechnica.com/arstechnica/index",
		hostAllow: ["arstechnica.com"],
		category: "programming",
		tags: ["programming"],
	},
	{
		id: "venturebeat",
		name: "VentureBeat",
		listUrl: "https://venturebeat.com/",
		feedUrl: "https://venturebeat.com/feed/",
		hostAllow: ["venturebeat.com"],
		category: "startups",
		tags: ["startups", "saas"],
	},
	{
		id: "thenextweb",
		name: "The Next Web",
		listUrl: "https://thenextweb.com/",
		feedUrl: "https://thenextweb.com/feed",
		hostAllow: ["thenextweb.com", "tnw.com"],
		category: "startups",
		tags: ["startups", "saas"],
	},
	{
		id: "producthunt",
		name: "Product Hunt",
		listUrl: "https://www.producthunt.com/",
		hostAllow: ["producthunt.com"],
		pathAllow: [/\/posts\//i, /\/products\//i],
		category: "saas",
		tags: ["saas", "startups"],
	},
	{
		id: "indiehackers",
		name: "Indie Hackers",
		listUrl: "https://www.indiehackers.com/",
		feedUrl: "https://www.indiehackers.com/feed.xml",
		hostAllow: ["indiehackers.com"],
		category: "saas",
		tags: ["saas", "startups"],
	},
	{
		id: "betalist",
		name: "BetaList",
		listUrl: "https://betalist.com/",
		hostAllow: ["betalist.com"],
		category: "startups",
		tags: ["startups", "saas"],
	},
	{
		id: "github-blog",
		name: "GitHub Blog",
		listUrl: "https://github.blog/",
		feedUrl: "https://github.blog/feed/",
		hostAllow: ["github.blog"],
		category: "programming",
		tags: ["programming"],
	},
	{
		id: "devto",
		name: "DEV Community",
		listUrl: "https://dev.to/",
		feedUrl: "https://dev.to/feed",
		hostAllow: ["dev.to"],
		category: "programming",
		tags: ["programming"],
	},
	{
		id: "lobsters",
		name: "Lobsters",
		listUrl: "https://lobste.rs/",
		feedUrl: "https://lobste.rs/rss",
		allowOffsite: true,
		pathDeny: [/\/login/i, /\/filters/i],
		category: "programming",
		tags: ["programming"],
	},
	{
		id: "a16z",
		name: "Andreessen Horowitz",
		listUrl: "https://a16z.com/news/",
		feedUrl: "https://a16z.com/feed/",
		hostAllow: ["a16z.com"],
		category: "investment",
		tags: ["investment", "funding"],
	},
	{
		id: "ycombinator-blog",
		name: "Y Combinator",
		listUrl: "https://www.ycombinator.com/blog",
		hostAllow: ["ycombinator.com"],
		pathAllow: [/\/blog\//i, /\/companies\//i],
		category: "startups",
		tags: ["startups", "funding"],
	},
	{
		id: "reuters-technology",
		name: "Reuters Technology",
		listUrl: "https://www.reuters.com/technology/",
		hostAllow: ["reuters.com"],
		pathAllow: [/\/technology\//i, /\/world\//i, /\/business\//i, /\/markets\//i],
		category: "investment",
		tags: ["investment", "funding"],
	},
	{
		id: "fortune",
		name: "Fortune",
		listUrl: "https://fortune.com/section/tech/",
		hostAllow: ["fortune.com"],
		category: "funding",
		tags: ["funding", "investment"],
	},
	{
		id: "axios",
		name: "Axios",
		listUrl: "https://www.axios.com/technology",
		hostAllow: ["axios.com"],
		category: "startups",
		tags: ["startups"],
	},
	{
		id: "smashingmagazine",
		name: "Smashing Magazine",
		listUrl: "https://www.smashingmagazine.com/",
		feedUrl: "https://www.smashingmagazine.com/feed/",
		hostAllow: ["smashingmagazine.com"],
		category: "programming",
		tags: ["programming"],
	},
];

export function clampUrlsPerPlatform(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return 15;
	return Math.min(20, Math.max(10, Math.round(v)));
}

export function resolvePlatform(id) {
	const key = String(id || "")
		.trim()
		.toLowerCase();
	if (!key) return null;
	return (
		NEWS_PLATFORMS.find(
			(p) =>
				p.id === key ||
				(p.aliases || []).includes(key),
		) || null
	);
}

export function listPlatformIds() {
	return NEWS_PLATFORMS.map((p) => p.id);
}

export function keywordQuery(entry) {
	if (!entry) return "";
	if (typeof entry === "string") return entry;
	return String(entry.q || "").trim();
}

export function resolveKeyword(raw) {
	const q = String(raw || "").trim().toLowerCase();
	if (!q) return null;
	return (
		NEWS_KEYWORDS.find((k) => keywordQuery(k).toLowerCase() === q) || {
			q: raw,
			category: "programming",
			tags: [],
		}
	);
}

/** Category + tags from platform and Google News keyword — no LLM. */
export function classifyStory({ platform, keyword, title, url } = {}) {
	const kw = resolveKeyword(keyword);
	const blob = `${title || ""} ${url || ""} ${keyword || ""}`.toLowerCase();
	const tags = new Set([
		platform?.id,
		...(platform?.tags || []),
		...(kw?.tags || []),
	].filter(Boolean));

	let category = kw?.category || platform?.category || "programming";
	if (/ihatereading/.test(blob)) {
		category = "ihatereading";
		tags.add("ihatereading");
	} else if (/\b(series a|seed round|venture capital|funding|raised)\b/.test(blob)) {
		category = "funding";
		tags.add("funding");
	} else if (/\b(saas|subscription)\b/.test(blob)) {
		category = "saas";
		tags.add("saas");
	} else if (/\b(startup|y combinator|yc )\b/.test(blob)) {
		category = "startups";
		tags.add("startups");
	}

	return { category, tags: [...tags] };
}
