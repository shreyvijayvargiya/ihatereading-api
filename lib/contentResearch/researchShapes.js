/**
 * Pure helpers that turn raw provider output into plain, Firestore-safe shapes.
 * No imports on purpose: usable (and testable) without Firebase.
 */

export function cleanKeyword(k) {
	if (!k || typeof k !== "object") return null;
	const out = {
		keyword: String(k.keyword || "").trim(),
		source: String(k.source || "unknown"),
	};
	if (!out.keyword) return null;
	if (k.intent) out.intent = String(k.intent);
	if (typeof k.searchVolume === "number") out.searchVolume = k.searchVolume;
	if (typeof k.difficulty === "number") out.difficulty = k.difficulty;
	if (typeof k.score === "number") out.score = k.score;
	return out;
}

export function cleanReddit(r) {
	if (!r || typeof r !== "object") return null;
	const out = {
		title: String(r.title || "").trim(),
		url: String(r.url || "").trim(),
	};
	if (!out.title || !out.url) return null;
	if (r.question) out.question = String(r.question);
	if (r.subreddit) out.subreddit = String(r.subreddit);
	if (typeof r.score === "number") out.score = r.score;
	if (typeof r.comments === "number") out.comments = r.comments;
	if (r.createdAt && typeof r.createdAt === "string") out.createdAt = r.createdAt;
	return out;
}

export function cleanInternal(a) {
	if (!a || typeof a !== "object") return null;
	const out = {
		title: String(a.title || "").trim(),
		url: String(a.url || "").trim(),
	};
	if (!out.title || !out.url) return null;
	if (a.description) out.description = String(a.description);
	if (a.publishedAt && typeof a.publishedAt === "string") {
		out.publishedAt = a.publishedAt;
	} else if (a.publishedAt && typeof a.publishedAt?.toDate === "function") {
		try {
			out.publishedAt = a.publishedAt.toDate().toISOString();
		} catch {
			/* skip */
		}
	}
	if (typeof a.relevanceScore === "number") out.relevanceScore = a.relevanceScore;
	return out;
}

export function cleanExternal(e) {
	if (!e || typeof e !== "object") return null;
	const out = {
		title: String(e.title || "").trim(),
		url: String(e.url || "").trim(),
		domain: String(e.domain || "").trim(),
	};
	if (!out.url) return null;
	if (typeof e.relevanceScore === "number") out.relevanceScore = e.relevanceScore;
	return out;
}

export function siteContextSummary(siteContext) {
	if (!siteContext) return null;
	return {
		origin: siteContext.origin || null,
		homepageTitle: siteContext.homepageTitle || null,
		themes: siteContext.themes || [],
		categories: siteContext.categories || [],
		sitemap_title_count: (siteContext.sitemapTitles || []).length,
		rss_item_count: (siteContext.rssItems || []).length,
		rss_titles: (siteContext.rssItems || []).slice(0, 15).map((i) => i.title),
		sitemap_titles_sample: (siteContext.sitemapTitles || []).slice(0, 20),
	};
}

export function hasAnyResearch(keywords, reddit, internal, external) {
	return (
		(keywords?.length || 0) +
			(reddit?.length || 0) +
			(internal?.length || 0) +
			(external?.length || 0) >
		0
	);
}
