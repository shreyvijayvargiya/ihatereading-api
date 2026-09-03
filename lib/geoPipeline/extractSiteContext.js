/**
 * Extract real site context from HTML, __NEXT_DATA__, meta tags, and llms.txt.
 * Avoids misreading brand names (e.g. iHateReading ≠ literature site).
 */

const PROGRAMMING_SIGNALS =
	/\b(react|next\.?js|node\.?js|javascript|typescript|programming|developer|software|frontend|backend|coding|tutorial|roadmap|api|web dev)\b/i;

const READING_LITERAL_SIGNALS =
	/\b(story letter|book summar|audiobook|literature|hate reading|reluctant reader|speed reading tips)\b/i;

/** @param {string} html */
export function parseNextDataSeo(html) {
	try {
		const m = String(html).match(
			/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
		);
		if (!m) return null;
		const data = JSON.parse(m[1]);
		const seo = data?.props?.pageProps?.seoData;
		if (!seo) return null;
		return {
			title: seo.title || null,
			description: seo.description || null,
			keywords: seo.keywords || null,
			url: seo.url || null,
		};
	} catch {
		return null;
	}
}

/** @param {string} html */
export function parseHtmlMeta(html) {
	const h = String(html || "");
	const pick = (name) => {
		const re = new RegExp(
			`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`,
			"i",
		);
		const re2 = new RegExp(
			`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`,
			"i",
		);
		return re.exec(h)?.[1] || re2.exec(h)?.[1] || null;
	};
	return {
		title: (h.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "").trim() || null,
		description: pick("description") || pick("og:description"),
		keywords: pick("keywords"),
		ogTitle: pick("og:title"),
		ogSiteName: pick("og:site_name"),
	};
}

export async function fetchLlmsTxt(origin) {
	const url = `${origin.replace(/\/$/, "")}/llms.txt`;
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(12_000),
			headers: { "User-Agent": "ihatereading-api/geo-pipeline" },
		});
		if (!res.ok) return null;
		const text = await res.text();
		return text.length > 50 ? text.slice(0, 12_000) : null;
	} catch {
		return null;
	}
}

export async function fetchPageHtml(url) {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(20_000),
		headers: {
			"User-Agent":
				"Mozilla/5.0 (compatible; ihatereading-api/geo-audit/1.0)",
			Accept: "text/html,application/xhtml+xml",
		},
	});
	if (!res.ok) throw new Error(`Fetch ${url} HTTP ${res.status}`);
	return res.text();
}

function firstParagraphFromLlms(txt) {
	const lines = String(txt || "").split("\n");
	for (const line of lines) {
		const t = line.replace(/^>\s*/, "").trim();
		if (t.startsWith("iHateReading") || t.length < 40) continue;
		if (t.startsWith("#") || t.startsWith("-") || t.startsWith("[")) continue;
		return t;
	}
	const gt = lines.find((l) => l.startsWith(">"));
	return gt ? gt.replace(/^>\s*/, "").trim() : null;
}

function topicsFromLlms(txt) {
	const topics = [];
	for (const line of String(txt || "").split("\n")) {
		const m = line.match(/^-\s+\[([^\]]+)\]/);
		if (m) topics.push(m[1].trim());
	}
	return topics.slice(0, 30);
}

/**
 * Build grounded site context — prefer description/llms over domain/brand name.
 */
export function buildSiteContext({
	url,
	markdown = "",
	scrapedMeta = {},
	html = "",
	llmsTxt = null,
	userNiche = null,
	userDescription = null,
}) {
	const nextSeo = html ? parseNextDataSeo(html) : null;
	const htmlMeta = html ? parseHtmlMeta(html) : {};

	const title =
		userDescription?.slice(0, 80) ||
		nextSeo?.title ||
		scrapedMeta.title ||
		htmlMeta.ogTitle ||
		htmlMeta.title ||
		null;

	const description =
		userDescription ||
		nextSeo?.description ||
		scrapedMeta.description ||
		htmlMeta.description ||
		firstParagraphFromLlms(llmsTxt) ||
		null;

	const metaKeywords =
		nextSeo?.keywords ||
		scrapedMeta.keywords ||
		htmlMeta.keywords ||
		null;

	const llmsTopics = llmsTxt ? topicsFromLlms(llmsTxt) : [];

	let niche =
		userNiche ||
		inferNicheFromSignals({
			description,
			metaKeywords,
			markdown,
			llmsTxt,
			llmsTopics,
		});

	// Brand "iHateReading" is dev education — never treat as anti-reading literature
	if (isBrandMisread(niche, description, metaKeywords, url)) {
		niche = inferNicheFromSignals({
			description,
			metaKeywords,
			markdown,
			llmsTxt,
			llmsTopics,
			forceProgramming: true,
		});
	}

	const siteSummary = [
		description,
		metaKeywords ? `Topics: ${metaKeywords}` : "",
		llmsTopics.length ? `Site sections: ${llmsTopics.slice(0, 8).join(", ")}` : "",
	]
		.filter(Boolean)
		.join(". ");

	return {
		title,
		description,
		metaKeywords,
		niche,
		siteSummary: siteSummary.slice(0, 1200),
		llmsTopics,
		llmsTxt: llmsTxt ? llmsTxt.slice(0, 8000) : null,
		contentSample: String(markdown || "").slice(0, 6000),
		scrapeQuality: scoreScrapeQuality(markdown, description, llmsTxt),
	};
}

function scoreScrapeQuality(markdown, description, llmsTxt) {
	let score = 0;
	if (String(markdown).trim().length > 400) score += 2;
	if (description) score += 2;
	if (llmsTxt) score += 2;
	if (PROGRAMMING_SIGNALS.test(`${description} ${markdown}`)) score += 2;
	if (score >= 5) return "good";
	if (score >= 2) return "partial";
	return "poor";
}

function isBrandMisread(niche, description, metaKeywords, url) {
	const blob = `${niche} ${description} ${metaKeywords} ${url}`.toLowerCase();
	if (PROGRAMMING_SIGNALS.test(blob)) return false;
	if (/ihatereading/i.test(url || "") && !READING_LITERAL_SIGNALS.test(blob)) {
		return READING_LITERAL_SIGNALS.test(niche) || /\breading\b|\bliterature\b|\bbook\b/.test(niche);
	}
	return READING_LITERAL_SIGNALS.test(niche);
}

function inferNicheFromSignals({
	description,
	metaKeywords,
	markdown,
	llmsTxt,
	llmsTopics,
	forceProgramming = false,
}) {
	const blob = [description, metaKeywords, markdown?.slice(0, 3000), llmsTxt?.slice(0, 2000)]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();

	if (forceProgramming || PROGRAMMING_SIGNALS.test(blob)) {
		if (/react|next/i.test(blob)) return "software development tutorials React Next.js";
		if (/node|backend/i.test(blob)) return "software development Node.js backend";
		if (/typescript|javascript/i.test(blob)) return "JavaScript TypeScript programming tutorials";
		return "software development programming tutorials";
	}

	if (llmsTopics.length >= 3) {
		return llmsTopics.slice(0, 3).join(", ");
	}

	if (description) {
		return description.split(/[.!?]/)[0].slice(0, 120).trim();
	}

	return "general";
}

export { PROGRAMMING_SIGNALS, READING_LITERAL_SIGNALS };
