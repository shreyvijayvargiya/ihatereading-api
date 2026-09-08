import type { DashboardTable } from "@/lib/api";

export const ENGLAND_CLUBS_TABLE: DashboardTable = {
	id: "clubs",
	label: "England clubs",
	group: "catalog",
	collection: "clubs",
	cli: "npm run england:clubs",
	http: "POST /england-clubs/run",
	description: "England football clubs from Soccer Wiki. Enrich with Maps/phone via npm run england:clubs:enrich.",
};

export const YC_TABLE: DashboardTable = {
	id: "yc",
	label: "YC",
	group: "leads",
	collection: "yc-companies",
	cli: "npm run yc:companies",
	http: "POST /yc-companies/run",
	description:
		"Y Combinator + a16z portfolio companies. Enrich stores site pages, logo/brand, llm.txt, address, lat/lng, mapsUrl.",
};

export const CRM_TABLE: DashboardTable = {
	id: "crm",
	label: "CRMs",
	group: "catalog",
	collection: "business-crms",
	cli: "npm run crm:directory",
	http: "POST /business-crms/run",
	description: "Business CRM products from Google search + list-page scrape. No LLM.",
};

/** Sidebar / cards always show clubs, YC, and CRMs, even if the API process is down. */
export function withPinnedTables(tables: DashboardTable[] = []): DashboardTable[] {
	const rest = tables.filter((t) => t.id !== "clubs" && t.id !== "yc" && t.id !== "a16z" && t.id !== "crm");
	const clubs = tables.find((t) => t.id === "clubs") || ENGLAND_CLUBS_TABLE;
	const yc = tables.find((t) => t.id === "yc") || YC_TABLE;
	const crm = tables.find((t) => t.id === "crm") || CRM_TABLE;
	return [clubs, yc, crm, ...rest];
}
