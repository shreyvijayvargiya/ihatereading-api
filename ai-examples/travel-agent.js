import { Type, GoogleGenAI } from "@google/genai";
import { Hono } from "hono";
import { ChatOllama, Ollama } from "@langchain/ollama";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { chromium } from "playwright";
import dotenv from "dotenv";

dotenv.config();

const ollama = new ChatOllama({
	model: "nemotron-mini",
	baseURL: "http://localhost:11434",
});

const genai = new GoogleGenAI({
	apiKey: process.env.GOOGLE_GENAI_API_KEY,
});

const app = new Hono();

// Enhanced Google Search with multiple search engines
const searchTool = async (query) => {
	const engines = ["bing"],
		limit = 5,
		config = {
			blockAds: true,
			storeInCache: true,
			timeout: 30000,
		};

	if (!query) {
		return c.json({ error: "Query is required" }, 400);
	}

	console.log("🔍 Multi-search for:", query, "Engines:", engines);
	let browser;

	try {
		browser = await chromium.launch({
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
			],
		});

		const context = await browser.newContext({
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.61 Safari/537.36",
			viewport: { width: 1920, height: 1080 },
			extraHTTPHeaders: {
				dnt: "1",
				"upgrade-insecure-requests": "1",
				accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
				"sec-fetch-site": "same-origin",
				"sec-fetch-mode": "navigate",
				"sec-fetch-user": "?1",
				"sec-fetch-dest": "document",
				referer: "https://www.google.com/",
				"accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
			},
		});
		const allResults = {};

		// Search Google
		if (engines.includes("google")) {
			try {
				const page = await context.newPage();
				await page.goto(
					`https://www.google.com/search?q=${encodeURIComponent(
						query
					)}&num=${limit}`,
					{
						waitUntil: "networkidle",
						timeout: config.timeout,
					}
				);

				// Fast search - wait briefly for content
				await page.waitForTimeout(1000);

				const googleResults = await page.evaluate((maxResults) => {
					const results = [];
					const searchItems = document.querySelectorAll(".g");

					searchItems.forEach((item, index) => {
						if (index >= maxResults) return;

						const titleElement = item.querySelector("h3 a");
						const snippetElement = item.querySelector(".s");

						if (titleElement) {
							results.push({
								title: titleElement.textContent.trim(),
								url: titleElement.href,
								snippet: snippetElement
									? snippetElement.textContent.trim()
									: "",
								position: index + 1,
							});
						}
					});

					return results;
				}, limit);

				allResults.google = googleResults;
				await page.close();
			} catch (error) {
				console.error("Google search error:", error);
				allResults.google = { error: error.message };
			}
		}

		// Search Bing
		if (engines.includes("bing")) {
			try {
				const page = await context.newPage();
				await page.goto(
					`https://www.bing.com/search?q=${encodeURIComponent(
						query
					)}&count=${limit}`,
					{
						waitUntil: "networkidle",
						timeout: config.timeout,
					}
				);

				const bingResults = await page.evaluate((maxResults) => {
					const results = [];
					const searchItems = document.querySelectorAll(".b_algo");

					searchItems.forEach((item, index) => {
						if (index >= maxResults) return;

						const titleElement = item.querySelector("h2 a");
						const snippetElement = item.querySelector(".b_caption p");

						if (titleElement) {
							results.push({
								title: titleElement.textContent.trim(),
								url: titleElement.href,
								snippet: snippetElement
									? snippetElement.textContent.trim()
									: "",
								position: index + 1,
							});
						}
					});

					return results;
				}, limit);

				allResults.bing = bingResults;
				await page.close();
			} catch (error) {
				console.error("Bing search error:", error);
				allResults.bing = { error: error.message };
			}
		}

		// Search yahoo
		if (engines.includes("yahoo")) {
			try {
				const page = await context.newPage();
				await page.goto(
					`https://search.yahoo.com/search?p=${encodeURIComponent(
						query
					)}&n=${limit}`,
					{
						waitUntil: "networkidle",
						timeout: config.timeout,
					}
				);

				const yahooResults = await page.evaluate((maxResults) => {
					const results = [];
					const searchItems = document.querySelectorAll(".search-result");

					searchItems.forEach((item, index) => {
						if (index >= maxResults) return;

						const titleElement = item.querySelector("h3 a");
						const snippetElement = item.querySelector(".search-result-snippet");

						if (titleElement) {
							results.push({
								title: titleElement.textContent.trim(),
								url: titleElement.href,
								snippet: snippetElement
									? snippetElement.textContent.trim()
									: "",
								position: index + 1,
							});
						}
					});

					return results;
				}, limit);

				allResults.yahoo = yahooResults;
				await page.close();
			} catch (error) {
				console.error("Yahoo search error:", error);
				allResults.yahoo = { error: error.message };
			}
		}

		await context.close();

		return {
			success: true,
			query,
			results: allResults,
			engines,
			config,
		};
	} catch (error) {
		console.error("❌ Multi-search error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to perform multi-search",
				details: error.message,
			},
			500
		);
	} finally {
		if (browser) {
			await browser.close();
		}
	}
};

const googleSearchFunction = async (query) => {
	try {
		const response = await fetch("https://api.firecrawl.dev/v1/search", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: query,
				limit: 5,
				scrapeOptions: {
					onlyMainContent: true,
					timeout: 30000,
					parsePDF: true,
					removeBase64Images: true,
					blockAds: true,
					storeInCache: true,
				},
			}),
		});

		if (!response.ok) {
			throw new Error(
				`Firecrawl API error: ${response.status} ${response.statusText}`
			);
		}

		const data = await response.json();
		return { result: data, success: true };
	} catch (error) {
		return { error: error.message, success: false };
	}
};

const googleSearchDeclaration = {
	name: "google_search",
	description: "Search the web for information",

	parameters: {
		type: Type.OBJECT,
		properties: {
			query: {
				type: Type.STRING,
				description: "The query to search for",
			},
		},
		required: ["query"],
	},
};

const bingSearchDeclaration = tool((_) => "", {
	name: "bing_search",
	description: "Search the web for information",
	schema: z.object({
		query: z.string().describe("The query to search for"),
	}),
});

// const OllamaWithTools = ollama.bindTools([googleSearchDeclaration]);

export const aiWebSearchAgent = async (prompt) => {
	if (!prompt) {
		return {
			response: "No prompt provided",
		};
	}
	const response = await genai.models.generateContent({
		model: "gemini-2.0-flash",
		contents: [
			{
				role: "user",
				parts: [
					{
						text: `
							You are a helpful assistant that can search the web for information.
							You can use the following tools to search the web:
							- google_search: Search the web for information
							Here is the user's prompt:
							${prompt}
						`,
					},
				],
			},
		],
		config: {
			tools: [
				{
					functionDeclarations: [googleSearchDeclaration],
				},
			],
		},
	});

	const functionCalls = response.candidates[0].content.parts.filter(
		(part) => part.functionCall
	);

	let functionResults = [];
	for (const functionCall of functionCalls) {
		const { name, args } = functionCall.functionCall;
		if (name === "google_search") {
			const result = await googleSearchFunction(args.query);
			functionResults.push(result.result.data);
		}
	}

	console.log(JSON.stringify(functionResults[0]), "functionResults");
	const finalResponse = await genai.models.generateContent({
		model: "gemini-2.0-flash",
		contents: [
			{
				role: "user",
				parts: [
					{
						text: `Question: ${prompt}  
							Google Search Results: ${JSON.stringify(functionResults[0])}
						Please provide a detailed answer to the question using the search results, include url and title as well in detailed answer.`,
					},
				],
			},
		],
	});
	// console.log(finalResponse.candidates[0].content.parts[0].text);
	return {
		response: finalResponse.candidates[0].content.parts[0].text,
	};
};

export default { aiWebSearchAgent };
