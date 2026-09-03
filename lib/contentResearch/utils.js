/**
 * Dedup / normalize / opportunity scoring for content research.
 */

export function normalize(text) {
	return String(text || "")
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s]+/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} keyFn
 */
export function dedupeBy(items, keyFn) {
	const seen = new Set();
	const out = [];
	for (const item of items || []) {
		const key = normalize(keyFn(item));
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}

export function domainFromUrl(url) {
	try {
		return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
	} catch {
		return "";
	}
}

export function inferIntent(keyword) {
	const k = String(keyword || "").toLowerCase();
	if (/\b(buy|price|cost|pricing|demo|trial|signup|subscribe)\b/.test(k)) {
		return "transactional";
	}
	if (/\b(vs|versus|compare|alternative|best|top)\b/.test(k)) {
		return "commercial";
	}
	if (/^(how|why|what|when|where|can|does|is|are)\b/.test(k)) {
		return "informational";
	}
	return "informational";
}

/**
 * Deterministic opportunity score 0–100 from research signals on an idea.
 */
export function computeOpportunityScore(idea, research) {
	const keywords = research?.keywords || [];
	const reddit = research?.reddit || [];
	const internal = research?.internal_articles || research?.internalArticles || [];
	const external =
		research?.external_references || research?.externalReferences || [];

	const primary = normalize(idea.primaryKeyword || idea.title || "");
	const secondary = (idea.secondaryKeywords || []).map(normalize);

	let keywordRelevance = 0;
	for (const k of keywords) {
		const nk = normalize(k.keyword || k.phrase || "");
		if (!nk) continue;
		if (nk === primary || primary.includes(nk) || nk.includes(primary)) {
			keywordRelevance = Math.max(keywordRelevance, 25);
		} else if (secondary.some((s) => s === nk || s.includes(nk) || nk.includes(s))) {
			keywordRelevance = Math.max(keywordRelevance, 15);
		}
	}

	const redditQs = idea.redditQuestions || [];
	let redditEvidence = Math.min(25, redditQs.length * 6);
	if (!redditQs.length && reddit.length) {
		const hit = reddit.some((r) => {
			const t = normalize(r.title || r.question || "");
			return primary && (t.includes(primary) || primary.split(" ").some((w) => w.length > 3 && t.includes(w)));
		});
		if (hit) redditEvidence = 10;
	}

	const titleN = normalize(idea.title || "");
	const covered = internal.some((a) => {
		const at = normalize(a.title || "");
		return at && titleN && (at === titleN || at.includes(titleN) || titleN.includes(at));
	});
	const contentGap = covered ? 5 : 20;

	const internalLinks = idea.internalLinks || [];
	const internalLinking = Math.min(15, internalLinks.length * 5);
	const externalLinks = idea.externalLinks || [];
	const externalAvail = Math.min(
		15,
		Math.max(externalLinks.length * 4, external.length ? 5 : 0),
	);

	const raw =
		keywordRelevance +
		redditEvidence +
		contentGap +
		internalLinking +
		externalAvail;
	return Math.max(0, Math.min(100, Math.round(raw)));
}

export function slugifyTitle(title) {
	return String(title || "")
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 120);
}

export function articleUrlFromPublish(doc) {
	const data = doc.data ? doc.data() : doc;
	const id = doc.id || data.id;
	const slug =
		data.slug ||
		data.path ||
		(data.title ? slugifyTitle(data.title) : id);
	return `https://ihatereading.in/t/${encodeURIComponent(String(slug).replace(/\s+/g, "-"))}`;
}
