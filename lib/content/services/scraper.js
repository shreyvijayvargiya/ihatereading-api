/**
 * Adapter over existing /scrape API (lib/scrapefast.js).
 */

import { scrapeUrl } from "../../scrapefast.js";
import { isJunkUrl, normalizeUrl, truncate } from "../utils.js";

function extractHeadings(data) {
	const md = String(data.markdown || data.data?.markdown || "");
	const headings = [];
	for (const line of md.split("\n")) {
		const m = line.match(/^(#{1,6})\s+(.+)/);
		if (m) headings.push({ level: m[1].length, text: m[2].trim() });
	}
	return headings.slice(0, 30);
}

/**
 * @param {string} url
 * @param {{ baseUrl?: string, maxText?: number }} [options]
 */
export async function scrapePage(url, options = {}) {
	const target = normalizeUrl(url);
	if (!target || isJunkUrl(target)) {
		return {
			url: target,
			title: "",
			text: "",
			headings: [],
			description: "",
			error: "invalid_or_junk_url",
		};
	}

	try {
		const row = await scrapeUrl(target, {
			baseUrl: options.baseUrl,
			timeoutMs: options.timeoutMs || 60_000,
			includeImages: false,
			includeLinks: true,
			includeSemanticContent: true,
		});

		const title =
			row.title ||
			row.data?.title ||
			row.metadata?.title ||
			"";
		const description =
			row.description ||
			row.data?.description ||
			row.metadata?.description ||
			"";
		const text = truncate(
			row.markdown ||
				row.data?.markdown ||
				row.semanticContent ||
				row.text ||
				"",
			options.maxText || 4000,
		);

		return {
			url: target,
			title: String(title).trim(),
			text,
			headings: extractHeadings(row),
			description: String(description).trim(),
		};
	} catch (err) {
		return {
			url: target,
			title: "",
			text: "",
			headings: [],
			description: "",
			error: err?.message || String(err),
		};
	}
}

/**
 * Scrape a limited set of URLs sequentially (cost control).
 */
export async function scrapePages(urls, options = {}) {
	const cap = options.limit ?? 12;
	const unique = [...new Set(urls.map(normalizeUrl).filter(Boolean))].slice(0, cap);
	const out = [];
	for (const url of unique) {
		out.push(await scrapePage(url, options));
	}
	return out;
}
