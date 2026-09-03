import type { DashboardTable } from "@/lib/api";

export const ENGLAND_CLUBS_TABLE: DashboardTable = {
	id: "clubs",
	label: "England clubs",
	group: "catalog",
	collection: "clubs",
	cli: "npm run england:clubs",
	http: "POST /england-clubs/run",
	description: "England football clubs from Soccer Wiki (333 clubs, no LLM).",
};

/** Sidebar / cards always show England clubs, even if the API process is stale. */
export function withPinnedTables(tables: DashboardTable[] = []): DashboardTable[] {
	const rest = tables.filter((t) => t.id !== "clubs");
	const clubs = tables.find((t) => t.id === "clubs") || ENGLAND_CLUBS_TABLE;
	return [clubs, ...rest];
}
