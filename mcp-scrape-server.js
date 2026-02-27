/**
 * MCP server that exposes the /scrape and /scrape-multiple API endpoints as tools.
 * Does not modify the API; forwards tool calls to the running API (default http://localhost:3002).
 *
 * Usage: node mcp-scrape-server.js
 * Configure SCRAPE_API_BASE_URL if your API runs on a different host/port.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	ListToolsRequestSchema,
	CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL =
	process.env.SCRAPE_API_BASE_URL || "http://localhost:3002";

const server = new Server(
	{
		name: "ihatereading-scrape",
		version: "1.0.0",
	},
	{
		capabilities: {
			tools: {},
		},
	},
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
	return {
		tools: [
			{
				name: "scrape",
				description:
					"Scrape a single URL and return structured data (markdown, metadata, semantic content, optional screenshot). Uses Puppeteer. Rate limited per IP.",
				inputSchema: {
					type: "object",
					properties: {
						url: {
							type: "string",
							description: "The URL to scrape (required).",
						},
						timeout: {
							type: "number",
							description: "Request timeout in ms (default 30000).",
							default: 30000,
						},
						includeSemanticContent: {
							type: "boolean",
							description: "Include extracted semantic content (default true).",
							default: true,
						},
						includeImages: { type: "boolean", default: true },
						includeLinks: { type: "boolean", default: true },
						extractMetadata: { type: "boolean", default: true },
						includeCache: { type: "boolean", default: false },
						useProxy: { type: "boolean", default: false },
						aiSummary: { type: "boolean", default: false },
						takeScreenshot: { type: "boolean", default: false },
					},
					required: ["url"],
				},
			},
			{
				name: "scrape_multiple",
				description:
					"Scrape multiple URLs in one request (max 20). Returns an array of results per URL. Uses Puppeteer. Rate limited per IP.",
				inputSchema: {
					type: "object",
					properties: {
						urls: {
							type: "array",
							items: { type: "string" },
							description: "List of URLs to scrape (required, max 20).",
						},
						timeout: {
							type: "number",
							description: "Request timeout per URL in ms (default 30000).",
							default: 30000,
						},
						includeSemanticContent: { type: "boolean", default: true },
						includeImages: { type: "boolean", default: true },
						includeLinks: { type: "boolean", default: true },
						extractMetadata: { type: "boolean", default: true },
						includeCache: { type: "boolean", default: false },
						useProxy: { type: "boolean", default: false },
						aiSummary: { type: "boolean", default: false },
						takeScreenshot: { type: "boolean", default: false },
					},
					required: ["urls"],
				},
			},
		],
	};
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;
	const argsObj = args || {};

	if (name === "scrape") {
		const url = argsObj.url;
		if (!url || typeof url !== "string") {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: false,
							error: "Missing or invalid 'url' argument",
						}),
					},
				],
				isError: true,
			};
		}
		try {
			const body = {
				url,
				timeout: argsObj.timeout ?? 30000,
				includeSemanticContent: argsObj.includeSemanticContent ?? true,
				includeImages: argsObj.includeImages ?? true,
				includeLinks: argsObj.includeLinks ?? true,
				extractMetadata: argsObj.extractMetadata ?? true,
				includeCache: argsObj.includeCache ?? false,
				useProxy: argsObj.useProxy ?? false,
				aiSummary: argsObj.aiSummary ?? false,
				takeScreenshot: argsObj.takeScreenshot ?? false,
			};
			const res = await fetch(`${BASE_URL}/scrape`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = await res.json();
			const text = JSON.stringify(data);
			return {
				content: [{ type: "text", text }],
				isError: data.success === false,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: false,
							error: message,
						}),
					},
				],
				isError: true,
			};
		}
	}

	if (name === "scrape_multiple") {
		const urls = argsObj.urls;
		if (!Array.isArray(urls) || urls.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: false,
							error: "Missing or invalid 'urls' argument (must be non-empty array)",
						}),
					},
				],
				isError: true,
			};
		}
		if (urls.length > 20) {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: false,
							error: "Maximum 20 URLs per request",
						}),
					},
				],
				isError: true,
			};
		}
		try {
			const body = {
				urls,
				timeout: argsObj.timeout ?? 30000,
				includeSemanticContent: argsObj.includeSemanticContent ?? true,
				includeImages: argsObj.includeImages ?? true,
				includeLinks: argsObj.includeLinks ?? true,
				extractMetadata: argsObj.extractMetadata ?? true,
				includeCache: argsObj.includeCache ?? false,
				useProxy: argsObj.useProxy ?? false,
				aiSummary: argsObj.aiSummary ?? false,
				takeScreenshot: argsObj.takeScreenshot ?? false,
			};
			const res = await fetch(`${BASE_URL}/scrape-multiple`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = await res.json();
			const text = JSON.stringify(data);
			return {
				content: [{ type: "text", text }],
				isError: data.success === false,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: false,
							error: message,
						}),
					},
				],
				isError: true,
			};
		}
	}

	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					success: false,
					error: `Unknown tool: ${name}`,
				}),
			},
		],
		isError: true,
	};
});

const transport = new StdioServerTransport();
await server.connect(transport);
