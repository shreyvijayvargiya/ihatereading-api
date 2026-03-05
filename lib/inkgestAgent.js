/**
 * Inkgest Agent — agentic task execution using /scrape and /scrape-multiple.
 * One LLM router + extensible skills: newsletter, scrape, table, blog, substack, linkedin, twitter, article.
 */

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

	const { includeImages = true } = options;
	const body = {
		urls: validUrls,
		timeout: 30000,
		includeSemanticContent: true,
		includeImages,
		includeLinks: true,
		extractMetadata: true,
		includeCache: false,
		useProxy: false,
		aiSummary: false,
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
		return { sources: [], errors: [getScrapeErrorMessage(err)] };
	}

	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		return { sources: [], errors: [data?.error || `HTTP ${res.status}`] };
	}

	if (validUrls.length === 1 && data.success) {
		const markdown = data.markdown || "";
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
		const sources = data.results.map((r) => {
			const url = r.url || "";
			const markdown = r.markdown || "";
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
				errors.push(data?.error || data?.details || `HTTP ${res.status}`);
				continue;
			}
			if (!data.success || !Array.isArray(data.data?.transcript)) {
				errors.push(data?.error || "No transcript in response");
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
			errors.push(getScrapeErrorMessage(err));
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

	for (const url of validUrls) {
		try {
			const res = await fetch(`${base}/scrape-reddit`, {
				method: "POST",
				signal: AbortSignal.timeout(REDDIT_FETCH_TIMEOUT_MS),
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				errors.push(data?.error || data?.details || `HTTP ${res.status}`);
				continue;
			}
			if (!data.success || !data.markdown) {
				errors.push(data?.error || "No Reddit data in response");
				continue;
			}
			const posts = data.data?.posts || [];
			const links = (data.data?.links || []).filter(Boolean);
			sources.push({
				url,
				markdown: data.markdown || "(No Reddit content)",
				title: data.data?.title || `Reddit: ${url}`,
				links,
			});
		} catch (err) {
			errors.push(getScrapeErrorMessage(err));
		}
	}

	return { sources, errors };
}

/** Router system prompt: decides suggested tasks from user message + URLs */
const ROUTER_SYSTEM_PROMPT = `You are InkAgent. You plan tasks from the user's message. You MUST infer URLs from context when the user does not paste a link. The user expects a concrete deliverable (blog, article, or table), not just raw data.

MANDATORY - When the user mentions a site or topic but no URL is provided:
- ALWAYS infer the URL from the prompt. Examples: "scrape dev.to" → https://dev.to or https://dev.to/feed ; "deadsimplesites.com" → https://deadsimplesites.com ; "Medium" → https://medium.com/feed.
- Put the inferred URL(s) in every suggested task's params.urls (and for crawl-url also params.url).
- Set shouldExecute: true when the intent is clear.
- NEVER say "I can't proceed without URLs" or "please provide URLs". Always infer and create tasks with inferred URLs.

DEFAULT DELIVERABLE - Always return a useful output skill:
- If the user asks for screenshots, crawl, or scrape (e.g. "get screenshot of first 10 products of deadsimplesites.com", "scrape X") and does NOT specify what to do with the data, suggest TWO tasks: (1) data task: crawl-url with takeScreenshot and/or scrapeContent true, (2) output task: blog or article with useCrawlResult: true and prompt summarizing the content (e.g. "Summarize the products/sites and key takeaways"). Default to blog/article so the user gets a readable deliverable, not just raw screenshots or links.
- If the user says "table" or "create a table" or "extract as table" (e.g. "get screenshot of first 5 products and create a table from it"), suggest TWO tasks: (1) crawl-url (takeScreenshot, scrapeContent true), (2) table with useCrawlResult: true and prompt describing the columns to extract (e.g. "name, description, link, image").
- If the user explicitly asks for newsletter, substack, linkedin, twitter, use that output type; otherwise default to blog or article for a generic deliverable.
- Rule: when in doubt, include both a data task (crawl-url or scrape) and an output task (blog, article, or table). Set useCrawlResult: true on the output task when it should use the crawl result.

Respond with JSON only (no markdown fences):
{
  "thinking": "Brief reasoning including inferred URL and chosen output type",
  "suggestedTasks": [
    { "type": "crawl-url" | "scrape" | "blog" | "article" | "table" | "newsletter" | "substack" | "linkedin" | "twitter" | "landing-page-generator" | "image-gallery-creator" | "infographics-svg-generator" , "label": "...", "params": { ... } }
    { "type": "blog" | "article" | "table" | ... , "label": "...", "params": { "urls": [...], "prompt": "...", "useCrawlResult": true } }
  ],
  "message": "Friendly summary of what you will do (never ask user for URLs)",
  "shouldExecute": true | false
}

Rules:
- When "URLs found: none", infer at least one URL and set params.urls.
- crawl-url: one seed URL. Use when the user needs to scrape a site and its nested URLs (sitemaps, many linked pages), or when /scrape would not work (SPAs, JS-heavy pages, or content spread across many URLs). Set takeScreenshot and/or scrapeContent as needed. Prefer scrape (single URL or few known URLs) when that is enough.
- scrape: use for a single page or a few known URLs when /scrape or /scrape-multiple will work. Use crawl-url when nested/sitemap discovery or full-site scrape is needed.
- YouTube: when the user provides YouTube URLs (youtube.com, youtu.be), the transcript will be fetched automatically. Suggest blog, article, newsletter, table, or other output skills based on the user's prompt (e.g. "summarize this video" → article, "create a blog from this" → blog).
- Reddit: when the user provides Reddit URLs (reddit.com), the post/thread content will be fetched automatically. Suggest blog, article, newsletter, table, or other output skills based on the user's prompt (e.g. "summarize this Reddit post" → article, "create a blog from this thread" → blog).
- For "screenshot of N products/sites" or "scrape X": add crawl-url + an output task (blog/article by default, or table if user said "table"). Set useCrawlResult: true on the output task.
- table: add when user says "table", "create a table", "extract as table". Set prompt describing columns. useCrawlResult: true so executor uses crawl data.
- blog / article: default output when user does not specify table/newsletter/etc. useCrawlResult: true when paired with crawl-url.
- newsletter / substack / linkedin / twitter: only when user explicitly asks for that format.
- landing-page-generator: when user wants an HTML landing page; use scraped content or prompt for copy. Can use useCrawlResult: true.
- image-gallery-creator: when user wants an array of images for a gallery; uses scraped content to extract/curate image URLs. useCrawlResult: true when paired with crawl.
- infographics-svg-generator: when user wants infographics / data visualisation cards from content; returns 4–5 infographic objects (stat, donut, bar, etc.). useCrawlResult: true when paired with crawl.
- Max 10 URLs per task (crawl-url uses one seed url).`;

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

// Input/output limits for skills (comprehensive context, up to 8k output)
const MAX_OUTPUT_TOKENS_LONG = 8000;
const MAX_OUTPUT_TOKENS_TABLE = 6000;
const MAX_SOURCE_CHARS_LONG = 20000; // newsletter, blog, article
const MAX_SOURCE_CHARS_TABLE_TOTAL = 28000;
const MAX_SOURCE_CHARS_SUBSTACK = 12000;
const MAX_SOURCE_CHARS_LINKEDIN = 8000;
const MAX_SOURCE_CHARS_TWITTER = 4000;
const MAX_SOURCE_CHARS_LANDING = 25000;
const MAX_SOURCE_CHARS_GALLERY = 15000;
const MAX_SOURCE_CHARS_INFOG = 12000;

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

/** Skill registry: type -> { maxTokens, buildSystemPrompt, buildUserContent, parseResponse? } */
const SKILLS = {
	newsletter: {
		maxTokens: MAX_OUTPUT_TOKENS_LONG,
		buildSystemPrompt: (format = "substack", style = "casual", hasSources) =>
			`You are an expert newsletter writer. Create a newsletter in ${format} style with a ${style} tone.

When sources are provided:
- Use them as research; synthesize and cite. Do not copy verbatim.
- Structure: optional subject-line suggestion, greeting, 2–4 clear sections with subheadings if helpful, and a clear CTA or sign-off.
- Length: substantial but scannable (e.g. 400–800 words for standard; longer if the user asks for a deep-dive).

When no sources are provided:
- Write from the user's prompt and angle only.

Output the newsletter body only. No JSON, no markdown code fences, no meta-commentary.`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0)
				return prompt || "Write a newsletter.";
			const blocks = sources.map(
				(s, i) =>
					`--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, MAX_SOURCE_CHARS_LONG)}`,
			);
			return `User angle: ${prompt || "General newsletter"}\n\nContent to use:\n\n${blocks.join("\n\n")}`;
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
			const perSource = Math.floor(
				MAX_SOURCE_CHARS_TABLE_TOTAL / Math.max(sources.length, 1),
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
				? `You are an expert blog writer. Write a long-form blog post using the scraped content as research.

Structure: compelling intro, 3–5 sections with clear headings, and a concise conclusion or CTA.
- Synthesize and cite; do not copy verbatim. Use a conversational but authoritative tone.
- Length: 800–2000+ words depending on the topic and user's angle.

Output the post body only. No JSON, no markdown fences, no placeholders.`
				: `You are an expert blog writer. Write a long-form blog post from the user's prompt.
Structure: intro, sections, conclusion. Output the post body only. No JSON, no markdown fences.`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0)
				return prompt || "Write a blog post.";
			const blocks = sources.map(
				(s, i) =>
					`--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, MAX_SOURCE_CHARS_LONG)}`,
			);
			return `Angle/instructions: ${prompt || "General blog"}\n\nContent:\n\n${blocks.join("\n\n")}`;
		},
	},
	article: {
		maxTokens: MAX_OUTPUT_TOKENS_LONG,
		buildSystemPrompt: (_, __, hasSources) =>
			hasSources
				? `You are an expert article writer. Write a polished article using the scraped content.

Structure: strong lead, well-organized body with subheadings, and a clear takeaway or conclusion.
- Use the sources to support your narrative; cite and synthesize. Professional, publication-ready tone.
- Length: 600–1500+ words as appropriate for the topic.

Output the article body only. No JSON, no markdown fences, no placeholders.`
				: `You are an expert article writer. Write an article from the user's prompt.
Output the article body only. No JSON, no markdown fences.`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0)
				return prompt || "Write an article.";
			const blocks = sources.map(
				(s, i) =>
					`--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, MAX_SOURCE_CHARS_LONG)}`,
			);
			return `Angle: ${prompt || "General article"}\n\nContent:\n\n${blocks.join("\n\n")}`;
		},
	},
	substack: {
		maxTokens: 3200,
		buildSystemPrompt: (_, __, hasSources) =>
			hasSources
				? `You write Substack-style newsletter posts. Concise, engaging, with a clear voice.
- Use the scraped content; synthesize and add perspective. Hook in the first line.
- Length: 300–600 words typical; can be longer if the topic demands.
- Output the post body only. No JSON, no markdown fences.`
				: `You write Substack-style posts. Engaging, clear voice. Output the post body only. No JSON.`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0)
				return prompt || "Write a Substack post.";
			const blocks = sources.map(
				(s, i) =>
					`--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, MAX_SOURCE_CHARS_SUBSTACK)}`,
			);
			return `Angle: ${prompt || "Substack post"}\n\nContent:\n\n${blocks.join("\n\n")}`;
		},
	},
	linkedin: {
		maxTokens: 1600,
		buildSystemPrompt: (_, __, hasSources) =>
			hasSources
				? `You write LinkedIn posts. Professional, engaging, hook + value.
- First line: hook or question. Then 3–5 short paragraphs; bullet points or line breaks for scanability.
- End with a CTA or question. Use the scraped content to support your points.
- Output the post only. No JSON, no markdown fences.`
				: `You write LinkedIn posts. Hook + value + CTA. Output the post only. No JSON.`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0)
				return prompt || "Write a LinkedIn post.";
			const blocks = sources.map(
				(s, i) =>
					`--- Source ${i + 1}: ${s.url} ---\n\n${(s.markdown || "").slice(0, MAX_SOURCE_CHARS_LINKEDIN)}`,
			);
			return `Angle: ${prompt || "LinkedIn post"}\n\nContent:\n\n${blocks.join("\n\n")}`;
		},
	},
	twitter: {
		maxTokens: 800,
		buildSystemPrompt: (_, __, hasSources) =>
			hasSources
				? `You write Twitter/X posts. Punchy, concise; can be a single tweet or a short thread.
- Use the scraped content for facts and angles. Stay within character limits per tweet (~280).
- Number thread tweets (1/ 2/ 3...) if multiple. Output the post(s) only. No JSON.`
				: `You write Twitter/X posts. Punchy, concise. Output the post only. No JSON.`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0) return prompt || "Write a tweet.";
			const blocks = sources.map(
				(s, i) =>
					`--- Source ${i + 1}: ${s.url} ---\n\n${(s.markdown || "").slice(0, MAX_SOURCE_CHARS_TWITTER)}`,
			);
			return `Angle: ${prompt || "Tweet"}\n\nContent:\n\n${blocks.join("\n\n")}`;
		},
	},
	// API-only: executed via POST /crawl-url. Use when prompt needs to scrape a URL and its nested URLs (sitemaps, many pages) or when /scrape won't work (SPAs, JS-heavy). Otherwise prefer scrape skill for single/few known URLs.
	"crawl-url": {
		maxTokens: 1,
		buildSystemPrompt: () => "N/A",
		buildUserContent: () => "N/A",
	},
	"landing-page-generator": {
		maxTokens: 12000,
		buildSystemPrompt: (_, __, hasSources) =>
			hasSources
				? `You are an expert landing page designer and front-end developer. Create a single, complete HTML document for a landing page that uses the provided content as copy and context.

Rules:
- Output one complete HTML file including <!DOCTYPE html>, <head>, and <body>. Embed all CSS inside a <style> tag in the head; do not use external stylesheets.
- Use the scraped/given content for headings, paragraphs, and CTAs. Adapt the tone and structure to match. Prefer semantic HTML (header, section, main, footer, nav).
- Make it responsive (meta viewport, fluid layout). Use a clean, modern aesthetic; vary accent colours for sections if it fits the content.
- No JavaScript required. No markdown code fences — output raw HTML only.`
				: `You are an expert landing page designer. Create a single, complete HTML document for a landing page based on the user's prompt. Embed all CSS in a <style> tag. Output raw HTML only; no markdown fences.`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0)
				return prompt || "Create a landing page.";
			const blocks = sources.map(
				(s, i) =>
					`--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, MAX_SOURCE_CHARS_LANDING)}`,
			);
			return `User brief: ${prompt || "Landing page"}\n\nContent to use for copy and structure:\n\n${blocks.join("\n\n")}`;
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
			const blocks = sources.map((s, i) => {
				const imageLinks = (s.links || []).filter((l) => imgExt.test(typeof l === "string" ? l : l?.url || ""));
				return `--- Source ${i + 1}: ${s.url} ---\n${s.title ? `Title: ${s.title}\n` : ""}${(s.markdown || "").slice(0, MAX_SOURCE_CHARS_GALLERY)}\nImage links: ${imageLinks.slice(0, 30).join(", ")}`;
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
			const combined = (sources || [])
				.map(
					(s, i) =>
						`--- Source ${i + 1}: ${s.url} ---\n${s.title ? `Title: ${s.title}\n` : ""}${(s.markdown || "").slice(0, MAX_SOURCE_CHARS_INFOG)}`,
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
	newsletter: 1,
	scrape: 1,
	table: 2,
	blog: 1,
	article: 1,
	substack: 1,
	linkedin: 1,
	twitter: 1,
	"crawl-url": 2,
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
};
