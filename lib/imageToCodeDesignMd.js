/**
 * DESIGN.md extraction agent for image-to-code family (screenshot → design system doc).
 */

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_DESIGN_MD_MODEL = "google/gemini-2.5-flash";
const DESIGN_MD_MAX_TOKENS = 8192;

export const DESIGN_MD_SYSTEM_PROMPT = `You are a senior product designer and design-systems architect. Analyze a UI screenshot (or existing React UI code) and produce a complete DESIGN.md document that captures its visual language so engineers can rebuild or extend the interface consistently.

OUTPUT FORMAT (strict):
- Output ONLY raw Markdown — no code fences, no \`\`\`markdown wrapper, no preamble, no closing commentary.
- Start with a single H1 title (# Name) — invent a short evocative product/theme name from the UI (e.g. Genesis, Meridian, Slate).
- Use exactly these H2 sections in order (omit none):
  ## Overview
  ## Colors
  ## Typography
  ## Elevation
  ## Components
  ## Spacing
  ## Border Radius
  ## Do's and Don'ts

SECTION RULES:
- **Overview**: 2–4 sentences on mood, audience, density, and personality. Be specific, not generic.
- **Colors**: Bullet list. Each line: \`- **Token Name** (#HEX): usage — short note\`. Sample at least 8 tokens from the UI (primary, hover, neutrals, background, surface, text, border, semantic states). Use real hex values sampled from the screenshot.
- **Typography**: Name display/body/mono fonts (infer from visual style if unknown; suggest Google Fonts or Fontshare pairings). Include weights, letter-spacing, and a type scale with px sizes.
- **Elevation**: How shadows, borders, blur, and hover lifts work — be concrete (e.g. "0 8px 30px rgba(0,0,0,0.08) on card hover").
- **Components**: Bullets for buttons, cards, inputs, nav, chips, lists, etc. that appear in the UI. Include radius, padding, and interaction notes.
- **Spacing**: Base unit, scale, section spacing, container max-width.
- **Border Radius**: Map px values to use cases (buttons, cards, avatars).
- **Do's and Don'ts**: At least 8 bullets — practical guardrails for maintaining this system.

QUALITY:
- Derive values FROM THE IMAGE — do not paste a generic SaaS palette unless the UI uses one.
- Prefer exact hex over Tailwind token names.
- Write for engineers implementing React + Tailwind.`;

export const DESIGN_MD_APPLY_THEME_SYSTEM_PROMPT = `You are a senior product designer and design-systems architect. Produce a complete DESIGN.md for a design theme that was just applied to an existing React UI.

The user selected a named theme (e.g. flat-design, neo-brutalism). Your job is to document that theme's design system AS IMPLEMENTED in the themed React output — colors, typography, elevation, components, spacing, and radius tokens engineers should follow going forward.

OUTPUT FORMAT (strict):
- Output ONLY raw Markdown — no code fences, no preamble.
- H1 title: use the theme name or an evocative name derived from the applied theme (e.g. # Flat Design, # Neo Brutalism).
- Use exactly these H2 sections in order:
  ## Overview
  ## Colors
  ## Typography
  ## Elevation
  ## Components
  ## Spacing
  ## Border Radius
  ## Do's and Don'ts

RULES:
- Prioritize concrete values from the THEMED REACT CODE (Tailwind classes, arbitrary hex, font families).
- Cross-reference the theme MDX reference provided — align tokens with the theme's intended personality.
- Colors: at least 8 bullets with **Token** (#HEX): usage.
- Do's and Don'ts: guardrails specific to THIS theme (not generic advice).
- If a screenshot is attached, use it for layout/component inventory only — tokens come from the themed code + theme reference.`;

const MD_OPENING_FENCE_RE = /^\s*```(?:markdown|md)?\s*\r?\n?/;
const MD_CLOSING_FENCE_RE = /\r?\n?```\s*$/;

export function stripDesignMdFences(text) {
	let t = String(text ?? "").trim();
	t = t.replace(MD_OPENING_FENCE_RE, "");
	t = t.replace(MD_CLOSING_FENCE_RE, "");
	return t.trim();
}

/** @param {...unknown} values */
export function parseDesignMdFlag(...values) {
	for (const v of values) {
		if (v === true || v === 1) return true;
		if (typeof v === "string") {
			const s = v.trim().toLowerCase();
			if (s === "true" || s === "1" || s === "yes") return true;
		}
	}
	return false;
}

export function buildDesignMdMessagesFromImage({
	mimeType,
	base64Data,
	userHint = "",
}) {
	let text =
		"Analyze the attached UI screenshot and write a complete DESIGN.md following the required section structure. Extract real colors, typography, spacing, and component patterns visible in the image.";
	if (userHint && String(userHint).trim()) {
		text += `\n\nAdditional context from the user:\n${String(userHint).trim()}`;
	}
	return [
		{ role: "system", content: DESIGN_MD_SYSTEM_PROMPT },
		{
			role: "user",
			content: [
				{ type: "text", text },
				{
					type: "image_url",
					image_url: {
						url: `data:${mimeType};base64,${base64Data}`,
					},
				},
			],
		},
	];
}

export function buildDesignMdMessagesFromCode({ code, userHint = "" }) {
	let text = `Analyze the React UI code below and write a complete DESIGN.md following the required section structure. Infer the design system (colors as hex, typography, spacing, components) from classNames and structure.\n\n---\n\n${String(code).trim()}`;
	if (userHint && String(userHint).trim()) {
		text += `\n\n## Additional context\n\n${String(userHint).trim()}`;
	}
	return [
		{ role: "system", content: DESIGN_MD_SYSTEM_PROMPT },
		{ role: "user", content: text },
	];
}

const APPLY_THEME_CODE_MAX_CHARS = 32_000;

/**
 * DESIGN.md for apply-theme — documents the newly applied theme from themed output + theme MDX.
 */
export function buildDesignMdMessagesForApplyTheme({
	designThemeMeta,
	themedCode,
	userHint = "",
	image,
}) {
	const { key, name, designMarkdown } = designThemeMeta;
	let codeBlock = String(themedCode ?? "").trim();
	if (codeBlock.length > APPLY_THEME_CODE_MAX_CHARS) {
		codeBlock = `${codeBlock.slice(0, APPLY_THEME_CODE_MAX_CHARS)}\n\n<!-- themed code truncated -->`;
	}

	let text = `Write DESIGN.md for the applied theme "${name}" (key: ${key}).

The React code below is the UI AFTER this theme was applied. Extract real token values (hex colors, fonts, radii, shadows, spacing) from it.

<theme_reference>
${designMarkdown}
</theme_reference>

<themed_react_code>
${codeBlock}
</themed_react_code>`;

	if (userHint && String(userHint).trim()) {
		text += `\n\n## Additional context\n\n${String(userHint).trim()}`;
	}

	const userContent = image?.base64Data
		? [
				{
					type: "text",
					text: `${text}\n\n(Optional) Screenshot of the original UI for component/layout context.`,
				},
				{
					type: "image_url",
					image_url: {
						url: `data:${image.mimeType};base64,${image.base64Data}`,
					},
				},
			]
		: text;

	return [
		{ role: "system", content: DESIGN_MD_APPLY_THEME_SYSTEM_PROMPT },
		{ role: "user", content: userContent },
	];
}

/**
 * Run DESIGN.md generation after themed code is assembled (apply-theme).
 */
export async function runDeferredDesignMdStream({
	controller,
	encoder,
	apiKey,
	messages,
	model = DEFAULT_DESIGN_MD_MODEL,
	sessionId,
	xTitle = "IHateReading Image-to-Code Apply Theme Design MD",
}) {
	const upstreamRes = await startDesignMdOpenRouterStream({
		apiKey,
		messages,
		model,
		sessionId,
		xTitle,
	});
	const result = await pipeDesignMdSseToClient(controller, encoder, upstreamRes);
	return { result, messages };
}

/**
 * Start a streaming OpenRouter request for DESIGN.md generation.
 */
export async function startDesignMdOpenRouterStream({
	apiKey,
	messages,
	model = DEFAULT_DESIGN_MD_MODEL,
	sessionId,
	xTitle = "IHateReading Image-to-Code Design MD",
}) {
	return fetch(OPENROUTER_CHAT_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			"HTTP-Referer": "https://ihatereading.in",
			"X-Title": xTitle,
		},
		body: JSON.stringify({
			model,
			stream: true,
			messages,
			temperature: 0.35,
			max_tokens: DESIGN_MD_MAX_TOKENS,
			...(sessionId ? { session_id: sessionId } : {}),
		}),
	});
}

/**
 * Pipe OpenRouter DESIGN.md SSE to client events.
 * @returns {Promise<{ content: string, usage: object|null, model: string|null }|null>}
 */
export async function pipeDesignMdSseToClient(controller, encoder, upstreamRes) {
	if (!upstreamRes?.ok) {
		let detail = `OpenRouter ${upstreamRes?.status || "error"}`;
		try {
			const errJson = await upstreamRes.json();
			detail = errJson?.error?.message || detail;
		} catch {}
		controller.enqueue(
			encoder.encode(
				`data: ${JSON.stringify({ type: "design_md_error", error: detail })}\n\n`,
			),
		);
		return null;
	}

	const reader = upstreamRes.body.getReader();
	const decoder = new TextDecoder();
	let sseBuffer = "";
	let assembled = "";
	let usageRaw = null;
	let streamModel = null;

	controller.enqueue(
		encoder.encode(`data: ${JSON.stringify({ type: "design_md_start" })}\n\n`),
	);

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			sseBuffer += decoder.decode(value, { stream: true });
			const lines = sseBuffer.split("\n");
			sseBuffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data: ")) continue;

				const payload = trimmed.slice(6);
				if (payload === "[DONE]") continue;

				let parsed;
				try {
					parsed = JSON.parse(payload);
				} catch {
					continue;
				}

				if (parsed?.error) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({
								type: "design_md_error",
								error: parsed.error.message || "OpenRouter error",
							})}\n\n`,
						),
					);
					return null;
				}

				if (parsed?.usage) usageRaw = parsed.usage;
				if (parsed?.model) streamModel = parsed.model;

				const delta = parsed?.choices?.[0]?.delta?.content ?? null;
				if (delta) {
					assembled += delta;
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: "design_md_delta", delta })}\n\n`,
						),
					);
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	const content = stripDesignMdFences(assembled);
	if (content) {
		controller.enqueue(
			encoder.encode(
				`data: ${JSON.stringify({ type: "design_md_final", designMd: content })}\n\n`,
			),
		);
	}

	return { content, usage: usageRaw, model: streamModel };
}

/**
 * Merge code + design-md usage for the final openrouter_meta SSE event.
 */
export function buildImageToCodeCombinedMeta({
	codeMessages,
	codeUsageRaw,
	codeModel,
	designMdMessages,
	designMdResult,
	normalizeUsage,
	toTokenUsageCamel,
	truncateMessages,
}) {
	const codeUsage = codeUsageRaw
		? normalizeUsage({ usage: codeUsageRaw })
		: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

	const base = {
		type: "openrouter_meta",
		usage: codeUsage,
		tokenUsage: toTokenUsageCamel(codeUsage),
		model: codeModel || "",
		aiPrompt: truncateMessages(codeMessages),
	};

	if (!designMdResult?.content && !designMdResult?.usage) {
		return base;
	}

	const mdUsage = designMdResult.usage
		? normalizeUsage({ usage: designMdResult.usage })
		: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

	const combined = {
		prompt_tokens: codeUsage.prompt_tokens + mdUsage.prompt_tokens,
		completion_tokens: codeUsage.completion_tokens + mdUsage.completion_tokens,
		total_tokens: codeUsage.total_tokens + mdUsage.total_tokens,
	};

	return {
		...base,
		designMd: {
			content: designMdResult.content || "",
			usage: mdUsage,
			tokenUsage: toTokenUsageCamel(mdUsage),
			model: designMdResult.model || "",
			aiPrompt: designMdMessages
				? truncateMessages(designMdMessages)
				: undefined,
		},
		usageCombined: combined,
		tokenUsageCombined: toTokenUsageCamel(combined),
	};
}

export function buildImageToCodeCombinedMetaWithSource(
	metaArgs,
	sourceCapture,
) {
	const meta = buildImageToCodeCombinedMeta(metaArgs);
	if (!sourceCapture?.pageUrl && !sourceCapture?.screenshotUrl) {
		return meta;
	}
	return {
		...meta,
		sourceCapture: {
			pageUrl: sourceCapture.pageUrl || null,
			screenshotUrl: sourceCapture.screenshotUrl || null,
			imageUrl: sourceCapture.screenshotUrl || null,
		},
	};
}
