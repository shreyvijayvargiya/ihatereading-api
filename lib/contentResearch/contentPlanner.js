/**
 * OpenRouter synthesis — content ideas from real research only.
 */

import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import {
	CONTENT_TYPES,
	PRIORITIES,
	SEARCH_INTENTS,
} from "./schemas.js";
import { computeOpportunityScore, dedupeBy, normalize } from "./utils.js";

const SYSTEM_PROMPT = `You are an SEO/content researcher for iHateReading, a developer-focused technical publication.

Use ONLY the supplied research data.

Do not invent URLs.

Do not invent Reddit questions.

Do not invent search volume.

Do not claim a keyword has high search volume unless actual volume data was provided.

Prioritize topics with evidence from multiple sources.

Prefer topics that:
1. Have real user questions.
2. Have keyword variations.
3. Are relevant to developers.
4. Are not already covered by iHateReading.
5. Can naturally link to existing iHateReading articles.
6. Have useful authoritative external references.

Avoid creating duplicate articles.

If an existing iHateReading article already covers the topic, suggest a different angle or content gap.

Use Reddit research as evidence of user interest, not as proof of search volume.

Return valid JSON matching the provided schema.`;

function allowedUrlSet(research) {
	const set = new Set();
	for (const r of research.reddit || []) {
		if (r.url) set.add(r.url);
	}
	for (const a of research.internalArticles || []) {
		if (a.url) set.add(a.url);
	}
	for (const e of research.externalReferences || []) {
		if (e.url) set.add(e.url);
	}
	return set;
}

function filterLinks(links, allowed) {
	return (links || [])
		.filter((l) => l && l.url && allowed.has(l.url))
		.map((l) => ({
			title: String(l.title || "").slice(0, 200),
			url: l.url,
			suggestedAnchor: String(l.suggestedAnchor || l.title || "").slice(0, 120),
		}));
}

function filterRedditQs(list, allowed) {
	return (list || [])
		.filter((q) => q && q.url && allowed.has(q.url))
		.map((q) => ({
			title: String(q.title || "").slice(0, 300),
			url: q.url,
		}));
}

function normalizeIdea(raw, research, count) {
	const allowed = allowedUrlSet(research);
	const intent = SEARCH_INTENTS.includes(raw.searchIntent)
		? raw.searchIntent
		: "informational";
	const contentType = CONTENT_TYPES.includes(raw.contentType)
		? raw.contentType
		: "guide";
	const priority = PRIORITIES.includes(raw.priority) ? raw.priority : "medium";

	const idea = {
		title: String(raw.title || "").trim().slice(0, 200),
		primaryKeyword: String(raw.primaryKeyword || "").trim().slice(0, 120),
		secondaryKeywords: Array.isArray(raw.secondaryKeywords)
			? raw.secondaryKeywords.map((s) => String(s).trim()).filter(Boolean).slice(0, 8)
			: [],
		searchIntent: intent,
		contentType,
		whyWriteThis: String(raw.whyWriteThis || "").trim().slice(0, 600),
		redditQuestions: filterRedditQs(raw.redditQuestions, allowed).slice(0, 6),
		internalLinks: filterLinks(raw.internalLinks, allowed).slice(0, 6),
		externalLinks: filterLinks(raw.externalLinks, allowed).slice(0, 6),
		outline: Array.isArray(raw.outline)
			? raw.outline.map((s) => String(s).trim()).filter(Boolean).slice(0, 12)
			: [],
		metaTitle: String(raw.metaTitle || raw.title || "").trim().slice(0, 70),
		metaDescription: String(raw.metaDescription || "").trim().slice(0, 160),
		priority,
	};

	if (!idea.title) return null;

	idea.opportunityScore = computeOpportunityScore(idea, {
		keywords: research.keywords,
		reddit: research.reddit,
		internal_articles: research.internalArticles,
		external_references: research.externalReferences,
	});

	return idea;
}

/**
 * @param {{
 *   topic: string,
 *   count: number,
 *   keywords: object[],
 *   reddit: object[],
 *   internalArticles: object[],
 *   externalReferences: object[],
 * }} research
 */
export async function generateContentIdeas(research) {
	const count = Math.min(20, Math.max(5, research.count || 10));
	const payload = {
		topic: research.topic,
		keywords: (research.keywords || []).slice(0, 40).map((k) => ({
			keyword: k.keyword,
			source: k.source,
			intent: k.intent,
			...(k.searchVolume != null ? { searchVolume: k.searchVolume } : {}),
		})),
		reddit: (research.reddit || []).slice(0, 30).map((r) => ({
			title: r.title,
			url: r.url,
			subreddit: r.subreddit,
			score: r.score,
			comments: r.comments,
		})),
		internal_articles: (research.internalArticles || []).slice(0, 30).map((a) => ({
			title: a.title,
			url: a.url,
			description: a.description,
		})),
		external_references: (research.externalReferences || [])
			.slice(0, 20)
			.map((e) => ({
				title: e.title,
				url: e.url,
				domain: e.domain,
			})),
	};

	const model =
		process.env.OPENROUTER_CONTENT_RESEARCH_MODEL ||
		process.env.OPENROUTER_MODEL ||
		undefined;

	const { content, usage, model: usedModel } = await openRouterChat({
		model,
		jsonMode: true,
		temperature: 0.35,
		maxTokens: 6000,
		timeoutMs: 120_000,
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{
				role: "user",
				content: `Generate exactly ${count} content ideas as JSON:
{
  "content_ideas": [
    {
      "title": "",
      "primaryKeyword": "",
      "secondaryKeywords": [],
      "searchIntent": "informational|commercial|transactional|navigational|mixed",
      "contentType": "tutorial|comparison|list|guide|case-study|news|opinion",
      "whyWriteThis": "",
      "redditQuestions": [{ "title": "", "url": "" }],
      "internalLinks": [{ "title": "", "url": "", "suggestedAnchor": "" }],
      "externalLinks": [{ "title": "", "url": "", "suggestedAnchor": "" }],
      "outline": [],
      "metaTitle": "",
      "metaDescription": "",
      "priority": "high|medium|low"
    }
  ]
}

Only use URLs that appear in the research JSON below.
For redditQuestions / internalLinks / externalLinks, copy title+url from research; leave arrays empty if none fit.

Research:
${JSON.stringify(payload)}`,
			},
		],
	});

	let parsed = {};
	try {
		parsed = parseJsonFromLLM(content);
	} catch (err) {
		throw new Error(`Failed to parse content ideas JSON: ${err?.message || err}`);
	}

	const rawIdeas = Array.isArray(parsed.content_ideas)
		? parsed.content_ideas
		: Array.isArray(parsed.contentIdeas)
			? parsed.contentIdeas
			: Array.isArray(parsed.ideas)
				? parsed.ideas
				: [];

	const ideas = dedupeBy(
		rawIdeas
			.map((raw) => normalizeIdea(raw, research, count))
			.filter(Boolean),
		(i) => i.title,
	)
		.sort((a, b) => (b.opportunityScore || 0) - (a.opportunityScore || 0))
		.slice(0, count);

	if (!ideas.length) {
		throw new Error("OpenRouter returned no usable content ideas");
	}

	return {
		contentIdeas: ideas,
		usage,
		model: usedModel,
	};
}

export { normalize };
