import { isValidHook } from "../config/hooks.js";

/**
 * Lightweight article quality checks (no LLM).
 */
export function validateArticle(article, linkValidation = { issues: [] }) {
	const issues = [...(linkValidation.issues || [])];

	if (!String(article.title || "").trim()) issues.push("Missing title");
	if (!String(article.description || "").trim()) issues.push("Missing description");
	if (!String(article.content || "").trim()) issues.push("Missing content");
	if (!String(article.slug || "").trim()) issues.push("Missing slug");
	if (!isValidHook(article.hook)) issues.push("Invalid or missing hook");

	const content = String(article.content || "");
	if (content.length < 400) issues.push("Content too short");
	if (content.length > 50000) issues.push("Content unusually long");

	// Obvious repeated paragraphs
	const paras = content.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
	const seen = new Set();
	for (const p of paras) {
		if (p.length < 80) continue;
		if (seen.has(p)) {
			issues.push("Repeated paragraph detected");
			break;
		}
		seen.add(p);
	}

	return {
		valid: issues.length === 0,
		issues,
	};
}
