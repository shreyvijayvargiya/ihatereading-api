/**
 * Stage 3: Question mining (AnswerThePublic-style) via scrapefast on Google SERP.
 * No Reddit/Quora. No Google suggest API — prefix variants scraped through scrapefast.
 */

import {
	scrapeUrl,
	buildGoogleSerpUrl,
	AUTocomplete_PREFIXES,
} from "../scrapefast.js";
import { openRouterEmbed } from "../openrouter.js";
import cosineSimilarity from "../../utils/cosineSimilarity.js";
import { extractGoogleSerpSignals } from "../geoPipeline/serpExtract.js";
import { addMany, queryByRun, updateRun } from "../geoPipeline/collections.js";

const ANSWERED_THRESHOLD = Number(
	process.env.GEO_ANSWERED_SIMILARITY || "0.85",
);
const MAX_SEED_KEYWORDS = 12;
const MAX_QUESTIONS_PER_KEYWORD = 20;

function dedupeQuestions(rows) {
	const seen = new Set();
	return rows.filter((r) => {
		const k = r.question.toLowerCase();
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

async function scrapeSerpHtml(keyword, scrapeOptions) {
	const url = buildGoogleSerpUrl(keyword, scrapeOptions.serpGeo || {});
	const scraped = await scrapeUrl(url, scrapeOptions);
	return (
		scraped.data?.html ||
		scraped.data?.rawHtml ||
		scraped.markdown ||
		""
	);
}

/**
 * @param {{ runId: string, siteProfile: object, audit: object, scrapeOptions?: object }} ctx
 */
export async function runQuestionMining({ runId, siteProfile, audit, scrapeOptions = {} }) {
	await updateRun(runId, { stage: "question_mining" });

	const keywords = await queryByRun("keywordData", runId);
	const seeds = keywords
		.map((k) => k.keyword)
		.filter(Boolean)
		.slice(0, MAX_SEED_KEYWORDS);

	if (!seeds.length) {
		seeds.push(audit?.niche || siteProfile.domain || "blog");
	}

	const collected = [];

	for (const keyword of seeds) {
		try {
			const html = await scrapeSerpHtml(keyword, scrapeOptions);
			const { paa, related, autocomplete } = extractGoogleSerpSignals(html, {
				keyword,
			});

			for (const row of paa) {
				collected.push({
					runId,
					question: row.question,
					source: "paa",
					sourceUrl: row.sourceUrl,
					relatedKeyword: keyword,
					cluster: keyword.split(/\s+/).slice(0, 2).join(" ") || "general",
					answeredOnSite: false,
				});
			}
			for (const phrase of related) {
				collected.push({
					runId,
					question: phrase.endsWith("?") ? phrase : `${phrase}?`,
					source: "related_search",
					sourceUrl: buildGoogleSerpUrl(phrase),
					relatedKeyword: keyword,
					cluster: keyword.split(/\s+/).slice(0, 2).join(" ") || "general",
					answeredOnSite: false,
				});
			}
			for (const phrase of autocomplete) {
				collected.push({
					runId,
					question: phrase.endsWith("?") ? phrase : phrase,
					source: "autocomplete",
					sourceUrl: buildGoogleSerpUrl(phrase),
					relatedKeyword: keyword,
					cluster: keyword.split(/\s+/).slice(0, 2).join(" ") || "general",
					answeredOnSite: false,
				});
			}

			// Prefix variants via scrapefast (not suggest endpoint)
			for (const prefix of AUTocomplete_PREFIXES.slice(0, 4)) {
				const q = `${prefix} ${keyword}`.trim();
				const prefixHtml = await scrapeSerpHtml(q, scrapeOptions);
				const sig = extractGoogleSerpSignals(prefixHtml, { keyword: q });
				for (const phrase of [...sig.related, ...sig.autocomplete]) {
					collected.push({
						runId,
						question: phrase.includes("?") ? phrase : `${phrase}?`,
						source: "autocomplete",
						sourceUrl: buildGoogleSerpUrl(phrase),
						relatedKeyword: keyword,
						cluster: keyword.split(/\s+/).slice(0, 2).join(" ") || "general",
						answeredOnSite: false,
					});
				}
			}
		} catch (err) {
			console.warn(`[questions] SERP scrape failed for "${keyword}":`, err.message);
		}
	}

	let unique = dedupeQuestions(collected).slice(
		0,
		seeds.length * MAX_QUESTIONS_PER_KEYWORD,
	);

	// answeredOnSite via embeddings
	const blogTitles = audit?.audit?.blogTitles || [];
	if (blogTitles.length && unique.length) {
		try {
			const titleTexts = blogTitles.slice(0, 40);
			const questionTexts = unique.map((q) => q.question);
			const [titleEmbeds, questionEmbeds] = await Promise.all([
				openRouterEmbed(titleTexts),
				openRouterEmbed(questionTexts),
			]);
			unique = unique.map((row, i) => {
				const qVec = questionEmbeds[i];
				if (!qVec) return row;
				let best = 0;
				for (const tVec of titleEmbeds) {
					const sim = cosineSimilarity(qVec, tVec);
					if (sim > best) best = sim;
				}
				return { ...row, answeredOnSite: best >= ANSWERED_THRESHOLD };
			});
		} catch (err) {
			console.warn("[questions] embedding backfill skipped:", err.message);
		}
	}

	if (unique.length) {
		await addMany("questionData", unique);
	}
	return unique;
}
