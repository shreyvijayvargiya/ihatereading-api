/**
 * Firestore access for content_sites collection tree.
 */

import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../../config/firebase.js";
import { domainHost, makeSiteId, slugify, titleSimilarity } from "../utils.js";
import { normalizeHook } from "../config/hooks.js";

export const SITES_COLLECTION = "content_sites";

function siteRef(siteId) {
	return firestore.collection(SITES_COLLECTION).doc(String(siteId));
}

function topicsRef(siteId) {
	return siteRef(siteId).collection("topics");
}

function articlesRef(siteId) {
	return siteRef(siteId).collection("articles");
}

function researchRef(siteId) {
	return siteRef(siteId).collection("research");
}

export async function getSite(siteId) {
	const snap = await siteRef(siteId).get();
	if (!snap.exists) return null;
	return { id: snap.id, ...snap.data() };
}

/** Resolve site by doc id, domain host, or slug (e.g. airdropbounty-events). */
export async function resolveSite(siteIdOrDomain) {
	const key = String(siteIdOrDomain || "").trim();
	if (!key) return null;

	const direct = await getSite(key);
	if (direct) return { siteId: key, site: direct };

	const needle = key.toLowerCase().replace(/^www\./, "");
	const sites = await listSites(200);
	for (const row of sites) {
		const id = row.id;
		const host = domainHost(row.domain || "");
		const idFromHost = makeSiteId(row.name, row.domain);
		const hostAsSlug = host.replace(/\./g, "-");
		if (
			id === needle ||
			host === needle ||
			idFromHost === needle ||
			hostAsSlug === needle
		) {
			return { siteId: id, site: row };
		}
	}
	return null;
}

export async function upsertSite(siteId, data) {
	const ref = siteRef(siteId);
	const existing = await ref.get();
	const now = new Date().toISOString();
	const payload = {
		...data,
		updatedAt: now,
	};
	if (!existing.exists) {
		payload.createdAt = FieldValue.serverTimestamp();
		payload.createdAtIso = now;
	}
	await ref.set(payload, { merge: true });
	const snap = await ref.get();
	return { id: snap.id, ...snap.data() };
}

export async function saveSiteExistingContent(siteId, patch) {
	await siteRef(siteId).set(
		{ ...patch, updatedAt: new Date().toISOString() },
		{ merge: true },
	);
}

export async function listSites(limit = 50) {
	const snap = await firestore.collection(SITES_COLLECTION).limit(limit).get();
	return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getTopic(siteId, topicId) {
	const snap = await topicsRef(siteId).doc(topicId).get();
	if (!snap.exists) return null;
	return { id: snap.id, ...snap.data() };
}

export async function listTopics(siteId, filters = {}) {
	const snap = await topicsRef(siteId).get();
	let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	if (filters.status) {
		const s = String(filters.status).toLowerCase();
		rows = rows.filter((r) => String(r.status || "").toLowerCase() === s);
	}
	if (filters.hook) {
		const h = String(filters.hook).toLowerCase();
		rows = rows.filter((r) => String(r.hook || "").toLowerCase() === h);
	}
	rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
	if (filters.limit) rows = rows.slice(0, filters.limit);
	return rows;
}

export async function saveTopic(siteId, topic) {
	const id = topic.id || slugify(topic.title);
	const ref = topicsRef(siteId).doc(id);
	const existing = await ref.get();
	const now = new Date().toISOString();
	const payload = {
		...topic,
		id,
		updatedAt: now,
	};
	if (!existing.exists) {
		payload.createdAt = FieldValue.serverTimestamp();
		payload.createdAtIso = now;
		payload.status = payload.status || "pending";
	}
	await ref.set(payload, { merge: true });
	return { id, ...payload };
}

export async function updateTopicStatus(siteId, topicId, status) {
	const ref = topicsRef(siteId).doc(topicId);
	const snap = await ref.get();
	if (!snap.exists) return null;
	await ref.set({ status, updatedAt: new Date().toISOString() }, { merge: true });
	return { id: topicId, ...snap.data(), status };
}

const TOPIC_STATUSES = new Set([
	"pending",
	"approved",
	"rejected",
	"generating",
	"generated",
	"needs_edit",
]);

export async function updateTopicFields(siteId, topicId, patch = {}) {
	const ref = topicsRef(siteId).doc(topicId);
	const snap = await ref.get();
	if (!snap.exists) return null;

	const { id: _id, siteId: _site, createdAt, ...rest } = patch;
	if (rest.status && !TOPIC_STATUSES.has(String(rest.status).toLowerCase())) {
		throw new Error(`Invalid status: ${rest.status}`);
	}
	const payload = {
		...rest,
		updatedAt: new Date().toISOString(),
	};
	if (payload.status) payload.status = String(payload.status).toLowerCase();
	await ref.set(payload, { merge: true });
	const next = await ref.get();
	return { id: topicId, ...next.data() };
}

export async function deleteTopic(siteId, topicId) {
	const ref = topicsRef(siteId).doc(topicId);
	const snap = await ref.get();
	if (!snap.exists) return false;
	await ref.delete();
	return true;
}

export async function duplicateTopic(siteId, topicId) {
	const topic = await getTopic(siteId, topicId);
	if (!topic) return null;
	const copy = {
		...topic,
		id: undefined,
		title: `${topic.title} (copy)`,
		status: "pending",
		createdAt: undefined,
		createdAtIso: undefined,
		updatedAt: undefined,
	};
	return saveTopic(siteId, copy);
}

export async function updateArticleFields(siteId, articleId, patch = {}) {
	const ref = articlesRef(siteId).doc(articleId);
	const snap = await ref.get();
	if (!snap.exists) return null;
	const { id: _id, siteId: _site, createdAt, ...rest } = patch;
	await ref.set({ ...rest, updatedAt: new Date().toISOString() }, { merge: true });
	const next = await ref.get();
	return { id: articleId, ...next.data() };
}

export async function deleteArticle(siteId, articleId) {
	const ref = articlesRef(siteId).doc(articleId);
	const snap = await ref.get();
	if (!snap.exists) return false;
	await ref.delete();
	return true;
}

export async function getArticleByTopic(siteId, topicId) {
	const snap = await articlesRef(siteId).where("topicId", "==", topicId).limit(1).get();
	if (snap.empty) return null;
	const d = snap.docs[0];
	return { id: d.id, ...d.data() };
}

export async function listArticles(siteId, limit = 50) {
	const snap = await articlesRef(siteId).limit(limit).get();
	return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function saveArticle(siteId, article) {
	const id = article.id || slugify(article.slug || article.title);
	const ref = articlesRef(siteId).doc(id);
	const existing = await ref.get();
	const now = new Date().toISOString();
	const payload = {
		...article,
		id,
		updatedAt: now,
	};
	if (!existing.exists) {
		payload.createdAt = FieldValue.serverTimestamp();
		payload.createdAtIso = now;
		payload.status = payload.status || "draft";
	}
	await ref.set(payload, { merge: true });
	return { id, ...payload };
}

export async function saveResearchRun(siteId, data) {
	const id = data.id || `research-${Date.now()}`;
	const ref = researchRef(siteId).doc(id);
	const now = new Date().toISOString();
	await ref.set(
		{
			...data,
			id,
			createdAt: FieldValue.serverTimestamp(),
			createdAtIso: now,
			updatedAt: now,
		},
		{ merge: true },
	);
	return id;
}

export function isDuplicateTopic(
	candidate,
	existingTopics,
	existingContent = [],
	opts = {},
) {
	const title = String(candidate.title || "").trim().toLowerCase();
	if (!title) return true;

	let topicPool = existingTopics;
	if (opts.discoverySource) {
		topicPool = existingTopics.filter(
			(t) => t.discoverySource === opts.discoverySource,
		);
	} else if (opts.excludeDiscoverySource) {
		topicPool = existingTopics.filter(
			(t) => t.discoverySource !== opts.excludeDiscoverySource,
		);
	}

	for (const t of topicPool) {
		if (String(t.title || "").trim().toLowerCase() === title) return true;
		if (titleSimilarity(t.title, candidate.title) >= 0.85) return true;
	}

	if (!opts.skipContentDedupe) {
		for (const page of existingContent) {
			if (titleSimilarity(page.title, candidate.title) >= 0.8) return true;
		}
	}

	return false;
}

/** Coerce LLM topic shapes (string items, alternate field names). */
export function coerceRawTopic(raw) {
	if (typeof raw === "string") {
		const title = raw.trim();
		return title ? { title } : null;
	}
	if (!raw || typeof raw !== "object") return null;

	const title = String(
		raw.title ||
			raw.topic ||
			raw.headline ||
			raw.name ||
			raw.Topic ||
			raw.topicTitle ||
			"",
	).trim();
	if (!title) return null;

	const sourceUrls = [
		...(Array.isArray(raw.sourceUrls) ? raw.sourceUrls : []),
		...(Array.isArray(raw.sources)
			? raw.sources.map((s) => (typeof s === "string" ? s : s?.url)).filter(Boolean)
			: []),
		...(Array.isArray(raw.source_urls) ? raw.source_urls : []),
	];

	return {
		...raw,
		title,
		sourceUrls: [...new Set(sourceUrls.map((u) => String(u).trim()).filter(Boolean))],
		hook: raw.hook || raw.contentHook || raw.type,
		articleApproach: raw.articleApproach || raw.approach || raw.article_approach,
		keyQuestions: raw.keyQuestions || raw.questions || raw.key_questions || [],
		readerProblem: raw.readerProblem || raw.problem || raw.reader_problem,
		researchSummary: raw.researchSummary || raw.summary || raw.research_summary,
	};
}

export function normalizeTopicFromAgent(raw, researchSignals) {
	const coerced = coerceRawTopic(raw);
	if (!coerced) {
		return { title: "", hook: "faq", status: "pending" };
	}
	raw = coerced;
	const sourceUrls = (raw.sourceUrls || []).filter(Boolean);
	const sources = sourceUrls.map((url) => {
		const hit = researchSignals.find((s) => s.url === url);
		return {
			title: hit?.title || "",
			url,
			domain: hit?.domain || "",
			type: /reddit\.com/i.test(url) ? "reddit" : "article",
		};
	});

	const hook = normalizeHook(raw.hook);
	const approach = raw.articleApproach || {};

	return {
		title: String(raw.title || "").trim(),
		hook,
		status: "pending",
		angle: String(raw.angle || "").trim(),
		intent: raw.intent || "informational",
		audience: String(raw.audience || "").trim(),
		readerProblem: String(raw.readerProblem || "").trim(),
		keyQuestions: raw.keyQuestions || [],
		entities: raw.entities || [],
		articleApproach: {
			style: approach.style || "practical",
			depth: approach.depth || "medium",
			openingStyle: approach.openingStyle || "direct-answer",
			format: approach.format || "narrative",
			avoid: approach.avoid || ["generic introduction", "AI filler"],
		},
		whyNow: String(raw.whyNow || "").trim(),
		researchSummary: String(raw.researchSummary || "").trim(),
		sources,
		internalLinkCandidates: [],
		externalLinkCandidates: sources.map((s) => ({
			title: s.title,
			url: s.url,
			domain: s.domain,
		})),
		priority: raw.priority || "medium",
		...(raw.discoverySource
			? { discoverySource: String(raw.discoverySource).trim() }
			: {}),
	};
}

export async function getDashboardData(siteId, filters = {}) {
	const site = await getSite(siteId);
	if (!site) return null;

	const topics = await listTopics(siteId, filters);
	const articles = await listArticles(siteId, 100);

	const redditTopics = topics.filter(
		(t) => t.discoverySource === "reddit-airdrop-bounty-scraper",
	);
	const editorialTopics = topics.filter(
		(t) => t.discoverySource !== "reddit-airdrop-bounty-scraper",
	);

	const stats = {
		topics: topics.length,
		editorialTopics: editorialTopics.length,
		redditTopics: redditTopics.length,
		pending: topics.filter((t) => t.status === "pending").length,
		approved: topics.filter((t) => t.status === "approved").length,
		rejected: topics.filter((t) => t.status === "rejected").length,
		generated: topics.filter((t) => t.status === "generated").length,
		articles: articles.length,
	};

	return { site, stats, topics, articles };
}
