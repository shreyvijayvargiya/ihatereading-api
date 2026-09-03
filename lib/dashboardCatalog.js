/**
 * Allowlisted Firestore collections for the scrape dashboard.
 * Firebase project ihatereading-4ba52, database (default).
 */

export const FIREBASE_PROJECT = "ihatereading-4ba52";
export const FIRESTORE_DATABASE = "(default)";

export const DASHBOARD_TABLES = [
	{
		id: "clubs",
		label: "England clubs",
		group: "catalog",
		collection: "clubs",
		cli: "npm run england:clubs",
		http: "POST /england-clubs/run",
		description: "England football clubs from Soccer Wiki (333 clubs, no LLM).",
	},
	{
		id: "ihatereading",
		label: "iHateReading",
		group: "reddit",
		collection: "redditIhatereadingPosts",
		cli: "npm run reddit:ihatereading",
		http: "POST /reddit-agents/ihatereading/run",
		description: "Reddit threads for iHateReading content and developers.",
	},
	{
		id: "saascrm",
		label: "saascrm",
		group: "reddit",
		collection: "redditPosts",
		cli: "auto on npm run dev",
		http: "POST /reddit/run",
		description: "Legacy SaaSCRM Reddit relevance monitor.",
	},
	{
		id: "karyam",
		label: "Karyam",
		group: "reddit",
		collection: "redditKaryamPosts",
		cli: "npm run reddit:karyam",
		http: "POST /reddit-agents/karyam/run",
		description: "Founders needing a software agency.",
	},
	{
		id: "saas",
		label: "SaaS",
		group: "reddit",
		collection: "redditSaasPosts",
		cli: "npm run reddit:saas",
		http: "POST /reddit-agents/saas/run",
		description: "SaaS pain / idea posts.",
	},
	{
		id: "directories",
		label: "Directory",
		group: "reddit",
		collection: "redditDirectoryPosts",
		cli: "npm run reddit:directories",
		http: "POST /reddit-agents/directories/run",
		description: "Directory / aggregator idea threads.",
	},
	{
		id: "buildsaas",
		label: "BuildSaas",
		group: "reddit",
		collection: "redditBuildsaasPosts",
		cli: "npm run reddit:buildsaas",
		http: "POST /reddit-agents/buildsaas/run",
		description: "Next.js SaaS boilerplate demand.",
	},
	{
		id: "scraping",
		label: "Scraping",
		group: "reddit",
		collection: "redditScrapingPosts",
		cli: "npm run reddit:scraping",
		http: "POST /reddit-agents/scraping/run",
		description: "Scraping / data-collection problems.",
	},
	{
		id: "ai-scraper",
		label: "AI scraper",
		group: "reddit",
		collection: "redditAiScraperPosts",
		cli: "npm run reddit:ai-scraper",
		http: "POST /reddit-ai-scraper/run",
		description: "Prompt-driven Reddit scraper.",
	},
	{
		id: "news",
		label: "News",
		group: "news",
		collection: "ihatereading-internet-news",
		cli: "npm run news:ihatereading",
		http: "POST /internet-news/run",
		description: "Programming / startups / funding news.",
	},
	{
		id: "maps",
		label: "Maps",
		group: "leads",
		collection: "mapsKaryamLeads",
		cli: "npm run maps:karyam",
		http: "POST /maps-agents/karyam-local/run",
		description: "Karyam local Maps businesses.",
	},
	{
		id: "investors",
		label: "Investors",
		group: "leads",
		collection: "angel-seed-investors",
		cli: "npm run angel:investors",
		http: "POST /angel-investors/run",
		description: "Angel / seed investors.",
	},
	{
		id: "yc",
		label: "YC",
		group: "leads",
		collection: "yc-companies",
		cli: "npm run yc:companies",
		http: "POST /yc-companies/run",
		description: "Y Combinator companies.",
	},
	{
		id: "linkedin",
		label: "LinkedIn",
		group: "leads",
		collection: "karyamLinkedInLeads",
		cli: "npm run karyam:linkedin",
		http: "POST /karyam-linkedin",
		description: "Karyam LinkedIn founder leads.",
	},
	{
		id: "founders",
		label: "Founders",
		group: "leads",
		collection: "karyamFounderLeads",
		cli: "npm run karyam:founders",
		http: "POST /karyam-founders/run",
		description: "Karyam B2B founders with emails — AutoSend outreach.",
	},
	{
		id: "apps",
		label: "Apps",
		group: "catalog",
		collection: "top-mobile-apps",
		cli: "npm run top:mobile-apps",
		http: "POST /top-mobile-apps/run",
		description: "App Store + Play listings.",
	},
	{
		id: "influencers",
		label: "Influencers",
		group: "catalog",
		collection: "individual-influencers",
		cli: "npm run top:influencers",
		http: "POST /individual-influencers/run",
		description: "Individual social creators.",
	},
	{
		id: "magazine",
		label: "Magazine",
		group: "catalog",
		collection: "dev-magazine-channels",
		cli: "npm run magazine:creators",
		http: "POST /dev-magazine/run",
		description: "Programming magazine channels.",
	},
	{
		id: "magazine-videos",
		label: "Magazine videos",
		group: "catalog",
		collection: "dev-magazine-videos",
		cli: "npm run magazine:creators",
		http: "POST /dev-magazine/run",
		description: "Latest videos for magazine channels.",
	},
	{
		id: "ai-styles",
		label: "AI Styles",
		group: "catalog",
		collection: "ai-styles-prompts",
		cli: "npm run ai:styles",
		http: "POST /ai-styles-prompts/run",
		description: "Refero DESIGN.md style prompts.",
	},
];

export function getDashboardTable(id) {
	const key = String(id || "").trim();
	if (!key) return null;
	const aliases = { "england-clubs": "clubs" };
	const resolved = aliases[key] || key;
	return DASHBOARD_TABLES.find((t) => t.id === resolved || t.id === key) || null;
}

export function getDashboardTableByCollection(collection) {
	return DASHBOARD_TABLES.find((t) => t.collection === collection) || null;
}
