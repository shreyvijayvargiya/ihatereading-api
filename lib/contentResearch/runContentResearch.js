/**
 * Orchestrates content research pipeline and persists runs to Firestore.
 */

import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { researchKeywords } from "./keywordResearch.js";
import { researchReddit } from "./redditResearch.js";
import { searchInternalArticles } from "./internalResearch.js";
import { researchExternalReferences } from "./externalResearch.js";
import { generateContentIdeas } from "./contentPlanner.js";
import { loadSiteContext } from "./siteContext.js";

const RUNS_COLL = "content_research_runs";
const CALENDAR_COLL = "content_calendar";

/**
 * Firestore rejects `undefined`. JSON round-trip drops undefined keys
 * and converts Timestamps / Dates into plain JSON-safe values.
 * FieldValue sentinels must be added AFTER this.
 */
function toPlainFirestoreData(value) {
	return JSON.parse(
		JSON.stringify(value, (_key, v) => (v === undefined ? undefined : v)),
	);
}

function cleanKeyword(k) {
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

function cleanReddit(r) {
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

function cleanInternal(a) {
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

function cleanExternal(e) {
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

function siteContextSummary(siteContext) {
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

function sanitizeRunPayload({
	id,
	topic,
	count,
	region,
	language,
	keywords,
	reddit,
	internalArticles,
	externalReferences,
	contentIdeas,
	warnings,
	generatedAt,
	model,
	siteContext,
}) {
	const plain = toPlainFirestoreData({
		id,
		topic,
		count,
		region,
		language,
		keywords: (keywords || []).map(cleanKeyword).filter(Boolean),
		reddit: (reddit || []).map(cleanReddit).filter(Boolean),
		internalArticles: (internalArticles || []).map(cleanInternal).filter(Boolean),
		externalReferences: (externalReferences || [])
			.map(cleanExternal)
			.filter(Boolean),
		contentIdeas: contentIdeas || [],
		warnings: (warnings || []).filter(Boolean).map(String),
		generatedAt,
		model: model || null,
		siteContext: siteContextSummary(siteContext),
	});
	plain.createdAt = FieldValue.serverTimestamp();
	plain.updatedAt = FieldValue.serverTimestamp();
	return plain;
}

function hasAnyResearch(keywords, reddit, internal, external) {
	return (
		(keywords?.length || 0) +
			(reddit?.length || 0) +
			(internal?.length || 0) +
			(external?.length || 0) >
		0
	);
}

async function saveRun(doc) {
	const id = doc.id || randomUUID();
	const payload = sanitizeRunPayload({ ...doc, id });
	await firestore.collection(RUNS_COLL).doc(id).set(payload, { merge: true });
	return id;
}

async function saveCalendarIdeas(runId, topic, ideas) {
	if (!ideas?.length) return;
	const batch = firestore.batch();
	for (const idea of ideas.slice(0, 20)) {
		const ref = firestore.collection(CALENDAR_COLL).doc();
		const plain = toPlainFirestoreData({
			runId,
			topic,
			title: idea.title || "",
			primaryKeyword: idea.primaryKeyword || "",
			opportunityScore:
				typeof idea.opportunityScore === "number" ? idea.opportunityScore : null,
			priority: idea.priority || "medium",
			status: "idea",
			contentIdea: idea,
		});
		plain.createdAt = FieldValue.serverTimestamp();
		batch.set(ref, plain);
	}
	await batch.commit();
}

/**
 * @param {{ topic: string, count?: number, region?: string, language?: string, baseUrl?: string }} input
 */
export async function runContentResearch(input) {
	const topic = String(input.topic || "").trim();
	const count = input.count ?? 10;
	const region = input.region || "global";
	const language = input.language || "en";
	const baseUrl = input.baseUrl || undefined;
	const warnings = [];
	const generatedAt = new Date().toISOString();

	let siteContext = null;
	try {
		const site = await loadSiteContext({ baseUrl });
		siteContext = site.siteContext;
		warnings.push(...(site.warnings || []));
	} catch (err) {
		warnings.push(`Site context failed: ${err?.message || err}`);
	}

	let keywords = [];
	try {
		const kwResult = await researchKeywords(topic, {
			language,
			region,
			baseUrl,
			siteContext,
		});
		keywords = kwResult.keywords || [];
		warnings.push(...(kwResult.warnings || []));
	} catch (err) {
		warnings.push(`Keyword research failed: ${err?.message || err}`);
	}

	const [redditSettled, internalSettled, externalSettled] =
		await Promise.allSettled([
			researchReddit(topic, keywords, { baseUrl }),
			searchInternalArticles(topic, keywords, { baseUrl }),
			researchExternalReferences(topic, keywords, { baseUrl, language }),
		]);

	let reddit = [];
	let internalArticles = [];
	let externalReferences = [];

	if (redditSettled.status === "fulfilled") {
		reddit = redditSettled.value.reddit || [];
		warnings.push(...(redditSettled.value.warnings || []));
	} else {
		warnings.push(
			`Reddit research failed: ${redditSettled.reason?.message || redditSettled.reason}`,
		);
	}

	if (internalSettled.status === "fulfilled") {
		internalArticles = internalSettled.value.internalArticles || [];
		warnings.push(...(internalSettled.value.warnings || []));
	} else {
		warnings.push(
			`Internal research failed: ${internalSettled.reason?.message || internalSettled.reason}`,
		);
	}

	if (externalSettled.status === "fulfilled") {
		externalReferences = externalSettled.value.externalReferences || [];
		warnings.push(...(externalSettled.value.warnings || []));
	} else {
		warnings.push(
			`External reference research failed: ${externalSettled.reason?.message || externalSettled.reason}`,
		);
	}

	// Always expose Firestore-safe shapes in API + storage
	keywords = keywords.map(cleanKeyword).filter(Boolean);
	reddit = reddit.map(cleanReddit).filter(Boolean);
	internalArticles = internalArticles.map(cleanInternal).filter(Boolean);
	externalReferences = externalReferences.map(cleanExternal).filter(Boolean);

	if (!hasAnyResearch(keywords, reddit, internalArticles, externalReferences)) {
		return {
			success: false,
			error: {
				code: "RESEARCH_EMPTY",
				message:
					"All research providers failed or returned no data. Cannot generate content ideas.",
			},
			warnings: [...new Set(warnings.filter(Boolean))],
			topic,
		};
	}

	if (!process.env.OPENROUTER_API_KEY?.trim()) {
		return {
			success: false,
			error: {
				code: "MISSING_OPENROUTER_KEY",
				message: "OPENROUTER_API_KEY is not configured",
			},
			warnings: [...new Set(warnings.filter(Boolean))],
			topic,
			research: {
				keywords,
				reddit,
				internal_articles: internalArticles,
				external_references: externalReferences,
			},
		};
	}

	let contentIdeas = [];
	let usage = null;
	let model = null;
	try {
		const generated = await generateContentIdeas({
			topic,
			count,
			keywords,
			reddit,
			internalArticles,
			externalReferences,
		});
		contentIdeas = generated.contentIdeas;
		usage = generated.usage;
		model = generated.model;
	} catch (err) {
		return {
			success: false,
			error: {
				code: "LLM_FAILED",
				message: err?.message || "Content idea generation failed",
			},
			warnings: [...new Set(warnings.filter(Boolean))],
			topic,
			research: {
				keywords,
				reddit,
				internal_articles: internalArticles,
				external_references: externalReferences,
			},
		};
	}

	const runId = randomUUID();
	try {
		await saveRun({
			id: runId,
			topic,
			count,
			region,
			language,
			keywords,
			reddit,
			internalArticles,
			externalReferences,
			contentIdeas,
			warnings: [...new Set(warnings.filter(Boolean))],
			generatedAt,
			model,
			siteContext,
		});
		await saveCalendarIdeas(runId, topic, contentIdeas);
		console.log(
			`[content-research] saved run ${runId} → ${RUNS_COLL} + ${CALENDAR_COLL}`,
		);
	} catch (err) {
		console.error("[content-research] Firestore save failed:", err);
		warnings.push(`Firestore save failed: ${err?.message || err}`);
	}

	return {
		success: true,
		topic,
		runId,
		research: {
			keywords,
			reddit,
			internal_articles: internalArticles,
			external_references: externalReferences,
			site_context: siteContextSummary(siteContext),
		},
		content_ideas: contentIdeas,
		warnings: [...new Set(warnings.filter(Boolean))],
		meta: {
			keyword_count: keywords.length,
			reddit_result_count: reddit.length,
			internal_article_count: internalArticles.length,
			external_reference_count: externalReferences.length,
			generated_at: generatedAt,
			model,
			region,
			language,
		},
		...(usage ? { usage } : {}),
	};
}
