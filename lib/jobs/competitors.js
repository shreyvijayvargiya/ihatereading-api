/**
 * Stage 4: Competitor tracking — DataForSEO SERP + scrapefast page scrape.
 */

import { fetchGoogleSerp } from "../dataforseo.js";
import { scrapeUrl } from "../scrapefast.js";
import { openRouterChat } from "../openrouter.js";
import { addMany, queryByRun, updateRun } from "../geoPipeline/collections.js";

const MAX_KEYWORDS = 8;
const MAX_COMPETITORS = 25;

function ownDomain(domain, url) {
	try {
		const h = new URL(url.startsWith("http") ? url : `https://${url}`).hostname
			.replace(/^www\./i, "")
			.toLowerCase();
		return h === domain?.toLowerCase();
	} catch {
		return false;
	}
}

export async function runCompetitorTracking({
	runId,
	siteProfile,
	audit,
	scrapeOptions = {},
}) {
	await updateRun(runId, { stage: "competitor_tracking" });
	const domain = siteProfile.domain;
	const keywords = await queryByRun("keywordData", runId);
	const seeds = keywords.map((k) => k.keyword).slice(0, MAX_KEYWORDS);

	const rows = [];
	for (const keyword of seeds) {
		try {
			const serp = await fetchGoogleSerp(keyword);
			for (const hit of serp) {
				if (!hit.competitorDomain || ownDomain(domain, hit.theirUrl)) continue;
				rows.push({
					runId,
					competitorDomain: hit.competitorDomain,
					rankingKeyword: keyword,
					theirUrl: hit.theirUrl,
					contentGap: true,
					structuralNotes: hit.title || null,
				});
			}
		} catch (err) {
			console.warn(`[competitors] SERP failed for "${keyword}":`, err.message);
		}
	}

	const deduped = [];
	const seen = new Set();
	for (const r of rows) {
		const k = `${r.competitorDomain}|${r.rankingKeyword}`;
		if (seen.has(k)) continue;
		seen.add(k);
		deduped.push(r);
	}

	const sample = deduped.slice(0, 6);
	for (const row of sample) {
		try {
			const scraped = await scrapeUrl(row.theirUrl, {
				...scrapeOptions,
				timeout: 40_000,
			});
			const md = (scraped.markdown || "").slice(0, 6000);
			if (process.env.OPENROUTER_API_KEY && md.length > 200) {
				const llm = await openRouterChat({
					maxTokens: 400,
					messages: [
						{
							role: "user",
							content: `One sentence structural note about this competitor page vs our site ${siteProfile.url}:\n${md}`,
						},
					],
				});
				row.structuralNotes = llm.content.trim();
			}
		} catch {
			/* keep SERP title */
		}
	}

	const final = deduped.slice(0, MAX_COMPETITORS);
	if (final.length) await addMany("competitorData", final);
	return final;
}
