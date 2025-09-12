import { Hono } from "hono";
import fs from "fs";
import { firestore } from "../firebase.js";
import { serve } from "@hono/node-server";
import dotenv from "dotenv";

dotenv.config();

const app = new Hono();

app.get("/universo", async (c) => {
	try {
		// Import data from JSON file instead of Firebase
		const jsonData = JSON.parse(fs.readFileSync("./dbs.json", "utf8"));

		// Filter items that have RSS links
		const feedsWithRSS = jsonData.filter((item) => item.rssLink);

		// Use Promise.all for concurrent execution - much faster!
		const fetchPromises = feedsWithRSS.map(async (res) => {
			const rssLink =
				res.rssLink && res.rssLink.startsWith("https")
					? res.rssLink
					: res.url + res.rssLink;

			try {
				// Add timeout to prevent hanging requests
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 second timeout

				const response = await fetch(rssLink, {
					signal: controller.signal,
					headers: {
						"User-Agent": "Mozilla/5.0 (compatible; RSS-Fetcher/1.0)",
					},
				});

				clearTimeout(timeoutId);

				if (!response.ok) {
					throw new Error(`HTTP error! status: ${response.status}`);
				}

				const data = await response.text();

				// Simple regex-based RSS parser (no external dependencies)
				const parseRSS = (xmlString) => {
					const items = [];
					const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
					const titleRegex = /<title[^>]*>([\s\S]*?)<\/title>/i;
					const linkRegex = /<link[^>]*>([\s\S]*?)<\/link>/i;
					const descriptionRegex =
						/<description[^>]*>([\s\S]*?)<\/description>/i;
					const pubDateRegex = /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i;
					const authorRegex = /<author[^>]*>([\s\S]*?)<\/author>/i;

					let match;
					while (
						(match = itemRegex.exec(xmlString)) !== null &&
						items.length < 5
					) {
						const itemContent = match[1];

						const title = titleRegex.exec(itemContent)?.[1]?.trim() || "";
						const link = linkRegex.exec(itemContent)?.[1]?.trim() || "";
						const description =
							descriptionRegex.exec(itemContent)?.[1]?.trim() || "";
						const pubDate = pubDateRegex.exec(itemContent)?.[1]?.trim() || "";
						const author = authorRegex.exec(itemContent)?.[1]?.trim() || "";

						items.push({
							title: title.replace(/<[^>]*>/g, ""),
							link: link.replace(/<[^>]*>/g, ""),
							description: description.replace(/<[^>]*>/g, ""),
							pubDate: pubDate.replace(/<[^>]*>/g, ""),
							author: author.replace(/<[^>]*>/g, ""),
						});
					}

					return items;
				};

				const blogs = parseRSS(data);

				return {
					source: res.title || res.name || res.url,
					rssLink: rssLink,
					latestBlogs: blogs,
					totalBlogs: blogs.length,
					status: "success",
				};
			} catch (error) {
				console.error(`Error fetching RSS from ${rssLink}:`, error.message);
				return {
					source: res.title || res.name || res.url,
					rssLink: rssLink,
					latestBlogs: [],
					error: error.message,
					totalBlogs: 0,
					status: "error",
				};
			}
		});

		// Wait for all promises to resolve concurrently
		const results = await Promise.all(fetchPromises);

		// Filter successful results
		const successfulResults = results.filter(
			(result) => result.status === "success"
		);
		const failedResults = results.filter((result) => result.status === "error");

		return c.json({
			totalFeeds: feedsWithRSS.length,
			successfulSources: successfulResults.length,
			failedSources: failedResults.length,
			sources: results,
		});
	} catch (error) {
		console.error("Error in /universo route:", error);
		return c.json({ error: "Failed to fetch RSS feeds" }, 500);
	}
});

// New batched endpoints for better performance
app.get("/universo/batch/:page", async (c) => {
	try {
		const page = parseInt(c.req.param("page")) || 1;
		const batchSize = 50;
		const offset = (page - 1) * batchSize;

		const jsonData = JSON.parse(fs.readFileSync("./dbs.json", "utf8"));

		const feedsWithRSS = jsonData;
		const totalFeeds = feedsWithRSS.length;

		const totalPages = Math.ceil(totalFeeds / batchSize);

		const paginatedFeeds = feedsWithRSS.slice(offset, offset + batchSize);

		const fetchPromises = paginatedFeeds.map(async (res) => {
			const rssLink =
				res.rssLink && res.rssLink.startsWith("https")
					? res.rssLink
					: res.url + res.rssLink;

			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 15000);

				const response = await fetch(rssLink, {
					signal: controller.signal,
					headers: {
						"User-Agent": "Mozilla/5.0 (compatible; RSS-Fetcher/1.0)",
					},
				});

				clearTimeout(timeoutId);

				if (!response.ok) {
					throw new Error(`HTTP error! status: ${response.status}`);
				}

				const data = await response.text();

				const parseRSS = (xmlString) => {
					const items = [];
					const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
					const titleRegex = /<title[^>]*>([\s\S]*?)<\/title>/i;
					const linkRegex = /<link[^>]*>([\s\S]*?)<\/link>/i;
					const descriptionRegex =
						/<description[^>]*>([\s\S]*?)<\/description>/i;
					const pubDateRegex = /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i;
					const authorRegex = /<author[^>]*>([\s\S]*?)<\/author>/i;

					let match;
					while (
						(match = itemRegex.exec(xmlString)) !== null &&
						items.length < 5
					) {
						const itemContent = match[1];
						const title = titleRegex.exec(itemContent)?.[1]?.trim() || "";
						const link = linkRegex.exec(itemContent)?.[1]?.trim() || "";
						const description =
							descriptionRegex.exec(itemContent)?.[1]?.trim() || "";
						const pubDate = pubDateRegex.exec(itemContent)?.[1]?.trim() || "";
						const author = authorRegex.exec(itemContent)?.[1]?.trim() || "";

						items.push({
							title: title.replace(/<[^>]*>/g, ""),
							link: link.replace(/<[^>]*>/g, ""),
							description: description.replace(/<[^>]*>/g, ""),
							pubDate: pubDate.replace(/<[^>]*>/g, ""),
							author: author.replace(/<[^>]*>/g, ""),
						});
					}
					return items;
				};

				const blogs = parseRSS(data);

				return {
					source: res.title || res.name || res.url,
					rssLink: rssLink,
					latestBlogs: blogs,
					totalBlogs: blogs.length,
					status: "success",
				};
			} catch (error) {
				console.error(`Error fetching RSS from ${rssLink}:`, error.message);
				return {
					source: res.title || res.name || res.url,
					rssLink: rssLink,
					latestBlogs: [],
					error: error.message,
					totalBlogs: 0,
					status: "error",
				};
			}
		});

		const results = await Promise.all(fetchPromises);
		const successfulResults = results.filter(
			(result) => result.status === "success"
		);
		const failedResults = results.filter((result) => result.status === "error");

		const uniqueSources = successfulResults
			.filter(
				(item) => item.status === "success" && item.latestBlogs.length > 0
			)
			.filter(
				(item, index, self) =>
					index === self.findIndex((t) => t.source === item.source)
			);

		if (uniqueSources.length > 0) {
			await firestore
				.collection("ScrapedData")
				.doc(page.toString())
				.set({
					page: page,
					totalPages: totalPages,
					totalFeeds: totalFeeds,
					batchSize: batchSize,
					processedInThisBatch: results.length,
					successfulSources: successfulResults.length,
					failedSources: failedResults.length,
					hasNextPage: page < totalPages,
					hasPreviousPage: page > 1,
					sources: uniqueSources,
					timestamp: new Date().toISOString(),
					createdAt: new Date(),
				});
		}
		return c.json({
			page: page,
			totalPages: totalPages,
			totalFeeds: totalFeeds,
			batchSize: batchSize,
			processedInThisBatch: results.length,
			successfulSources: successfulResults.length,
			failedSources: failedResults.length,
			hasNextPage: page < totalPages,
			hasPreviousPage: page > 1,
			sources: uniqueSources,
		});
	} catch (error) {
		console.error("Error in /universo/batch route:", error);
		return c.json({ error: "Failed to fetch RSS feeds batch" }, 500);
	}
});

app.get("/universo/info", async (c) => {
	try {
		// Import data from JSON file instead of Firebase
		const jsonData = JSON.parse(fs.readFileSync("./firestore.json", "utf8"));

		// Filter items that have RSS links
		const feedsWithRSS = jsonData.filter((item) => item.rssLink);
		const totalFeeds = feedsWithRSS.length;
		const batchSize = 10;
		const totalPages = Math.ceil(totalFeeds / batchSize);

		return c.json({
			totalFeeds: totalFeeds,
			totalPages: totalPages,
			batchSize: batchSize,
			estimatedTimePerBatch: "15-30 seconds",
			endpoints: {
				getAll: "/universo",
				getBatch: "/universo/batch/:page",
				getInfo: "/universo/info",
			},
		});
	} catch (error) {
		console.error("Error in /universo/info route:", error);
		return c.json({ error: "Failed to get pagination info" }, 500);
	}
});

serve({
	port: 3000,
	fetch: app.fetch,
});
