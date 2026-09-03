/**
 * Extract PAA + related searches from Google SERP HTML or scrape markdown.
 */

import { load } from "cheerio";

function cleanText(s) {
	return String(s || "")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeHref(href) {
	if (!href) return null;
	let h = href.trim();
	if (h.startsWith("//")) h = `https:${h}`;
	if (h.startsWith("/url?q=")) {
		try {
			const u = new URL(h, "https://www.google.com");
			return u.searchParams.get("q") || h;
		} catch {
			return h;
		}
	}
	if (/^https?:\/\//i.test(h)) return h;
	return null;
}

function extractFromMarkdown(markdown, keyword) {
	const paa = [];
	const related = new Set();
	const lines = String(markdown || "").split("\n");
	for (const line of lines) {
		const t = cleanText(line.replace(/^[-*#>\d.]+\s*/, ""));
		if (t.endsWith("?") && t.length > 12 && t.length < 200) {
			if (!paa.some((r) => r.question === t)) {
				paa.push({ question: t, sourceUrl: null });
			}
		}
		if (
			t.length >= 8 &&
			t.length <= 100 &&
			!t.endsWith("?") &&
			keyword &&
			t.toLowerCase() !== keyword.toLowerCase() &&
			/^[a-z0-9\s-]+$/i.test(t)
		) {
			related.add(t);
		}
	}
	return { paa, related: [...related], autocomplete: [] };
}

/**
 * @param {string} html
 * @returns {{ paa: { question: string, sourceUrl: string|null }[], related: string[], autocomplete: string[] }}
 */
export function extractGoogleSerpSignals(htmlOrMarkdown, { keyword = "" } = {}) {
	const input = String(htmlOrMarkdown || "");
	if (!input.includes("<") || input.length < 200) {
		return extractFromMarkdown(input, keyword);
	}

	const $ = load(input);
	const paa = [];
	const related = new Set();
	const autocomplete = new Set();

	$('[data-q], div[jsname="N760b"], .related-question-pair, div.Cy9ZJc').each((_, el) => {
		const block = $(el);
		const q =
			block.attr("data-q") ||
			block.find('[role="button"]').first().text() ||
			block.find(".cbphWd, .CSkcDe, span").first().text();
		const question = cleanText(q);
		if (!question || question.length < 8) return;
		if (paa.some((row) => row.question === question)) return;
		let sourceUrl = null;
		const link = block.find('a[href^="http"]').first().attr("href");
		sourceUrl = normalizeHref(link);
		paa.push({ question, sourceUrl });
	});

	if (paa.length === 0) {
		const text = $("body").text();
		for (const line of text.split("\n")) {
			const t = cleanText(line);
			if (t.endsWith("?") && t.length > 12 && t.length < 180) {
				if (!paa.some((r) => r.question === t)) paa.push({ question: t, sourceUrl: null });
			}
		}
	}

	$(
		'a[href*="/search?"], .brs_col a, div[data-hveid] a, .k8XOCe a, .s75CSd a',
	).each((_, el) => {
		const a = $(el);
		const t = cleanText(a.text());
		if (!t || t.length < 4 || t.length > 120) return;
		if (/^(images|videos|news|maps|shopping|books|flights)$/i.test(t)) return;
		if (keyword && t.toLowerCase() === keyword.toLowerCase()) return;
		related.add(t);
	});

	$('[role="option"], .sbct').each((_, el) => {
		const t = cleanText($(el).text());
		if (t.length >= 4 && t.length <= 120) autocomplete.add(t);
	});

	const mdFallback = extractFromMarkdown(input, keyword);
	return {
		paa: paa.length ? paa : mdFallback.paa,
		related: related.size ? [...related].slice(0, 15) : mdFallback.related,
		autocomplete: autocomplete.size
			? [...autocomplete].slice(0, 12)
			: mdFallback.autocomplete,
	};
}
