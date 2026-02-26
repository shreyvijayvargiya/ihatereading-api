const searchFnDecl = {
	name: "google_search",
	description:
		"Search Google and return results with title, link, description.",
	parameters: {
		type: Type.OBJECT,
		properties: {
			query: { type: Type.STRING, description: "Search query" },
			num: { type: Type.NUMBER, description: "Number of results" },
			language: { type: Type.STRING, description: "Language code" },
			country: { type: Type.STRING, description: "Country code" },
		},
		required: ["query"],
	},
};

const scrapFnDecl = {
	name: "scrap_url",
	description: "Scrape a URL and return chunkedMarkdown.",
	parameters: {
		type: Type.OBJECT,
		properties: {
			url: { type: Type.STRING, description: "URL to scrape" },
		},
		required: ["url"],
	},
};

const scrapMetadataDecl = {
	name: "scrap_metadata",
	description: "Scrape metadata from a URL.",
	parameters: {
		type: Type.OBJECT,
		properties: {
			url: {
				type: Type.STRING,
				description: "URL to scrape metadata from",
			},
		},
	},
};

const crawlUrlFnDecl = {
	name: "crawl_url",
	description: "Crawl a URL and return chunkedMarkdown.",
	parameters: {
		type: Type.OBJECT,
		properties: {
			url: { type: Type.STRING, description: "URL to crawl" },
		},
		required: ["url"],
	},
};

// One endpoint: LLM answers, and can call google-search and scrape as needed
app.post("/ai-answer", async (c) => {
	try {
		const { prompt, numResults = 5 } = await c.req.json();
		if (!prompt || String(prompt).trim().length === 0) {
			return c.json({ success: false, error: "prompt is required" }, 400);
		}

		const xfProto = c.req.header("x-forwarded-proto") || "http";
		const xfHost = c.req.header("x-forwarded-host") || c.req.header("host");
		const fallbackHost = `127.0.0.1:${process.env.PORT || "3000"}`;
		const baseUrl = `${xfProto}://${xfHost || fallbackHost}`;

		let response = await genai.models.generateContent({
			model: "gemini-1.5-flash",
			contents: [
				{
					role: "user",
					parts: [
						{
							text: `You are a highly precise and helpful assistant. Follow these instructions strictly:

1. To provide exact answers based on source content, **always prioritize using scrap_url** to fetch the full page content in markdown format before answering.

2. Use google_search only for finding relevant URLs or data sources. Your search queries must be clear, context-rich, and optimized for precise, high-quality results.

3. Use scrap_metadata strictly for obtaining webpage metadata like titles, descriptions, or authors as necessary.

4. Use crawl_url only when explicitly instructed or if you need to gather all links from a webpage.

5. Do not answer the user queries directly without first attempting to collect supporting information from the appropriate tools.

6. When combining information, rely on the scrapped URL content primarily to build accurate and comprehensive responses.

7. Keep all queries and tool calls concise but meaningful and aligned with the user’s prompt.

8. Strictly use tools provided to you and do not answer without using google search tool

User prompt: ${prompt}`,
						},
					],
				},
			],
			config: {
				tools: [
					{
						functionDeclarations: [
							searchFnDecl,
							scrapFnDecl,
							scrapMetadataDecl,
							crawlUrlFnDecl,
						],
					},
				],
			},
		});

		const toolCalls =
			response.candidates?.[0]?.content?.parts?.filter((p) => p.functionCall) ||
			[];
		const conversation = [
			{ role: "user", parts: [{ text: prompt }] },
			{ role: "model", parts: response.candidates?.[0]?.content?.parts || [] },
		];

		const toolArtifacts = {
			searchResults: [],
			scraps: [],
			metadata: [],
			crawlUrls: [],
		};

		for (const callPart of toolCalls) {
			const { name, args } = callPart.functionCall;
			let resultPayload;
			if (name === "google_search") {
				const searchReq = {
					query: args?.query || prompt,
					num: Number(args?.num ?? numResults),
					language: args?.language || "en",
					country: args?.country || "in",
				};
				const searchRes = await axios.post(`${baseUrl}/ddg-search`, searchReq, {
					headers: { "Content-Type": "application/json" },
				});
				resultPayload =
					searchRes.data?.results?.map((r) => ({
						title: r.title,
						link: r.link,
						description: r.description,
					})) || [];
				toolArtifacts.searchResults.push(...resultPayload);
			} else if (name === "scrap_url") {
				const scrapRes = await axios.post(
					`${baseUrl}/scrape`,
					{ url: args?.url },
					{
						headers: { "Content-Type": "application/json" },
						timeout: 60000,
					},
				);
				resultPayload = {
					url: args?.url,
					chunkedMarkdown:
						scrapRes.data?.markdown || scrapRes.data?.data?.markdown,
				};
				toolArtifacts.scraps.push(resultPayload);
			} else if (name === "scrap_metadata") {
				const scrapMetadataRes = await axios.post(
					`${baseUrl}/take-metadata`,
					{ url: args?.url },
					{ headers: { "Content-Type": "application/json" } },
				);
				resultPayload = {
					url: args?.url,
					metadata: scrapMetadataRes.data?.metadata,
				};
				toolArtifacts.metadata.push(resultPayload);
			} else if (name === "crawl_url") {
				const crawlUrlRes = await axios.post(
					`${baseUrl}/crawl-url`,
					{ url: args?.url },
					{ headers: { "Content-Type": "application/json" } },
				);
				resultPayload = {
					url: args?.url,
					crawlUrls: crawlUrlRes.data?.crawledUrls,
				};
				toolArtifacts.crawlUrls.push(resultPayload);
			}

			conversation.push({
				role: "user",
				parts: [
					{ text: `Function ${name} result: ${JSON.stringify(resultPayload)}` },
				],
			});
			conversation.push({
				role: "model",
				parts: [
					{
						text: `You are a helpful assistant. Answer the user's prompt. 
							User prompt: ${prompt}

							The answer should be precise to the user query, provide citiations, links and metadata and 
							single page markdown content fetched and added below 
							Strictly follow the instructions and use the tools provided.
							
							Function ${name} result: ${JSON.stringify(resultPayload)}`,
					},
				],
			});
			response = await genai.models.generateContent({
				model: "gemini-1.5-flash",
				contents: conversation,
			});
		}

		const finalText = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
		return c.json({
			success: true,
			response: finalText,
			tools: toolArtifacts,
			usageMetadata: response.usageMetadata.totalTokenCount,
		});
	} catch (error) {
		console.error("/ai-answer error:", error);
		return c.json({ success: false, error: error.message }, 500);
	}
});

// Local LLM flow without tool-calling: generate queries → search → optional scrape → answer
app.post("/ai-answer-ollama", async (c) => {
	try {
		const {
			prompt,
			model = "gemma3:270m",
			numResults = 5,
			scrapeTopK = 1,
			temperature = 0.3,
		} = await c.req.json();

		if (!prompt || String(prompt).trim().length === 0) {
			return c.json({ success: false, error: "prompt is required" }, 400);
		}

		const xfProto = c.req.header("x-forwarded-proto") || "http";
		const xfHost = c.req.header("x-forwarded-host") || c.req.header("host");
		const fallbackHost = `127.0.0.1:${process.env.PORT || "3000"}`;
		const baseUrl = `${xfProto}://${xfHost || fallbackHost}`;

		const ollama = new ChatOllama({ model, temperature });

		// Step 1: Ask LLM for search queries
		const queryGenPrompt = `You are assisting with web research. Based on the user's prompt below, generate 3–5 highly targeted Google search queries. Output your answer as a JSON array of strings, with each string being a single search query. Do not include any explanations or extra text, only output the JSON array.\n\nUser prompt:\n${prompt}`;
		const queryGen = await ollama.invoke(queryGenPrompt);
		let queries = [];
		let queryText =
			typeof queryGen?.content === "string"
				? queryGen.content
				: Array.isArray(queryGen?.content)
					? queryGen.content
							.map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
							.join("\n")
					: String(queryGen || "");
		const jsonMatch = queryText.match(/\[[\s\S]*\]/);
		if (jsonMatch) {
			try {
				const arr = JSON.parse(jsonMatch[0]);
				if (Array.isArray(arr)) {
					queries = arr
						.map((q) => String(q).trim())
						.filter((q) => q.length > 0);
				}
			} catch {}
		}
		if (!Array.isArray(queries) || queries.length === 0) {
			queries = (queryText || "")
				.split("\n")
				.map((q) => q.replace(/^[\-\*\d\.\)]\s*/, "").trim())
				.filter((q) => q.length > 0);
		}
		if (queries.length === 0) queries = [String(prompt)];

		// Step 2: Google search for each query
		const searchPromises = queries.slice(0, 4).map(async (q) => {
			try {
				const searchRes = await axios.post(
					`${baseUrl}/ddg-search`,
					{ query: q, num: numResults, language: "en", country: "in" },
					{ headers: { "Content-Type": "application/json" } },
				);

				const rows = searchRes.data?.results || [];

				for (const r of rows) {
					return {
						title: r.title,
						link: r.link,
						description: r.description,
					};
				}
			} catch {
				return null;
			}
		});
		const searchResults = [];
		(await Promise.allSettled(searchPromises)).filter((r) => {
			if (r.status === "fulfilled" && r.value) {
				searchResults.push(r.value);
			}
		});

		// Step 3: Ask LLM which URLs to scrape (optional)
		let urlsToScrape = [];
		const chooserPrompt = `Given these search results, pick up to ${scrapeTopK} URLs that are most likely to contain authoritative, detailed content for answering the user's prompt. Respond with a JSON array of URLs only.\n\nSearch results:\n${JSON.stringify(
			searchResults,
			null,
			2,
		)}\n\nUser prompt:\n${prompt}`;
		const chooseRes = await ollama.invoke(chooserPrompt);
		const chooseText =
			typeof chooseRes?.content === "string"
				? chooseRes.content
				: JSON.stringify(chooseRes?.content ?? "");
		const match = chooseText.match(/\[[\s\S]*\]/);
		if (match) {
			urlsToScrape = JSON.parse(match[0]);
		}
		if (!Array.isArray(urlsToScrape)) urlsToScrape = [];
		if (urlsToScrape.length === 0) {
			urlsToScrape = allResults
				.slice(1, scrapeTopK)
				.map((r) => r.link)
				.filter(Boolean);
		}

		// Step 4: Scrape selected URLs for chunked markdown
		const scrapsPromises = urlsToScrape.map(async (url) => {
			const scrapRes = await axios.post(
				`${baseUrl}/scrape`,
				{ url },
				{ headers: { "Content-Type": "application/json" }, timeout: 60000 },
			);
			return {
				url,
				chunkedMarkdown:
					scrapRes.data?.markdown || scrapRes.data?.data?.markdown || "",
			};
		});

		const scrapsResults = [];
		(await Promise.allSettled(scrapsPromises)).filter((r) => {
			if (r.status === "fulfilled" && r.value) {
				scrapsResults.push(r.value);
			}
		});

		// Step 5: Final answer synthesis
		const finalPrompt = `You are a precise assistant. Answer the user's prompt using the evidence below.\n\n
If you use specific facts, cite the URL in parentheses. Keep it concise and accurate.\n\n
User prompt:\n${prompt}
\n\nSearch results (title, link, description):\n${JSON.stringify(
			searchResults,
			null,
			2,
		)}\n\nScraped markdown (url + markdown chunks):\n${JSON.stringify(
			scrapsResults.map(({ url, markdown }) => ({
				url,
				markdown,
			})),
			null,
			2,
		)}`;
		const finalRes = await ollama.invoke(finalPrompt);
		const finalText =
			typeof finalRes?.content === "string"
				? finalRes.content
				: JSON.stringify(finalRes?.content ?? "");

		const totalTokens = finalRes.usage_metadata.total_tokens;
		return c.json({
			success: true,
			response: finalText,
			totalTokens: totalTokens,
			searchResults: searchResults,
			scrapsResults: scrapsResults,
		});
	} catch (error) {
		console.error("/ai-answer-ollama error:", error);
		return c.json({ success: false, error: error.message }, 500);
	}
});
