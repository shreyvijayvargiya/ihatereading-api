/** @param {...unknown} values */
export function parseUrlCaptureFlag(...values) {
	for (const v of values) {
		if (v === true || v === 1) return true;
		if (typeof v === "string") {
			const s = v.trim().toLowerCase();
			if (s === "true" || s === "1" || s === "yes") return true;
		}
	}
	return false;
}

/** @param {...unknown} values — default false unless explicitly true */
export function parseFullPageFlag(...values) {
	return parseUrlCaptureFlag(...values);
}

/**
 * Resolve a page URL from request body / form fields.
 * When `url` is a string starting with http(s), it is treated as the page URL.
 */
export function resolvePageUrlFromRequest(fields = {}) {
	const candidates = [
		fields.pageUrl,
		fields.websiteUrl,
		fields.targetUrl,
		fields.siteUrl,
	];
	if (typeof fields.url === "string" && /^https?:\/\//i.test(fields.url.trim())) {
		candidates.unshift(fields.url);
	}
	for (const raw of candidates) {
		const s = String(raw ?? "").trim();
		if (s && /^https?:\/\//i.test(s)) return s;
	}
	return null;
}

export function validateHttpUrl(url) {
	try {
		const u = new URL(url);
		if (u.protocol !== "http:" && u.protocol !== "https:") {
			return { ok: false, error: "URL must use http or https" };
		}
		return { ok: true, href: u.href };
	} catch {
		return { ok: false, error: "Invalid URL format" };
	}
}

export const DEFAULT_IMAGE_TO_CODE_PROMPT =
	"Recreate this UI as a pixel-accurate React component using Tailwind CSS and lucide-react icons.";
