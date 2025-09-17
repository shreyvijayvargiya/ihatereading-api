import { Type, GoogleGenAI } from "@google/genai";
import { Hono } from "hono";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import dotenv from "dotenv";
import { ChatOllama } from "@langchain/ollama";
import axios from "axios";
import { serve } from "@hono/node-server";
import https from "https";
import { JSDOM } from "jsdom";
import ollama from "ollama";

dotenv.config();

// Available Ollama models from your local setup
const AVAILABLE_MODELS = [
	"deepseek-r1:1.5b",
	"gemma:2b",
	"codellama:7b",
	"nemotron-mini",
];

const ollamaClient = new ChatOllama({
	model: "gemma:2b", // Using one of your available models
	baseURL: "http://localhost:11434",
});

const genai = new GoogleGenAI({
	apiKey: process.env.GOOGLE_GENAI_API_KEY,
});

const getRandomInt = (min, max) =>
	Math.floor(Math.random() * (max - min + 1)) + min;
function get_useragent() {
	const lynx_version = `Lynx/${getRandomInt(2, 3)}.${getRandomInt(
		8,
		9
	)}.${getRandomInt(0, 2)}`;
	const libwww_version = `libwww-FM/${getRandomInt(2, 3)}.${getRandomInt(
		13,
		15
	)}`;
	const ssl_mm_version = `SSL-MM/${getRandomInt(1, 2)}.${getRandomInt(3, 5)}`;
	const openssl_version = `OpenSSL/${getRandomInt(1, 3)}.${getRandomInt(
		0,
		4
	)}.${getRandomInt(0, 9)}`;
	return `${lynx_version} ${libwww_version} ${ssl_mm_version} ${openssl_version}`;
}

const app = new Hono();

async function googleSearchFunction({
	query,
	num = 10,
	language = "en",
	country = "in",
}) {
	const results = [];
	try {
		const response = await axios.get(`https://www.google.com/search`, {
			headers: {
				"User-Agent": get_useragent(),
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Accept-Charset": "utf-8", // Explicitly request UTF-8
				"Accept-Encoding": "gzip, deflate",
			},

			params: {
				q: query,
				results: num,
				hl: language,
				gl: country,
				safe: "active",
			},
			withCredentials: true,
			httpsAgent: new https.Agent({
				rejectUnauthorized: true,
			}),
		});

		// Use response.data directly - axios already handles UTF-8
		const dom = new JSDOM(response.data, {
			contentType: "text/html",
			includeNodeLocations: false,
			storageQuota: 10000000,
		});
		const document = dom.window.document;

		const result_block = document.querySelectorAll("div.ezO2md");

		for (const result of result_block) {
			const link_tag = result.querySelector("a[href]");
			const title_tag = link_tag ? link_tag.querySelector("span.CVA68e") : null;
			const description_tag = result.querySelector("span.FrIlee");

			if (link_tag && title_tag && description_tag) {
				const link = decodeURIComponent(
					link_tag.href.split("&")[0].replace("/url?q=", "")
				);

				const title = (title_tag.textContent || "").trim().normalize("NFC");
				const description = (description_tag.textContent || "")
					.trim()
					.normalize("NFC");

				results.push({
					title,
					description,
					link,
				});
			}
		}
		return {
			query,
			results,
		};
	} catch (error) {
		console.error("Google search error:", error);
		return { error: error.message };
	}
}

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
			num: {
				type: Type.NUMBER,
				description: "The number of results to return",
			},
			language: {
				type: Type.STRING,
				description: "The language to search in",
			},
			country: {
				type: Type.STRING,
				description: "The country to search in",
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


const ddgSearchDeclaration = tool((_) => "", {
	name: "ddg_search",
	description: "Search the web for information",
	schema: z.object({
		query: z.string().describe("The query to search for"),
	}),
});

// Function to generate search queries from user prompt
const generateSearchQueries = async (prompt, modelName) => {
	try {
		const response = await ollama.chat({
			model: modelName,
			messages: [
				{
					role: "system",
					content: `You are a search query generator. Given a user's question, generate 2-3 effective Google search queries that would help find relevant information to answer the question.

Return ONLY a JSON array of search query strings. No explanations, no markdown, just the JSON array.

Example format: ["query 1", "query 2", "query 3"]`,
				},
				{
					role: "user",
					content: `Generate search queries for this question: ${prompt}`,
				},
			],
			stream: false,
		});

		// Parse the JSON response
		const queriesText = response.message.content.trim();
		console.log("Generated queries text:", queriesText);

		// Try to extract JSON array from the response
		const jsonMatch = queriesText.match(/\[.*\]/s);
		if (jsonMatch) {
			const queries = JSON.parse(jsonMatch[0]);
			return Array.isArray(queries) ? queries : [prompt];
		}

		// Fallback: if no JSON found, use the original prompt
		return [prompt];
	} catch (error) {
		console.error("Error generating search queries:", error);
		return [prompt];
	}
};

// Ollama-based AI Web Search Agent (Two-step approach)
export const aiWebSearchAgent = async (
	prompt,
	modelName = "deepseek-r1:1.5b"
) => {
	if (!prompt) {
		return {
			response: "No prompt provided",
		};
	}

	try {
		// Step 1: Determine if we need web search and generate queries
		let searchResults = [];

		// Generate search queries using the LLM
		const searchQueries = await generateSearchQueries(prompt, modelName);

		// Execute searches for each query
		for (const query of searchQueries) {
			try {
				const searchResult = await googleSearchFunction({
					query: query,
					num: 5, // Limit results per query
					language: "en",
					country: "in",
				});

				if (searchResult && searchResult.results) {
					searchResults.push({
						query: query,
						results: searchResult.results,
					});
				}
			} catch (searchError) {
				console.error(`Search error for query "${query}":`, searchError);
			}
		}

		// Step 2: Generate final response using search results
		let finalPrompt = prompt;

		if (searchResults.length > 0) {
			const searchData = searchResults.map((sr) => ({
				query: sr.query,
				results: sr.results,
			}));

			finalPrompt = `Question: ${prompt}

Search Results:
${JSON.stringify(searchData, null, 2)}

Please provide a comprehensive answer to the question using the search results above. Include relevant URLs and titles when appropriate. If the search results don't contain enough information, mention that and provide what you can based on the available data.`;
		}

		// Generate final response
		const finalResponse = await ollamaClient.generate({
			model: modelName,
			messages: [
				{
					role: "system",
					content: `You are a helpful assistant that provides accurate and detailed answers. When search results are provided, use them to give comprehensive responses with proper citations.`,
				},
				{
					role: "user",
					content: finalPrompt,
				},
				{
					role: "tool",
					content: "google_search",
					tool_call_id: "google_search",
					tool_choice: "auto",
					tool_input: {
						query: prompt,
					},
				},
			],
			stream: false,
		});

		return {
			response: finalResponse.llmOutput,
			searchResults: searchResults,
			model: modelName,
			searchesPerformed: searchResults.length > 0,
		};
	} catch (error) {
		console.error("Ollama web search error:", error);
		return {
			response: `Error: ${error.message}`,
			model: modelName,
			searchesPerformed: false,
		};
	}
};

app.post("/ai-web-search-agent", async (c) => {
	const { prompt } = await c.req.json();
	return aiWebSearchAgent(prompt);
});

export default { aiWebSearchAgent };

console.log(`server is running on port 3000`);
serve({
	fetch: app.fetch,
	port: 3000,
});
