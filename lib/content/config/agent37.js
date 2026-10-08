/**
 * Agent37.com brand + site identity for content intelligence.
 */

export const AGENT37_SITE_IDS = ["agent37-com", "agent37", "agent37-dev"];

export const AGENT37_DISCOVERY_SOURCE = "agent37-multi-source-research";

export const AGENT37_BRAND = {
	name: "Agent37",
	domain: "https://agent37.com",
	tagline: "Build, deploy, and orchestrate AI agents for real workflows.",
	audience:
		"Developers, indie hackers, and product teams shipping AI agents, automations, and multi-step LLM workflows.",
	voice:
		"Technical but approachable — like a senior engineer explaining what actually works in production.",
	tone: [
		"practical and code-aware",
		"opinionated without hype",
		"framework-agnostic where possible",
		"clear trade-offs and failure modes",
	],
	contentPillars: [
		"AI agent architecture and orchestration",
		"tool use, MCP, and API integrations",
		"prompting patterns for reliable agents",
		"deployment, observability, and cost control",
		"comparisons of agent frameworks and platforms",
	],
	avoid: [
		"generic AI hype without implementation detail",
		"invented benchmarks or fake case studies",
		"shilling unverified tools",
	],
};

export function isAgent37Site(siteId, site = {}) {
	const id = String(siteId || "").toLowerCase();
	const domain = String(site.domain || "").toLowerCase();
	return (
		AGENT37_SITE_IDS.some((s) => id.includes(s)) || domain.includes("agent37")
	);
}
