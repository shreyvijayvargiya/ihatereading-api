/**
 * Keyword research — site-context AI seeds + Google Suggest + SERP + expansions.
 * Free sources only (no DataForSEO). Does not invent search volume.
 */

import { fetchWithTimeout, googleSearch } from "./http.js";
import { aiKeywordSeedsFromSite } from "./siteContext.js";
import { dedupeBy, inferIntent, normalize } from "./utils.js";

const MAX_KEYWORDS = 50;
const MIN_KEYWORDS = 20;

const SUFFIXES = [
	"",
	" tutorial",
	" guide",
	" best",
	" alternatives",
	" vs",
	" boilerplate",
	" starter",
	" authentication",
	" performance",
	" for beginners",
	" saas",
	" example",
	" how to",
];

const PREFIXES = ["how to ", "best ", "top ", "", "what is "];

async function googleAutocomplete(seed) {
	const variants = [
		seed,
		`${seed} `,
		`how to ${seed}`,
		`best ${seed}`,
		`${seed} vs`,
		`${seed} alternatives`,
		`${seed} for`,
	];
	const out = [];
	const settled = await Promise.allSettled(
		variants.map(async (q) => {
			const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`;
			const res = await fetchWithTimeout(url, {
				timeoutMs: 10_000,
				headers: { Accept: "application/json" },
			});
			if (!res.ok) return [];
			const data = await res.json();
			return Array.isArray(data?.[1])
				? data[1].filter((s) => typeof s === "string")
				: [];
		}),
	);
	for (const r of settled) {
		if (r.status === "fulfilled") {
			for (const s of r.value) out.push(s);
		}
	}
	return out;
}

function phraseFromSerpTitle(title, seeds) {
	const t = String(title || "")
		.replace(/\s*[|\-–—]\s*.*$/, "")
		.replace(/\s+/g, " ")
		.trim();
	if (t.length < 4 || t.length > 90) return null;
	const titleN = normalize(t);
	const seedWords = (seeds || [])
		.flatMap((s) => normalize(s).split(" "))
		.filter((w) => w.length > 3);
	if (!seedWords.length) return t;
	const hit = seedWords.some((w) => titleN.includes(w));
	return hit ? t : null;
}

function heuristicExpansions(topic) {
	const t = String(topic).trim();
	const compact = t.replace(/\s+/g, "").toLowerCase();
	const spaced = t.toLowerCase();
	const seeds = [
		...new Set([t, spaced, compact === spaced ? null : compact].filter(Boolean)),
	];
	const out = [];
	for (const seed of seeds) {
		for (const pre of PREFIXES) {
			for (const suf of SUFFIXES.slice(0, 8)) {
				const phrase = `${pre}${seed}${suf}`.replace(/\s+/g, " ").trim();
				if (phrase.length > 3 && phrase.length < 80) out.push(phrase);
			}
		}
	}
	return out.slice(0, 30);
}

/**
 * @param {string} topic
 * @param {{ language?: string, region?: string, baseUrl?: string, siteContext?: object }} [opts]
 */
export async function researchKeywords(topic, opts = {}) {
	const warnings = [];
	const rows = [];
	let aiUsage = null;

	const push = (keyword, source, intent) => {
		const k = String(keyword || "").trim();
		if (k.length < 2 || k.length > 120) return;
		rows.push({
			keyword: k,
			source,
			intent: intent || inferIntent(k),
		});
	};

	push(topic, "seed", inferIntent(topic));

	// Site-aware AI seeds (categories / sitemap / RSS bridges)
	if (opts.siteContext) {
		try {
			const { seeds, usage } = await aiKeywordSeedsFromSite(
				topic,
				opts.siteContext,
			);
			aiUsage = usage;
			for (const s of seeds) {
				push(s.keyword, "site_ai", s.intent || inferIntent(s.keyword));
			}
			if (!seeds.length) {
				warnings.push("Site-context AI returned no keyword seeds");
			}
		} catch (err) {
			warnings.push(
				`Site-context keyword AI failed: ${err?.message || err}`,
			);
		}

		for (const theme of opts.siteContext.themes || []) {
			push(`${topic} ${theme}`, "site_theme", inferIntent(`${topic} ${theme}`));
			push(theme, "site_theme", inferIntent(theme));
		}
	}

	// Autocomplete for topic + top AI seeds
	const autoSeeds = [
		topic,
		...rows
			.filter((r) => r.source === "site_ai")
			.slice(0, 5)
			.map((r) => r.keyword),
	];
	try {
		const settled = await Promise.allSettled(
			autoSeeds.map((s) => googleAutocomplete(s)),
		);
		for (const r of settled) {
			if (r.status === "fulfilled") {
				for (const s of r.value) push(s, "suggestion", inferIntent(s));
			}
		}
	} catch (err) {
		warnings.push(`Keyword autocomplete unavailable: ${err?.message || err}`);
	}

	// Google SERP title mining across a few seed phrases
	try {
		const country =
			opts.region && opts.region !== "global"
				? String(opts.region).slice(0, 2).toLowerCase()
				: "us";
		const serpSeeds = [
			topic,
			`${topic} tutorial`,
			`best ${topic}`,
			...rows
				.filter((r) => r.source === "site_ai")
				.slice(0, 3)
				.map((r) => r.keyword),
		].slice(0, 6);

		const settled = await Promise.allSettled(
			serpSeeds.map((q) =>
				googleSearch(q, {
					baseUrl: opts.baseUrl,
					num: 8,
					country,
					language: opts.language || "en",
				}),
			),
		);
		for (const r of settled) {
			if (r.status !== "fulfilled") {
				warnings.push(
					`Google keyword search failed: ${r.reason?.message || r.reason}`,
				);
				continue;
			}
			for (const row of r.value || []) {
				const phrase = phraseFromSerpTitle(row.title, serpSeeds);
				if (phrase) push(phrase, "google_search", inferIntent(phrase));
			}
		}
	} catch (err) {
		warnings.push(`Google search keyword mining failed: ${err?.message || err}`);
	}

	for (const h of heuristicExpansions(topic)) {
		push(h, "expansion", inferIntent(h));
	}

	let keywords = dedupeBy(rows, (r) => r.keyword);
	keywords.sort((a, b) => {
		const rank = (s) =>
			s === "site_ai"
				? 0
				: s === "suggestion"
					? 1
					: s === "google_search"
						? 2
						: s === "site_theme"
							? 3
							: s === "seed"
								? 4
								: 5;
		return rank(a.source) - rank(b.source);
	});
	keywords = keywords.slice(0, MAX_KEYWORDS);

	if (keywords.length < MIN_KEYWORDS) {
		warnings.push(
			`Only ${keywords.length} keywords found (target ${MIN_KEYWORDS}+); expansions may be thin`,
		);
	}

	return { keywords, warnings, usage: aiUsage };
}

/** Pick top N keywords for downstream limited searches. */
export function topKeywordsForSearch(keywords, limit = 8) {
	const preferred = (keywords || []).filter((k) =>
		["site_ai", "suggestion", "google_search", "seed", "site_theme"].includes(
			k.source,
		),
	);
	const pool = preferred.length >= 3 ? preferred : keywords || [];
	return dedupeBy(pool, (k) => k.keyword).slice(0, limit);
}

export { normalize };
