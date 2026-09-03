/**
 * Stage 6: Blog idea synthesis — merge keywords, questions, competitors, AI visibility.
 */

import { z } from "zod";
import { openRouterChat, DEFAULT_CHAT_MODEL } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import {
	addMany,
	queryByRun,
	updateRun,
} from "../geoPipeline/collections.js";

const blogIdeaSchema = z.object({
	ideas: z.array(
		z.object({
			title: z.string().min(8),
			angle: z.string().min(8),
			targetKeywords: z.array(z.string()).min(1),
			targetIntent: z.string(),
			priorityScore: z.number().min(0).max(100),
			sourceType: z.enum([
				"question",
				"competitor_gap",
				"keyword",
				"geo",
				"mixed",
			]),
			questionRef: z.string().optional().nullable(),
			competitorGapRef: z.string().optional().nullable(),
			geoOpportunity: z.boolean().optional(),
		}),
	),
});

function applyPriorityBonuses(ideas, { questions, competitors, aiRows }) {
	const unanswered = questions.filter((q) => !q.answeredOnSite);
	const gaps = competitors.filter((c) => c.contentGap);
	const uncited = aiRows.filter((a) => !a.cited);

	return ideas.map((idea) => {
		let score = idea.priorityScore || 50;
		if (idea.sourceType === "question" || idea.questionRef) score += 18;
		if (idea.sourceType === "competitor_gap" || idea.competitorGapRef) score += 10;
		if (idea.geoOpportunity || idea.sourceType === "geo") score += 12;
		if (unanswered.length > 0 && idea.sourceType === "question") score += 5;
		if (gaps.length > 0 && idea.sourceType === "competitor_gap") score += 4;
		if (uncited.length > 0 && idea.geoOpportunity) score += 6;
		return { ...idea, priorityScore: Math.min(100, Math.round(score)) };
	});
}

function buildSynthesisPrompt({
	siteProfile,
	audit,
	keywords,
	questions,
	competitors,
	aiRows,
}) {
	const siteBrief =
		audit?.siteSummary ||
		audit?.audit?.description ||
		siteProfile.description ||
		"Unknown — infer only from scraped signals below.";

	return `You are an SEO/GEO content strategist. Return ONLY valid JSON matching:
{ "ideas": [{ "title", "angle", "targetKeywords": string[], "targetIntent", "priorityScore": 0-100, "sourceType": "question"|"competitor_gap"|"keyword"|"geo"|"mixed", "questionRef": "docId or null", "competitorGapRef": "docId or null", "geoOpportunity": boolean }] }

Site URL: ${siteProfile.url}
Domain: ${siteProfile.domain}

CRITICAL — What this site ACTUALLY is (ignore misleading brand/domain names):
${siteBrief}

Meta keywords: ${audit?.audit?.metaKeywords || siteProfile.metaKeywords || "n/a"}
Existing content topics on site: ${JSON.stringify(audit?.audit?.blogTitles?.slice(0, 20) || audit?.audit?.llmsTopics?.slice(0, 15) || [])}
Tech stack: ${JSON.stringify(siteProfile.techStack || audit?.techStack || [])}
Scrape quality: ${audit?.audit?.scrapeQuality || "unknown"}

Keywords (volume/difficulty when present):
${JSON.stringify(keywords.slice(0, 25), null, 0)}

Unanswered questions (PAA / related / autocomplete — highest AEO value):
${JSON.stringify(questions.filter((q) => !q.answeredOnSite).slice(0, 30), null, 0)}

Competitor content gaps:
${JSON.stringify(competitors.filter((c) => c.contentGap).slice(0, 20), null, 0)}

AI visibility (we were NOT cited — GEO opportunity):
${JSON.stringify(aiRows.filter((a) => !a.cited).slice(0, 10), null, 0)}

Rules:
- ALL blog ideas must fit the site's ACTUAL topic (${siteBrief.slice(0, 200)}).
- Do NOT suggest ideas about books, literature, story letters, audiobooks, or "hating to read" unless the site brief explicitly says that is the product.
- For developer/education sites: focus on tutorials, roadmaps, tools, templates, jobs, newsletters, comparisons in that domain.
- Produce 12-18 blog ideas.
- Weight priorityScore highest for unanswered question-sourced ideas (AEO/GEO).
- Use questionRef/competitorGapRef IDs from the JSON above when applicable.
- targetIntent: informational | commercial | transactional`;
}

async function callSynthesisWithRetry(prompt) {
	let lastErr;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const r = await openRouterChat({
				model: DEFAULT_CHAT_MODEL,
				jsonMode: true,
				maxTokens: 5000,
				messages: [
					{
						role: "system",
						content:
							"You output structured blog ideas as JSON only. No markdown fences.",
					},
					{ role: "user", content: prompt },
				],
			});
			const parsed = parseJsonFromLLM(r.content);
			const validated = blogIdeaSchema.parse(parsed);
			return validated.ideas;
		} catch (err) {
			lastErr = err;
			console.warn(`[synthesize] attempt ${attempt + 1} failed:`, err.message);
		}
	}
	throw lastErr || new Error("Synthesis failed");
}

export async function runBlogIdeaSynthesis({ runId, siteProfile, audit }) {
	await updateRun(runId, { stage: "blog_synthesis" });

	const [keywords, questions, competitors, aiRows] = await Promise.all([
		queryByRun("keywordData", runId),
		queryByRun("questionData", runId, {
			where: [["answeredOnSite", "==", false]],
		}),
		queryByRun("competitorData", runId, {
			where: [["contentGap", "==", true]],
		}),
		queryByRun("aiVisibilityResults", runId, {
			where: [["cited", "==", false]],
		}),
	]);

	const prompt = buildSynthesisPrompt({
		siteProfile,
		audit,
		keywords,
		questions,
		competitors,
		aiRows,
	});

	let ideas = await callSynthesisWithRetry(prompt);
	ideas = applyPriorityBonuses(ideas, { questions, competitors, aiRows });

	const toWrite = ideas.map((idea) => ({
		runId,
		title: idea.title,
		angle: idea.angle,
		targetKeywords: idea.targetKeywords,
		targetIntent: idea.targetIntent,
		competitorGapRef: idea.competitorGapRef || null,
		questionRef: idea.questionRef || null,
		geoOpportunity: Boolean(idea.geoOpportunity),
		priorityScore: idea.priorityScore,
		status: "new",
		sourceType: idea.sourceType,
	}));

	if (toWrite.length) await addMany("blogIdeas", toWrite);
	return toWrite;
}

export { blogIdeaSchema };
