import { normalizeUrl } from "../utils.js";

function allowedSet(candidates) {
	const set = new Set();
	for (const c of candidates || []) {
		const url = normalizeUrl(c.url);
		if (url) set.add(url);
	}
	return set;
}

/**
 * Validate and filter links against allowed candidate lists.
 */
export function validateLinks(article, internalCandidates, externalCandidates) {
	const internalAllowed = allowedSet(internalCandidates);
	const externalAllowed = allowedSet(externalCandidates);
	const issues = [];

	const internalLinks = [];
	for (const link of article.internalLinks || []) {
		const url = normalizeUrl(link.url);
		if (!url) {
			issues.push(`Invalid internal URL: ${link.url}`);
			continue;
		}
		if (!internalAllowed.has(url)) {
			issues.push(`Invented internal link removed: ${url}`);
			continue;
		}
		internalLinks.push({ ...link, url });
	}

	const externalLinks = [];
	const seen = new Set();
	for (const link of article.externalLinks || []) {
		const url = normalizeUrl(link.url);
		if (!url) {
			issues.push(`Invalid external URL: ${link.url}`);
			continue;
		}
		if (seen.has(url)) {
			issues.push(`Duplicate external link removed: ${url}`);
			continue;
		}
		if (!externalAllowed.has(url)) {
			issues.push(`Invented external link removed: ${url}`);
			continue;
		}
		seen.add(url);
		externalLinks.push({ ...link, url });
	}

	return {
		internalLinks,
		externalLinks,
		issues,
	};
}
