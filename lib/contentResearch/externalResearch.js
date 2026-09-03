/**
 * External / authoritative reference research (not full backlink analysis).
 */

import { googleSearch } from "./http.js";
import { topKeywordsForSearch } from "./keywordResearch.js";
import { dedupeBy, domainFromUrl, normalize } from "./utils.js";

const MAX_REFS = 20;
const MAX_SEARCHES = 6;

const PREFERRED_DOMAINS = [
	"nextjs.org",
	"vercel.com",
	"react.dev",
	"github.com",
	"developer.mozilla.org",
	"cloudflare.com",
	"supabase.com",
	"nodejs.org",
	"typescriptlang.org",
	"tailwindcss.com",
	"prisma.io",
	"docs.github.com",
	"web.dev",
	"openai.com",
	"anthropic.com",
	"hono.dev",
	"remix.run",
	"astro.build",
];

function isPreferred(domain) {
	const d = String(domain || "").toLowerCase();
	return PREFERRED_DOMAINS.some(
		(p) => d === p || d.endsWith(`.${p}`) || d.includes(p),
	);
}

function relevanceFor(domain, title, topic) {
	let score = 10;
	if (isPreferred(domain)) score += 40;
	const blob = normalize(`${title} ${domain}`);
	const t = normalize(topic);
	if (t && blob.includes(t)) score += 20;
	if (/docs?|documentation|guide|api|reference|official/i.test(title || "")) {
		score += 15;
	}
	if (/github\.com/i.test(domain)) score += 10;
	return score;
}

/**
 * @param {string} topic
 * @param {object[]} keywords
 * @param {{ baseUrl?: string, language?: string }} [opts]
 */
export async function researchExternalReferences(
	topic,
	keywords = [],
	opts = {},
) {
	const warnings = [];
	const top = topKeywordsForSearch(keywords, 4).map((k) => k.keyword);
	const queries = [
		`${topic} official documentation`,
		`${topic} site:github.com`,
		`${topic} docs`,
		...top.map((k) => `${k} documentation`),
	]
		.filter(Boolean)
		.slice(0, MAX_SEARCHES);

	const settled = await Promise.allSettled(
		queries.map((q) =>
			googleSearch(q, {
				baseUrl: opts.baseUrl,
				num: 8,
				language: opts.language || "en",
			}),
		),
	);

	const refs = [];
	let anyOk = false;
	for (const r of settled) {
		if (r.status === "fulfilled") {
			anyOk = true;
			for (const row of r.value || []) {
				const url = row.url || row.link;
				if (!url || !/^https?:\/\//i.test(url)) continue;
				if (/ihatereading\.in|reddit\.com|duckduckgo\.com/i.test(url)) continue;
				const domain = domainFromUrl(url);
				if (!domain) continue;
				refs.push({
					title: row.title || domain,
					url,
					domain,
					relevanceScore: relevanceFor(domain, row.title, topic),
				});
			}
		} else {
			warnings.push(
				`External search failed: ${r.reason?.message || r.reason}`,
			);
		}
	}

	if (!anyOk) {
		warnings.push("External reference research unavailable");
	} else if (!refs.length) {
		warnings.push("External reference research returned no results");
	}

	const preferred = refs.filter((r) => isPreferred(r.domain));
	const others = refs.filter((r) => !isPreferred(r.domain));
	const ordered = [...preferred, ...others];

	const externalReferences = dedupeBy(ordered, (r) => r.url)
		.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
		.slice(0, MAX_REFS);

	return { externalReferences, warnings };
}
