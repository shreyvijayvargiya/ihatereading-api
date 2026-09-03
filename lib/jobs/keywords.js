/**
 * Stage 2: Keyword research via DataForSEO (+ LLM seed fallback).
 */

import { fetchKeywordSuggestions } from "../dataforseo.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import { addMany, updateRun, queryByRun, col } from "../geoPipeline/collections.js";
import { firestore } from "../../config/firebase.js";

const MAX_KEYWORDS = 35;

function keywordSeed(siteProfile, audit) {
	if (audit?.audit?.metaKeywords) {
		const parts = String(audit.audit.metaKeywords)
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		if (parts.length) return parts.slice(0, 5).join(" ");
	}
	if (audit?.siteSummary) return audit.siteSummary.slice(0, 120);
	if (audit?.audit?.description) return audit.audit.description.slice(0, 120);
	if (audit?.niche && !looksLikeMisreadBrand(audit.niche, siteProfile.url)) {
		return audit.niche;
	}
	if (siteProfile.niche) return siteProfile.niche;
	return "software development tutorials";
}

function looksLikeMisreadBrand(niche, url) {
	const n = String(niche).toLowerCase();
	if (/ihatereading/i.test(url || "") && /\b(reading|literature|book|story letter)\b/.test(n)) {
		return true;
	}
	return /\bhate reading\b|\bstory letter\b|\bbook summar/.test(n);
}

function seedKeywordsFromText(seed, audit) {
	const base = String(seed || "programming tutorials").trim();
	const fromMeta = String(audit?.audit?.metaKeywords || "")
		.split(",")
		.map((s) => s.trim())
		.filter((k) => k.length > 2);
	const bits = [...new Set([base, ...fromMeta])].slice(0, 15);
	return bits.map((keyword) => ({
		keyword,
		volume: null,
		difficulty: null,
		intent: "informational",
		cluster: base.split(/\s+/).slice(0, 2).join(" ") || "dev",
		source: "llm_seed",
	}));
}

async function llmSeedKeywords(siteProfile, seed, audit) {
	const llm = await openRouterChat({
		messages: [
			{
				role: "system",
				content:
					'Return ONLY valid JSON: { "keywords": [{ "keyword": string, "intent": string, "cluster": string }] }. Keywords must match the ACTUAL site topic — ignore misleading brand names.',
			},
			{
				role: "user",
				content: `Site: ${siteProfile.url}
What this site actually is: ${audit?.siteSummary || audit?.audit?.description || seed}
Meta keywords: ${audit?.audit?.metaKeywords || "n/a"}
Sections: ${(audit?.audit?.llmsTopics || []).join(", ") || "n/a"}

Generate 15 SEO keywords for THIS site's real audience (developers/programming if applicable).
Do NOT generate keywords about books, literature, or "hating to read" unless the site summary explicitly says that.`,
			},
		],
		jsonMode: true,
		maxTokens: 1200,
	});
	const parsed = parseJsonFromLLM(llm.content);
	const list = parsed.keywords || parsed.data?.keywords || [];
	return list
		.map((k) => ({
			keyword: String(k.keyword || k.phrase || "").trim(),
			volume: null,
			difficulty: null,
			intent: k.intent || "informational",
			cluster: k.cluster || seed,
			source: "llm_seed",
		}))
		.filter((k) => k.keyword.length > 2);
}

export async function runKeywordResearch({ runId, siteProfile, audit, replaceExisting = false }) {
	await updateRun(runId, { stage: "keyword_research" });

	if (replaceExisting) {
		const existing = await queryByRun("keywordData", runId);
		if (existing.length) {
			const b = firestore.batch();
			for (const row of existing) {
				b.delete(col("keywordData").doc(row.id));
			}
			await b.commit();
		}
	}

	const seed = keywordSeed(siteProfile, audit);

	let rows = [];
	try {
		rows = await fetchKeywordSuggestions(seed);
	} catch (err) {
		console.warn("[keywords] DataForSEO failed, LLM seed:", err.message);
	}

	if (rows.length < 8) {
		try {
			rows = await llmSeedKeywords(siteProfile, seed, audit);
		} catch (err) {
			console.warn("[keywords] LLM seed parse failed, heuristic fallback:", err.message);
			rows = seedKeywordsFromText(seed, audit);
		}
	}

	if (!rows.length) {
		rows = seedKeywordsFromText(seed, audit);
	}

	const toWrite = rows.slice(0, MAX_KEYWORDS).map((r) => ({
		runId,
		keyword: r.keyword,
		volume: r.volume ?? null,
		difficulty: r.difficulty ?? null,
		intent: r.intent || "informational",
		cluster: r.cluster || "general",
		source: r.source || "dataforseo",
	}));

	if (toWrite.length) {
		await addMany("keywordData", toWrite);
	}
	return toWrite;
}
