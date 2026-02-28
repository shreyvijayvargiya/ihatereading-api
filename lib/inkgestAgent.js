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

	let res;
	if (validUrls.length === 1) {
		res = await fetch(`${baseUrl}/scrape`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...body, url: validUrls[0] }),
		});
	} else {
		res = await fetch(`${baseUrl}/scrape-multiple`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
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
const ROUTER_SYSTEM_PROMPT = `You are InkAgent. Given a user message and a list of URLs (already extracted), decide what to do.

Respond with JSON only (no markdown fences):
{
  "thinking": "Brief reasoning",
  "suggestedTasks": [
    {
      "type": "newsletter" | "scrape" | "table" | "blog" | "substack" | "linkedin" | "twitter" | "article",
      "label": "Short label",
      "params": {
        "urls": ["use the provided URLs that apply"],
        "prompt": "user's angle/instructions",
        "format": "substack",
        "style": "casual"
      }
    }
  ],
  "message": "Friendly summary",
  "shouldExecute": true | false
}

Rules:
- Use the URLs provided; they are already extracted.
- newsletter: prompt required, urls optional. format can be substack, beehiiv, etc. style: casual, professional.
- scrape: need at least one url. Just return scraped content.
- table: need urls + prompt describing columns to extract.
- blog / article: long-form post from scraped content; prompt = angle.
- substack / linkedin / twitter: short-form post; prompt = angle, format implies platform.
- shouldExecute true only when intent is clear.
- Max 10 URLs per task.`;

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
