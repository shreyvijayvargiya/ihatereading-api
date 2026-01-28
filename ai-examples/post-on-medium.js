import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

dotenv.config();

const app = new Hono();

const genai = new GoogleGenAI({
	apiKey: process.env.GOOGLE_GENAI_API_KEY,
});

// Function to convert markdown to HTML
const convertMarkdownToHtml = (markdown) => {
	if (!markdown) return "";

	// Simple markdown to HTML conversion
	return markdown
		.replace(/^### (.*$)/gim, "<h3>$1</h3>")
		.replace(/^## (.*$)/gim, "<h2>$1</h2>")
		.replace(/^# (.*$)/gim, "<h1>$1</h1>")
		.replace(/\*\*(.*)\*\*/gim, "<strong>$1</strong>")
		.replace(/\*(.*)\*/gim, "<em>$1</em>")
		.replace(/\n/gim, "<br>")
		.replace(/`(.*)`/gim, "<code>$1</code>")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/gim, '<a href="$2">$1</a>');
};

// Function to post to Medium
app.post("/post-to-medium", async (c) => {
	try {
		const { prompt } = await c.req.json();
		if (!prompt) {
			c.status(400);
			return c.json({
				error: "Prompt is required",
			});
		}

		const response = await genai.models.generateContent({
			model: "gemini-2.0-flash",
			contents: [
				{
					role: "model",
					parts: [
						{
							text: "You are a helpful assistant that can help me write a blog post on Medium. You will be given a prompt and you will need to write a blog post on Medium.",
						},
					],
				},
				{
					role: "user",
					parts: [{ text: prompt }],
				},
			],
		});

		const generatedContent = response.candidates[0].content.parts[0].text;

		const lines = generatedContent.split("\n");
		let title = "Untitled Blog";
		let contentBody = generatedContent;

		if (lines[0] && lines[0].startsWith("#")) {
			title = lines[0].replace(/^#+\s*/, "").trim();
			contentBody = lines.slice(1).join("\n").trim();
		}

		const htmlContent = convertMarkdownToHtml(contentBody);

		const postData = {
			title: title,
			contentFormat: "html",
			content: htmlContent,
			tags: ["AI", "automation", "blogging"],
			publishStatus: "public",
		};

		let data = JSON.stringify(postData);

		let config = {
			method: "post",
			url: "https://api.medium.com/v1/users/11585d0546e2287a0f02365d2a2a2ae80916fe4982dac93cbb713ef19af1dfc16/posts",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${process.env.MEDIUM_TOKEN}`,
			},
			data: data,
		};

		const mediumResponse = await fetch(config.url, {
			method: config.method,
			headers: config.headers,
			body: config.data,
		});

		// Get response as text first to check content type
		const responseText = await mediumResponse.text();

		let responseData;
		try {
			responseData = JSON.parse(responseText);
		} catch (parseError) {
			throw new Error(
				"Medium API returned invalid response - likely authentication or endpoint issue"
			);
		}

		if (mediumResponse.ok) {
			return {
				success: true,
				message: "Post published successfully to Medium",
				data: responseData,
			};
		} else {
			throw new Error(
				`Failed to publish to Medium: ${
					responseData.error || responseData.message || "Unknown error"
				}`
			);
		}
	} catch (error) {
		console.error("Error posting to Medium:", error.message);
		throw error;
	}
});



serve({
	app: app.fetch,
	port: 3001,
});
