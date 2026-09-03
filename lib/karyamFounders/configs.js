/**
 * Karyam.xyz B2B founder lead agent.
 * Google SERP → nested page scrape → contact enrichment → optional AutoSend.
 *
 * Target: founders / owners / CTOs / solo builders who need software Karyam can ship.
 */

export const FOUNDERS_COLLECTION = "karyamFounderLeads";
export const FOUNDERS_STATE_COLLECTION = "karyamFounderAgentState";

/** Bump when QUERY_HASH changes so the cursor resets. */
export const QUERY_SET_VERSION = 1;

export const KARYAM_AGENT = {
	id: "karyam-founders",
	name: "Karyam B2B Founder Leads",
	agency: "https://karyam.xyz",
	collection: FOUNDERS_COLLECTION,
	stateCollection: FOUNDERS_STATE_COLLECTION,
	relevanceMin: 4,
	scoreBatchSize: 8,
	queriesPerRun: Number(process.env.KARYAM_FOUNDERS_QUERIES_PER_RUN || "3"),
	enrichPerRun: Number(process.env.KARYAM_FOUNDERS_ENRICH_PER_RUN || "6"),
	nestedPagesPerLead: Number(process.env.KARYAM_FOUNDERS_NESTED_PAGES || "3"),
	followupQueriesPerLead: Number(
		process.env.KARYAM_FOUNDERS_FOLLOWUP_QUERIES || "2",
	),
	model: process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4",
};

export const KARYAM_OFFERINGS = [
	"custom software and SaaS products",
	"AI agents (WhatsApp, Reddit, LinkedIn, support, ops)",
	"mobile apps (iOS / Android / React Native / Flutter)",
	"websites, landing pages, SEO ranking",
	"tools, automations, workflows",
	"CRM, CMS, ERP, ecommerce",
	"scraping APIs, LinkedIn scrapers, database APIs",
];

export const KARYAM_PITCH = `karyam.xyz is a software studio. We build AI agents, mobile apps, websites, landing pages, SEO, tools, automations, workflows, CRM, CMS, ERP, ecommerce, WhatsApp / Reddit / LinkedIn agents, scraping APIs, and database APIs.`;

/**
 * Query hash — rotating Google searches. Keys are stable ids.
 * intent groups: saas-crm | ai-agent | mvp | mobile | web-seo | ecommerce | ops | scraping | indie
 */
export const QUERY_HASH = {
	"saas-crm-need": {
		intent: "saas-crm",
		country: "us",
		query: "SaaS founder looking for custom CRM development",
	},
	"saas-crm-replace": {
		intent: "saas-crm",
		country: "us",
		query: "startup founder replace Salesforce custom CRM email",
	},
	"saas-crm-build": {
		intent: "saas-crm",
		country: "us",
		query: `"building a CRM" founder OR CEO contact email`,
	},
	"saas-crm-hire": {
		intent: "saas-crm",
		country: "us",
		query: "B2B SaaS founder hire software development agency",
	},
	"saas-crm-india": {
		intent: "saas-crm",
		country: "in",
		query: "SaaS founder India looking for CRM developers agency",
	},
	"saas-crm-linkedin": {
		intent: "saas-crm",
		country: "us",
		query: "SaaS CRM founder CEO site:linkedin.com/in",
	},
	"saas-crm-vertical": {
		intent: "saas-crm",
		country: "us",
		query: `"we need a CRM" founder OR "custom CRM for" startup contact`,
	},
	"saas-crm-pipeline": {
		intent: "saas-crm",
		country: "us",
		query: "sales CRM startup founder looking for developers",
	},
	"saas-founder-agency": {
		intent: "saas-crm",
		country: "us",
		query: `"looking for a development agency" SaaS founder`,
	},
	"saas-founder-email": {
		intent: "saas-crm",
		country: "us",
		query: "SaaS founder email contact LinkedIn website",
	},

	"ai-agent-founders": {
		intent: "ai-agent",
		country: "us",
		query: "AI agent startup founder looking for developers",
	},
	"ai-whatsapp-agent": {
		intent: "ai-agent",
		country: "us",
		query: `"WhatsApp AI agent" OR "WhatsApp chatbot" founder hire developers`,
	},
	"ai-reddit-agent": {
		intent: "ai-agent",
		country: "us",
		query: `"Reddit agent" OR "Reddit monitoring" startup founder`,
	},
	"ai-linkedin-agent": {
		intent: "ai-agent",
		country: "us",
		query: `"LinkedIn agent" OR "LinkedIn automation" founder developers`,
	},
	"ai-llm-mvp": {
		intent: "ai-agent",
		country: "us",
		query: "LLM startup founder need MVP developers agency",
	},
	"ai-gpt-product": {
		intent: "ai-agent",
		country: "us",
		query: `"build a GPT agent" OR "custom GPT" founder contact`,
	},
	"ai-support-agent": {
		intent: "ai-agent",
		country: "us",
		query: "customer support AI agent founder looking for engineers",
	},
	"ai-workflow": {
		intent: "ai-agent",
		country: "us",
		query: "AI workflow automation founder hire development agency",
	},
	"ai-voice-agent": {
		intent: "ai-agent",
		country: "us",
		query: "voice AI agent startup founder contact email",
	},
	"ai-india": {
		intent: "ai-agent",
		country: "in",
		query: "AI startup founder India looking for development agency",
	},
	"ai-linkedin-in": {
		intent: "ai-agent",
		country: "us",
		query: "AI startup founder CTO site:linkedin.com/in",
	},
	"ai-ops-agent": {
		intent: "ai-agent",
		country: "us",
		query: `"autonomous agent" SaaS founder email OR contact`,
	},

	"mvp-need-built": {
		intent: "mvp",
		country: "us",
		query: `"need an MVP" OR "need MVP built" founder`,
	},
	"mvp-agency": {
		intent: "mvp",
		country: "us",
		query: "startup founder looking for software development agency",
	},
	"mvp-nextjs": {
		intent: "mvp",
		country: "us",
		query: `"hire Next.js developers" founder OR CTO`,
	},
	"mvp-outsource": {
		intent: "mvp",
		country: "in",
		query: "founder outsource product development India agency",
	},
	"mvp-tech-partner": {
		intent: "mvp",
		country: "us",
		query: `"looking for a tech partner" OR "need developers" startup founder`,
	},
	"mvp-fractional-cto": {
		intent: "mvp",
		country: "us",
		query: `"fractional CTO" OR "need a tech co-founder" startup founder`,
	},
	"mvp-rebuild": {
		intent: "mvp",
		country: "us",
		query: `"rebuild our app" OR "migrate to Next.js" founder agency`,
	},
	"mvp-white-label": {
		intent: "mvp",
		country: "us",
		query: "white label software founder looking for developers",
	},
	"mvp-custom-software": {
		intent: "mvp",
		country: "us",
		query: `"need custom software" founder OR CEO contact email`,
	},
	"mvp-linkedin": {
		intent: "mvp",
		country: "us",
		query: "startup founder looking for developers site:linkedin.com/in",
	},
	"mvp-india-ceo": {
		intent: "mvp",
		country: "in",
		query: "startup CEO India hire software development agency",
	},
	"mvp-full-stack": {
		intent: "mvp",
		country: "us",
		query: `"hire full stack developers" founder agency`,
	},

	"mobile-need-app": {
		intent: "mobile",
		country: "us",
		query: `"need a mobile app" founder OR CEO`,
	},
	"mobile-rn": {
		intent: "mobile",
		country: "us",
		query: "React Native founder looking for developers agency",
	},
	"mobile-flutter": {
		intent: "mobile",
		country: "us",
		query: "Flutter app startup founder hire agency",
	},
	"mobile-ios-android": {
		intent: "mobile",
		country: "us",
		query: `"iOS Android app" founder looking for development agency`,
	},
	"mobile-idea": {
		intent: "mobile",
		country: "us",
		query: `"app idea" looking for developers founder contact`,
	},
	"mobile-india": {
		intent: "mobile",
		country: "in",
		query: "mobile app founder India hire React Native developers",
	},
	"mobile-d2c": {
		intent: "mobile",
		country: "us",
		query: "D2C brand founder need mobile app developers",
	},
	"mobile-linkedin": {
		intent: "mobile",
		country: "us",
		query: "mobile app founder CTO site:linkedin.com/in",
	},

	"web-landing": {
		intent: "web-seo",
		country: "us",
		query: `"need a landing page" founder OR startup`,
	},
	"web-redesign": {
		intent: "web-seo",
		country: "us",
		query: "SaaS founder website redesign hire agency",
	},
	"web-seo": {
		intent: "web-seo",
		country: "us",
		query: `"need SEO" OR "technical SEO" SaaS founder agency`,
	},
	"web-need-site": {
		intent: "web-seo",
		country: "us",
		query: `"need a website" startup founder contact`,
	},
	"web-webflow": {
		intent: "web-seo",
		country: "us",
		query: "Webflow OR Framer founder looking for developer",
	},
	"web-ph-launch": {
		intent: "web-seo",
		country: "us",
		query: "Product Hunt launch landing page founder hire",
	},
	"web-marketing-site": {
		intent: "web-seo",
		country: "us",
		query: `"marketing site" Next.js founder looking for developers`,
	},
	"web-india": {
		intent: "web-seo",
		country: "in",
		query: "startup founder India need website landing page agency",
	},
	"web-rank": {
		intent: "web-seo",
		country: "us",
		query: `"rank on Google" SaaS founder looking for SEO agency`,
	},
	"web-linkedin": {
		intent: "web-seo",
		country: "us",
		query: "founder looking for website agency site:linkedin.com/in",
	},

	"ecom-d2c": {
		intent: "ecommerce",
		country: "us",
		query: "D2C founder looking for custom ecommerce developers",
	},
	"ecom-shopify": {
		intent: "ecommerce",
		country: "us",
		query: "Shopify Plus founder looking for development agency",
	},
	"ecom-headless": {
		intent: "ecommerce",
		country: "us",
		query: "headless commerce founder hire Next.js developers",
	},
	"ecom-store": {
		intent: "ecommerce",
		country: "us",
		query: `"need an online store" founder contact email`,
	},
	"ecom-india": {
		intent: "ecommerce",
		country: "in",
		query: "ecommerce founder India hire developers custom store",
	},
	"ecom-shopify-app": {
		intent: "ecommerce",
		country: "us",
		query: "Shopify custom app founder looking for developers",
	},
	"ecom-dtc-tech": {
		intent: "ecommerce",
		country: "us",
		query: `"DTC brand" looking for tech partner founder`,
	},
	"ecom-linkedin": {
		intent: "ecommerce",
		country: "us",
		query: "ecommerce founder CEO site:linkedin.com/in",
	},

	"ops-crm": {
		intent: "ops",
		country: "us",
		query: `"need a CRM" small business founder contact`,
	},
	"ops-erp": {
		intent: "ops",
		country: "us",
		query: `"custom ERP" founder OR CEO looking for developers`,
	},
	"ops-cms": {
		intent: "ops",
		country: "us",
		query: `"need a CMS" founder OR "custom CMS" startup`,
	},
	"ops-zapier": {
		intent: "ops",
		country: "us",
		query: `"Zapier alternative" OR "n8n" founder looking for developers`,
	},
	"ops-workflow": {
		intent: "ops",
		country: "us",
		query: "workflow automation founder hire development agency",
	},
	"ops-internal-tools": {
		intent: "ops",
		country: "us",
		query: `"need internal tools" founder OR "Retool" looking for developers`,
	},
	"ops-airtable": {
		intent: "ops",
		country: "us",
		query: "Airtable founder looking for custom software developers",
	},
	"ops-india": {
		intent: "ops",
		country: "in",
		query: "founder India need CRM ERP automation developers",
	},
	"ops-make": {
		intent: "ops",
		country: "us",
		query: `"Make.com" custom integration founder developers`,
	},
	"ops-linkedin": {
		intent: "ops",
		country: "us",
		query: "operations founder looking for software agency site:linkedin.com/in",
	},

	"scrape-need": {
		intent: "scraping",
		country: "us",
		query: `"need a scraper" OR "need web scraping" founder`,
	},
	"scrape-linkedin": {
		intent: "scraping",
		country: "us",
		query: `"LinkedIn scraper" looking for developers founder`,
	},
	"scrape-api": {
		intent: "scraping",
		country: "us",
		query: `"need a scraping API" OR "data API" founder`,
	},
	"scrape-leads": {
		intent: "scraping",
		country: "us",
		query: "lead generation scraper founder looking for developers",
	},
	"scrape-maps": {
		intent: "scraping",
		country: "us",
		query: `"Google Maps scraper" founder hire developers`,
	},
	"scrape-db-api": {
		intent: "scraping",
		country: "us",
		query: `"need a database API" founder contact`,
	},
	"scrape-india": {
		intent: "scraping",
		country: "in",
		query: "web scraping agency founder India looking for developers",
	},
	"scrape-reddit": {
		intent: "scraping",
		country: "us",
		query: `"Reddit scraper" OR "Reddit data" founder developers`,
	},

	"indie-hacker": {
		intent: "indie",
		country: "us",
		query: "indie hacker looking for developers OR technical co-founder",
	},
	"indie-solo": {
		intent: "indie",
		country: "us",
		query: `"solo founder" need developers OR agency`,
	},
	"indie-micro-saas": {
		intent: "indie",
		country: "us",
		query: `"micro SaaS" founder looking for developers`,
	},
	"indie-build-public": {
		intent: "indie",
		country: "us",
		query: `"building in public" founder hire developers`,
	},
	"indie-creator-app": {
		intent: "indie",
		country: "us",
		query: "content creator looking for app developers founder",
	},
	"indie-newsletter": {
		intent: "indie",
		country: "us",
		query: "newsletter founder looking for custom software developers",
	},
	"indie-bootstrapped": {
		intent: "indie",
		country: "us",
		query: "bootstrapped founder need technical help agency",
	},
	"indie-youtube": {
		intent: "indie",
		country: "us",
		query: "YouTuber founder looking for software developers",
	},
	"indie-linkedin": {
		intent: "indie",
		country: "us",
		query: "indie hacker founder site:linkedin.com/in",
	},
	"indie-ph-makers": {
		intent: "indie",
		country: "us",
		query: "Product Hunt maker founder email contact",
	},

	"dir-saas-india": {
		intent: "saas-crm",
		country: "in",
		query: "SaaS founders India directory contact email LinkedIn",
	},
	"dir-saas-us": {
		intent: "saas-crm",
		country: "us",
		query: "B2B SaaS founder directory email LinkedIn 2025",
	},
	"dir-ai-startups": {
		intent: "ai-agent",
		country: "us",
		query: "AI agent startups founders contact email",
	},
	"dir-hired-agency": {
		intent: "mvp",
		country: "us",
		query: "founders who hired a software development agency",
	},
	"dir-looking-agency": {
		intent: "mvp",
		country: "us",
		query: `"looking for an agency" founder software OR app OR website`,
	},
	"dir-uk": {
		intent: "mvp",
		country: "uk",
		query: "SaaS founder UK looking for development agency",
	},
	"dir-uae": {
		intent: "mvp",
		country: "ae",
		query: "startup founder Dubai looking for software developers",
	},
	"dir-sg": {
		intent: "mvp",
		country: "sg",
		query: "SaaS founder Singapore hire development agency",
	},
};

export const ALL_QUERIES = Object.entries(QUERY_HASH).map(([id, row]) => ({
	id,
	...row,
}));

export const INTENTS = [
	...new Set(ALL_QUERIES.map((q) => q.intent)),
].sort();

export function queriesForIntent(intent) {
	if (!intent) return ALL_QUERIES;
	const key = String(intent).trim().toLowerCase();
	return ALL_QUERIES.filter((q) => q.intent === key);
}

export function getQueryById(id) {
	const key = String(id || "").trim();
	if (!key || !QUERY_HASH[key]) return null;
	return { id: key, ...QUERY_HASH[key] };
}
