/**
 * Inkgest Agent — agentic task execution using /scrape and /scrape-multiple.
 * One LLM router + extensible skills: newsletter, scrape, table, blog, substack, linkedin, twitter, article.
 */

import { loadSkills } from "../ai-examples/simba-ui-ux/skills/loadSkills.js";

const URL_REGEX = /https?:\/\/[^\s\)\]"'\<\>]+/gi;
const MAX_URLS = 10;

/** YouTube URL patterns: youtube.com, youtu.be, youtube.com/shorts */
const YOUTUBE_URL_REGEX =
	/https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]+/gi;

/** Check if a URL is a YouTube video URL */
function isYoutubeUrl(url) {
	if (!url || typeof url !== "string") return false;
	return /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)/i.test(url);
}

/** Check if a URL is a Reddit URL */
function isRedditUrl(url) {
	if (!url || typeof url !== "string") return false;
	return /reddit\.com/i.test(url);
}

/** Extract YouTube URLs from text */
function extractYoutubeUrlsFromText(text) {
	if (!text || typeof text !== "string") return [];
	const matches = text.match(YOUTUBE_URL_REGEX) || [];
	return [...new Set(matches.map((u) => u.replace(/[.,;:!?]+$/, "")))].slice(
		0,
		MAX_URLS,
	);
}

/** Extract URLs from text (regex, no LLM) */
function extractUrlsFromText(text) {
	if (!text || typeof text !== "string") return [];
	const matches = text.match(URL_REGEX) || [];
	return [...new Set(matches.map((u) => u.replace(/[.,;:!?]+$/, "")))].slice(
		0,
		MAX_URLS,
	);
}

/** Unique http(s) URLs from task list (params.urls and params.url). */
export function collectHttpUrlsFromTasks(tasks) {
	if (!Array.isArray(tasks)) return [];
	const out = [];
	for (const t of tasks) {
		const p = t?.params || {};
		const multi = Array.isArray(p.urls) ? p.urls : [];
		for (const u of multi) {
			if (typeof u === "string" && /^https?:\/\/\S+$/i.test(u)) out.push(u);
		}
		const single = p.url;
		if (single && /^https?:\/\/\S+$/i.test(String(single)))
			out.push(String(single));
	}
	return [...new Set(out)];
}

/** Build a user-friendly message from fetch/network errors */
function getScrapeErrorMessage(err) {
	if (!err) return "Scrape request failed";
	const msg = err?.message || String(err);
	const cause = err?.cause;
	const isAbort = err?.name === "AbortError" || cause?.name === "AbortError";
	if (isAbort) {
		return "Scrape request timed out. The scrape service took too long to respond.";
	}
	if (cause?.code === "UND_ERR_HEADERS_TIMEOUT") {
		return "Scrape request timed out waiting for response headers. The target may be slow or unreachable.";
	}
	if (cause?.code === "UND_ERR_BODY_TIMEOUT") {
		return "Scrape request timed out while receiving response body.";
	}
	if (
		msg.includes("fetch failed") ||
		msg.includes("ECONNREFUSED") ||
		msg.includes("ENOTFOUND")
	) {
		return "Scrape service unreachable. Check that the scrape API is running and reachable.";
	}
	return msg || "Scrape request failed";
}

/** Scrape one or many URLs via the API (fetch to /scrape or /scrape-multiple) */
async function scrapeUrlsViaApi(baseUrl, urls, options = {}) {
	if (!urls || urls.length === 0) return { sources: [], errors: [] };
	const validUrls = urls
		.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u))
		.slice(0, MAX_URLS);
	if (validUrls.length === 0) return { sources: [], errors: [] };

	const { includeImages = true, aiSummary = false, useProxy = false } = options;
	const body = {
		urls: validUrls,
		timeout: 30000,
		includeSemanticContent: true,
		includeImages,
		includeLinks: true,
		extractMetadata: true,
		includeCache: false,
		useProxy:
			useProxy ||
			(process.env.INKGEST_USE_PROXY === "true" ||
				process.env.INKGEST_USE_PROXY === "1"),
		aiSummary,
		takeScreenshot: false,
	};

	const SCRAPE_FETCH_TIMEOUT_MS = 90_000; // 90s — scrape can be slow for multiple URLs

	let res;
	try {
		if (validUrls.length === 1) {
			res = await fetch(`${baseUrl}/scrape`, {
				method: "POST",
				signal: AbortSignal.timeout(SCRAPE_FETCH_TIMEOUT_MS),
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...body, url: validUrls[0] }),
			});
		} else {
			res = await fetch(`${baseUrl}/scrape-multiple`, {
				method: "POST",
				signal: AbortSignal.timeout(SCRAPE_FETCH_TIMEOUT_MS),
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		}
	} catch (err) {
		const msg = getScrapeErrorMessage(err);
		console.error("[inkgest-agent] Scrape fetch failed:", msg, err);
		return { sources: [], errors: [msg] };
	}

	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const errMsg = data?.error || `HTTP ${res.status}`;
		console.error("[inkgest-agent] Scrape API error:", errMsg, "urls:", validUrls);
		return { sources: [], errors: [errMsg] };
	}

	if (validUrls.length === 1 && data.success) {
		// When aiSummary: true, use summary (condensed, with links/images) to avoid context overflow
		const markdown = (aiSummary && data.summary ? data.summary : data.markdown) || "";
		const title = data.data?.metadata?.title || data.data?.title || "";
		const links = (data.data?.links || [])
			.map((l) => (typeof l === "string" ? l : l?.url || l))
			.filter(Boolean);
		return {
			sources: [{ url: validUrls[0], markdown, title, links }],
			errors: [],
		};
	}

	if (data.results && Array.isArray(data.results)) {
		const scrapeFailures = data.results.filter((r) => r.success === false);
		if (scrapeFailures.length > 0) {
			console.error(
				"[inkgest-agent] Scrape failed for URL(s):",
				scrapeFailures.map((r) => ({ url: r.url, error: r.error })),
			);
		}
		const sources = data.results.map((r) => {
			const url = r.url || "";
			// When aiSummary: true, use summary (condensed, with links/images) to avoid context overflow
			const markdown =
				(aiSummary && r.summary ? r.summary : r.markdown) || "";
			const title = r.data?.metadata?.title || r.data?.title || "" || "";
			const links = (r.data?.links || [])
				.map((l) => (typeof l === "string" ? l : l?.url || l))
				.filter(Boolean);
			return { url, markdown, title, links };
		});
		const errors = data.results
			.filter((r) => r.success === false)
			.map((r) => r.error || r.url);
		return { sources, errors };
	}

	return { sources: [], errors: ["Unexpected scrape API response"] };
}

/** Scrape YouTube video transcript via POST /scrape-youtube. Returns sources in same shape as scrape (url, markdown, title, links). */
async function scrapeYoutubeViaApi(apiBaseUrl, youtubeUrls) {
	if (!youtubeUrls || youtubeUrls.length === 0) return { sources: [], errors: [] };
	const validUrls = youtubeUrls
		.filter((u) => typeof u === "string" && isYoutubeUrl(u))
		.slice(0, MAX_URLS);
	if (validUrls.length === 0) return { sources: [], errors: [] };

	const YOUTUBE_FETCH_TIMEOUT_MS = 30_000;
	const base = String(apiBaseUrl || "").replace(/\/$/, "");
	if (!base) return { sources: [], errors: ["API base URL required for YouTube scrape"] };

	const sources = [];
	const errors = [];

	for (const url of validUrls) {
		try {
			const res = await fetch(`${base}/scrape-youtube`, {
				method: "POST",
				signal: AbortSignal.timeout(YOUTUBE_FETCH_TIMEOUT_MS),
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: url }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				const errMsg = data?.error || data?.details || `HTTP ${res.status}`;
				console.error("[inkgest-agent] YouTube scrape failed:", url, errMsg);
				errors.push(errMsg);
				continue;
			}
			if (!data.success || !Array.isArray(data.data?.transcript)) {
				const errMsg = data?.error || "No transcript in response";
				console.error("[inkgest-agent] YouTube scrape failed:", url, errMsg);
				errors.push(errMsg);
				continue;
			}
			const transcript = data.data.transcript;
			const markdown = transcript
				.map((t) => (typeof t === "string" ? t : t?.text || ""))
				.filter(Boolean)
				.join("\n\n");
			sources.push({
				url,
				markdown: markdown || "(No transcript text)",
				title: `YouTube video: ${url}`,
				links: [],
			});
		} catch (err) {
			const msg = getScrapeErrorMessage(err);
			console.error("[inkgest-agent] YouTube scrape error:", url, msg);
			errors.push(msg);
		}
	}

	return { sources, errors };
}

/** Scrape Reddit post/thread via POST /scrape-reddit. Returns sources in same shape as scrape (url, markdown, title, links). */
async function scrapeRedditViaApi(apiBaseUrl, redditUrls) {
	if (!redditUrls || redditUrls.length === 0) return { sources: [], errors: [] };
	const validUrls = redditUrls
		.filter((u) => typeof u === "string" && isRedditUrl(u))
		.slice(0, MAX_URLS);
	if (validUrls.length === 0) return { sources: [], errors: [] };

	const REDDIT_FETCH_TIMEOUT_MS = 30_000;
	const base = String(apiBaseUrl || "").replace(/\/$/, "");
	if (!base) return { sources: [], errors: ["API base URL required for Reddit scrape"] };

	const sources = [];
	const errors = [];

	const scrapePromises = validUrls.map(async (url) => {
		try {
			const res = await fetch(`${base}/scrape-reddit`, {
				method: "POST",
				signal: AbortSignal.timeout(REDDIT_FETCH_TIMEOUT_MS),
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				const errMsg = data?.error || data?.details || `HTTP ${res.status}`;
				console.error("[inkgest-agent] Reddit scrape failed:", url, errMsg);
				errors.push(errMsg);
				return;
			}
			if (!data.success || !data.markdown) {
				const errMsg = data?.error || "No Reddit data in response";
				console.error("[inkgest-agent] Reddit scrape failed:", url, errMsg);
				errors.push(errMsg);
				return;
			}

			const links = (data.data?.links || []).filter(Boolean);
			sources.push({
				url,
				markdown: data.markdown || "(No Reddit content)",
				title: data.data?.title || `Reddit: ${url}`,
				links,
			});
		} catch (err) {
			const msg = getScrapeErrorMessage(err);
			console.error("[inkgest-agent] Reddit scrape error:", url, msg);
			errors.push(msg);
		}
	});

	await Promise.all(scrapePromises);

	return { sources, errors };
}

/** Router system prompt: decides suggested tasks from user message + URLs */
const ROUTER_SYSTEM_PROMPT = `You are InkAgent. You plan tasks from the user's message. You MUST infer URLs from context when the user does not paste a link. The user expects a concrete, SEO-optimised deliverable (blog, article, or table) with backlinks to sources — not just raw data.

CRITICAL - Scraping when URLs are provided:
- When URLs are present in sources, the system MUST scrape them successfully. If scraping fails for all URLs, the task will be aborted — no AI-generated content will be created. The AI must not create any asset when scrape fails. Only proceed with content creation when scraped content is available.

CRITICAL - URL + summarise/blog/article (e.g. "summarise this tweet", "create a blog from this link"):
- When the user provides URL(s) and asks for "summarise", "summarize", "create a blog", "create an article", "write a blog from this", "blog from this link" — suggest ONLY the output task (blog or article) with params.urls containing the exact URL(s) from "URLs found:".
- NEVER suggest only "scrape" when the user wants a deliverable. After planning, the system scrapes all URLs in parallel, then runs content tasks; the output task will receive the scraped content. Suggest blog or article with params.urls and a clear prompt (e.g. "Summarize the key points" or "Create a blog post from this content").
- For "summarise this" without format: suggest article with params.urls and prompt "Summarize the key points and takeaways".
- For "create a blog from this link": suggest blog with params.urls and prompt "Create a blog post from this content".
- ALWAYS put every URL from "URLs found:" into params.urls for the output task. Without params.urls, the task will not receive the scraped content.

MANDATORY - When the user mentions a site or topic but no URL is provided:
- ALWAYS infer the URL from the prompt. Examples: "scrape dev.to" → https://dev.to or https://dev.to/feed ; "deadsimplesites.com" → https://deadsimplesites.com ; "Medium" → https://medium.com/feed.
- Put the inferred URL(s) in every suggested task's params.urls (and for crawl-url also params.url).
- Set shouldExecute: true when the intent is clear.
- NEVER say "I can't proceed without URLs" or "please provide URLs". Always infer and create tasks with inferred URLs.

DEFAULT DELIVERABLE - Always return a useful output skill:
- For "find X news / latest stories / get content from X / summarize X": suggest ONLY the content task (article or blog) with the inferred URL in params.urls. Do NOT add a separate scrape or crawl-url task — the system automatically scrapes params.urls before running the content task.
- ONLY use crawl-url when the user explicitly asks to crawl a site, take screenshots, or needs deep multi-page discovery. NEVER stack crawl-url + scrape for the same URL.
- NEVER suggest both a scrape task and a crawl-url task for the same URL. Pick one: crawl-url for multi-page/SPA/screenshot needs, or just use params.urls on the content task for everything else.
- If the user asks for screenshots (e.g. "get screenshot of first 10 products of deadsimplesites.com") or explicit full-site crawl, suggest TWO tasks: (1) crawl-url with takeScreenshot and/or scrapeContent true, (2) output task (blog or article) with useCrawlResult: true. This is the ONLY case where both tasks are needed.
- If the user says "table" or "create a table" or "extract as table", suggest TWO tasks: (1) crawl-url (takeScreenshot, scrapeContent true), (2) table with useCrawlResult: true and prompt describing the columns to extract (e.g. "name, description, link, image").
- If the user explicitly asks for newsletter, substack, linkedin, twitter, use that output type; otherwise default to blog or article for a generic deliverable.

Respond with JSON only (no markdown fences):
{
  "thinking": "Brief reasoning including inferred URL and chosen output type",
  "suggestedTasks": [
    { "type": "crawl-url" | "scrape" | "github-trending" | "image-reading" | "blog" | "article" | "table" | "newsletter" | "substack" | "linkedin" | "twitter" | "landing-page-generator" | "image-gallery-creator" | "infographics-svg-generator" , "label": "...", "params": { ... } }
    { "type": "blog" | "article" | "table" | ... , "label": "...", "params": { "urls": [...], "prompt": "...", "useCrawlResult": true } }
  ],
  "message": "Friendly summary of what you will do (never ask user for URLs)",
  "shouldExecute": true | false
}

Rules:
- When "URLs found: none", infer at least one URL and set params.urls.
- crawl-url: ONLY for explicit deep crawls (full-site discovery, sitemaps, many linked pages) or screenshots. DO NOT use for simple "get news / latest posts / top stories" prompts — those only need params.urls on the content task. Well-known listing pages (Hacker News, dev.to, Lobsters, Product Hunt, etc.) are fully served by a single scrape via params.urls; never use crawl-url for them. NEVER combine crawl-url and a separate scrape task for the same URL.
- scrape: use only when the user explicitly asks to see raw scraped data (not a deliverable). For content/blog/article tasks, put the URL in params.urls instead — the system scrapes automatically. Do NOT suggest a scrape task alongside a content task for the same URL; that is always redundant.
- GitHub (github.com) URLs: treat like any other URL. The system scrapes the page (README, rendered HTML) before content tasks — do NOT suggest a separate scrape-git task or scrape + blog + extra repo-AST steps. For "blog about this repo" or "write about this GitHub link", suggest ONLY the output task (blog or article) with params.urls containing the GitHub URL(s), same as Twitter/X links.
- github-trending: use when the user asks for trending repos, "GitHub trending", "trending this week/month/year", or to discover popular repos. Suggest github-trending with params: since (daily|weekly|monthly), optional language (e.g. JavaScript, TypeScript, Python), optional category (web|mobile|ai|infra|data|all), optional per_page (default 25, max 100). The endpoint returns a list of trending repos with name, url, description, stars, language, etc.
- image-reading: use when the user provides image(s) (via "Images provided:" in context). Suggest image-reading so the agent extracts content from the image(s) for use by blog, article, newsletter, table, etc. Set params.images from the provided images (injected by the executor). Optional params.convertToCode: true when the user also wants HTML/code from the image. Content from image-reading is merged with scraped sources for downstream tasks.
- YouTube: when the user provides YouTube URLs (youtube.com, youtu.be), the transcript will be fetched automatically. Suggest blog, article, newsletter, table, or other output skills based on the user's prompt (e.g. "summarize this video" → article, "create a blog from this" → blog).
- Reddit: when the user provides Reddit URLs (reddit.com), the post/thread content will be fetched automatically. Suggest blog, article, newsletter, table, or other output skills based on the user's prompt (e.g. "summarize this Reddit post" → article, "create a blog from this thread" → blog).
- Twitter/X: when the user provides x.com or twitter.com URLs (tweets, posts), the page will be scraped. Suggest blog or article with params.urls and a prompt that uses the scraped content (e.g. "Summarize this tweet" → article with "Summarize the key points", "create a blog from this tweet" → blog with "Create a blog post from this content"). ALWAYS include params.urls.
- For "screenshot of N products/sites": add crawl-url (takeScreenshot: true) + an output task (blog/article by default, or table if user said "table"). Set useCrawlResult: true on the output task. Do NOT also add a scrape task.
- For "scrape X" without a deliverable intent: suggest ONLY article or blog with params.urls — the system scrapes automatically. Do NOT add an explicit scrape task.
- table: add when user says "table", "create a table", "extract as table". Set prompt describing columns. useCrawlResult: true so executor uses crawl data.
- blog / article: default output when user does not specify table/newsletter/etc. useCrawlResult: true when paired with crawl-url.
- newsletter / substack / linkedin / twitter: only when user explicitly asks for that format.
- landing-page-generator: when user wants an HTML landing page; use scraped content or prompt for copy. Can use useCrawlResult: true.
- image-gallery-creator: when user wants an array of images for a gallery; uses scraped content to extract/curate image URLs. useCrawlResult: true when paired with crawl.
- infographics-svg-generator: when user wants infographics / data visualisation cards from content; returns 4–5 infographic objects (stat, donut, bar, etc.). useCrawlResult: true when paired with crawl.
- Max 10 URLs per task (crawl-url uses one seed url).
- Multiple URLs: when user provides several URLs and asks for summarization or blog, include ALL URLs in params.urls. The output will synthesize content from all sources.`;

/** Parse router LLM response (extract JSON) */
function parseAgentResponse(raw) {
	const trimmed = String(raw || "").trim();
	const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
	if (!jsonMatch) throw new Error("Agent did not return valid JSON");
	try {
		return JSON.parse(jsonMatch[0]);
	} catch {
		throw new Error("Agent returned invalid JSON");
	}
}

// Input/output limits for skills (completion max is also capped in index via INKGEST_SKILL_MAX_OUTPUT_TOKENS)
const MAX_OUTPUT_TOKENS_LONG = 4096;
const MAX_OUTPUT_TOKENS_TABLE = 4096;
const MAX_SOURCE_CHARS_LONG = 10000; // newsletter, blog, article (per source, capped by total)
const MAX_SOURCE_CHARS_TABLE_TOTAL = 28000;
const MAX_SOURCE_CHARS_SUBSTACK = 12000;
const MAX_SOURCE_CHARS_LINKEDIN = 8000;
const MAX_SOURCE_CHARS_TWITTER = 4000;
const MAX_SOURCE_CHARS_LANDING = 16000;
const MAX_SOURCE_CHARS_GALLERY = 15000;
const MAX_SOURCE_CHARS_INFOG = 12000;

/** When total markdown from sources exceeds this, agent runs a condense LLM step before content skills */
const MAX_SOURCE_CHARS_TOTAL_THRESHOLD = 18000;
const MAX_SUMMARY_INPUT_CHARS = 35000; // max chars sent to summarization LLM
const MAX_SUMMARY_OUTPUT_CHARS = 8000; // max chars from summarization output

/** System prompt for infographics-svg-generator — 4–5 infographic objects from 9 types */
const INFOGraphics_SYSTEM_PROMPT = `You are a world-class data visualisation designer and editorial analyst.
Your job is to read the provided content and turn it into a set of 4–5 rich, visually diverse infographic data objects.

━━━ VISUAL STYLE RULES ━━━
• Every card must use a distinct visual style. Vary the accent colours across cards — do NOT use the same hex colour twice.
• Pick accent colours that match the emotional tone of each data point:
  – Data / metrics / numbers → blue #5B8FA8 or teal #2ECCAA
  – Process / workflow / steps → green #7C9D6F
  – Comparison / contrast → amber #E8A84A or orange #C17B2F
  – Key statistics / highlights → gold #E8D5B0
  – Quotes / narrative / insight → purple #9B7DB5
  – Timeline / history / milestones → coral #E86F4A
  – Progress / completion / ratios → indigo #6C63FF
  – Metric grids / dashboards → teal #2ECCAA
• Add an "accentColor" field (hex string) to every object.

━━━ AVAILABLE TYPES ━━━
Return ONLY a valid JSON array. No markdown, no explanation, no code fences. Raw JSON array only.

Alternatively you may return a JSON object with a single key "infographics" whose value is the array of 4–5 objects. Example: { "infographics": [ {...}, {...} ] }

Each object must match ONE of these 9 schemas exactly:

1. type:"stat"
   { "type":"stat","accentColor":"#hex","title":"short insight label","stat":"NUMBER or %","unit":"unit string or empty","subtitle":"one sentence on what this means","context":"source / additional note" }

2. type:"donut"
   { "type":"donut","accentColor":"#hex","title":"chart title","subtitle":"one-line context","centerValue":"text in middle","centerLabel":"small label in middle","segments":[{"label":"Name","value":NUMBER},...] }
   • Max 5 segments. Values are percentages (add up to ~100).

3. type:"bar"
   { "type":"bar","accentColor":"#hex","title":"chart title","subtitle":"context","yLabel":"unit suffix e.g. % or h","bars":[{"label":"short","value":NUMBER},...] }
   • Max 6 bars.

4. type:"steps"
   { "type":"steps","accentColor":"#hex","title":"process title","subtitle":"one-line context","steps":[{"title":"Step title","body":"1–2 sentence description"},...] }
   • 3–4 steps.

5. type:"comparison"
   { "type":"comparison","accentColor":"#hex","title":"X vs Y","left":{"label":"Option A","items":["point","point","point"]},"right":{"label":"Option B","items":["point","point","point"]} }

6. type:"quote"
   { "type":"quote","accentColor":"#hex","quote":"compelling sentence ≤40 words from the text","author":"author name or 'Editor'","source":"title ≤6 words" }

7. type:"timeline"
   { "type":"timeline","accentColor":"#hex","title":"timeline title","subtitle":"one-line context","events":[{"label":"Year or date","title":"Event name","detail":"1-sentence description"},...] }
   • 3–5 events in chronological order.

8. type:"progress"
   { "type":"progress","accentColor":"#hex","title":"progress title","subtitle":"one-line context","items":[{"label":"Metric name","value":NUMBER,"max":NUMBER,"unit":"unit string or %"},...] }
   • 3–6 items. value must be ≤ max.

9. type:"metric_grid"
   { "type":"metric_grid","accentColor":"#hex","title":"grid title","subtitle":"one-line context","metrics":[{"label":"Metric name","value":"formatted value","unit":"unit","change":"e.g. +12%","trend":"up|down|neutral"},...] }
   • 4–6 metrics.

━━━ CONTENT & SELECTION RULES ━━━
• Use REAL data and numbers from the content — never invent figures.
• Never repeat the same type twice in one response.
• Choose types that best match what the content actually contains:
  stat / donut / bar / progress → when there are specific numbers or percentages
  steps → when there is a sequential process or how-to list
  comparison → when there is a before/after, pros/cons, or A-vs-B contrast
  quote → when there is a punchy, memorable standalone sentence
  timeline → when there are events, milestones, or a sequence across time
  metric_grid → when there are 4+ related metrics or KPIs worth comparing
• If content lacks numerical data, prefer: steps, comparison, quote, timeline.
• Return exactly 4 or 5 objects (as a raw array or inside { "infographics": [...] }).`;

/** Shared rules for SEO, backlinks, hyperlinks, images — used by blog, article, newsletter, etc. */
const SEO_AND_BACKLINKS_RULES = `
SEO, BACKLINKS & READABILITY (when sources are provided):
- BACKLINKS & HYPERLINKS: Include as many contextual backlinks and hyperlinks as possible. Add 4–8+ links back to the source URL(s) throughout the body (e.g. "As noted in [this article](source_url)...", "Learn more [here](source_url)", inline links to specific sections). Use the exact source URLs provided. Link to relevant external resources mentioned in the sources. Make content richly linked — not just AI-generated text.
- IMAGES: Include images from the scraped content wherever relevant. Use markdown image syntax ![alt](url) for images found in the sources. Add images to break up text and improve readability. If the source provides image URLs or links, embed them in the output.
- SEO: use clear H2/H3 headings, natural keyword placement, meta-friendly structure. Stay on-topic; avoid filler.
- Fidelity: stay close to the scraped content. Do not invent facts, quotes, or data. Synthesize and expand only from what the sources actually say.`;

/** Skill registry: type -> { maxTokens, buildSystemPrompt, buildUserContent, parseResponse? } */
const SKILLS = {
	newsletter: {
		maxTokens: MAX_OUTPUT_TOKENS_LONG,
		buildSystemPrompt: (format = "substack", style = "casual", hasSources) =>
			`You are an expert newsletter writer. Create an SEO-optimised newsletter in ${format} style with a ${style} tone.

When sources are provided:
- Use them as research; synthesize and cite. Do not copy verbatim. Stay relevant and close to the scraped content — do not invent facts.
- Structure: optional subject-line suggestion, greeting, 2–4 clear sections with subheadings if helpful, and a clear CTA or sign-off.
- Length: substantial but scannable (e.g. 400–800 words for standard; longer if the user asks for a deep-dive).
- BACKLINKS & HYPERLINKS: Include as many backlinks and hyperlinks as possible to the source URLs. Link to relevant external resources. Make it richly linked — not just AI text.
- IMAGES: Embed images from the sources using ![alt](url). Include images to improve readability.
${hasSources ? SEO_AND_BACKLINKS_RULES : ""}

When no sources are provided:
- Write from the user's prompt and angle only.

Output the newsletter body only. Include backlinks, hyperlinks, and images throughout. No JSON, no markdown code fences, no meta-commentary.`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0)
				return prompt || "Write a newsletter.";
			const imgExt = /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i;
			const perSource = Math.min(
				MAX_SOURCE_CHARS_LONG,
				Math.floor(MAX_SOURCE_CHARS_TOTAL_THRESHOLD / sources.length),
			);
			const blocks = sources.map((s, i) => {
				const imageLinks = (s.links || [])
					.filter((l) =>
						imgExt.test(typeof l === "string" ? l : l?.url || ""),
					)
					.slice(0, 15)
					.map((l) => (typeof l === "string" ? l : l?.url || ""))
					.filter(Boolean);
				const imgSection = imageLinks.length
					? `\n\nImage URLs to embed: ${imageLinks.join(", ")}`
					: "";
				return `--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, perSource)}${imgSection}`;
			});
			const urlList = sources.map((s) => s.url).filter(Boolean).join("\n");
			return `User angle: ${prompt || "General newsletter"}\n\nContent to use:\n\n${blocks.join("\n\n")}\n\nSource URLs for backlinks (include 4–8+ hyperlinks in your output):\n${urlList}\n\nIMPORTANT: Include backlinks, hyperlinks, and images throughout. Make it readable and richly linked — not just AI-generated text.`;
		},
	},
	scrape: {
		maxTokens: 1,
		buildSystemPrompt: () => "N/A",
		buildUserContent: () => "N/A",
	},
	table: {
		maxTokens: MAX_OUTPUT_TOKENS_TABLE,
		buildSystemPrompt: () =>
			`You extract structured data from the given content into a single table.

Rules:
- Infer column names and types from the user's request and the content. Use consistent keys (e.g. snake_case).
- Include all relevant rows; do not truncate unless the content is excessively long (then add a note in description).
- Include the relavant links, images, titles and hyperlinks present content scraped from the source in the final table.
- "description" should briefly explain what the table represents.
- Respond with valid JSON only (no markdown, no explanation).

Schema:
{
  "title": "Table title",
  "description": "Brief description",
  "columns": [{"key": "col1", "label": "Column 1"}, ...],
  "rows": [{"col1": "value", "col2": "value"}, ...]
}`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0) return "";
			const perSource = Math.min(
				Math.floor(MAX_SOURCE_CHARS_TABLE_TOTAL / Math.max(sources.length, 1)),
				Math.floor(MAX_SOURCE_CHARS_TOTAL_THRESHOLD / sources.length),
			);
			const combined = (sources || [])
				.map(
					(s, i) =>
						`--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, perSource)}`,
				)
				.join("\n\n");
			return `USER REQUEST:\n${prompt || "Extract structured data into a table"}\n\nSCRAPED CONTENT:\n\n${combined}`;
		},
		parseResponse: (raw) => {
			const trimmed = String(raw || "").trim();
			const m = trimmed.match(/\{[\s\S]*\}/);
			if (!m) return { title: "", description: "", columns: [], rows: [] };
			try {
				const o = JSON.parse(m[0]);
				return {
					title: o.title || "",
					description: o.description || "",
					columns: Array.isArray(o.columns) ? o.columns : [],
					rows: Array.isArray(o.rows) ? o.rows : [],
				};
			} catch {
				return { title: "", description: "", columns: [], rows: [] };
			}
		},
	},
	blog: {
		maxTokens: MAX_OUTPUT_TOKENS_LONG,
		buildSystemPrompt: (_, __, hasSources) =>
			hasSources
				? `You are an expert blog writer. Write an SEO-optimised long-form blog post using the scraped content as research.

Structure: compelling intro, 3–5 sections with clear H2/H3 headings, and a concise conclusion or CTA.
- Synthesize and cite; do not copy verbatim. Use a conversational but authoritative tone.
- Length: 800–2000+ words depending on the topic and user's angle.
- Stay relevant and close to the scraped content — do not invent facts, quotes, or data.
- BACKLINKS & IMAGES: Include 4–8+ hyperlinks to sources. Embed images using ![alt](url) where relevant.
${SEO_AND_BACKLINKS_RULES}

Output the post body only. Include backlinks, hyperlinks, and images. No JSON, no markdown fences, no placeholders.`
				: `You are an expert blog writer. Write an SEO-optimised long-form blog post from the user's prompt.
Structure: intro, sections, conclusion. Include links and images where relevant. No JSON, no markdown fences.`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0)
				return prompt || "Write a blog post.";
			const imgExt = /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i;
			const perSource = Math.min(
				MAX_SOURCE_CHARS_LONG,
				Math.floor(MAX_SOURCE_CHARS_TOTAL_THRESHOLD / sources.length),
			);
			const blocks = sources.map((s, i) => {
				const imageLinks = (s.links || [])
					.filter((l) =>
						imgExt.test(typeof l === "string" ? l : l?.url || ""),
					)
					.slice(0, 15)
					.map((l) => (typeof l === "string" ? l : l?.url || ""))
					.filter(Boolean);
				const imgSection = imageLinks.length
					? `\n\nImage URLs to embed: ${imageLinks.join(", ")}`
					: "";
				return `--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, perSource)}${imgSection}`;
			});
			const urlList = sources.map((s) => s.url).filter(Boolean).join("\n");
			return `Angle/instructions: ${prompt || "General blog"}\n\nContent:\n\n${blocks.join("\n\n")}\n\nSource URLs for backlinks (include 4–8+ hyperlinks in your output):\n${urlList}\n\nIMPORTANT: Include backlinks, hyperlinks, and images throughout. Make it readable and richly linked — not just AI-generated text.`;
		},
	},
	article: {
		maxTokens: MAX_OUTPUT_TOKENS_LONG,
		buildSystemPrompt: (_, __, hasSources) =>
			hasSources
				? `You are an expert article writer. Write an SEO-optimised, polished article using the scraped content.

Structure: strong lead, well-organized body with H2/H3 subheadings, and a clear takeaway or conclusion.
- Use the sources to support your narrative; cite and synthesize. Professional, publication-ready tone.
- Length: 600–1500+ words as appropriate for the topic.
- Stay relevant and close to the scraped content — do not invent facts or drift from the source.
- BACKLINKS & IMAGES: Include 4–8+ hyperlinks to sources. Embed images using ![alt](url) where relevant.
${SEO_AND_BACKLINKS_RULES}

Output the article body only. Include backlinks, hyperlinks, and images. No JSON, no markdown fences, no placeholders.`
				: `You are an expert article writer. Write an SEO-optimised article from the user's prompt.
Include links and images where relevant. No JSON, no markdown fences.`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0)
				return prompt || "Write an article.";
			const imgExt = /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i;
			const perSource = Math.min(
				MAX_SOURCE_CHARS_LONG,
				Math.floor(MAX_SOURCE_CHARS_TOTAL_THRESHOLD / sources.length),
			);
			const blocks = sources.map((s, i) => {
				const imageLinks = (s.links || [])
					.filter((l) =>
						imgExt.test(typeof l === "string" ? l : l?.url || ""),
					)
					.slice(0, 15)
					.map((l) => (typeof l === "string" ? l : l?.url || ""))
					.filter(Boolean);
				const imgSection = imageLinks.length
					? `\n\nImage URLs to embed: ${imageLinks.join(", ")}`
					: "";
				return `--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, perSource)}${imgSection}`;
			});
			const urlList = sources.map((s) => s.url).filter(Boolean).join("\n");
			return `Angle: ${prompt || "General article"}\n\nContent:\n\n${blocks.join("\n\n")}\n\nSource URLs for backlinks (include 4–8+ hyperlinks in your output):\n${urlList}\n\nIMPORTANT: Include backlinks, hyperlinks, and images throughout. Make it readable and richly linked — not just AI-generated text.`;
		},
	},
	substack: {
		maxTokens: 3200,
		buildSystemPrompt: (_, __, hasSources) =>
			hasSources
				? `You write SEO-optimised Substack-style newsletter posts. Concise, engaging, with a clear voice.
- Use the scraped content; synthesize and add perspective. Hook in the first line.
- Length: 300–600 words typical; can be longer if the topic demands.
- Stay relevant and close to the scraped content — do not invent facts.
- BACKLINKS & IMAGES: Include 4+ hyperlinks to sources. Embed images where relevant.
${SEO_AND_BACKLINKS_RULES}

Output the post body only. Include backlinks, hyperlinks, and images. No JSON, no markdown fences.`
				: `You write SEO-optimised Substack-style posts. Engaging, clear voice. Include links and images where relevant. No JSON.`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0)
				return prompt || "Write a Substack post.";
			const imgExt = /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i;
			const perSource = Math.min(
				MAX_SOURCE_CHARS_SUBSTACK,
				Math.floor(MAX_SOURCE_CHARS_TOTAL_THRESHOLD / sources.length),
			);
			const blocks = sources.map((s, i) => {
				const imageLinks = (s.links || [])
					.filter((l) =>
						imgExt.test(typeof l === "string" ? l : l?.url || ""),
					)
					.slice(0, 10)
					.map((l) => (typeof l === "string" ? l : l?.url || ""))
					.filter(Boolean);
				const imgSection = imageLinks.length
					? `\n\nImage URLs to embed: ${imageLinks.join(", ")}`
					: "";
				return `--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, perSource)}${imgSection}`;
			});
			const urlList = sources.map((s) => s.url).filter(Boolean).join("\n");
			return `Angle: ${prompt || "Substack post"}\n\nContent:\n\n${blocks.join("\n\n")}\n\nSource URLs for backlinks (include 4+ hyperlinks):\n${urlList}\n\nIMPORTANT: Include backlinks, hyperlinks, and images. Make it readable and richly linked.`;
		},
	},
	linkedin: {
		maxTokens: 1600,
		buildSystemPrompt: (_, __, hasSources) =>
			hasSources
				? `You write SEO-optimised LinkedIn posts. Professional, engaging, hook + value.
- First line: hook or question. Then 3–5 short paragraphs; bullet points or line breaks for scanability.
- End with a CTA or question. Use the scraped content to support your points. Stay relevant and close to the source.
- Include 2–4 backlinks to the source URL(s) when natural (e.g. "Read more: [link]").
- Output the post only. Include backlinks and hyperlinks. No JSON, no markdown fences.`
				: `You write SEO-optimised LinkedIn posts. Hook + value + CTA. Include links where relevant. No JSON.`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0)
				return prompt || "Write a LinkedIn post.";
			const perSource = Math.min(
				MAX_SOURCE_CHARS_LINKEDIN,
				Math.floor(MAX_SOURCE_CHARS_TOTAL_THRESHOLD / sources.length),
			);
			const blocks = sources.map(
				(s, i) =>
					`--- Source ${i + 1}: ${s.url} ---\n\n${(s.markdown || "").slice(0, perSource)}`,
			);
			const urlList = sources.map((s) => s.url).filter(Boolean).join("\n");
			return `Angle: ${prompt || "LinkedIn post"}\n\nContent:\n\n${blocks.join("\n\n")}\n\nSource URLs for backlinks (include 2–4 hyperlinks):\n${urlList}\n\nIMPORTANT: Include backlinks and hyperlinks. Make it readable and linked.`;
		},
	},
	twitter: {
		maxTokens: 800,
		buildSystemPrompt: (_, __, hasSources) =>
			hasSources
				? `You write Twitter/X posts. Punchy, concise; can be a single tweet or a short thread.
- Use the scraped content for facts and angles. Stay relevant and close to the source — do not invent.
- Stay within character limits per tweet (~280).
- Include the source URL as a link in the final tweet when space allows.
- Number thread tweets (1/ 2/ 3...) if multiple. Output the post(s) only. No JSON.`
				: `You write Twitter/X posts. Punchy, concise. Output the post only. No JSON.`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0) return prompt || "Write a tweet.";
			const perSource = Math.min(
				MAX_SOURCE_CHARS_TWITTER,
				Math.floor(MAX_SOURCE_CHARS_TOTAL_THRESHOLD / sources.length),
			);
			const blocks = sources.map(
				(s, i) =>
					`--- Source ${i + 1}: ${s.url} ---\n\n${(s.markdown || "").slice(0, perSource)}`,
			);
			const urlList = sources.map((s) => s.url).filter(Boolean).join("\n");
			return `Angle: ${prompt || "Tweet"}\n\nContent:\n\n${blocks.join("\n\n")}\n\nSource URL(s) — include in final tweet when space allows:\n${urlList}`;
		},
	},
	// API-only: executed via POST /crawl-url. Use when prompt needs to scrape a URL and its nested URLs (sitemaps, many pages) or when /scrape won't work (SPAs, JS-heavy). Otherwise prefer scrape skill for single/few known URLs.
	"crawl-url": {
		maxTokens: 1,
		buildSystemPrompt: () => "N/A",
		buildUserContent: () => "N/A",
	},
	// API-only: executed via GET /github-trending. Use when user asks for trending repos (since=daily|weekly|monthly, optional language, category).
	"github-trending": {
		maxTokens: 1,
		buildSystemPrompt: () => "N/A",
		buildUserContent: () => "N/A",
	},
	// API-only: executed via POST /image-reading. When images are provided, extracts content (markdown) and optionally code; result is merged as sources for blog/article/newsletter etc.
	"image-reading": {
		maxTokens: 1,
		buildSystemPrompt: () => "N/A",
		buildUserContent: () => "N/A",
	},
	"landing-page-generator": {
		maxTokens: 12000,
		buildSystemPrompt: () => loadSkills.landingPageSkill.skill,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0)
				return prompt || "Create a landing page.";
			const perSource = Math.min(
				MAX_SOURCE_CHARS_LANDING,
				Math.floor(MAX_SOURCE_CHARS_TOTAL_THRESHOLD / sources.length),
			);
			const blocks = sources.map(
				(s, i) =>
					`--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, perSource)}`,
			);
			const urlList = sources.map((s) => s.url).filter(Boolean).join("\n");
			return `User brief: ${prompt || "Landing page"}\n\nContent to use for copy and structure:\n\n${blocks.join("\n\n")}\n\nSource URLs for backlinks (add a Sources/Learn more section):\n${urlList}`;
		},
	},
	"image-gallery-creator": {
		maxTokens: 4000,
		buildSystemPrompt: () =>
			`You create an image gallery specification from the given content and prompt.

Rules:
- Output a valid JSON object with a single key "images", which is an array of image entries.
- Each entry: { "url": "image URL (must be https)", "alt": "short description", "caption": "optional caption" }.
- Prefer image URLs extracted from the provided content (e.g. from links ending in .jpg, .png, .webp, .gif). If the content lists products or pages with image links, include those. If no image URLs are found, use placeholder URLs (e.g. https://placehold.co/600x400) and set alt/caption from the content.
- Return 4–20 images. No markdown, no code fences — raw JSON only.`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0)
				return prompt || "Create an image gallery.";
			const imgExt = /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i;
			const perSource = Math.min(
				MAX_SOURCE_CHARS_GALLERY,
				Math.floor(MAX_SOURCE_CHARS_TOTAL_THRESHOLD / sources.length),
			);
			const blocks = sources.map((s, i) => {
				const imageLinks = (s.links || []).filter((l) => imgExt.test(typeof l === "string" ? l : l?.url || ""));
				return `--- Source ${i + 1}: ${s.url} ---\n${s.title ? `Title: ${s.title}\n` : ""}${(s.markdown || "").slice(0, perSource)}\nImage links: ${imageLinks.slice(0, 30).join(", ")}`;
			});
			return `User request: ${prompt || "Image gallery"}\n\nContent (use for context and image URLs):\n\n${blocks.join("\n\n")}`;
		},
		parseResponse: (raw) => {
			const trimmed = String(raw || "").trim().replace(/```json|```/gi, "").trim();
			const m = trimmed.match(/\{[\s\S]*\}/);
			if (!m) return { images: [] };
			try {
				const o = JSON.parse(m[0]);
				return { images: Array.isArray(o.images) ? o.images : [] };
			} catch {
				return { images: [] };
			}
		},
	},
	"infographics-svg-generator": {
		maxTokens: 2200,
		buildSystemPrompt: () => INFOGraphics_SYSTEM_PROMPT,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0)
				return `Title: ${prompt || "Draft"}\n\nNo content provided — use the title/prompt to create relevant infographic ideas.`;
			const perSource = Math.min(
				MAX_SOURCE_CHARS_INFOG,
				Math.floor(MAX_SOURCE_CHARS_TOTAL_THRESHOLD / sources.length),
			);
			const combined = (sources || [])
				.map(
					(s, i) =>
						`--- Source ${i + 1}: ${s.url} ---\n${s.title ? `Title: ${s.title}\n` : ""}${(s.markdown || "").slice(0, perSource)}`,
				)
				.join("\n\n");
			return `Title: ${prompt || "Draft"}\n\nContent to analyse:\n\n${combined}`;
		},
		parseResponse: (raw) => {
			const trimmed = String(raw || "").trim().replace(/```json|```/gi, "").trim();
			// Try raw array first: [...]
			const arrMatch = trimmed.match(/\[[\s\S]*\]/);
			if (arrMatch) {
				try {
					const arr = JSON.parse(arrMatch[0]);
					const list = Array.isArray(arr) ? arr : [];
					return { infographics: list, count: list.length };
				} catch {}
			}
			// Try full JSON object: { "infographics": [...] } or { infographics: [...] }
			try {
				const objMatch = trimmed.match(/\{[\s\S]*\}/);
				if (objMatch) {
					const o = JSON.parse(objMatch[0]);
					const list = Array.isArray(o.infographics) ? o.infographics : [];
					return { infographics: list, count: list.length };
				}
			} catch {}
			return { infographics: [], count: 0 };
		},
	},
};

const TASK_TYPES = Object.keys(SKILLS);

/** Credits per action (client deducts these). thinking = one router LLM call; rest = per executed task. */
const CREDITS = {
	thinking: 0.25,
	"source-condense": 0.25,
	newsletter: 1,
	scrape: 1,
	table: 2,
	blog: 1,
	article: 1,
	substack: 1,
	linkedin: 1,
	twitter: 1,
	"crawl-url": 2,
	"github-trending": 1,
	"image-reading": 1,
	"landing-page-generator": 2,
	"image-gallery-creator": 1,
	"infographics-svg-generator": 2,
};

export {
	URL_REGEX,
	MAX_URLS,
	YOUTUBE_URL_REGEX,
	isYoutubeUrl,
	isRedditUrl,
	extractYoutubeUrlsFromText,
	extractUrlsFromText,
	scrapeUrlsViaApi,
	scrapeYoutubeViaApi,
	scrapeRedditViaApi,
	ROUTER_SYSTEM_PROMPT,
	parseAgentResponse,
	SKILLS,
	TASK_TYPES,
	CREDITS,
	MAX_SOURCE_CHARS_TOTAL_THRESHOLD,
	MAX_SUMMARY_INPUT_CHARS,
	MAX_SUMMARY_OUTPUT_CHARS,
};
