/**
 * Agent37.com — parallel multi-source research → topic discovery → Firestore.
 * Sources: Reddit, LinkedIn, X, web (internal /google-search + /scrape APIs).
 */

import {
	AGENT37_DISCOVERY_SOURCE,
	AGENT37_SITE_IDS,
	isAgent37Site,
} from "../config/agent37.js";
import {
	planAgent37Queries,
	discoverAgent37Topics,
} from "./agent37-research-agent.js";
import { collectRedditSignals } from "./source-collectors/reddit.js";
import { collectLinkedInSignals } from "./source-collectors/linkedin.js";
import { collectXSignals } from "./source-collectors/x.js";
import { collectWebSignals } from "./source-collectors/web.js";
import { mergeSignalLists } from "./source-collectors/utils.js";
import { normalizeSignals } from "./research-agent.js";
import { scrapePages } from "./scraper.js";
import {
	resolveSite,
	listTopics,
	saveTopic,
	saveResearchRun,
	upsertSite,
	coerceRawTopic,
	normalizeTopicFromAgent,
	isDuplicateTopic,
} from "./firestore.js";
import { getExistingContent, findInternalLinkCandidates } from "./site-content.js";
import { log, urlDomain } from "../utils.js";

const DEFAULT_SITE_ID = "agent37-com";

function assertAgent37Site(siteId, site) {
	if (isAgent37Site(siteId, site)) return;
	throw Object.assign(
		new Error(`Site "${siteId}" is not an Agent37 site. Enroll agent37.com first.`),
		{ status: 400 },
	);
}

function pickUrlsToScrape(signals, limit = 10) {
	return signals
		.filter((s) => {
			const d = s.domain || urlDomain(s.url);
			return (
				d &&
				!/reddit\.com|linkedin\.com|twitter\.com|x\.com/i.test(d) &&
				(s.snippet?.length > 80 || s.sourceType === "web")
			);
		})
		.sort((a, b) => (b.snippet?.length || 0) - (a.snippet?.length || 0))
		.map((s) => s.url)
		.slice(0, limit);
}

export async function runAgent37MultiSourceResearch(siteIdOrDomain, opts = {}) {
	const resolved = await resolveSite(siteIdOrDomain || DEFAULT_SITE_ID);
	if (!resolved) {
		throw Object.assign(
			new Error(
				`Site not found: ${siteIdOrDomain}. Enroll first:\n` +
					`  npm run content:intelligence -- enroll --name "Agent37" --domain https://agent37.com`,
			),
			{ status: 404 },
		);
	}

	let { siteId, site } = resolved;
	assertAgent37Site(siteId, site);

	if (!process.env.OPENROUTER_API_KEY?.trim()) {
		throw Object.assign(
			new Error("OPENROUTER_API_KEY required for Agent37 topic discovery"),
			{ status: 400 },
		);
	}

	const baseUrl = opts.baseUrl;
	const limit = Math.min(30, Math.max(1, Number(opts.limit) || 20));
	const sources = opts.sources || ["reddit", "linkedin", "x", "web"];

	const existingContent = await getExistingContent(siteId, {
		baseUrl,
		refresh: opts.refreshContent,
	});
	const existingTopics = await listTopics(siteId);

	log("Agent37 planning queries");
	const plan = await planAgent37Queries(site, existingTopics, opts);

	const summary = {
		siteId,
		discoverySource: AGENT37_DISCOVERY_SOURCE,
		sources,
		plan,
		channels: {},
		signals: 0,
		scraped: 0,
		saved: 0,
		skippedDuplicates: 0,
		rejectedEmpty: 0,
		topics: [],
		errors: [],
	};

	const collectors = [];
	if (sources.includes("reddit")) {
		collectors.push(
			collectRedditSignals(plan, { baseUrl, numPerQuery: opts.numPerQuery || 6 }),
		);
	}
	if (sources.includes("linkedin")) {
		collectors.push(
			collectLinkedInSignals(plan, { baseUrl, numPerQuery: opts.numPerQuery || 6 }),
		);
	}
	if (sources.includes("x")) {
		collectors.push(collectXSignals(plan, { baseUrl, numPerQuery: opts.numPerQuery || 6 }));
	}
	if (sources.includes("web")) {
		collectors.push(collectWebSignals(plan, { baseUrl, numPerQuery: opts.numPerQuery || 6 }));
	}

	log("Agent37 collecting signals", collectors.length + " channels in parallel");
	const results = await Promise.allSettled(collectors);

	const signalLists = [];
	for (const r of results) {
		if (r.status === "fulfilled") {
			summary.channels[r.value.channel] = r.value.count;
			summary.errors.push(...(r.value.errors || []));
			signalLists.push(r.value.signals);
		} else {
			summary.errors.push({
				channel: "unknown",
				error: r.reason?.message || String(r.reason),
			});
		}
	}

	let merged = mergeSignalLists(signalLists);
	log("Agent37 raw signals", merged.length);

	const urlsToScrape = pickUrlsToScrape(merged, opts.scrapeLimit || 10);
	let scrapedPages = [];
	if (urlsToScrape.length) {
		log("Agent37 scraping pages", urlsToScrape.length);
		scrapedPages = await scrapePages(urlsToScrape, {
			baseUrl,
			limit: urlsToScrape.length,
		});
		summary.scraped = scrapedPages.filter((p) => p.text || p.title).length;
	}

	const signals = normalizeSignals(merged, scrapedPages);
	summary.signals = signals.length;

	if (!signals.length) {
		return { success: true, ...summary, reason: "no_signals" };
	}

	const rawTopics = await discoverAgent37Topics(
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
		topic.discoverySource = AGENT37_DISCOVERY_SOURCE;
		if (Array.isArray(raw.signalChannels) && raw.signalChannels.length) {
			topic.researchSummary = [topic.researchSummary, `Channels: ${raw.signalChannels.join(", ")}`]
				.filter(Boolean)
				.join(" — ");
		}

		const row = await saveTopic(siteId, topic);
		saved.push(row);
	}

	const researchId = await saveResearchRun(siteId, {
		source: AGENT37_DISCOVERY_SOURCE,
		sources,
		channels: summary.channels,
		queries: [
			...(plan.redditQueries || []),
			...(plan.linkedinQueries || []),
			...(plan.xQueries || []),
			...(plan.webQueries || []),
		],
		signalCount: signals.length,
		scrapedCount: summary.scraped,
		topicCount: saved.length,
		skippedDuplicates: skipped,
		rejectedEmpty,
	});

	await upsertSite(siteId, {
		lastAgent37ResearchAt: new Date().toISOString(),
		lastAgent37ResearchId: researchId,
	});

	summary.researchId = researchId;
	summary.saved = saved.length;
	summary.skippedDuplicates = skipped;
	summary.rejectedEmpty = rejectedEmpty;
	summary.topics = saved;

	log(
		"Agent37 topics saved",
		`${saved.length} new (${skipped} dupes, ${rejectedEmpty} rejected)`,
	);

	return { success: true, ...summary };
}

export { DEFAULT_SITE_ID as AGENT37_DEFAULT_SITE_ID, AGENT37_SITE_IDS };
