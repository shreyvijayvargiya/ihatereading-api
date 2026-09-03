/**
 * OpenRouter function tools for the Claude toprated agent.
 */

import {
	tableAddRows,
	tableEditRow,
	tableGetRow,
	tableListRows,
	tableRemoveRows,
	listTables,
} from "./table.js";
import {
	toolGoogleSearch,
	toolScrapeGithub,
	toolScrapeInstagram,
	toolScrapeLinkedIn,
	toolScrapeMaps,
	toolScrapeProductHunt,
	toolScrapeWebsite,
	toolScrapeX,
	toolScrapeYoutube,
} from "./scrapers.js";

function fn(name, description, properties, required = []) {
	return {
		type: "function",
		function: {
			name,
			description,
			parameters: {
				type: "object",
				properties,
				required,
			},
		},
	};
}

export const CLAUDE_TOPRATED_TOOLS = [
	fn(
		"table_add_rows",
		"Create or append a Firestore table. The table name becomes a new collection; each row is a new document (docId from row.id / row.docId, else a hash). Use this to persist scrape results as structured data.",
		{
			collection: {
				type: "string",
				description: "Collection / table name, e.g. restaurant-leads or yc-founders",
			},
			rows: {
				type: "array",
				description: "Row objects. Optional id or docId on each row.",
				items: {
					type: "object",
					additionalProperties: true,
					properties: {
						id: { type: "string" },
						docId: { type: "string" },
					},
				},
			},
		},
		["collection", "rows"],
	),
	fn(
		"table_edit_row",
		"Merge-update one document in a table/collection.",
		{
			collection: { type: "string" },
			docId: { type: "string" },
			data: {
				type: "object",
				additionalProperties: true,
				properties: {},
				description: "Fields to merge",
			},
		},
		["collection", "docId", "data"],
	),
	fn(
		"table_remove_row",
		"Delete one or more documents from a table/collection.",
		{
			collection: { type: "string" },
			docIds: {
				type: "array",
				items: { type: "string" },
				description: "Document ids to delete",
			},
		},
		["collection", "docIds"],
	),
	fn(
		"table_list",
		"List documents in a table, or list tables the agent has created.",
		{
			collection: {
				type: "string",
				description: "Omit to list known tables; set to list rows in that collection",
			},
			limit: { type: "number" },
		},
		[],
	),
	fn(
		"table_get",
		"Read a single document from a table.",
		{
			collection: { type: "string" },
			docId: { type: "string" },
		},
		["collection", "docId"],
	),
	fn(
		"google_search",
		"Search Google / the web. Use to find URLs, people, companies, Product Hunt posts, LinkedIn profiles.",
		{
			query: { type: "string" },
		},
		["query"],
	),
	fn(
		"scrape_website",
		"Scrape any public website URL and return markdown + links. Primary page scraper.",
		{
			url: { type: "string" },
		},
		["url"],
	),
	fn(
		"scrape_maps",
		"Google Maps local businesses for a query like 'cafes in Jaipur'. Returns name, address, phone, website, rating.",
		{
			query: { type: "string" },
		},
		["query"],
	),
	fn(
		"scrape_linkedin",
		"Find LinkedIn profiles via search, or scrape a linkedin.com URL if given.",
		{
			query: { type: "string", description: "Person, company, or role search" },
			url: { type: "string", description: "linkedin.com profile or company URL" },
		},
		[],
	),
	fn(
		"scrape_x",
		"Public X / Twitter profile (handle or URL).",
		{
			handle: { type: "string" },
			url: { type: "string" },
		},
		[],
	),
	fn(
		"scrape_instagram",
		"Public Instagram profile (username or URL).",
		{
			username: { type: "string" },
			url: { type: "string" },
		},
		[],
	),
	fn(
		"scrape_youtube",
		"YouTube channel profile, or video transcript if a watch/shorts URL is given.",
		{
			handle: { type: "string" },
			url: { type: "string" },
			channelId: { type: "string" },
		},
		[],
	),
	fn(
		"scrape_github",
		"Scrape a github.com repo or profile URL (README, stars, metadata).",
		{
			url: { type: "string" },
		},
		["url"],
	),
	fn(
		"scrape_producthunt",
		"Scrape a Product Hunt product/post URL, or search Product Hunt for a query then scrape the top result.",
		{
			url: { type: "string" },
			query: { type: "string" },
		},
		[],
	),
];

function parseArgs(raw) {
	if (raw && typeof raw === "object") return raw;
	if (typeof raw === "string") {
		try {
			return JSON.parse(raw);
		} catch {
			return {};
		}
	}
	return {};
}

function jsonSafe(value) {
	try {
		return JSON.stringify(value);
	} catch {
		return JSON.stringify({ error: "unserializable" });
	}
}

export async function executeTool(name, rawArgs, ctx) {
	const args = parseArgs(rawArgs);
	switch (name) {
		case "table_add_rows":
			return tableAddRows(args.collection, args.rows);
		case "table_edit_row":
			return tableEditRow(args.collection, args.docId, args.data);
		case "table_remove_row":
			return tableRemoveRows(args.collection, args.docIds || args.docId);
		case "table_list":
			if (args.collection) return tableListRows(args.collection, args.limit);
			return { tables: await listTables(args.limit) };
		case "table_get":
			return tableGetRow(args.collection, args.docId);
		case "google_search":
			return toolGoogleSearch(args.query, ctx);
		case "scrape_website":
			return toolScrapeWebsite(args.url, ctx);
		case "scrape_maps":
			return toolScrapeMaps(args.query, ctx);
		case "scrape_linkedin":
			return toolScrapeLinkedIn(args, ctx);
		case "scrape_x":
			return toolScrapeX(args);
		case "scrape_instagram":
			return toolScrapeInstagram(args);
		case "scrape_youtube":
			return toolScrapeYoutube(args, ctx);
		case "scrape_github":
			return toolScrapeGithub(args.url, ctx);
		case "scrape_producthunt":
			return toolScrapeProductHunt(args, ctx);
		default:
			throw new Error(`unknown tool: ${name}`);
	}
}

export { jsonSafe, parseArgs };
