import { Hono } from "hono";
import { createServer } from "vite";
import { serve } from "@hono/node-server";
import { stream } from "hono/streaming";
import { firestore } from "./firebase.js";
import fs from "fs/promises";
import { GoogleGenAI } from "@google/genai";
import { CheerioCrawler } from "crawlee";
import { chromium } from "playwright";
import path from "path";
import dotenv from "dotenv";
import { aiWebSearchAgent } from "./ai-examples/ai-web-search-agent.js";

// Load environment variables
dotenv.config();

const genai = new GoogleGenAI({
	apiKey: process.env.GOOGLE_GENAI_API_KEY,
});

const app = new Hono();

app.use("/");

app.get("/health", (c) => {
	return c.text("Health check", 200);
});

app.get("/home", async (c) => {
	try {
		// Fetch blog posts from Firestore
		const postsSnapshot = await firestore
			.collection("publish")
			.orderBy("timeStamp", "desc")
			.get();
		const posts = [];

		postsSnapshot.docs.forEach(async (doc) => {
			posts.push({
				id: doc.id,
				...doc.data(),
			});
		});

		// Format timestamp (assuming it's a Firestore timestamp)
		const formatDate = (timestamp) => {
			if (!timestamp) return "Unknown date";
			const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
			return date.toLocaleDateString("en-US", {
				year: "numeric",
				month: "long",
				day: "numeric",
			});
		};

		const calculateReadingTime = (htmlContent) => {
			if (!htmlContent) return 0;
			// Remove HTML tags
			const text = htmlContent.replace(/<[^>]*>/g, " ");
			// Remove extra whitespace and split into words
			const words = text.trim().split(/\s+/);
			const wordsPerMinute = 200; // average reading speed
			const minutes = Math.ceil(words.length / wordsPerMinute);
			return isNaN(minutes) ? 0 : minutes;
		};

		const bloghtml = `
  <html>
  <script src="https://cdn.tailwindcss.com"></script>
  <body class="bg-gray-50 min-h-screen">
    <div class="container mx-auto px-4 py-8 max-w-7xl">
      <header class="mb-12">
        <h1 class="text-4xl font-bold text-gray-900 mb-2">Blog</h1>
        <p class="text-gray-600">Latest articles by <a href="https://ihatereading.in" class="text-zinc-600 hover:text-zinc-800 underline cursor-pointer font-medium" target="_blank">iHateReading.in</a></p>
      </header>
      
      <div class="space-y-2 grid grid-cols-1 md:grid-cols-1 lg:grid-cols-1 gap-4 justify-center items-start">
        ${posts
					.filter((item) => (item?.title?.length > 0 ? item : null))
					.map(
						(post) => `
          <article class="bg-white cursor-pointer max-w-4xl mx-auto rounded-xl shadow-md p-6 hover:shadow-lg transition-shadow my-4"  onClick="window.location.href='/t/${post?.title.replace(
						/\s+/g,
						"-"
					)}'">
            <header class="mb-4">
            
              <h2 class="text-2xl font-bold text-gray-900 mb-2 hover:text-zinc-600 transition-colors">
                ${post?.title || post?.name}
              </h2>
              <p class="text-gray-600 text-lg mb-3">
                ${post?.description || post?.htmlContent?.substring(0, 150)}
              </p>
              <div class="flex items-center text-sm text-gray-500 space-x-4">
                <span class="flex items-center">
                  <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                  </svg>
                  ${formatDate(post?.timeStamp)}
                </span>
                <span class="flex items-center">
                  <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                  </svg>
                  ${calculateReadingTime(post?.content)} min read
                </span>
              </div>
            </header>
            <footer class="mt-6 pt-4 border-t border-gray-200">
              <a href="/t/${post?.title.replace(
								/\s+/g,
								"-"
							)}" class="text-zinc-600 cursor-pointer hover:text-zinc-800 font-medium">
                Read blog →
              </a>
            </footer>
          </article>
        `
					)
					.join("")}
      </div>
    </div>
  </body>
  </html>
  `;
		return c.html(bloghtml);
	} catch (error) {
		console.error("Error fetching posts:", error);
		return c.text("Error loading blog posts", 500);
	}
});

app.get("/t/:slug", async (c) => {
	try {
		const slug = c.req.param("slug");

		// Convert slug back to title by replacing hyphens with spaces
		const title = slug.replace(/-/g, " ");

		// Fetch the specific blog post from Firestore
		const postsSnapshot = await firestore
			.collection("publish")
			.where("title", "==", title)
			.get();

		const post = {
			id: postsSnapshot.docs[0].id,
			...postsSnapshot.docs[0].data(),
		};

		// Format timestamp (assuming it's a Firestore timestamp)
		const formatDate = (timestamp) => {
			if (!timestamp) return "Unknown date";
			const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
			return date.toLocaleDateString("en-US", {
				year: "numeric",
				month: "long",
				day: "numeric",
			});
		};

		const calculateReadingTime = (htmlContent) => {
			if (!htmlContent) return 0;
			// Remove HTML tags
			const text = htmlContent.replace(/<[^>]*>/g, " ");
			// Remove extra whitespace and split into words
			const words = text.trim().split(/\s+/);
			const wordsPerMinute = 200; // average reading speed
			const minutes = Math.ceil(words.length / wordsPerMinute);
			return isNaN(minutes) ? 0 : minutes;
		};

		const blogPostHtml = `
  <html>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="/blog-styles.css" />
  <script>
    function copyToClipboard(text) {
      navigator.clipboard.writeText(text).then(function() {
        // Show a temporary success message
        const button = event.target.closest('button');
        const originalHTML = button.innerHTML;
        button.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>';
        button.classList.remove('text-gray-500', 'hover:text-green-600');
        button.classList.add('text-green-600');
        
        setTimeout(() => {
          button.innerHTML = originalHTML;
          button.classList.remove('text-green-600');
          button.classList.add('text-gray-500', 'hover:text-green-600');
        }, 2000);
      }).catch(function(err) {
        console.error('Could not copy text: ', err);
      });
    }
  </script>
  <body class="bg-gray-50 min-h-screen">
    <div class="container mx-auto px-4 py-8 max-w-4xl">
      <a href="/home" class="text-zinc-600 hover:text-zinc-800 font-medium inline-block">
        ← Back to Blog
      </a>
      <header class="mt-8 bg-white rounded-t-xl shadow-md px-8 pb-4 pt-8">
        <h1 class="text-2xl font-bold text-gray-900">${
					post?.title || post?.name
				}</h1>
        <p class="text-gray-600 text-lg mb-4">${post?.description || ""}</p>
        <div class="flex items-center justify-between">
          <div class="flex items-center text-sm text-gray-500 space-x-4">
            <span class="flex items-center">
              <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
              </svg>
              ${formatDate(post?.timeStamp)}
            </span>
            <span class="flex items-center">
              <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
              ${calculateReadingTime(post?.content)} min read
            </span>
          </div>
          
          <div class="flex items-center justify-start space-x-3">
            <!-- Twitter Icon -->
            <a href="https://twitter.com/intent/tweet?text=${encodeURIComponent(
							post?.title || post?.name
						)}&url=${encodeURIComponent(`http://localhost:3001/t/${slug}`)}" 
               target="_blank" 
               class="text-gray-500 hover:text-blue-400 transition-colors duration-200">
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M23.953 4.57a10 10 0 01-2.825.775 4.958 4.958 0 002.163-2.723c-.951.555-2.005.959-3.127 1.184a4.92 4.92 0 00-8.384 4.482C7.69 8.095 4.067 6.13 1.64 3.162a4.822 4.822 0 00-.666 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 01-2.228-.616v.06a4.923 4.923 0 003.946 4.827 4.996 4.996 0 01-2.212.085 4.936 4.936 0 004.604 3.417 9.867 9.867 0 01-6.102 2.105c-.39 0-.779-.023-1.17-.067a13.995 13.995 0 007.557 2.209c9.053 0 13.998-7.496 13.998-13.985 0-.21 0-.42-.015-.63A9.935 9.935 0 0024 4.59z"/>
              </svg>
            </a>
            
            <!-- LinkedIn Icon -->
            <a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
							`http://localhost:3001/t/${slug}`
						)}" 
               target="_blank" 
               class="text-gray-500 hover:text-blue-600 transition-colors duration-200">
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
              </svg>
            </a>
            
            <!-- Copy Link Icon -->
            <button onclick="copyToClipboard('http://localhost:3001/t/${slug}')" 
                    class="text-gray-500 hover:text-green-600 transition-colors duration-200">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
              </svg>
            </button>
          </div>
        </div>

      </header>
      
      <article class="bg-white rounded-b-xl shadow-md p-8">
        <div class="prose prose-lg max-w-none">
          ${post?.content || "Content not available"}
        </div>
      </article>
    </div>
  </body>
  </html>
  `;

		return c.html(blogPostHtml);
	} catch (error) {
		console.error("Error fetching blog post:", error);
		return c.text("Error loading blog post", 500);
	}
});

app.post("/checkout/", async (c) => {
	const { variantId, price } = await c.req.json();
	const response = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
		method: "POST",
		headers: {
			Accept: "application/vnd.api+json",
			"Content-Type": "application/vnd.api+json",
			Authorization: `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`,
		},
		body: JSON.stringify({
			data: {
				type: "checkouts",
				attributes: {
					store_id: process.env.LEMON_SQUEEZY_STORE_ID,
					variant_id: variantId,
					checkout_data: {
						custom: {
							user_id: "Shrey",
							price: price,
						},
					},
					product_options: {
						redirect_url: `http://localhost:3001/?subscription=true`,
					},
				},
				relationships: {
					store: {
						data: {
							type: "stores",
							id: process.env.LEMON_SQUEEZY_STORE_ID,
						},
					},
					variant: {
						data: {
							type: "variants",
							id: variantId,
						},
					},
				},
			},
		}),
	});

	const data = await response.json();
	return c.json({ link: data.data.attributes.url }, 200);
});

app.get("/store-scraped-data", async (c) => {
	const data = await firestore.collection("ScrapedData").get();
	const result = data.docs.map((item) => {
		return {
			id: item.id,
			...item.data(),
		};
	});
	const latestBlogs = result
		.map((item) => item.sources)
		.flat()
		.map((item) => item.latestBlogs)
		.flat();

	const remove = latestBlogs.filter(
		(item, index, self) => self.findIndex((t) => t.link === item.link) === index
	);

	Array.from({ length: Math.ceil(latestBlogs.length / 100) }).forEach(
		async (_, index) => {
			await firestore
				.collection("scraped-data")
				.doc(`latest-blogs-${index}`)
				.set({
					blogs: latestBlogs
						.slice(index * 100, (index + 1) * 100)
						.filter((item) => {
							if (item.pubDate.split(" ")[3] < "2024") return false;
							return true;
						}),
				});
		}
	);
	return c.json(latestBlogs);
});

// Function to post to Dev.to
app.post("/post-to-devto", async (c) => {
	try {
		const { title } = await c.req.json();
		if (!title) {
			c.status(400);
			return c.json({
				error: "Title is required",
			});
		}

		// Check if DEV_TO_API token is available
		if (!process.env.DEV_TO_API_TOKEN) {
			c.status(500);
			return c.json({
				error: "DEV_TO_API_TOKEN environment variable is not set",
			});
		}

		// Fetch the document from Firestore publish collection using the title
		const postsSnapshot = await firestore
			.collection("publish")
			.where("title", "==", title.replaceAll("-", " "))
			.get();

		if (postsSnapshot.empty) {
			c.status(404);
			return c.json({
				error: `No post found with title: ${title}`,
			});
		}

		const postDoc = postsSnapshot.docs[0];
		const postData = postDoc.data();

		// Validate required fields
		if (!postData.content && !postData.htmlContent) {
			return c.json(
				{
					success: false,
					error: "Post content is required (content or htmlContent field)",
				},
				400
			);
		}

		// Prepare the article data for Dev.to API
		const processedTags = (() => {
			// Handle tags properly for Dev.to API
			if (!Array.isArray(postData.tags) || postData.tags.length === 0) {
				return ["general"];
			}

			// Dev.to tags must be lowercase, only alphanumeric characters (no hyphens, spaces, or special chars)
			const cleanTags = postData.tags
				.slice(0, 4) // Dev.to allows max 4 tags
				.map((tag) => {
					// Convert to string and clean up
					let cleanTag = String(tag)
						.toLowerCase()
						.trim()
						// Remove ALL non-alphanumeric characters (including hyphens, spaces, underscores, etc.)
						.replace(/[^a-zA-Z0-9]/g, "")
						// Limit length (Dev.to has tag length limits)
						.substring(0, 30);

					return cleanTag;
				})
				.filter((tag) => tag.length > 0 && tag.length <= 30);

			// Ensure we have at least one valid tag
			return cleanTags.length > 0 ? cleanTags : ["general"];
		})();

		// Prepare content for Dev.to (they prefer markdown)
		let bodyContent = "";
		if (postData.content) {
			// If content exists, use it (assume it's markdown)
			bodyContent = postData.content;
		} else if (postData.htmlContent) {
			// If only HTML content exists, convert basic HTML to markdown
			bodyContent = postData.htmlContent
				.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n\n")
				.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n\n")
				.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n\n")
				.replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
				.replace(/<br\s*\/?>/gi, "\n")
				.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
				.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*")
				.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`")
				.replace(/<[^>]*>/g, "") // Remove any remaining HTML tags
				.replace(/\n\s*\n\s*\n/g, "\n\n") // Clean up excessive newlines
				.trim();
		}

		// Add footer with original publication link
		const footerText = `\n\n---\n\n*Originally published on [iHateReading](https://ihatereading.in/t/${encodeURIComponent(
			title.replace(/\s+/g, "-")
		)})*`;
		bodyContent += footerText;

		const articleData = {
			article: {
				title: postData.title || title,
				body_markdown: bodyContent,
				tags: processedTags,
				published: true,
				series: postData.series || null,
				canonical_url: postData.canonicalUrl || null,
				description: postData.description || "",
				cover_image: postData.coverImage || null,
				main_image: postData.mainImage || null,
			},
		};

		// Post to Dev.to API
		const devtoResponse = await fetch("https://dev.to/api/articles", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"api-key": process.env.DEV_TO_API_TOKEN,
			},
			body: JSON.stringify(articleData),
		});

		if (!devtoResponse.ok) {
			const errorData = await devtoResponse.text();
			console.error("Dev.to API error:", errorData);
			console.error("Response status:", devtoResponse.status);
			console.error(
				"Response headers:",
				Object.fromEntries(devtoResponse.headers.entries())
			);

			// Try to parse error for better error messages
			let errorMessage = "Failed to post to Dev.to";
			try {
				const parsedError = JSON.parse(errorData);
				if (parsedError.error) {
					errorMessage = `Dev.to API Error: ${parsedError.error}`;
				}
			} catch (e) {
				errorMessage = `Dev.to API Error (${devtoResponse.status}): ${errorData}`;
			}

			throw new Error(errorMessage);
		}

		const responseData = await devtoResponse.json();

		// Update Firestore document with Dev.to post information
		await firestore.collection("publish").doc(postDoc.id).update({
			devtoPostId: responseData.id,
			devtoUrl: responseData.url,
			devtoPublishedAt: new Date(),
			lastUpdated: new Date(),
		});

		return c.json({
			success: true,
			message: "Post published successfully to Dev.to",
			data: {
				devtoPostId: responseData.id,
				devtoUrl: responseData.url,
				title: responseData.title,
				publishedAt: responseData.published_at,
			},
		});
	} catch (error) {
		console.error("Error posting to Dev.to:", error);
		c.status = 500;
		return c.json({
			error: error.message,
		});
	}
});

app.post("/ai-generate-code", async (c) => {
	const { prompt } = await c.req.json();
	const response = await genai.models.generateContentStream({
		model: "gemini-2.0-flash-001",
		contents: [
			{
				role: "user",
				parts: [
					{
						text: prompt,
					},
				],
			},
		],
	});

	return stream(c, async (stream) => {
		for await (const chunk of response) {
			await stream.writeln(chunk.text);
		}
	});
});

app.post("/crawler", async (c) => {
	try {
		const { url } = await c.req.json();

		if (!url) {
			return c.json({ error: "URL is required" }, 400);
		}

		const crawler = new CheerioCrawler({
			async requestHandler({ request, $, log }) {
				log.info(request);
				try {
					const title = $("title").text();
					const url = request.url;

					const result = {
						title,
						url,
						timestamp: new Date().toISOString(),
					};
					log.info(result);
					// Save to dataset
					await dataset.pushData(result);
				} catch (error) {
					await dataset.pushData({
						title: "Error",
						description: error.message,
						image: null,
						url: request.url,
						error: true,
						timestamp: new Date().toISOString(),
					});
				}
			},

			maxRequestsPerCrawl: 1, // Only crawl the single URL
			requestHandlerTimeoutSecs: 30,
			maxRequestRetries: 2,
		});

		await crawler.run([{ url }]);

		return c.json({
			success: true,
			data: results.items,
			total: results.items.length,
		});
	} catch (error) {
		console.error("Crawler error:", error);
		return c.json(
			{
				success: false,
				error: error.message,
			},
			500
		);
	}
});

app.post("/ai-web-search-agent", async (c) => {
	const { prompt } = await c.req.json();
	const response = await aiWebSearchAgent(prompt);
	return c.json(response);
});

app.post("/any-crawl-website", async (c) => {
	const { url } = await c.req.json();

	const response = await fetch("https://api.anycrawl.dev/v1/scrape", {
		method: "POST",
		headers: {
			Authorization: "Bearer ac-861db0c0185872013363ec3af98c8",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			url,
		}),
	});
	const result = await response.json();
	console.log(result.data.markdown);
	return c.text(result.data.markdown);
});

app.post("/scrap-google-images", async (c) => {
	const { queries, options = {}, limit = 5 } = await c.req.json();

	// Handle both single query and array of queries
	const queryArray = Array.isArray(queries) ? queries : [queries];

	if (!queryArray.length || queryArray.some((q) => !q)) {
		return c.json({ error: "Invalid queries" }, 400);
	}

	let browser;
	try {
		const tbsParts = Object.entries(options)
			.map(([k, v]) => codeMap[k]?.[v])
			.filter(Boolean);
		const tbsQuery = tbsParts.length ? `&tbs=${tbsParts.join(",")}` : "";

		// Launch browser with proper configuration
		browser = await chromium.launch({
			headless: true,
			userAgent:
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-accelerated-2d-canvas",
				"--no-first-run",
				"--no-zygote",
				"--single-process",
				"--disable-gpu",
			],
		});

		// Create a shared context for all queries
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

		// Block unnecessary resources
		await context.route("**/*", (route) => {
			const type = route.request().resourceType();
			return ["font", "stylesheet"].includes(type)
				? route.abort()
				: route.continue();
		});

		// Process all queries in parallel using Promise.all
		const results = await Promise.all(
			queryArray.map(async (query) => {
				const page = await context.newPage();
				try {
					await page.goto(
						`https://www.google.com/search?q=${encodeURIComponent(
							query
						)}&tbm=isch${tbsQuery}`,
						{
							waitUntil: "networkidle",
						}
					);
					await page.waitForSelector('img[src^="https"]');
					await page.evaluate(() =>
						window.scrollTo(0, document.body.scrollHeight)
					);
					await page.waitForTimeout(2000);

					const images = await page.evaluate(
						(max) =>
							Array.from(document.querySelectorAll('img[src^="https"]'))
								.map((img) => ({
									url: img.src,
									w: img.naturalWidth,
									h: img.naturalHeight,
									...img,
								}))
								.filter((i) => i.w > 100 && i.h > 100)
								.slice(0, max)
								.map((i) => i.url),
						limit
					);

					return { query, images };
				} catch (error) {
					console.error(`Error processing query "${query}":`, error);
					return {
						query,
						images: [],
						error: error.message,
					};
				} finally {
					await page.close();
				}
			})
		);

		// Close the shared context after all queries are complete
		await context.close();

		// If single query was provided, return just the images array
		if (!Array.isArray(queries)) {
			const result = results[0];
			if (!result.images.length) {
				return c.json({
					error: "No images found",
					data: result,
				});
			}
			return c.json(result.images);
		}

		// For multiple queries, return array of results
		return c.json(results);
	} catch (error) {
		console.error("Error scraping Google Images:", error);
		return c.json({
			error: "Failed to fetch images",
			details: error.message,
		});
	} finally {
		if (browser) {
			await browser.close();
		}
	}
});

app.post("/find-latest-jobs", async (c) => {
	const { query } = await c.req.json();
	const urlEncodedQuery = encodeURIComponent(query);
	const apiUrl = `https://jsearch.p.rapidapi.com/search?query=${urlEncodedQuery}&page=1&num_pages=1&date_posted=all`;

	const response = await fetch(apiUrl, {
		method: "GET",
		headers: {
			"x-rapidapi-host": "jsearch.p.rapidapi.com",
			"x-rapidapi-key": "eIy5QzLhLAmshwdt2uWvSf1qt2FKp1WsxBfjsnW4MYd6YpicwO",
		},
	});

	if (!response.ok) {
		return c.json(
			{
				success: false,
				error: `API error: ${response.status} ${response.statusText}`,
			},
			500
		);
	}

	const data = await response.json();
	return c.json({
		success: true,
		data,
	});
});

// Custom Google Search Agent using Playwright
app.post("/google-search", async (c) => {
	const {
		query,
		limit = 5,
		config = {
			blockAds: true,
			storeInCache: true,
			timeout: 30000,
			userAgent:
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
		},
	} = await c.req.json();

	if (!query) {
		return c.json({ error: "Query is required" }, 400);
	}

	let browser;

	try {
		// Launch browser with proper configuration
		browser = await chromium.launch({
			headless: true,
			userAgent: config.userAgent,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-accelerated-2d-canvas",
				"--no-first-run",
				"--no-zygote",
				"--single-process",
				"--disable-gpu",
				"--disable-web-security",
				"--disable-features=VizDisplayCompositor",
			],
		});

		let searchResults;
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

		// Block unnecessary resources
		await context.route("**/*", (route) => {
			const type = route.request().resourceType();
			return ["font", "stylesheet"].includes(type)
				? route.abort()
				: route.continue();
		});

		// Search Google using undici HTTP client for better stealth
		try {
			const { request } = await import("undici");

			// Random user agent rotation
			const userAgents = [
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
			];
			const selectedUserAgent =
				userAgents[Math.floor(Math.random() * userAgents.length)];

			// Random delay to mimic human behavior
			await new Promise((resolve) =>
				setTimeout(resolve, Math.random() * 3000 + 1000)
			);

			// Build Google search URL with additional parameters for better results
			const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(
				query
			)}&num=${limit}&hl=en&gl=us&source=hp&ie=UTF-8&oe=UTF-8`;

			// Prepare headers to look like a real browser
			const headers = {
				"User-Agent": selectedUserAgent,
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Accept-Encoding": "gzip, deflate, br",
				DNT: "1",
				Connection: "keep-alive",
				"Upgrade-Insecure-Requests": "1",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Cache-Control": "max-age=0",
			};

			// Make the request using undici
			const response = await request(searchUrl, {
				method: "GET",
				headers,
				bodyTimeout: config.timeout,
				headersTimeout: config.timeout,
			});

			// Check if we got blocked
			if (response.statusCode === 403 || response.statusCode === 429) {
				console.warn(
					"⚠️ Google blocked the request - HTTP status:",
					response.statusCode
				);
				searchResults = {
					error: `Google blocked the request (HTTP ${response.statusCode}). Try again later or use a different IP.`,
					blocked: true,
					statusCode: response.statusCode,
					suggestion: "Consider using a proxy or waiting before retrying",
				};
				return;
			}

			if (response.statusCode !== 200) {
				console.warn(
					"⚠️ Unexpected response from Google:",
					response.statusCode
				);
				searchResults = {
					error: `Unexpected response from Google (HTTP ${response.statusCode})`,
					statusCode: response.statusCode,
				};
				return;
			}

			// Get the HTML content
			const htmlContent = await response.body.text();

			// Check for anti-bot content
			if (
				htmlContent.includes("unusual traffic") ||
				htmlContent.includes("Terms of Service") ||
				htmlContent.includes("Sorry") ||
				htmlContent.includes("captcha")
			) {
				console.warn("⚠️ Google detected automated access");
				searchResults = {
					error:
						"Google detected automated access. Try again later or use a different IP.",
					blocked: true,
					suggestion: "Consider using a proxy or waiting before retrying",
				};
				return;
			}

			// Parse HTML and extract search results
			const { JSDOM } = await import("jsdom");
			const dom = new JSDOM(htmlContent);
			const document = dom.window.document;

			// Extract search results using multiple selectors
			const results = [];
			const selectors = [
				".g a[href]", // Standard Google results
				"[data-ved] a[href]", // Alternative selector
				".yuRUbf a[href]", // Another common selector
				'a[href*="http"]:not([href*="google.com"])', // Fallback
			];

			let links = [];
			for (const selector of selectors) {
				links = document.querySelectorAll(selector);
				if (links.length > 0) break;
			}

			links.forEach((link, index) => {
				if (results.length >= limit) return;

				const url = link.href;
				const title = link.textContent.trim();

				// Skip Google's own pages and obvious non-results
				if (
					url.includes("google.com") ||
					url.includes("youtube.com") ||
					url.includes("maps.google") ||
					title.length < 5 ||
					title.length > 200 ||
					title.toLowerCase().includes("sign in") ||
					title.toLowerCase().includes("terms") ||
					title.toLowerCase().includes("privacy") ||
					title.toLowerCase().includes("sorry")
				) {
					return;
				}

				// Extract domain
				let domain = "";
				try {
					domain = new URL(url).hostname.replace("www.", "");
				} catch (e) {
					domain = "";
				}

				// Try to extract a snippet from nearby elements
				let snippet = "";
				const parent = link.closest("div");
				if (parent) {
					const snippetEl = parent.querySelector(".s, .st, span, div");
					if (snippetEl && snippetEl !== link) {
						snippet = snippetEl.textContent.trim().substring(0, 200);
					}
				}

				results.push({
					title,
					url,
					snippet,
					domain,
					position: results.length + 1,
				});
			});

			if (results.length === 0) {
				console.warn(
					"⚠️ No search results found - possible detection or no results"
				);
				searchResults = {
					error:
						"No search results found. Google may have blocked the request.",
					noResults: true,
					suggestion: "Try a different query or wait before retrying",
				};
			} else {
				console.log(`✅ Found ${results.length} search results using undici`);
				searchResults = results;
			}
		} catch (error) {
			console.error("Google search error with undici:", error);
			searchResults = { error: error.message };
		}

		await context.close();

		return c.json({
			success: true,
			query,
			results: searchResults,
			total: searchResults.length,
			config: {
				blockAds: config.blockAds,
				storeInCache: config.storeInCache,
				timeout: config.timeout,
			},
		});
	} catch (error) {
		console.error("❌ Google search error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to perform Google search",
				details: error.message,
			},
			500
		);
	} finally {
		if (browser) {
			await browser.close();
		}
	}
});

// Enhanced Google Search with multiple search engines
app.post("/multi-search", async (c) => {
	const {
		query,
		engines = ["google", "bing", "yahoo"],
		limit = 5,
		config = {
			blockAds: true,
			storeInCache: true,
			timeout: 30000,
		},
	} = await c.req.json();

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

		return c.json({
			success: true,
			query,
			results: allResults,
			engines,
			config,
		});
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
});

// Dedicated Bing Search endpoint using Playwright (like multi-search)
app.post("/bing-search", async (c) => {
	const {
		query,
		limit = 5,
		config = {
			timeout: 30000,
		},
	} = await c.req.json();

	if (!query) {
		return c.json({ error: "Query is required" }, 400);
	}

	let searchResults;
	let browser;

	try {
		// Use Playwright like multi-search for JavaScript rendering
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
				referer: "https://www.bing.com/",
				"accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
			},
		});

		const page = await context.newPage();

		// Navigate to Bing search
		await page.goto(
			`https://www.bing.com/search?q=${encodeURIComponent(
				query
			)}&count=${limit}`,
			{
				waitUntil: "networkidle",
				timeout: config.timeout,
			}
		);

		// Wait for search results to load (like multi-search does)
		await page.waitForTimeout(1000);

		// Extract search results using the same method as multi-search
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
						snippet: snippetElement ? snippetElement.textContent.trim() : "",
						position: index + 1,
					});
				}
			});

			return results;
		}, limit);

		// Process results and add domain extraction
		const results = bingResults.map((result, index) => {
			let domain = "";
			try {
				domain = new URL(result.url).hostname.replace("www.", "");
			} catch (e) {
				domain = "";
			}

			return {
				...result,
				domain,
				position: index + 1,
			};
		});

		if (results.length === 0) {
			console.warn(
				"⚠️ No Bing search results found - possible detection or no results"
			);
			searchResults = {
				error: "No search results found. Bing may have blocked the request.",
				noResults: true,
				suggestion: "Try a different query or wait before retrying",
			};
		} else {
			console.log(
				`✅ Found ${results.length} Bing search results using Playwright`
			);
			searchResults = results;
		}

		await page.close();
		await context.close();
	} catch (error) {
		console.error("Bing search error with Playwright:", error);
		searchResults = { error: error.message };
	} finally {
		if (browser) {
			await browser.close();
		}
	}

	return c.json({
		success: true,
		query,
		results: searchResults,
		total: Array.isArray(searchResults) ? searchResults.length : 0,
		engine: "bing",
		config: {
			timeout: config.timeout,
		},
	});
});

// Web Scraping API - Scrape any URL content
app.post("/scrape-url", async (c) => {
	const {
		url,
		selectors = {}, // Custom selectors for specific elements
		waitForSelector = null, // Wait for specific element to load
		timeout = 30000,
		includeImages = false,
		includeLinks = false,
		extractMetadata = true,
	} = await c.req.json();

	if (!url) {
		return c.json({ error: "URL is required" }, 400);
	}

	let browser;
	let scrapedData = {};

	try {
		// Launch browser with anti-detection settings
		browser = await chromium.launch({
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
				"--disable-web-security",
				"--disable-features=VizDisplayCompositor",
			],
		});

		const context = await browser.newContext({
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			viewport: { width: 1920, height: 1080 },
			extraHTTPHeaders: {
				dnt: "1",
				"upgrade-insecure-requests": "1",
				accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
				"sec-fetch-site": "none",
				"sec-fetch-mode": "navigate",
				"sec-fetch-user": "?1",
				"sec-fetch-dest": "document",
				"accept-language": "en-US,en;q=0.9",
			},
		});

		const page = await context.newPage();

		// Block unnecessary resources for faster loading
		await page.route("**/*", (route) => {
			const type = route.request().resourceType();
			if (["font", "stylesheet", "image"].includes(type) && !includeImages) {
				return route.abort();
			}
			return route.continue();
		});

		// Navigate to URL
		await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: timeout,
		});

		// Wait for specific selector if provided
		if (waitForSelector) {
			try {
				await page.waitForSelector(waitForSelector, { timeout: 10000 });
			} catch (error) {
				console.warn(`Selector ${waitForSelector} not found within timeout`);
			}
		}

		// Wait a bit for dynamic content to load
		await page.waitForTimeout(2000);

		// Extract page content
		scrapedData = await page.evaluate(
			(options) => {
				const data = {
					url: window.location.href,
					title: document.title,
					timestamp: new Date().toISOString(),
					content: {},
					metadata: {},
					links: [],
					images: [],
				};

				["h1", "h2", "h3", "h4", "h5", "h6"].forEach((tag) => {
					data.content[tag] = Array.from(document.querySelectorAll(tag)).map(
						(h) => h.textContent.trim()
					);
				});

				// Extract metadata
				if (options.extractMetadata) {
					// Meta tags
					const metaTags = document.querySelectorAll("meta");
					metaTags.forEach((meta) => {
						const name =
							meta.getAttribute("name") || meta.getAttribute("property");
						const content = meta.getAttribute("content");
						if (name && content) {
							data.metadata[name] = content;
						}
					});

					// Open Graph tags
					const ogTags = document.querySelectorAll('meta[property^="og:"]');
					ogTags.forEach((meta) => {
						const property = meta.getAttribute("property");
						const content = meta.getAttribute("content");
						if (property && content) {
							data.metadata[property] = content;
						}
					});

					// Twitter Card tags
					const twitterTags = document.querySelectorAll(
						'meta[name^="twitter:"]'
					);
					twitterTags.forEach((meta) => {
						const name = meta.getAttribute("name");
						const content = meta.getAttribute("content");
						if (name && content) {
							data.metadata[name] = content;
						}
					});
				}

				// Extract links
				const links = document.querySelectorAll("a");
				const rawLinks = Array.from(links).map((link) => ({
					text: link.textContent.trim(),
					href: link.href,
					title: link.getAttribute("title") || "",
				}));

				// Remove duplicate links based on text, href, or title
				const seenLinks = new Set();
				data.links = rawLinks.filter((link) => {
					const key = `${link.text}|${link.href}|${link.title}`;
					if (seenLinks.has(key)) return false;
					seenLinks.add(key);
					return true;
				});

				// Extract semantic content with optimized methods
				const extractSemanticContent = (
					selector,
					processor = (el) => el.textContent.trim()
				) => {
					const elements = document.querySelectorAll(selector);
					return elements.length > 0 ? Array.from(elements).map(processor) : [];
				};

				const extractTableContent = (table) => {
					const rows = Array.from(table.querySelectorAll("tr"));
					return rows
						.map((row) => {
							const cells = Array.from(row.querySelectorAll("td, th")).map(
								(cell) => cell.textContent.trim()
							);
							return cells.filter((cell) => cell.length > 0);
						})
						.filter((row) => row.length > 0);
				};

				const extractListContent = (list) => {
					return Array.from(list.querySelectorAll("li"))
						.map((li) => li.textContent.trim())
						.filter((item) => item.length > 0);
				};

				// Add semantic content to data.content structure
				const rawSemanticContent = {
					paragraphs: extractSemanticContent("p"),
					divs: extractSemanticContent("div", (el) =>
						el.textContent.trim().substring(0, 200)
					),
					tables: extractSemanticContent("table", extractTableContent),
					blockquotes: extractSemanticContent("blockquote"),
					preformatted: extractSemanticContent("pre"),
					unorderedLists: extractSemanticContent("ul", extractListContent),
					orderedLists: extractSemanticContent("ol", extractListContent),
					codeBlocks: extractSemanticContent("code"),
					articleSections: extractSemanticContent("article"),
					sectionContent: extractSemanticContent("section"),
					asideContent: extractSemanticContent("aside"),
					mainContent: extractSemanticContent("main"),
					headerContent: extractSemanticContent("header"),
					footerContent: extractSemanticContent("footer"),
					navContent: extractSemanticContent("nav"),
					formContent: extractSemanticContent("form"),
					fieldsetContent: extractSemanticContent("fieldset"),
					labelContent: extractSemanticContent("label"),
					spanContent: extractSemanticContent("span", (el) =>
						el.textContent.trim().substring(0, 100)
					),
					strongContent: extractSemanticContent("strong"),
					emContent: extractSemanticContent("em"),
					markContent: extractSemanticContent("mark"),
					smallContent: extractSemanticContent("small"),
					citeContent: extractSemanticContent("cite"),
					timeContent: extractSemanticContent("time"),
					addressContent: extractSemanticContent("address"),
					detailsContent: extractSemanticContent("details"),
					summaryContent: extractSemanticContent("summary"),
					figureContent: extractSemanticContent("figure"),
					figcaptionContent: extractSemanticContent("figcaption"),
					dlContent: extractSemanticContent("dl", (el) => {
						const dts = Array.from(el.querySelectorAll("dt")).map((dt) =>
							dt.textContent.trim()
						);
						const dds = Array.from(el.querySelectorAll("dd")).map((dd) =>
							dd.textContent.trim()
						);
						return { terms: dts, definitions: dds };
					}),
				};

				// Remove duplicates from semantic content
				const removeDuplicates = (array) => {
					if (!Array.isArray(array)) return array;
					const seen = new Set();
					return array.filter((item) => {
						if (typeof item === "string") {
							const normalized = item.toLowerCase().trim();
							if (seen.has(normalized)) return false;
							seen.add(normalized);
							return true;
						} else if (typeof item === "object" && item !== null) {
							// Handle complex objects like tables and definition lists
							const key = JSON.stringify(item);
							if (seen.has(key)) return false;
							seen.add(key);
							return true;
						}
						return true;
					});
				};

				// Apply duplicate removal to all semantic content
				data.content.semanticContent = Object.fromEntries(
					Object.entries(rawSemanticContent).map(([key, value]) => [
						key,
						removeDuplicates(value),
					])
				);

				// Extract images
				if (options.includeImages) {
					const images = document.querySelectorAll("img[src]");
					data.images = Array.from(images).map((img) => ({
						src: img.src,
						alt: img.alt || "",
						title: img.title || "",
						width: img.naturalWidth || img.width,
						height: img.naturalHeight || img.height,
					}));
				}

				// Extract custom selectors if provided
				if (options.selectors && Object.keys(options.selectors).length > 0) {
					data.customSelectors = {};
					for (const [key, selector] of Object.entries(options.selectors)) {
						try {
							const elements = document.querySelectorAll(selector);
							if (elements.length === 1) {
								data.customSelectors[key] = elements[0].textContent.trim();
							} else if (elements.length > 1) {
								data.customSelectors[key] = Array.from(elements).map((el) =>
									el.textContent.trim()
								);
							}
						} catch (error) {
							data.customSelectors[key] = null;
						}
					}
				}

				return data;
			},
			{ extractMetadata, includeImages, includeLinks, selectors }
		);

		// Add page info
		scrapedData.pageInfo = {
			url: url,
			scrapedAt: new Date().toISOString(),
			userAgent: await page.evaluate(() => navigator.userAgent),
			viewport: await page.viewportSize(),
		};

		await page.close();
		await context.close();

		return c.json({
			success: true,
			data: scrapedData,
			url: url,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error("❌ Web scraping error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to scrape URL",
				details: error.message,
				url: url,
			},
			500
		);
	} finally {
		if (browser) {
			await browser.close();
		}
	}
});

// Store active development servers
const activeServers = new Map();
const projectSessions = new Map();

// Generate unique project ID
const generateProjectId = () => {
	return `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

// Create or update a Vite project and store in Firebase Firestore
app.post("/create-project", async (c) => {
	try {
		const {
			files,
			projectId = null,
			projectName = null,
			description = null,
			tags = [],
		} = await c.req.json();

		if (!files || !Array.isArray(files)) {
			return c.json({ success: false, error: "Files array is required" }, 400);
		}

		const id = projectId || generateProjectId();
		const projectPath = path.join(process.cwd(), "gettemplates-projects", id);

		// Check if project already exists in Firestore
		let existingProject = null;
		if (projectId) {
			try {
				const projectDoc = await firestore
					.collection("gettemplate-projects")
					.doc(id)
					.get();

				if (projectDoc.exists) {
					existingProject = projectDoc.data();
					console.log(`📝 Updating existing project: ${id}`);
				}
			} catch (error) {
				console.log(`❌ Error checking existing project: ${error.message}`);
			}
		}

		// Create project directory
		await fs.mkdir(projectPath, { recursive: true });

		// Filter out node_modules and other unwanted files
		const filteredFiles = files.filter((file) => {
			const path = file.path.toLowerCase();
			return (
				!path.includes("node_modules") &&
				!path.includes(".git") &&
				!path.includes(".env") &&
				!path.includes(".DS_Store") &&
				!path.includes("package-lock.json") &&
				!path.includes("yarn.lock")
			);
		});

		// Write all filtered files
		for (const file of filteredFiles) {
			const filePath = path.join(projectPath, file.path);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, file.content);
		}

		// Extract project name from package.json if available
		let extractedProjectName = projectName;
		const packageJsonFile = filteredFiles.find(
			(f) => f.path === "package.json"
		);
		if (packageJsonFile && !projectName) {
			try {
				const packageJson = JSON.parse(packageJsonFile.content);
				extractedProjectName = packageJson.name || `project-${id}`;
			} catch (e) {
				extractedProjectName = `project-${id}`;
			}
		}

		// Create package.json if it doesn't exist
		const packageJsonPath = path.join(projectPath, "package.json");
		if (!filteredFiles.find((f) => f.path === "package.json")) {
			const defaultPackageJson = {
				name: extractedProjectName,
				private: true,
				version: "0.0.0",
				type: "module",
				scripts: {
					dev: "vite",
					build: "vite build",
					preview: "vite preview",
				},
				dependencies: {
					react: "^18.2.0",
					"react-dom": "^18.2.0",
				},
				devDependencies: {
					"@types/react": "^18.2.43",
					"@types/react-dom": "^18.2.17",
					"@vitejs/plugin-react": "^4.2.1",
					vite: "^5.0.8",
				},
			};
			await fs.writeFile(
				packageJsonPath,
				JSON.stringify(defaultPackageJson, null, 2)
			);

			// Add to filtered files for Firestore
			filteredFiles.push({
				path: "package.json",
				content: JSON.stringify(defaultPackageJson, null, 2),
			});
		}

		// Create vite.config.js if it doesn't exist
		const viteConfigPath = path.join(projectPath, "vite.config.js");
		if (!filteredFiles.find((f) => f.path === "vite.config.js")) {
			const defaultViteConfig = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 0, // Let Vite choose a random port
    host: '0.0.0.0'
  }
})`;
			await fs.writeFile(viteConfigPath, defaultViteConfig);

			// Add to filtered files for Firestore
			filteredFiles.push({
				path: "vite.config.js",
				content: defaultViteConfig,
			});
		}

		// Calculate project statistics
		const fileTypes = {};
		let totalLines = 0;
		filteredFiles.forEach((file) => {
			const extension = file.path.split(".").pop() || "no-extension";
			fileTypes[extension] = (fileTypes[extension] || 0) + 1;
			totalLines += file.content.split("\n").length;
		});

		// Store project in Firebase Firestore with metadata
		const projectMetadata = {
			projectId: id,
			projectName: extractedProjectName,
			description: description || `Project: ${extractedProjectName}`,
			tags: tags || [],
			files: filteredFiles,
			fileCount: filteredFiles.length,
			fileTypes: fileTypes,
			totalLines: totalLines,
			lastUpdated: new Date(),
			status: existingProject ? "updated" : "created",
			framework: "vite-react",
			version: "1.0.0",
		};

		// Preserve original creation date if updating existing project
		if (existingProject) {
			projectMetadata.createdAt = existingProject.createdAt;
			projectMetadata.previewUrl = existingProject.previewUrl;
			projectMetadata.deployedAt = existingProject.deployedAt;
		} else {
			projectMetadata.createdAt = new Date();
		}
		const action = existingProject ? "updated" : "created";

		await firestore
			.collection("gettemplate-projects")
			.doc(id)
			.set(projectMetadata);

		// Store project session
		projectSessions.set(id, {
			path: projectPath,
			files: filteredFiles,
			createdAt: new Date(),
			lastUpdated: new Date(),
		});

		return c.json({
			success: true,
			projectId: id,
			projectName: extractedProjectName,
			firestoreId: id,
			isUpdate: !!existingProject,
			metadata: {
				fileCount: filteredFiles.length,
				fileTypes: Object.keys(fileTypes),
				totalLines,
			},
			message: existingProject
				? "Project updated successfully in Firestore"
				: "Project created successfully and stored in Firestore",
		});
	} catch (error) {
		console.error("❌ Create project error:", error);
		return c.json({ success: false, error: error.message }, 500);
	}
});

// Start development server and deploy from Firestore
app.post("/start-dev-server", async (c) => {
	try {
		const { projectId } = await c.req.json();

		if (!projectId) {
			return c.json({ success: false, error: "Project ID is required" }, 400);
		}
		if (activeServers.has(projectId)) {
			return c.json({
				success: true,
				previewUrl: activeServers.get(projectId).url,
			});
		}

		// Get project from Firestore
		const projectDoc = await firestore
			.collection("gettemplate-projects")
			.doc(projectId)
			.get();

		if (!projectDoc.exists) {
			return c.json(
				{ success: false, error: "Project not found in Firestore" },
				404
			);
		}

		const projectData = projectDoc.data();
		// Update project status to building
		// await firestore.collection("gettemplate-projects").doc(projectId).update({
		// 	buildStatus: "pending",
		// 	lastBuildStarted: new Date(),
		// });

		// Create temporary directory for building
		const tempProjectPath = path.join(process.cwd(), "temp", projectId);
		await fs.mkdir(tempProjectPath, { recursive: true });

		// Write all files from Firestore to temporary directory
		for (const file of projectData.files) {
			const filePath = path.join(tempProjectPath, file.path);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, file.content);
		}

		console.log(`✅ Wrote ${projectData.files.length} files to temp directory`);

		const server = await createServer({
			root: tempProjectPath,
			server: {
				middlewareMode: true,
				strictPort: true,
			},
			appType: "custom", // or 'custom' for full control
			clearScreen: false,
			logLevel: "info",
			configFile: false,
		});

		console.log(server, "server");
		activeServers.set(projectId, { server });

		await firestore.collection("gettemplate-projects").doc(projectId).update({
			buildStatus: "ready",
			lastBuildCompleted: new Date(),
		});

		return c.json({
			success: true,
			buildStatus: "ready",
			message: "Preview ready",
		});
	} catch (error) {
		console.error("❌ Vite build error:", error);
		return c.json({ success: false, error: error.message }, 500);
	}
});

// Middleware to serve preview content by proxying to Vite dev server
app.get("/preview/:projectId/*", async (c) => {
	const { projectId } = c.req.param();
	const path = c.req.param("*") || "";

	try {
		// Get project from Firestore to get preview URL
		const projectDoc = await firestore
			.collection("gettemplate-projects")
			.doc(projectId)
			.get();

		if (!projectDoc.exists) {
			return c.text("Project not found", 404);
		}

		const projectData = projectDoc.data();
		if (!projectData.previewUrl || projectData.buildStatus !== "ready") {
			return c.text("Preview not ready. Please build the project first.", 404);
		}

		// Proxy request to Vite dev server
		const targetUrl = `${projectData.previewUrl}/${path}`;

		// Get headers safely
		const requestHeaders = {};
		for (const [key, value] of Object.entries(c.req.header())) {
			requestHeaders[key] = value;
		}

		const response = await fetch(targetUrl, {
			method: c.req.method,
			headers: {
				...requestHeaders,
				host: new URL(projectData.previewUrl).host,
			},
		});

		// Forward the response
		const responseHeaders = new Headers();
		response.headers.forEach((value, key) => {
			responseHeaders.set(key, value);
		});

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders,
		});
	} catch (error) {
		console.error("Preview proxy error:", error);
		return c.text("Preview server error", 500);
	}
});

// Root preview route (redirect to index.html)
app.get("/preview/:projectId", async (c) => {
	const { projectId } = c.req.param();
	return c.redirect(`/preview/${projectId}/`);
});

// Check preview status
app.get("/preview-status/:projectId", async (c) => {
	const { projectId } = c.req.param();

	try {
		const projectDoc = await firestore
			.collection("gettemplate-projects")
			.doc(projectId)
			.get();

		if (!projectDoc.exists) {
			return c.json({ success: false, error: "Project not found" }, 404);
		}

		const projectData = projectDoc.data();
		return c.json({
			success: true,
			projectId,
			buildStatus: projectData.buildStatus || "not_started",
			previewUrl: projectData.previewUrl || null,
			previewReady:
				projectData.buildStatus === "ready" && projectData.previewUrl,
			lastBuildCompleted: projectData.lastBuildCompleted || null,
		});
	} catch (error) {
		console.error("Preview status error:", error);
		return c.json({ success: false, error: error.message }, 500);
	}
});

// Build and deploy project for production preview using Firebase Firestore
app.post("/deploy-project", async (c) => {
	try {
		const { projectId } = await c.req.json();

		if (!projectId) {
			return c.json({ success: false, error: "Project ID is required" }, 400);
		}

		// Get project from Firestore
		const projectDoc = await firestore
			.collection("gettemplate-projects")
			.doc(projectId)
			.get();
		if (!projectDoc.exists) {
			return c.json(
				{ success: false, error: "Project not found in Firestore" },
				404
			);
		}
		const files = projectDoc.data().files;
		const tempDir = path.join(
			process.cwd(),
			"temp",
			`${projectId}-${Date.now()}`
		);
		await fs.mkdir(tempDir, { recursive: true });
		for (const file of files) {
			const filePath = path.join(tempDir, file.path);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, file.content);
		}

		await execPromise(`cd ${tempDir} && npm install && npm run build`);

		// 5️⃣ Serve or Upload dist/
		const distPath = path.join(tempDir, "dist");
		const publicUrl = await uploadToStorage(distPath);

		// Generate deployment ID
		const deployedId = `deploy_${Date.now()}_${Math.random()
			.toString(36)
			.substr(2, 9)}`;

		// Update Firestore with deployment info
		await firestore.collection("gettemplate-projects").doc(projectId).update({
			demoUrl: publicUrl,
			deployedId: deployedId,
			lastDeployed: new Date(),
			lastCommitted: new Date(),
			status: "deployed",
		});

		return c.json({
			success: true,
			demoUrl: publicUrl,
			deployedId: deployedId,
			projectName: projectData.projectName,
			message: "Project built and deployed to cloud storage successfully",
		});
	} catch (error) {
		console.error("❌ Deploy project error:", error);
		return c.json({ success: false, error: error.message }, 500);
	}
});

// Get project status
app.get("/project-status/:projectId", async (c) => {
	try {
		const projectId = c.req.param("projectId");

		// Get project from Firestore
		const projectDoc = await firestore
			.collection("gettemplate-projects")
			.doc(projectId)
			.get();

		if (!projectDoc.exists) {
			return c.json(
				{ success: false, error: "Project not found in Firestore" },
				404
			);
		}

		const projectData = projectDoc.data();

		// Check if dev server is running
		const devServer = activeServers.get(projectId);
		const previewServer = activeServers.get(`${projectId}_preview`);

		return c.json({
			success: true,
			projectId,
			projectName: projectData.projectName,
			buildStatus: projectData.buildStatus || "not_started",
			previewUrl: projectData.previewUrl || null,
			buildError: projectData.buildError || null,
			lastBuildStarted: projectData.lastBuildStarted || null,
			lastBuildCompleted: projectData.lastBuildCompleted || null,
			devServer: devServer
				? { url: devServer.url, pid: devServer.process.pid }
				: null,
			previewServer: previewServer
				? { url: previewServer.url, pid: previewServer.process.pid }
				: null,
		});
	} catch (error) {
		console.error("❌ Get project status error:", error);
		return c.json({ success: false, error: error.message }, 500);
	}
});

// Cleanup function to stop all servers on shutdown
const cleanup = () => {
	console.log("🛑 Shutting down servers...");
	for (const [key, server] of activeServers) {
		console.log(`Stopping server: ${key}`);
		server.process.kill("SIGTERM");
	}
	activeServers.clear();
	process.exit(0);
};

// Handle graceful shutdown
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// Start the server (only for local development)
if (process.env.NODE_ENV !== 'production') {
	const port = 3001;
	console.log(`Server is running on port ${port}`);
	serve({
		fetch: app.fetch,
		port,
	});
}

// Export for Vercel
export default app;
