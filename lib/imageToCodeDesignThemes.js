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

/** Dropdown list: same keys as prompts.js for frontend. */
export function listDesignThemes() {
	return Object.entries(prompts).map(([key, entry]) => ({
		key,
		name: entry?.name || key,
	}));
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
