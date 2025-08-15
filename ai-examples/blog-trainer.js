import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { GoogleGenAI } from "@google/genai";
import { firestore } from "../firebase.js";
import dotenv from "dotenv";

dotenv.config();

const app = new Hono();

const genai = new GoogleGenAI({
	apiKey: process.env.GOOGLE_GENAI_API_KEY,
});

// Helper function to clean and structure blog content
const preprocessBlogContent = (blogData) => {
	if (!blogData || !blogData.content) {
		return "No blog content available.";
	}

	// Extract key information
	const title = blogData.title || "Untitled";
	const author = blogData.author || "Unknown";
	const publishDate =
		blogData.publishDate || blogData.createdAt || "Unknown date";
	const tags = blogData.tags || [];
	const category = blogData.category || "Uncategorized";

	// Clean HTML content (remove excessive whitespace, normalize)
	let content = blogData.content
		.replace(/\s+/g, " ") // Normalize whitespace
		.trim();

	return {
		title,
		author,
		publishDate,
		tags,
		category,
		content,
		wordCount: content.split(" ").length,
	};
};

app.post("/chat-with-blog-content", async (c) => {
	try {
		const { prompt, blogId } = c.req.query();

		if (!prompt || !blogId) {
			return c.json(
				{
					error: "Missing required parameters: prompt and blogId",
				},
				400
			);
		}

		// Fetch blog content from Firestore
		const blogDoc = await firestore.collection("publish").doc(blogId).get();

		if (!blogDoc.exists) {
			return c.json(
				{
					error: "Blog not found with the provided blogId",
				},
				404
			);
		}

		const blogData = blogDoc.data();
		const processedBlog = preprocessBlogContent(blogData);

		// Enhanced conversation structure
		const conversation = [
			{
				role: "user",
				parts: [
					{
						text: `You are an expert AI assistant specialized in analyzing and answering questions about blog content. 

IMPORTANT INSTRUCTIONS:
- Answer questions using ONLY the provided blog content as your source
- If the question cannot be answered from the blog content, say "I cannot answer this question based on the provided blog content"
- Preserve any links, code snippets, or formatting mentioned in the blog
- Be accurate and cite specific parts of the blog when relevant
- Keep responses concise but comprehensive

BLOG INFORMATION:
Title: ${processedBlog.title}
Author: ${processedBlog.author}
Published: ${processedBlog.publishDate}
Category: ${processedBlog.category}
Tags: ${processedBlog.tags.join(", ")}
Word Count: ${processedBlog.wordCount}

BLOG CONTENT (HTML):
${processedBlog.content}

USER QUESTION:
${prompt}

Please provide a detailed answer based on the blog content above.`,
					},
				],
			},
		];

		console.log(`🤖 Processing question for blog: ${processedBlog.title}`);
		console.log(`📝 Question: ${prompt}`);

		const response = await genai.models.generateContent({
			model: "gemini-2.0-flash",
			contents: conversation,
			generationConfig: {
				maxOutputTokens: 2048,
				temperature: 0.3, // Lower temperature for more factual responses
			},
		});

		const answer = response.candidates[0].content.parts[0].text;

		console.log(`✅ Generated answer (${answer.length} characters)`);

		return c.json({
			success: true,
			response: answer,
			blogInfo: {
				title: processedBlog.title,
				author: processedBlog.author,
				wordCount: processedBlog.wordCount,
			},
			question: prompt,
		});
	} catch (error) {
		console.error("Error in chat-with-blog-content:", error);
		return c.json(
			{
				error: "Failed to process the question",
				details: error.message,
			},
			500
		);
	}
});

export default app;

serve({
	port: 3002,
	fetch: app.fetch,
});
