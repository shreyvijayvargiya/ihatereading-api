import { Hono } from "hono";
import { serve } from "@hono/node-server";
import OpenAI from "openai";
import { cors } from "hono/cors";
import dotenv from "dotenv";
import { uiBlockLibrary } from "../tailwind-ui-blocks.js";
import { templates } from "../templates.js";
import { prompts } from "./prompts/prompts.js";

dotenv.config();

const port = Number(process.env.PORT) || 4001;

const openai = new OpenAI({
	baseURL: "https://openrouter.ai/api/v1",
	apiKey: process.env.OPENROUTER_API_KEY,
});

// Cache for embeddings
let templateEmbeddingsCache = null;
let blockEmbeddingsCache = null;
let promptEmbeddingsCache = null;

async function getEmbedding(text) {
	if (!text || typeof text !== "string") {
		console.warn("getEmbedding: Invalid or empty text provided.");
		return null;
	}
	try {
		const response = await openai.embeddings.create({
			model: "openai/text-embedding-3-small",
			input: text,
		});
		if (
			response &&
			response.data &&
			Array.isArray(response.data) &&
			response.data[0] &&
			response.data[0].embedding
		) {
			return response.data[0].embedding;
		}
		console.error(
			"Embedding API returned unexpected format. Full response:",
			JSON.stringify(response, null, 2),
		);
		return null;
	} catch (error) {
		console.error("Embedding API error:", error);
		return null;
	}
}

async function getTemplateEmbeddings() {
	if (templateEmbeddingsCache) return templateEmbeddingsCache;
	const embeddings = {};
	for (const [key, template] of Object.entries(templates)) {
		const text = `${template.category} ${template.keywords.join(" ")}`;
		const embedding = await getEmbedding(text);
		if (embedding) embeddings[key] = embedding;
	}
	templateEmbeddingsCache = embeddings;
	return embeddings;
}

async function getBlockEmbeddings() {
	if (blockEmbeddingsCache) return blockEmbeddingsCache;
	const embeddings = [];
	for (let i = 0; i < uiBlockLibrary.length; i++) {
		const block = uiBlockLibrary[i];
		const text = `${block.name} ${block.tags.join(" ")}`;
		const embedding = await getEmbedding(text);
		if (embedding) embeddings.push({ index: i, embedding });
	}
	blockEmbeddingsCache = embeddings;
	return embeddings;
}

function getPromptMarkdownText(entry) {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry.prompt === "string") return entry.prompt;
	return "";
}

async function getPromptEmbeddings() {
	if (promptEmbeddingsCache) return promptEmbeddingsCache;
	const embeddings = {};
	for (const [key, promptObj] of Object.entries(prompts)) {
		const raw = getPromptMarkdownText(promptObj);
		const text = raw.slice(0, 500).replace(/<[^>]*>/g, "") || "";
		const embedding = await getEmbedding(text);
		if (embedding) embeddings[key] = embedding;
	}
	promptEmbeddingsCache = embeddings;
	return embeddings;
}

function cosineSimilarity(a, b) {
	if (!a?.length || !b?.length || a.length !== b.length) return -1;
	let dot = 0,
		na = 0,
		nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}

function normalizeVariantToken(s) {
	return String(s || "")
		.toLowerCase()
		.trim()
		.replace(/[\s_]+/g, "-");
}

/** Resolve prompts key from API variant (camelCase key, slug, or display name). */
function resolvePromptKey(variantRaw) {
	const v = normalizeVariantToken(variantRaw);
	if (!v) return null;
	for (const [key, entry] of Object.entries(prompts)) {
		if (normalizeVariantToken(key) === v) return key;
		const name = typeof entry === "object" && entry?.name ? entry.name : "";
		if (name && normalizeVariantToken(name) === v) return key;
	}
	return null;
}

async function resolveDesignMarkdown({ variant, theme }) {
	if (variant) {
		const key = resolvePromptKey(variant);
		if (!key) {
			return {
				ok: false,
				error: `Unknown design variant "${variant}". Use a key or slug from prompts (e.g. neoBrutalism, neo-brutalism).`,
			};
		}
		const text = getPromptMarkdownText(prompts[key]);
		if (!text.trim()) {
			return { ok: false, error: `Design markdown is empty for variant "${key}".` };
		}
		return { ok: true, promptKey: key, designMarkdown: text };
	}

	const themeText = typeof theme === "string" ? theme.trim() : "";
	if (!themeText) {
		return {
			ok: false,
			error:
				'Provide `variant` (prompts key or slug) or `theme` (short natural-language design style) to select a design MDX.',
		};
	}

	const queryVec = await getEmbedding(themeText);
	if (!queryVec) {
		return { ok: false, error: "Could not embed `theme` for design selection." };
	}

	const cache = await getPromptEmbeddings();
	let bestKey = null;
	let bestScore = -1;
	for (const [key, vec] of Object.entries(cache)) {
		const s = cosineSimilarity(queryVec, vec);
		if (s > bestScore) {
			bestScore = s;
			bestKey = key;
		}
	}

	if (bestKey === null || bestScore < 0.25) {
		return {
			ok: false,
			error:
				"No confident design match for `theme`. Pass an explicit `variant` or a clearer `theme` description.",
		};
	}

	const designMarkdown = getPromptMarkdownText(prompts[bestKey]);
	return {
		ok: true,
		promptKey: bestKey,
		designMarkdown,
		matchedScore: bestScore,
	};
}

/** Mirrors index.js codegen constraints; kept in system message (compact task lines, no long section recipes). */
const CODEGEN_CRITICAL_HTML = `CRITICAL OUTPUT FORMAT — HTML ONLY:
- Your ENTIRE response must be ONE complete HTML5 document. First line MUST be <!DOCTYPE html> (or start with <html).
- Put <script src="https://cdn.tailwindcss.com"></script> in <head> before </head>.
- FORBIDDEN: React, JSX, import/export, lucide-react, framer-motion, or .tsx syntax.
- Use semantic HTML, Tailwind utility classes only, inline SVG or Unicode icons as needed.

`;

const CODEGEN_CRITICAL_REACT = `CRITICAL OUTPUT FORMAT — REACT / JSX ONLY:
- Your ENTIRE response must be ONE file: a default-exported React functional component (JSX).
- FORBIDDEN: <!DOCTYPE html> or a full HTML document as the only output.
- Use Tailwind. You may import from "lucide-react" and "framer-motion" when appropriate.

`;

const OUTPUT_TYPE_HINT = {
	landing: "Full marketing landing: sticky nav, hero, social proof, features, how-it-works, pricing, FAQ, footer.",
	app: "Single app shell: sidebar + main (top bar + content); product-style hierarchy.",
	page: "Lighter page: hero, 2–3 sections, CTA, compact footer.",
	mobile: "Mobile-first: max-w-md / sm breakpoints, large tap targets, bottom nav or drawer where it fits.",
};

/** Keeps generated UIs shippable: real copy, responsive layout, accessible interaction, no brittle assets. */
const IMPLEMENTATION_QUALITY_RULES = `Implementation quality:
- Responsive layout is mandatory: use Tailwind breakpoints (e.g. sm:, md:, lg:), fluid widths (w-full, max-w-*, min-h-0 where needed), and flex/grid that reflows on small screens—never ship a layout that only works at one desktop width.
- Avoid images: do not use <img>, src="…" photos, or external image URLs. Prefer inline SVG, lucide-react icons in React, or simple vector/icon treatments so the UI never depends on missing assets.
- Every visible piece of UI must be finished: all nav links, headings, labels, buttons, cards, features, and list items need concrete, readable text that reflects the user’s build request—no empty tags, no “Title”/“Description” placeholders, and no lorem ipsum.

Semantics, accessibility, and resilient layout:
- Use semantic elements: header/nav/main/section/footer where appropriate; one clear <h1> (or single top-level heading) per screen, then h2/h3 without skipping levels.
- Clickable controls must be real <button type="button"> (or type="submit" in forms) or <a href="…"> with a purposeful URL—never a bare <div onClick>. Icon-only buttons need aria-label (or visually hidden text).
- Every input, select, and textarea needs an associated <label htmlFor> (React) or matching for/id (HTML), or explicit aria-label—no orphan fields.
- All interactive elements need visible focus styles (e.g. focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none) and comfortable hit targets (at least ~44px min height/width on touch areas via padding or min-h-11/min-w-11).
- Flex/grid hygiene: use min-w-0 on flex children that should shrink or truncate; use overflow-x-hidden on the page wrapper when horizontal scroll would break mobile; use line-clamp-* only when copy should truncate, not as an excuse to omit text.
- Motion: keep animations subtle; prefer CSS transitions or light framer-motion; respect prefers-reduced-motion with motion-reduce:transition-none motion-reduce:animate-none where you add transitions/animation classes.
- Do not rely on color alone for state (errors, success)—pair with text, icons, or borders. Ensure contrast stays readable against the design system’s backgrounds.`;

function buildDesignAwareSystemPrompt(format, outputType, options = {}) {
	const { siblingPage } = options;
	const isHtml = format === "html";
	const critical = isHtml ? CODEGEN_CRITICAL_HTML : CODEGEN_CRITICAL_REACT;
	const hint = OUTPUT_TYPE_HINT[outputType] || OUTPUT_TYPE_HINT.page;
	const fmtRules =
		format === "react"
			? "Tailwind only; one default export; import React if needed."
			: "One HTML file; Tailwind CDN in <head>; utility classes only.";
	const siblingBlock = siblingPage
		? `

Multi-page / sibling: The user may include a reference page from the same product. Reuse its Tailwind habits (spacing, radii, shadows, type scale), nav/header branding, and tone so the new file feels like the same site—while still delivering a complete new page for the described role (not a copy-paste of unrelated sections).`
		: "";
	return `${critical}You are an expert frontend engineer. The user message starts with an authoritative DESIGN SYSTEM (markdown from our MDX library). Follow it strictly for colors, typography, surfaces, and patterns—do not invent a different visual language unless the design doc explicitly allows choices.

${IMPLEMENTATION_QUALITY_RULES}

Task shape: ${hint}
${fmtRules}${siblingBlock}

Output ONLY raw code — no markdown fences, no explanation before or after.`;
}

function buildDesignUpdateSystemPrompt(format, outputType) {
	const base = buildDesignAwareSystemPrompt(format, outputType);
	return `${base}

Editing mode: The user message includes CURRENT SOURCE CODE. Apply the change request and output ONE complete updated file in the same format (React or HTML). Keep parts that still apply; change only what is needed plus any necessary follow-on edits for consistency. No diffs, no partial-only snippets, no commentary—full file only.`;
}

/** Large pastes from prior codegen; clipped to protect context limits. */
const CODE_CONTEXT_MAX_CHARS = 48_000;
const EXISTING_CODE_MIN_CHARS = 80;

function clipCodeForPrompt(code, labelForTruncation = "truncated") {
	const t = String(code).replace(/\r\n/g, "\n").trim();
	if (t.length <= CODE_CONTEXT_MAX_CHARS) return t;
	return `${t.slice(0, CODE_CONTEXT_MAX_CHARS)}\n\n/* … ${labelForTruncation} … */`;
}

function streamOpenRouterSseToPlainText(openRouterBody) {
	const encoder = new TextEncoder();
	const upstreamReader = openRouterBody.getReader();
	const upstreamDecoder = new TextDecoder();
	return new ReadableStream({
		async start(controller) {
			let sseBuffer = "";
			try {
				while (true) {
					const { done, value } = await upstreamReader.read();
					if (done) break;

					sseBuffer += upstreamDecoder.decode(value, { stream: true });
					const lines = sseBuffer.split("\n");
					sseBuffer = lines.pop();

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed.startsWith("data: ")) continue;

						const payload = trimmed.slice(6);
						if (payload === "[DONE]") {
							controller.close();
							return;
						}

						let parsed;
						try {
							parsed = JSON.parse(payload);
						} catch {
							continue;
						}

						if (parsed?.error) {
							const errMsg =
								typeof parsed.error === "string"
									? parsed.error
									: parsed.error.message || "OpenRouter error";
							controller.enqueue(encoder.encode(errMsg));
							controller.close();
							return;
						}

						const delta = parsed?.choices?.[0]?.delta?.content ?? null;
						if (delta) {
							controller.enqueue(encoder.encode(delta));
						}
					}
				}
				controller.close();
			} catch (err) {
				try {
					controller.enqueue(encoder.encode(err.message));
					controller.close();
				} catch {}
			} finally {
				upstreamReader.releaseLock();
			}
		},
	});
}

async function fetchOpenRouterPlainTextStream({
	openRouterApiKey,
	model,
	messages,
	title,
	temperature = 0.35,
}) {
	let openRouterRes;
	try {
		openRouterRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${openRouterApiKey}`,
				"HTTP-Referer": "https://ihatereading.in",
				"X-Title": title,
			},
			body: JSON.stringify({
				model,
				stream: true,
				messages,
				temperature,
			}),
		});
	} catch (fetchErr) {
		return {
			ok: false,
			status: 502,
			text: `Failed to reach OpenRouter: ${fetchErr.message}`,
		};
	}

	if (!openRouterRes.ok) {
		let detail = `OpenRouter ${openRouterRes.status}`;
		try {
			const errJson = await openRouterRes.json();
			detail = errJson?.error?.message || detail;
		} catch {}
		return { ok: false, status: openRouterRes.status, text: detail };
	}

	return {
		ok: true,
		stream: streamOpenRouterSseToPlainText(openRouterRes.body),
	};
}

function buildCodegenSuccessResponse({
	outputStream,
	format,
	outputType,
	promptKey,
	extraHeaders = {},
}) {
	return new Response(outputStream, {
		status: 200,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
			"X-Codegen-Format": format,
			"X-Codegen-Output-Type": outputType,
			"X-Design-Variant-Key": promptKey,
			...extraHeaders,
		},
	});
}

const app = new Hono();

// Add CORS middleware
app.use(
	"*",
	cors({
		origin: [
			"http://localhost:4001",
			"http://localhost:3000",
			"http://localhost:3001",
		],
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
		credentials: true,
	}),
);

/**
 * POST /codegen-design?format=react|html&outputType=…&model=<optional>
 * Body: { query, prompt?, variant?, theme?, referenceCode? }
 * Optional referenceCode: prior page from same site (e.g. landing) so new pages stay visually aligned.
 * Streams text/plain.
 */
app.post("/codegen-design", async (c) => {
	let body = {};
	try {
		body = await c.req.json();
	} catch {
		return c.text("Invalid JSON body", 400);
	}

	const formatRaw =
		c.req.query("format") ||
		(typeof body.format === "string" ? body.format : "") ||
		"react";
	const format = String(formatRaw).toLowerCase().trim();
	if (format !== "react" && format !== "html") {
		return c.text('format must be "react" or "html"', 400);
	}

	const outputTypeRaw =
		c.req.query("outputType") ||
		(typeof body.outputType === "string" ? body.outputType : "") ||
		"page";
	const outputType = String(outputTypeRaw).toLowerCase().trim();
	const VALID = new Set(["landing", "app", "page", "mobile"]);
	if (!VALID.has(outputType)) {
		return c.text("Invalid outputType. Allowed: landing, app, page, mobile.", 400);
	}

	const query =
		typeof body.query === "string"
			? body.query.trim()
			: typeof body.userQuery === "string"
				? body.userQuery.trim()
				: "";
	if (query.length < 10) {
		return c.text(
			"query (or userQuery) must be at least 10 characters",
			400,
		);
	}

	const extraPrompt =
		typeof body.prompt === "string" ? body.prompt.trim() : "";
	const variantRaw =
		c.req.query("variant") ||
		(typeof body.variant === "string" ? body.variant : "") ||
		"";
	const themeRaw =
		c.req.query("theme") ||
		(typeof body.theme === "string" ? body.theme : "") ||
		"";

	const referenceRaw =
		typeof body.referenceCode === "string" ? body.referenceCode : "";
	const hasReference = referenceRaw.trim().length > 0;

	const resolved = await resolveDesignMarkdown({
		variant: variantRaw.trim(),
		theme: themeRaw,
	});
	if (!resolved.ok) {
		return c.text(resolved.error, 400);
	}

	const { designMarkdown, promptKey } = resolved;
	const openRouterApiKey = process.env.OPENROUTER_API_KEY;
	if (!openRouterApiKey) {
		return c.text("OpenRouter API key not configured", 503);
	}

	const model =
		c.req.query("model") ||
		process.env.CODEGEN_MODEL ||
		"google/gemini-2.0-flash-001";

	const systemPrompt = buildDesignAwareSystemPrompt(format, outputType, {
		siblingPage: hasReference,
	});

	let userMessage = `# DESIGN SYSTEM (authoritative — follow this markdown exactly)\n\n${designMarkdown}\n\n---\n`;
	if (hasReference) {
		const refClipped = clipCodeForPrompt(referenceRaw, "reference truncated");
		userMessage += `\n# Reference page (same product or site — align patterns; new page must be a full standalone file)\n\n${refClipped}\n\n---\n`;
	}
	userMessage += `\n# Build request\n\n${query}`;
	if (extraPrompt) {
		userMessage += `\n\n## Additional instructions\n\n${extraPrompt}`;
	}

	const messages = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userMessage },
	];

	const streamResult = await fetchOpenRouterPlainTextStream({
		openRouterApiKey,
		model,
		messages,
		title: "Simba design-aware codegen",
		temperature: 0.35,
	});
	if (!streamResult.ok) {
		return c.text(streamResult.text, streamResult.status);
	}

	return buildCodegenSuccessResponse({
		outputStream: streamResult.stream,
		format,
		outputType,
		promptKey,
		extraHeaders: hasReference
			? { "X-Codegen-Sibling-Reference": "1" }
			: {},
	});
});

/**
 * POST /codegen-design/update — edit code previously produced by /codegen-design (or any matching React/HTML file).
 * Body: { existingCode, query, prompt?, variant?, theme?, format?, outputType? }
 * Streams text/plain full updated file.
 */
app.post("/codegen-design/update", async (c) => {
	let body = {};
	try {
		body = await c.req.json();
	} catch {
		return c.text("Invalid JSON body", 400);
	}

	const formatRaw =
		c.req.query("format") ||
		(typeof body.format === "string" ? body.format : "") ||
		"react";
	const format = String(formatRaw).toLowerCase().trim();
	if (format !== "react" && format !== "html") {
		return c.text('format must be "react" or "html"', 400);
	}

	const outputTypeRaw =
		c.req.query("outputType") ||
		(typeof body.outputType === "string" ? body.outputType : "") ||
		"page";
	const outputType = String(outputTypeRaw).toLowerCase().trim();
	const VALID = new Set(["landing", "app", "page", "mobile"]);
	if (!VALID.has(outputType)) {
		return c.text("Invalid outputType. Allowed: landing, app, page, mobile.", 400);
	}

	const query =
		typeof body.query === "string"
			? body.query.trim()
			: typeof body.userQuery === "string"
				? body.userQuery.trim()
				: "";
	if (query.length < 10) {
		return c.text(
			"query (or userQuery) must be at least 10 characters",
			400,
		);
	}

	const existingCode =
		typeof body.existingCode === "string"
			? body.existingCode
			: typeof body.code === "string"
				? body.code
				: "";
	if (existingCode.trim().length < EXISTING_CODE_MIN_CHARS) {
		return c.text(
			`existingCode (or code) must be at least ${EXISTING_CODE_MIN_CHARS} characters`,
			400,
		);
	}

	const extraPrompt =
		typeof body.prompt === "string" ? body.prompt.trim() : "";
	const variantRaw =
		c.req.query("variant") ||
		(typeof body.variant === "string" ? body.variant : "") ||
		"";
	const themeRaw =
		c.req.query("theme") ||
		(typeof body.theme === "string" ? body.theme : "") ||
		"";

	const resolved = await resolveDesignMarkdown({
		variant: variantRaw.trim(),
		theme: themeRaw,
	});
	if (!resolved.ok) {
		return c.text(resolved.error, 400);
	}

	const { designMarkdown, promptKey } = resolved;
	const openRouterApiKey = process.env.OPENROUTER_API_KEY;
	if (!openRouterApiKey) {
		return c.text("OpenRouter API key not configured", 503);
	}

	const model =
		c.req.query("model") ||
		process.env.CODEGEN_MODEL ||
		"google/gemini-2.0-flash-001";

	const systemPrompt = buildDesignUpdateSystemPrompt(format, outputType);
	const codeClipped = clipCodeForPrompt(existingCode, "existing code truncated");

	let userMessage = `# DESIGN SYSTEM (authoritative — follow this markdown exactly)\n\n${designMarkdown}\n\n---\n\n# Current code (edit this)\n\n${codeClipped}\n\n---\n\n# Change request\n\n${query}`;
	if (extraPrompt) {
		userMessage += `\n\n## Additional instructions\n\n${extraPrompt}`;
	}

	const messages = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userMessage },
	];

	const streamResult = await fetchOpenRouterPlainTextStream({
		openRouterApiKey,
		model,
		messages,
		title: "Simba design-aware codegen update",
		temperature: 0.25,
	});
	if (!streamResult.ok) {
		return c.text(streamResult.text, streamResult.status);
	}

	return buildCodegenSuccessResponse({
		outputStream: streamResult.stream,
		format,
		outputType,
		promptKey,
		extraHeaders: { "X-Codegen-Mode": "update" },
	});
});

serve({
	fetch: app.fetch,
	port,
});
