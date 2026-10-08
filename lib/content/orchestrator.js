/**
 * Content Intelligence orchestrator — enroll, research, generate, dashboard.
 */

import { HOOK_IDS } from "./config/hooks.js";
import {
	getSite,
	resolveSite,
	upsertSite,
	listTopics,
	saveTopic,
	updateTopicStatus,
	updateTopicFields,
	deleteTopic,
	duplicateTopic,
	updateArticleFields,
	deleteArticle,
	getTopic,
	getArticleByTopic,
	saveArticle,
	saveResearchRun,
	isDuplicateTopic,
	coerceRawTopic,
	normalizeTopicFromAgent,
	getDashboardData,
	listSites,
} from "./services/firestore.js";
import { searchWebBatch } from "./services/search.js";
import { scrapePages } from "./services/scraper.js";
import {
	planSearchQueries,
	discoverTopics,
	normalizeSignals,
} from "./services/research-agent.js";
import { generateArticle } from "./services/writer-agent.js";
import {
	getExistingContent,
	findInternalLinkCandidates,
} from "./services/site-content.js";
import { validateLinks } from "./services/link-validator.js";
import { validateArticle } from "./services/article-validator.js";
import {
	log,
	makeSiteId,
	normalizeDomain,
	mapPool,
} from "./utils.js";

const RESEARCH_COOLDOWN_MS = Number(
	process.env.CONTENT_INTEL_RESEARCH_COOLDOWN_MS || 6 * 60 * 60 * 1000,
);

export async function enrollSite(body) {
	const name = String(body.name || "").trim();
	const domain = normalizeDomain(body.domain);
	if (!name || !domain) {
		throw Object.assign(new Error("name and domain are required"), { status: 400 });
	}

	const siteId = makeSiteId(name, domain);
	log("Enrolling site", `${name} → ${siteId}`);

	const site = await upsertSite(siteId, {
		name,
		domain,
		description: String(body.description || "").trim(),
		audience: String(body.audience || "").trim(),
		contentGoals: body.contentGoals || [],
		hooks: body.hooks || HOOK_IDS,
		competitors: body.competitors || [],
		existingArticleUrls: body.existingArticleUrls || [],
	});

	return { siteId, site };
}

export async function runResearch(siteId, opts = {}) {
	const resolved = await resolveSite(siteId);
	if (!resolved) {
		const hint = makeSiteId("Site", siteId.includes(".") ? siteId : `https://${siteId}`);
		throw Object.assign(
			new Error(
				`Site not found: "${siteId}". Enroll first:\n` +
					`  npm run content:intelligence -- enroll --name "Your Site" --domain https://${siteId.includes(".") ? siteId : `${siteId}.com`}\n` +
					`  (expected siteId is often "${hint}")`,
			),
			{ status: 404, code: "SITE_NOT_FOUND" },
		);
	}
	const { siteId: resolvedId, site } = resolved;
	siteId = resolvedId;

	const limit = Math.min(30, Math.max(1, Number(opts.limit) || 30));
	const baseUrl = opts.baseUrl;

	if (!opts.force && site.lastResearchAt) {
		const age = Date.now() - new Date(site.lastResearchAt).getTime();
		if (age < RESEARCH_COOLDOWN_MS) {
			const topics = await listTopics(siteId);
			return {
				siteId,
				skipped: true,
				reason: "recent_research",
				topicCount: topics.length,
				topics: topics.slice(0, limit),
			};
		}
	}

	const existingContent = await getExistingContent(siteId, {
		baseUrl,
		refresh: opts.refreshContent,
	});
	const existingTopics = await listTopics(siteId);

	log("Generating research queries");
	const queries = await planSearchQueries(site, existingContent, opts);
	// Ensure Reddit coverage via Google site: queries
	const redditQueries = queries
		.filter((q) => !/site:reddit/i.test(q))
		.slice(0, 4)
		.map((q) => `site:reddit.com ${q}`);

	log("Google search completed", `${queries.length + redditQueries.length} queries`);
	const searchResults = await searchWebBatch(
		[...queries, ...redditQueries],
		{ baseUrl, maxQueries: 18, numPerQuery: 6 },
	);

	const urlsToScrape = searchResults
		.sort((a, b) => (b.snippet?.length || 0) - (a.snippet?.length || 0))
		.map((r) => r.url)
		.slice(0, opts.scrapeLimit || 12);

	log("Pages scraped", `up to ${urlsToScrape.length}`);
	const scrapedPages = await scrapePages(urlsToScrape, {
		baseUrl,
		limit: urlsToScrape.length,
	});

	const signals = normalizeSignals(searchResults, scrapedPages);
	log("Research agent running", `${signals.length} signals`);

	const rawTopics = await discoverTopics(
		site,
		existingContent,
		existingTopics,
		signals,
		{ limit },
	);

	const saved = [];
	let skipped = 0;
	let rejectedEmpty = 0;
	for (const raw of rawTopics) {
		const coerced = coerceRawTopic(raw);
		if (!coerced) {
			rejectedEmpty += 1;
			continue;
		}
		const topic = normalizeTopicFromAgent(coerced, signals);
		if (!topic.title) {
			rejectedEmpty += 1;
			continue;
		}
		if (isDuplicateTopic(topic, [...existingTopics, ...saved], existingContent)) {
			skipped += 1;
			continue;
		}
		topic.internalLinkCandidates = findInternalLinkCandidates(
			topic,
			existingContent,
			10,
		);
		const row = await saveTopic(siteId, topic);
		saved.push(row);
	}

	const researchId = await saveResearchRun(siteId, {
		queries,
		signalCount: signals.length,
		scrapedCount: scrapedPages.length,
		topicCount: saved.length,
		skippedDuplicates: skipped,
		rejectedEmpty,
	});

	await upsertSite(siteId, {
		lastResearchAt: new Date().toISOString(),
		lastResearchId: researchId,
	});

	if (rejectedEmpty) {
		log("Topics rejected", `${rejectedEmpty} missing usable title field`);
	}
	log("Topics saved", `${saved.length} new (${skipped} duplicates skipped)`);

	return {
		siteId,
		researchId,
		queries: queries.length,
		signals: signals.length,
		scraped: scrapedPages.length,
		saved: saved.length,
		skippedDuplicates: skipped,
		rejectedEmpty,
		topics: saved,
	};
}

export async function patchTopic(siteId, topicId, body) {
	const keys = Object.keys(body || {}).filter((k) => k !== "siteId");
	if (!keys.length) {
		throw Object.assign(new Error("No fields to update"), { status: 400 });
	}
	const updated = await updateTopicFields(siteId, topicId, body);
	if (!updated) throw Object.assign(new Error("Topic not found"), { status: 404 });
	return updated;
}

export async function createTopic(siteId, body) {
	const site = await getSite(siteId);
	if (!site) throw Object.assign(new Error("Site not found"), { status: 404 });
	if (!body?.title?.trim()) {
		throw Object.assign(new Error("title is required"), { status: 400 });
	}
	return saveTopic(siteId, {
		hook: body.hook || "faq",
		status: body.status || "pending",
		priority: body.priority || "medium",
		intent: body.intent || "informational",
		audience: body.audience || site.audience || "",
		angle: body.angle || "",
		readerProblem: body.readerProblem || "",
		researchSummary: body.researchSummary || "",
		...body,
	});
}

export async function removeTopic(siteId, topicId) {
	const ok = await deleteTopic(siteId, topicId);
	if (!ok) throw Object.assign(new Error("Topic not found"), { status: 404 });
	return { deleted: true, topicId };
}

export async function copyTopic(siteId, topicId) {
	const copy = await duplicateTopic(siteId, topicId);
	if (!copy) throw Object.assign(new Error("Topic not found"), { status: 404 });
	return copy;
}

export async function patchArticle(siteId, articleId, body) {
	const updated = await updateArticleFields(siteId, articleId, body);
	if (!updated) throw Object.assign(new Error("Article not found"), { status: 404 });
	return updated;
}

export async function removeArticle(siteId, articleId) {
	const ok = await deleteArticle(siteId, articleId);
	if (!ok) throw Object.assign(new Error("Article not found"), { status: 404 });
	return { deleted: true, articleId };
}

export { listArticles } from "./services/firestore.js";

export async function runGenerate(siteId, topicId, opts = {}) {
	const site = await getSite(siteId);
	if (!site) throw Object.assign(new Error("Site not found"), { status: 404 });

	const topic = await getTopic(siteId, topicId);
	if (!topic) throw Object.assign(new Error("Topic not found"), { status: 404 });

	if (!opts.force) {
		if (topic.status === "generating") {
			throw Object.assign(new Error("Topic is already generating"), { status: 409 });
		}
		if (topic.status === "generated") {
			const existing = await getArticleByTopic(siteId, topicId);
			if (existing) return { article: existing, existing: true };
		}
		if (topic.status !== "approved" && !opts.force) {
			throw Object.assign(
				new Error("Topic must be approved (or pass force: true)"),
				{ status: 400 },
			);
		}
	}

	const existing = await getArticleByTopic(siteId, topicId);
	if (existing && !opts.force) {
		return { article: existing, existing: true };
	}

	await updateTopicStatus(siteId, topicId, "generating");
	log("Writing article", topic.title);

	try {
		const existingContent = await getExistingContent(siteId, { baseUrl: opts.baseUrl });
		topic.internalLinkCandidates =
			topic.internalLinkCandidates?.length
				? topic.internalLinkCandidates
				: findInternalLinkCandidates(topic, existingContent, 10);

		const draft = await generateArticle(site, topic, {
			...opts,
			siteId,
			existingContent,
		});

		const linkValidation = validateLinks(
			draft,
			topic.internalLinkCandidates,
			topic.externalLinkCandidates || topic.sources,
		);

		const validation = validateArticle(
			{ ...draft, hook: topic.hook },
			linkValidation,
		);

		const article = await saveArticle(siteId, {
			topicId,
			title: draft.title,
			slug: draft.slug,
			description: draft.description,
			hook: topic.hook,
			content: draft.content,
			tags: draft.tags || [],
			bannerImage: draft.bannerImage || "",
			sources: topic.sources || [],
			internalLinks: linkValidation.internalLinks,
			externalLinks: linkValidation.externalLinks,
			validation,
			status: validation.valid ? "draft" : "needs_review",
		});

		await updateTopicStatus(siteId, topicId, "generated");
		log("Article saved", article.id);
		return { article, validation };
	} catch (err) {
		await updateTopicStatus(siteId, topicId, "approved");
		throw err;
	}
}

export async function runGenerateBatch(siteId, opts = {}) {
	const limit = Math.min(15, Math.max(1, Number(opts.limit) || 15));
	let batch;

	if (Array.isArray(opts.topicIds) && opts.topicIds.length) {
		const ids = [...new Set(opts.topicIds.map(String).filter(Boolean))].slice(0, 15);
		batch = [];
		for (const topicId of ids) {
			const topic = await getTopic(siteId, topicId);
			if (topic) batch.push(topic);
		}
	} else {
		const topics = await listTopics(siteId, { status: "approved" });
		batch = topics.slice(0, limit);
	}

	const results = await mapPool(batch, opts.concurrency || 2, async (topic) => {
		try {
			const out = await runGenerate(siteId, topic.id, {
				...opts,
				force: opts.force,
			});
			return { topicId: topic.id, success: true, articleId: out.article?.id };
		} catch (err) {
			return {
				topicId: topic.id,
				success: false,
				error: err?.message || String(err),
			};
		}
	});

	const generated = results.filter((r) => r.success).length;
	const failed = results.filter((r) => !r.success).length;

	return {
		success: true,
		requested: batch.length,
		generated,
		failed,
		results,
	};
}

export async function getDashboard(siteId, filters = {}) {
	const data = await getDashboardData(siteId, filters);
	if (!data) throw Object.assign(new Error("Site not found"), { status: 404 });
	return data;
}

export { listSites, listTopics };
export { runRedditAirdropBountyScraper } from "./services/reddit-airdrop-scraper.js";
export { runAgent37MultiSourceResearch } from "./services/agent37-multi-source-research.js";
