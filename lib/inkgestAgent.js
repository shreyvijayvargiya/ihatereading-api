/**
 * Inkgest Agent — agentic task execution using /scrape and /scrape-multiple.
 * One LLM router + extensible skills: newsletter, scrape, table, blog, substack, linkedin, twitter, article.
 */

const URL_REGEX = /https?:\/\/[^\s\)\]"'\<\>]+/gi;
const MAX_URLS = 10;

/** Extract URLs from text (regex, no LLM) */
function extractUrlsFromText(text) {
	if (!text || typeof text !== "string") return [];
	const matches = text.match(URL_REGEX) || [];
	return [...new Set(matches.map((u) => u.replace(/[.,;:!?]+$/, "")))].slice(0, MAX_URLS);
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
	if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) {
		return "Scrape service unreachable. Check that the scrape API is running and reachable.";
	}
	return msg || "Scrape request failed";
}

/** Scrape one or many URLs via the API (fetch to /scrape or /scrape-multiple) */
async function scrapeUrlsViaApi(baseUrl, urls, options = {}) {
	if (!urls || urls.length === 0) return { sources: [], errors: [] };
	const validUrls = urls.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u)).slice(0, MAX_URLS);
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
		const links = (data.data?.links || []).map((l) => (typeof l === "string" ? l : l?.url || l)).filter(Boolean);
		return {
			sources: [{ url: validUrls[0], markdown, title, links }],
			errors: [],
		};
	}

	if (data.results && Array.isArray(data.results)) {
		const sources = data.results.map((r) => {
			const url = r.url || "";
			const markdown = r.markdown || "";
			const title = (r.data?.metadata?.title || r.data?.title || "") || "";
			const links = (r.data?.links || []).map((l) => (typeof l === "string" ? l : l?.url || l)).filter(Boolean);
			return { url, markdown, title, links };
		});
		const errors = data.results.filter((r) => r.success === false).map((r) => r.error || r.url);
		return { sources, errors };
	}

	return { sources: [], errors: ["Unexpected scrape API response"] };
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
    { "type": "crawl-url" | "scrape" | ... , "label": "...", "params": { "urls": [...], "url": "...", "takeScreenshot": true, "scrapeContent": true } },
    { "type": "blog" | "article" | "table" | ... , "label": "...", "params": { "urls": [...], "prompt": "...", "useCrawlResult": true } }
  ],
  "message": "Friendly summary of what you will do (never ask user for URLs)",
  "shouldExecute": true | false
}

Rules:
- When "URLs found: none", infer at least one URL and set params.urls.
- crawl-url: one seed URL. Use takeScreenshot and scrapeContent when user wants screenshots or full content.
- For "screenshot of N products/sites" or "scrape X": add crawl-url + an output task (blog/article by default, or table if user said "table"). Set useCrawlResult: true on the output task.
- table: add when user says "table", "create a table", "extract as table". Set prompt describing columns. useCrawlResult: true so executor uses crawl data.
- blog / article: default output when user does not specify table/newsletter/etc. useCrawlResult: true when paired with crawl-url.
- newsletter / substack / linkedin / twitter: only when user explicitly asks for that format.
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
const MAX_SOURCE_CHARS_LONG = 20000;   // newsletter, blog, article
const MAX_SOURCE_CHARS_TABLE_TOTAL = 28000;
const MAX_SOURCE_CHARS_SUBSTACK = 12000;
const MAX_SOURCE_CHARS_LINKEDIN = 8000;
const MAX_SOURCE_CHARS_TWITTER = 4000;

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
			if (!sources || sources.length === 0) return prompt || "Write a newsletter.";
			const blocks = sources.map(
				(s, i) => `--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, MAX_SOURCE_CHARS_LONG)}`,
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
			const perSource = Math.floor(MAX_SOURCE_CHARS_TABLE_TOTAL / Math.max(sources.length, 1));
			const combined = (sources || [])
				.map((s, i) => `--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, perSource)}`)
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
			if (!sources || sources.length === 0) return prompt || "Write a blog post.";
			const blocks = sources.map(
				(s, i) => `--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, MAX_SOURCE_CHARS_LONG)}`,
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
			if (!sources || sources.length === 0) return prompt || "Write an article.";
			const blocks = sources.map(
				(s, i) => `--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, MAX_SOURCE_CHARS_LONG)}`,
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
			if (!sources || sources.length === 0) return prompt || "Write a Substack post.";
			const blocks = sources.map(
				(s, i) => `--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, MAX_SOURCE_CHARS_SUBSTACK)}`,
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
			if (!sources || sources.length === 0) return prompt || "Write a LinkedIn post.";
			const blocks = sources.map(
				(s, i) => `--- Source ${i + 1}: ${s.url} ---\n\n${(s.markdown || "").slice(0, MAX_SOURCE_CHARS_LINKEDIN)}`,
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
				(s, i) => `--- Source ${i + 1}: ${s.url} ---\n\n${(s.markdown || "").slice(0, MAX_SOURCE_CHARS_TWITTER)}`,
			);
			return `Angle: ${prompt || "Tweet"}\n\nContent:\n\n${blocks.join("\n\n")}`;
		},
	},
	// API-only: executed via /crawl-url (takeScreenshot + scrapeContent params cover screenshots and nested content)
	"crawl-url": {
		maxTokens: 1,
		buildSystemPrompt: () => "N/A",
		buildUserContent: () => "N/A",
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
};

export {
	URL_REGEX,
	MAX_URLS,
	extractUrlsFromText,
	scrapeUrlsViaApi,
	ROUTER_SYSTEM_PROMPT,
	parseAgentResponse,
	SKILLS,
	TASK_TYPES,
	CREDITS,
};
