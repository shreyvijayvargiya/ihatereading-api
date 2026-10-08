/**
 * Outbound B2B prospect agent — karyam.xyz + saascrm.site pipeline.
 * Google Search + Google Maps → scrape email/phone → optional OpenRouter outreach drafts.
 */

import { resolveAgentLlmModel } from "../useAi.js";

export const LEADS_COLLECTION = "outboundProspectLeads";
export const STATE_COLLECTION = "outboundProspectAgentState";

export const QUERY_SET_VERSION = 1;

export const OUTBOUND_AGENT = {
	id: "outbound-prospects",
	name: "Outbound B2B Prospect Pipeline",
	brands: ["karyam.xyz", "saascrm.site"],
	collection: LEADS_COLLECTION,
	stateCollection: STATE_COLLECTION,
	relevanceMin: 4,
	scoreBatchSize: Number(process.env.OUTBOUND_PROSPECTS_SCORE_BATCH || "3"),
	jobsPerRun: Number(process.env.OUTBOUND_PROSPECTS_JOBS_PER_RUN || "4"),
	enrichPerRun: Number(process.env.OUTBOUND_PROSPECTS_ENRICH_PER_RUN || "8"),
	model: resolveAgentLlmModel(),
};

export const KARYAM_PITCH = `karyam.xyz builds custom software, AI agents (WhatsApp, Reddit, LinkedIn, support, ops), mobile apps, websites, SEO, automations, workflows, CRM, CMS, ERP, ecommerce, and scraping APIs for founders and B2B teams worldwide.`;

export const SAASCRM_PITCH = `saascrm.site provides AI-powered CRM, ERP, SEO auditing, AI SEO articles, lead tools, and consultancy for B2B agencies, SaaS teams, and operators in the US, Australia, Europe, and India.`;

export const INTENTS = [
	"ai-agent",
	"crm-erp",
	"software-mvp",
	"seo-content",
	"agency-buyer",
	"consulting",
];

/**
 * Rotating discovery jobs. channel: google | maps
 * @type {Array<{ id: string, channel: "google"|"maps", brand: "karyam"|"saascrm"|"both", intent: string, country: string, query: string }>}
 */
export const DISCOVERY_JOBS = [
	// USA — Google
	{
		id: "us-ai-founder",
		channel: "google",
		brand: "karyam",
		intent: "ai-agent",
		country: "us",
		query: "SaaS founder looking for AI agent development agency USA",
	},
	{
		id: "us-crm-buyer",
		channel: "google",
		brand: "saascrm",
		intent: "crm-erp",
		country: "us",
		query: "B2B company need custom CRM ERP software founder contact email",
	},
	{
		id: "us-seo-agency",
		channel: "google",
		brand: "saascrm",
		intent: "seo-content",
		country: "us",
		query: "marketing agency needs SEO audit tool AI content USA contact",
	},
	{
		id: "us-mvp-hire",
		channel: "google",
		brand: "karyam",
		intent: "software-mvp",
		country: "us",
		query: '"looking for development agency" startup founder software MVP',
	},
	{
		id: "us-ai-consult",
		channel: "google",
		brand: "both",
		intent: "consulting",
		country: "us",
		query: "CEO hiring AI consultancy automate business operations",
	},
	{
		id: "us-linkedin-founder",
		channel: "google",
		brand: "karyam",
		intent: "agency-buyer",
		country: "us",
		query: 'founder CEO site:linkedin.com/in "custom software" OR "AI agent"',
	},
	// USA — Maps
	{
		id: "us-maps-agency-austin",
		channel: "maps",
		brand: "both",
		intent: "agency-buyer",
		country: "us",
		query: "digital marketing agency Austin TX",
	},
	{
		id: "us-maps-saas-nyc",
		channel: "maps",
		brand: "saascrm",
		intent: "crm-erp",
		country: "us",
		query: "B2B software consulting company New York",
	},
	{
		id: "us-maps-seo-sf",
		channel: "maps",
		brand: "saascrm",
		intent: "seo-content",
		country: "us",
		query: "SEO agency San Francisco",
	},
	// Australia
	{
		id: "au-google-founder",
		channel: "google",
		brand: "karyam",
		intent: "software-mvp",
		country: "au",
		query: "Australian startup founder looking for software developers agency",
	},
	{
		id: "au-crm",
		channel: "google",
		brand: "saascrm",
		intent: "crm-erp",
		country: "au",
		query: "Sydney business needs CRM automation contact email founder",
	},
	{
		id: "au-maps-agency",
		channel: "maps",
		brand: "both",
		intent: "agency-buyer",
		country: "au",
		query: "digital agency Sydney Australia",
	},
	{
		id: "au-maps-melbourne",
		channel: "maps",
		brand: "karyam",
		intent: "ai-agent",
		country: "au",
		query: "technology consulting Melbourne",
	},
	// UK / Europe
	{
		id: "uk-google-saas",
		channel: "google",
		brand: "saascrm",
		intent: "crm-erp",
		country: "uk",
		query: "UK SaaS founder custom CRM development contact",
	},
	{
		id: "uk-ai",
		channel: "google",
		brand: "karyam",
		intent: "ai-agent",
		country: "uk",
		query: "London startup AI automation agency hire developers",
	},
	{
		id: "uk-maps-agency",
		channel: "maps",
		brand: "both",
		intent: "agency-buyer",
		country: "uk",
		query: "digital agency London UK",
	},
	{
		id: "de-maps-consult",
		channel: "maps",
		brand: "karyam",
		intent: "consulting",
		country: "de",
		query: "IT consulting Berlin Germany",
	},
	{
		id: "eu-seo",
		channel: "google",
		brand: "saascrm",
		intent: "seo-content",
		country: "uk",
		query: "European marketing agency AI SEO content tools",
	},
	// India (secondary)
	{
		id: "in-founder",
		channel: "google",
		brand: "karyam",
		intent: "software-mvp",
		country: "in",
		query: "Indian SaaS founder looking for software agency outsource",
	},
	{
		id: "in-crm",
		channel: "google",
		brand: "saascrm",
		intent: "crm-erp",
		country: "in",
		query: "India B2B company need CRM ERP software founder email",
	},
	{
		id: "in-maps-bangalore",
		channel: "maps",
		brand: "both",
		intent: "agency-buyer",
		country: "in",
		query: "software company Bangalore",
	},
	{
		id: "in-maps-mumbai",
		channel: "maps",
		brand: "karyam",
		intent: "ai-agent",
		country: "in",
		query: "digital agency Mumbai",
	},
	// More US verticals
	{
		id: "us-ecom",
		channel: "google",
		brand: "karyam",
		intent: "software-mvp",
		country: "us",
		query: "ecommerce brand founder hire developers custom platform",
	},
	{
		id: "us-workflow",
		channel: "google",
		brand: "karyam",
		intent: "ai-agent",
		country: "us",
		query: '"need to automate" workflow founder CEO email contact',
	},
	{
		id: "us-maps-denver",
		channel: "maps",
		brand: "saascrm",
		intent: "crm-erp",
		country: "us",
		query: "business consulting Denver Colorado",
	},
	{
		id: "us-maps-chicago",
		channel: "maps",
		brand: "both",
		intent: "agency-buyer",
		country: "us",
		query: "marketing agency Chicago",
	},
];

export function jobsForFilter(opts = {}) {
	let pool = DISCOVERY_JOBS;
	if (opts.brand) {
		const b = String(opts.brand).toLowerCase();
		pool = pool.filter((j) => j.brand === b || j.brand === "both");
	}
	if (opts.intent) {
		pool = pool.filter((j) => j.intent === opts.intent);
	}
	if (opts.channel) {
		pool = pool.filter((j) => j.channel === opts.channel);
	}
	if (opts.country) {
		pool = pool.filter((j) => j.country === opts.country);
	}
	if (opts.jobId) {
		pool = pool.filter((j) => j.id === opts.jobId);
	}
	return pool;
}
