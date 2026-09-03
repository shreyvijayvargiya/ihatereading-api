/**
 * Stage 5: AI visibility check via OpenRouter (Perplexity / OpenAI / Claude routes).
 */

import { openRouterChat } from "../openrouter.js";
import { addMany, updateRun } from "../geoPipeline/collections.js";

const ENGINES = [
	{ engine: "perplexity", model: "perplexity/sonar-pro" },
	{ engine: "openai", model: "openai/gpt-4o-mini" },
	{ engine: "claude", model: "anthropic/claude-sonnet-4" },
];

function buildPrompt(siteProfile, audit) {
	const topic =
		audit?.siteSummary ||
		audit?.audit?.description ||
		audit?.niche ||
		siteProfile.description ||
		siteProfile.niche ||
		"software development learning";

	return `What are the best websites, platforms, and tools for: ${topic}?

List 5 specific product/site names with URLs if known. Be concise.

Important: Base your answer on the topic description above, NOT on any pun or literal reading of the domain name "${siteProfile.domain}".`;
}

function parseCitations(content, domain) {
	const lower = String(content).toLowerCase();
	const domainNorm = String(domain || "")
		.replace(/^www\./i, "")
		.toLowerCase();
	const cited = domainNorm
		? lower.includes(domainNorm) || lower.includes(domainNorm.split(".")[0])
		: false;
	const competitors = [];
	const urlRe = /https?:\/\/[^\s)\]"']+/gi;
	for (const u of content.match(urlRe) || []) {
		try {
			const h = new URL(u).hostname.replace(/^www\./i, "");
			if (domainNorm && h.includes(domainNorm.replace(/^www\./i, ""))) continue;
			competitors.push(h);
		} catch {
			/* skip */
		}
	}
	return {
		cited,
		competitorCited: [...new Set(competitors)].slice(0, 8),
		citationPosition: cited ? 1 : null,
	};
}

export async function runAiVisibility({ runId, siteProfile, audit }) {
	await updateRun(runId, { stage: "ai_visibility" });
	const prompt = buildPrompt(siteProfile, audit);
	const rows = [];

	for (const { engine, model } of ENGINES) {
		try {
			const r = await openRouterChat({
				model,
				messages: [{ role: "user", content: prompt }],
				maxTokens: 700,
			});
			const meta = parseCitations(r.content, siteProfile.domain);
			rows.push({
				runId,
				engine,
				prompt,
				cited: meta.cited,
				citationPosition: meta.citationPosition,
				competitorCited: meta.competitorCited,
				rawAnswer: r.content.slice(0, 4000),
			});
		} catch (err) {
			console.warn(`[ai-visibility] ${engine} failed:`, err.message);
			rows.push({
				runId,
				engine,
				prompt,
				cited: false,
				citationPosition: null,
				competitorCited: [],
				error: err.message,
			});
		}
	}

	if (rows.length) await addMany("aiVisibilityResults", rows);
	return rows;
}
