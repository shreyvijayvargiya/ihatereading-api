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

/** Skill registry: type -> { systemPrompt, maxTokens, parseResponse? } */
const SKILLS = {
	newsletter: {
		maxTokens: 2400,
		buildSystemPrompt: (format = "substack", style = "casual", hasSources) =>
			`You are a newsletter writer. Create a newsletter in ${format} style, ${style} tone.
${hasSources ? "Use the provided scraped content as sources. Cite and synthesize; do not copy verbatim." : "Write based on the user's prompt."}
Output the newsletter body only (no JSON, no markdown fences).`,
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0) return prompt || "Write a newsletter.";
			const blocks = sources.map(
				(s, i) => `--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, 8000)}`,
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
		maxTokens: 2400,
		buildSystemPrompt: () =>
			`You extract structured data from content into a table. Respond with JSON only (no markdown):
{
  "title": "Table title",
  "description": "Brief description",
  "columns": [{"key": "col1", "label": "Column 1"}, ...],
  "rows": [{"col1": "value", "col2": "value"}, ...]
}`,
		buildUserContent: (prompt, sources) => {
			const combined = (sources || [])
				.map((s, i) => `--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, 12000)}`)
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
		maxTokens: 3200,
		buildSystemPrompt: (_, __, hasSources) =>
			hasSources
				? "You are a blog writer. Write a long-form blog post using the scraped content as research. Output the post body only (no JSON, no markdown fences)."
				: "You are a blog writer. Write a long-form blog post from the user's prompt. Output the post body only.",
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0) return prompt || "Write a blog post.";
			const blocks = sources.map(
				(s, i) => `--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, 10000)}`,
			);
			return `Angle/instructions: ${prompt || "General blog"}\n\nContent:\n\n${blocks.join("\n\n")}`;
		},
	},
	article: {
		maxTokens: 3200,
		buildSystemPrompt: (_, __, hasSources) =>
			hasSources
				? "You are an article writer. Write a polished article using the scraped content. Output the article body only (no JSON, no markdown fences)."
				: "You are an article writer. Write an article from the user's prompt. Output the article body only.",
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0) return prompt || "Write an article.";
			const blocks = sources.map(
				(s, i) => `--- Source ${i + 1}: ${s.url} ---\n\n${s.title ? `# ${s.title}\n\n` : ""}${(s.markdown || "").slice(0, 10000)}`,
			);
			return `Angle: ${prompt || "General article"}\n\nContent:\n\n${blocks.join("\n\n")}`;
		},
	},
	substack: {
		maxTokens: 1600,
		buildSystemPrompt: (_, __, hasSources) =>
			hasSources
				? "You write Substack-style newsletter posts. Concise, engaging. Use the scraped content. Output the post body only (no JSON)."
				: "You write Substack-style posts. Output the post body only (no JSON).",
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0) return prompt || "Write a Substack post.";
			const blocks = sources.map(
				(s, i) => `--- Source ${i + 1}: ${s.url} ---\n\n${(s.markdown || "").slice(0, 6000)}`,
			);
			return `Angle: ${prompt || "Substack post"}\n\nContent:\n\n${blocks.join("\n\n")}`;
		},
	},
	linkedin: {
		maxTokens: 800,
		buildSystemPrompt: (_, __, hasSources) =>
			hasSources
				? "You write LinkedIn posts. Professional, engaging, hook + value. Use the scraped content. Output the post only (no JSON)."
				: "You write LinkedIn posts. Output the post only (no JSON).",
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0) return prompt || "Write a LinkedIn post.";
			const blocks = sources.map((s, i) => `--- Source ${i + 1} ---\n${(s.markdown || "").slice(0, 4000)}`);
			return `Angle: ${prompt || "LinkedIn post"}\n\nContent:\n\n${blocks.join("\n\n")}`;
		},
	},
	twitter: {
		maxTokens: 600,
		buildSystemPrompt: (_, __, hasSources) =>
			hasSources
				? "You write Twitter/X posts. Punchy, concise (can be a thread). Use the scraped content. Output the post(s) only (no JSON)."
				: "You write Twitter/X posts. Output the post only (no JSON).",
		buildUserContent: (prompt, sources) => {
			if (!sources || sources.length === 0) return prompt || "Write a tweet.";
			const blocks = sources.map((s, i) => `--- Source ${i + 1} ---\n${(s.markdown || "").slice(0, 3000)}`);
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
