/**
 * Allowlisted CLI spawn configs for the scrape dashboard.
 * Dashboard always runs a single tick (`once`); looping is owned by dashboardRunner.
 */

const LLM = {
	key: "llm",
	label: "LLM scoring",
	type: "checkbox",
	flag: "--llm",
	help: "OpenRouter scoring (needs OPENROUTER_API_KEY)",
};
const USE_AI = {
	key: "useAI",
	label: "Use AI",
	type: "checkbox",
	flag: "--use-ai",
	help: "OpenRouter enrich/score (needs OPENROUTER_API_KEY)",
};
const SKIP_GOOGLE = {
	key: "skipGoogle",
	label: "Skip Google",
	type: "checkbox",
	flag: "--skip-google",
};

export const AGENT_RUNS = {
	ihatereading: {
		script: "scripts/run-reddit-agent.js",
		args: ["ihatereading"],
		fields: [LLM],
	},
	saascrm: {
		kind: "scheduler",
		help: "In-process Reddit monitor (same as npm run dev scheduler).",
		fields: [],
	},
	karyam: {
		script: "scripts/run-reddit-agent.js",
		args: ["karyam"],
		fields: [LLM],
	},
	saas: {
		script: "scripts/run-reddit-agent.js",
		args: ["saas"],
		fields: [LLM, SKIP_GOOGLE],
	},
	directories: {
		script: "scripts/run-reddit-directories.js",
		args: ["once"],
		fields: [LLM, SKIP_GOOGLE],
	},
	buildsaas: {
		script: "scripts/run-reddit-agent.js",
		args: ["buildsaas"],
		fields: [LLM, SKIP_GOOGLE],
	},
	scraping: {
		script: "scripts/run-reddit-scraping.js",
		args: ["once"],
		fields: [LLM, SKIP_GOOGLE],
	},
	"ai-scraper": {
		script: "scripts/run-reddit-ai-scraper.js",
		args: ["once"],
		fields: [
			{
				key: "prompt",
				label: "Prompt",
				type: "text",
				flag: "--prompt",
				required: true,
				placeholder: "people looking for scrapers and datasets",
			},
			LLM,
			SKIP_GOOGLE,
			{ key: "rediscover", label: "Rediscover subs", type: "checkbox", flag: "--rediscover" },
		],
	},
	news: {
		script: "scripts/run-internet-news.js",
		args: ["once"],
		fields: [
			{ key: "platform", label: "Platform", type: "text", flag: "--platform", placeholder: "hackernews" },
			{ key: "keyword", label: "Keyword", type: "text", flag: "--keyword", placeholder: "SaaS funding" },
			{ key: "urls", label: "URLs / platform", type: "number", flag: "--urls" },
			{ key: "platforms", label: "Platforms / tick", type: "number", flag: "--platforms" },
		],
	},
	maps: {
		script: "scripts/run-maps-agent.js",
		args: [],
		fields: [
			{ key: "city", label: "City", type: "text", flag: "--city", placeholder: "bangalore" },
			{ key: "queries", label: "Queries / tick", type: "number", flag: "--queries" },
			USE_AI,
			{ key: "allKeywords", label: "All keywords", type: "checkbox", flag: "--all-keywords" },
		],
	},
	investors: {
		script: "scripts/run-angel-investors.js",
		args: [],
		fields: [
			{ key: "platform", label: "Platform", type: "text", flag: "--platform", placeholder: "x | linkedin | google" },
			{ key: "queries", label: "Queries / tick", type: "number", flag: "--queries" },
			USE_AI,
		],
	},
	yc: {
		script: "scripts/run-yc-companies.js",
		args: ["once"],
		fields: [
			{ key: "status", label: "Status", type: "text", flag: "--status", placeholder: "Active" },
			{ key: "hiring", label: "Hiring only", type: "checkbox", flag: "--hiring" },
			USE_AI,
		],
	},
	linkedin: {
		script: "scripts/run-karyam-linkedin.js",
		args: ["once"],
		fields: [
			{ key: "geo", label: "Geo", type: "text", flag: "--geo", placeholder: "in" },
			{ key: "city", label: "City", type: "text", flag: "--city", placeholder: "bangalore" },
			{ key: "queries", label: "Queries / tick", type: "number", flag: "--queries" },
			USE_AI,
		],
	},
	founders: {
		script: "scripts/run-karyam-founders.js",
		args: [],
		fields: [
			{ key: "intent", label: "Intent", type: "text", flag: "--intent", placeholder: "saas-crm | ai-agent | mvp" },
			{ key: "queries", label: "Queries / tick", type: "number", flag: "--queries" },
			USE_AI,
			{
				key: "send",
				label: "Send via AutoSend",
				type: "checkbox",
				flag: "--send",
				help: "Email leads with a contact after this tick (needs AUTOSEND_API_KEY)",
			},
		],
	},
	apps: {
		script: "scripts/run-top-mobile-apps.js",
		args: ["once"],
		fields: [
			{ key: "category", label: "Category", type: "text", flag: "--category", placeholder: "Finance" },
			{ key: "platform", label: "Platform", type: "text", flag: "--platform", placeholder: "ios | android" },
			USE_AI,
		],
	},
	influencers: {
		script: "scripts/run-individual-influencers.js",
		args: ["once"],
		fields: [
			{ key: "platform", label: "Platform", type: "text", flag: "--platform", placeholder: "instagram" },
			{ key: "niche", label: "Niche", type: "text", flag: "--niche", placeholder: "Tech" },
			USE_AI,
		],
	},
	magazine: {
		script: "scripts/run-dev-magazine.js",
		args: ["once"],
		fields: [
			{ key: "category", label: "Category", type: "text", flag: "--category", placeholder: "frontend" },
			{ key: "topic", label: "Topic", type: "text", flag: "--topic", placeholder: "react" },
			{ key: "platform", label: "Platform", type: "text", flag: "--platform", placeholder: "youtube" },
			USE_AI,
		],
	},
	"magazine-videos": {
		script: "scripts/run-dev-magazine.js",
		args: ["once", "--videos"],
		fields: [
			{ key: "category", label: "Category", type: "text", flag: "--category", placeholder: "frontend" },
			USE_AI,
		],
	},
	"ai-styles": {
		script: "scripts/run-ai-styles-prompts.js",
		args: ["once"],
		fields: [
			{ key: "styles", label: "Styles / tick", type: "number", flag: "--styles" },
			USE_AI,
			{
				key: "enrichJob",
				label: "Run enrich job instead",
				type: "checkbox",
				script: "scripts/run-ai-styles-enrich.js",
				args: ["once"],
			},
			{ key: "reset", label: "Reset enrich cursor", type: "checkbox", flag: "--reset" },
		],
	},
	clubs: {
		script: "scripts/run-england-clubs.js",
		args: ["once"],
		help: "Loops across Soccer Wiki pages until 333 England clubs are stored, then stops.",
		fields: [
			{ key: "reset", label: "Reset listing cursor", type: "checkbox", flag: "--reset" },
			{
				key: "enrich",
				label: "Google + site enrich",
				type: "checkbox",
				flag: "--enrich",
				help: "Official website, emails, socials (no LLM)",
			},
		],
	},
};

export function getAgentRun(id) {
	return AGENT_RUNS[id] || null;
}
