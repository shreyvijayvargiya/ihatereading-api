/**
 * Google News search URL + article extraction from a /scrape result.
 */

export function buildGoogleNewsUrl(
	keyword,
	{ hl = "en", gl = "US" } = {},
) {
	const q = String(keyword || "").trim();
	const params = new URLSearchParams({
		q,
		hl,
		gl,
		ceid: `${gl}:${hl}`,
	});
	return `https://news.google.com/search?${params.toString()}`;
}

function hrefOf(link) {
	if (!link) return "";
	if (typeof link === "string") return link.trim();
	return String(link.href || link.url || link.link || "").trim();
}

function textOf(link) {
	if (!link || typeof link === "string") return String(link || "").trim();
	return String(link.text || link.title || link.name || "").trim();
}

export function isGoogleNewsArticleUrl(href) {
	const u = String(href || "");
	return (
		u.includes("/articles/") ||
		u.includes("/read/") ||
		u.includes("news.google.com/stories") ||
		u.includes("news.google.com/rss/articles")
	);
}

/**
 * Pull ranked news rows out of a Puppeteer /scrape payload.
 * @param {object} scraped  /scrape row or scrapeSingleUrlWithPuppeteer result
 * @param {{ limit?: number, keyword?: string }} [opts]
 */
export function extractGoogleNewsItems(scraped, opts = {}) {
	const limit = Math.min(50, Math.max(1, Number(opts.limit) || 20));
	const data = scraped?.data ?? scraped?.scrapedData ?? scraped ?? {};
	const rawLinks = data.links ?? scraped?.links ?? [];
	const headings = [
		...(data.content?.h3 ?? []),
		...(data.content?.h4 ?? []),
		...(data.content?.h2 ?? []),
	];

	const seen = new Set();
	const news = [];
	for (let i = 0; i < rawLinks.length && news.length < limit; i++) {
		const link = rawLinks[i];
		const url = hrefOf(link);
		if (!isGoogleNewsArticleUrl(url)) continue;
		const key = url.split("?")[0];
		if (seen.has(key)) continue;
		seen.add(key);
		const title =
			textOf(link) ||
			String(headings[news.length] || "").trim() ||
			"Untitled";
		let source = "news.google.com";
		try {
			source = new URL(url).hostname.replace(/^www\./, "");
		} catch {
			/* ignore */
		}
		news.push({
			title,
			url,
			source,
			snippet: String(link?.title || "").trim(),
			keyword: opts.keyword || null,
			index: news.length + 1,
		});
	}
	return news;
}
