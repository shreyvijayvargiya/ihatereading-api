import { readFile } from "fs/promises";
import path from "path";
import { prompts } from "../ai-examples/simba-ui-ux/prompts/prompts.js";

const MAX_DESIGN_THEME_CHARS = 32_000;

function normalizeVariantToken(s) {
	return String(s || "")
		.toLowerCase()
		.trim()
		.replace(/[\s_]+/g, "-");
}

function getPromptMarkdownText(entry) {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry.prompt === "string") return entry.prompt;
	return "";
}

/** Resolve prompts.js key from camelCase key or slug name (e.g. swissMinimilistic | swiss-minimilistic). */
export function resolvePromptKey(variantRaw) {
	const v = normalizeVariantToken(variantRaw);
	if (!v) return null;
	for (const [key, entry] of Object.entries(prompts)) {
		if (normalizeVariantToken(key) === v) return key;
		const name = typeof entry === "object" && entry?.name ? entry.name : "";
		if (name && normalizeVariantToken(name) === v) return key;
	}
	return null;
}

/**
 * Remove MDX tail sections that target HTML/JSON codegen (not image-to-code React output).
 */
export function stripMdxOutputSection(markdown) {
	let text = String(markdown || "").trimEnd();
	const patterns = [
		/────────────────────────────────────────\s*\n\s*\[OUTPUT FORMAT[\s\S]*$/i,
		/\[OUTPUT FORMAT[\s\S]*$/i,
	];
	for (const re of patterns) {
		if (re.test(text)) {
			text = text.replace(re, "").trimEnd();
			break;
		}
	}
	return text;
}

/** Adapt theme MDX for React image-to-code (strip JSON/HTML output specs). */
export function prepareDesignThemeMarkdown(rawMarkdown) {
	let text = stripMdxOutputSection(rawMarkdown);
	if (text.length > MAX_DESIGN_THEME_CHARS) {
		text = `${text.slice(0, MAX_DESIGN_THEME_CHARS)}\n\n<!-- design system truncated for context limits -->`;
	}
	return text;
}

/** Lightweight theme list (no HTML) — used in error payloads. */
export function listDesignThemes() {
	return Object.entries(prompts).map(([key, entry]) => ({
		key,
		name: entry?.name || key,
	}));
}

/** Theme list with preview HTML and MDX design prompt per theme. */
export async function listDesignThemesWithPreviews(themeHtmlDir) {
	const themes = [];
	for (const [key, entry] of Object.entries(prompts)) {
		const slug = entry?.name || key;
		const filePath = path.join(themeHtmlDir, `${slug}.html`);
		const rawMdx = getPromptMarkdownText(entry);
		let previewHtml = "";
		try {
			previewHtml = await readFile(filePath, "utf-8");
		} catch {
			previewHtml = "";
		}
		themes.push({
			key,
			name: slug,
			previewHtml,
			mdxPrompt: prepareDesignThemeMarkdown(rawMdx),
		});
	}
	return themes;
}

/**
 * @param {string} designTheme - prompts.js key or slug name
 */
export function resolveImageToCodeDesignTheme(designTheme) {
	const raw = String(designTheme || "").trim();
	if (!raw) {
		return { ok: false, error: "designTheme is empty" };
	}

	const key = resolvePromptKey(raw);
	if (!key) {
		return {
			ok: false,
			error: `Unknown designTheme "${raw}". Use a key from prompts.js (e.g. swissMinimilistic) or slug (e.g. swiss-minimilistic).`,
			validThemes: listDesignThemes(),
		};
	}

	const entry = prompts[key];
	const rawMarkdown = getPromptMarkdownText(entry);
	if (!rawMarkdown.trim()) {
		return {
			ok: false,
			error: `Design theme "${key}" has no prompt content.`,
		};
	}

	return {
		ok: true,
		key,
		name: entry?.name || key,
		designMarkdown: prepareDesignThemeMarkdown(rawMarkdown),
	};
}

/**
 * Inject selected design system into image-to-code system prompt.
 */
export function buildDesignThemePromptSection({ key, name, designMarkdown }) {
	return `SELECTED DESIGN THEME (user chose "${name}", key: ${key}):
- Reproduce the SCREENSHOT layout, structure, labels, copy, and component hierarchy faithfully.
- Apply colours, typography, border radii, shadows, spacing rhythm, and visual personality from the design system below.
- When screenshot neutrals conflict with the theme palette, the THEME wins for styling (user explicitly selected it).
- Translate any HTML/data-lucide/Unsplash guidance in the theme to React + Tailwind + lucide-react.
- IGNORE any removed "OUTPUT FORMAT" / JSON / multi-page HTML instructions from the theme — your only output is ONE React component file.

<design_system>
${designMarkdown}
</design_system>`;
}

const EXISTING_CODE_MIN_CHARS = 80;
const REDESIGN_CODE_MAX_CHARS = 48_000;

export function clipReactCodeForPrompt(code, label = "truncated") {
	const t = String(code).replace(/\r\n/g, "\n").trim();
	if (t.length <= REDESIGN_CODE_MAX_CHARS) return t;
	return `${t.slice(0, REDESIGN_CODE_MAX_CHARS)}\n\n/* … ${label} … */`;
}

const IMAGE_TO_CODE_REDESIGN_SYSTEM_BASE = `You are an expert frontend engineer. Restyle an EXISTING React component to match a new design theme.

TASK:
- Keep the same layout structure, sections, labels, copy, interactive behaviour, and component hierarchy.
- Change ONLY visual styling: colours, typography, border radii, shadows, spacing rhythm, icons treatment, and decorative patterns per the design system.
- Do NOT remove sections, rename buttons, or change user-visible text unless the optional user prompt asks for it.
- Output ONE complete default-exported React component file — full replacement, not a diff.
n
OUTPUT FORMAT (strict):
- JavaScript only — NO TypeScript. Plain JSX React.
- Output ONLY raw code — no markdown fences, no explanations, no comments.
- NEVER wrap output in markdown code fences. Forbidden: \`\`\`jsx, \`\`\`javascript, \`\`\`js, \`\`\`react, or any \`\`\` line. Do NOT start with \`\`\` or end with \`\`\`.
- First line MUST be valid code (import, const, or function). Last line MUST be export default — never a closing fence.
- Tailwind CSS utility classes only; lucide-react and react-icons for icons.
- No placeholder image URLs — use lucide/react-icons for avatars and thumbnails.
- Every import, handler, and state variable must be defined; file must compile in Vite/CRA.
- Balanced braces/tags; never truncate mid-component.`;

/**
 * Build OpenRouter messages for apply-theme / redesign endpoint.
 */
export function buildImageToCodeRedesignMessages({
	existingCode,
	designThemeMeta,
	prompt = "",
}) {
	const codeClipped = clipReactCodeForPrompt(existingCode, "existing code truncated");
	let userMessage = `# CURRENT REACT CODE (preserve structure & copy — restyle only)\n\n${codeClipped}\n\n---\n\nApply the design theme below to this component. Output the full updated file.`;
	if (prompt && String(prompt).trim()) {
		userMessage += `\n\n## Additional instructions\n\n${String(prompt).trim()}`;
	}

	const cachedBlock = `${IMAGE_TO_CODE_REDESIGN_SYSTEM_BASE}\n\n${buildDesignThemePromptSection(designThemeMeta)}`;

	return [
		{
			role: "user",
			content: [
				{
					type: "text",
					text: cachedBlock,
					cache_control: { type: "ephemeral" },
				},
				{ type: "text", text: userMessage },
			],
		},
	];
}

export { EXISTING_CODE_MIN_CHARS };
