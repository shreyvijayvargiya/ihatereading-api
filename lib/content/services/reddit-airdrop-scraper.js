/**
 * Reddit → AirdropBounty topic scraper.
 * Google site:reddit.com → search.rss → subreddit /new/.rss → LLM topics → Firestore.
 */

import { fetchRssFeed } from "../../scrapefast.js";
import { googleReddit, pickSubreddits } from "../../redditAiScraper/discover.js";
import {
	runRssAgent,
	threadUrl,
	normalizeSub,
	permalinkDocId,
} from "../../redditAgents/core.js";
import {
	buildSearchFeedUrl,
	parseRedditPostFeed,
} from "../../redditMonitor/rss.js";
import { AIRDROPBOUNTY_SITE_IDS } from "../config/airdropbounty.js";
import {
	planRedditAirdropQueries,
	discoverRedditAirdropTopics,
	fallbackTopicsFromSignals,
	redditPostsToSignals,
} from "./reddit-airdrop-research-agent.js";
import { redditPostScorePrompt } from "../prompts/reddit-airdrop-research.js";
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
import { log } from "../utils.js";

const DEFAULT_SITE_ID = "airdropbounty-events";
const REDDIT_SOURCE = "reddit-airdrop-bounty-scraper";
const MAX_SEARCH_RSS = Number(process.env.REDDIT_MAX_SEARCH_RSS || 5);
const MAX_SUBREDDITS = Number(process.env.REDDIT_MAX_SUBREDDITS || 6);

function postsToSignals(google, searchRss, rssPosts = []) {
	return redditPostsToSignals(
		dedupePosts([
			...google.posts.map((p) => ({
				...p,
				threadUrl: threadUrl(p.permalink),
				discoverySource: "google_site",
			})),
			...searchRss.posts,
			...rssPosts.map((p) => ({
				...p,
				discoverySource: "subreddit_rss",
			})),
		]),
	);
}

async function saveRedditTopics({
	siteId,
	site,
	signals,
	existingContent,
	existingTopics,
	limit,
	useLlm,
	model,
}) {
	let rawTopics = [];
	let usedFallback = false;

	try {
		rawTopics = await discoverRedditAirdropTopics(
			site,
			existingContent,
			existingTopics,
			signals,
			{ limit, model },
		);
	} catch (err) {
		console.warn(
			"[reddit-airdrop] LLM topic discovery failed, using signal fallback:",
			err?.message || err,
		);
		rawTopics = fallbackTopicsFromSignals(signals, limit);
		usedFallback = true;
	}

	if (!rawTopics.length) {
		rawTopics = fallbackTopicsFromSignals(signals, limit);
		usedFallback = true;
		log("Reddit topic fallback", `${rawTopics.length} topics from signals`);
	}

	const saved = [];
	let skipped = 0;
	let rejectedEmpty = 0;

	for (const raw of rawTopics) {
		if (saved.length >= limit) break;

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
		if (
			isDuplicateTopic(topic, [...existingTopics, ...saved], existingContent, {
				discoverySource: REDDIT_SOURCE,
				skipContentDedupe: true,
			})
		) {
			skipped += 1;
			continue;
		}
		topic.internalLinkCandidates = findInternalLinkCandidates(
			topic,
			existingContent,
			10,
		);
		topic.discoverySource = REDDIT_SOURCE;
		if (raw.inspiredByReddit) {
			topic.researchSummary = [topic.researchSummary, raw.inspiredByReddit]
				.filter(Boolean)
				.join(" — ");
		}

		const row = await saveTopic(siteId, topic);
		saved.push(row);
	}

	return { saved, skipped, rejectedEmpty, usedFallback };
}

const REDDIT_AGENT = {
	id: "airdropbounty-reddit",
	name: "AirdropBounty Reddit Scraper",
	collection: "redditAirdropBountyPosts",
	relevanceMin: 4,
	scoreSystemPrompt: redditPostScorePrompt(),
	subreddits: [],
};

function subFromPermalink(permalink) {
	const m = String(permalink || "").match(/\/r\/([^/]+)/i);
	return m ? normalizeSub(m[1]) : "";
}

async function fetchSearchRssPosts(queries) {
	const posts = [];
	const errors = [];

	for (const query of queries) {
		const feedUrl = buildSearchFeedUrl(query);
		try {
			const xml = await fetchRssFeed(feedUrl);
			const parsed = parseRedditPostFeed(xml, "");
			for (const p of parsed) {
				posts.push({
					...p,
					subreddit: p.subreddit || subFromPermalink(p.permalink),
					threadUrl: threadUrl(p.permalink),
					source: "search_rss",
					query,
					discoverySource: "search_rss",
				});
			}
			log("Search RSS", `${query} → ${parsed.length} items`);
		} catch (err) {
			const msg = err?.message || String(err);
			console.warn(`[reddit-airdrop] search RSS failed (${query}):`, msg);
			errors.push({ query, error: msg });
		}
	}

	return { posts, errors };
}

function dedupePosts(posts) {
	const seen = new Set();
	const out = [];
	for (const p of posts) {
		const key = permalinkDocId(p.permalink) || p.threadUrl || p.title;
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(p);
	}
	return out;
}

function assertAirdropSite(siteId, site) {
	if (AIRDROPBOUNTY_SITE_IDS.some((id) => String(siteId).includes(id))) return;
	const domain = String(site?.domain || "").toLowerCase();
	if (!domain.includes("airdropbounty")) {
		throw Object.assign(
			new Error(`Site "${siteId}" is not an AirdropBounty site`),
			{ status: 400 },
		);
	}
}

export async function runRedditAirdropBountyScraper(siteIdOrDomain, opts = {}) {
	const resolved = await resolveSite(siteIdOrDomain || DEFAULT_SITE_ID);
	if (!resolved) {
		throw Object.assign(
			new Error(`Site not found: ${siteIdOrDomain}. Enroll airdropbounty-events first.`),
			{ status: 404 },
		);
	}

	let { siteId, site } = resolved;
	assertAirdropSite(siteId, site);

	const baseUrl = opts.baseUrl;
	const limit = Math.min(30, Math.max(1, Number(opts.limit) || 20));
	const useLlm = opts.llm !== false;

	if (!process.env.OPENROUTER_API_KEY?.trim()) {
		throw Object.assign(
			new Error("OPENROUTER_API_KEY required for Reddit topic discovery"),
			{ status: 400 },
		);
	}

	const existingContent = await getExistingContent(siteId, {
		baseUrl,
		refresh: opts.refreshContent,
	});
	const existingTopics = await listTopics(siteId);

	log("Planning Reddit search queries");
	const plan = await planRedditAirdropQueries(site, existingTopics, opts);
	const searchRssQueries = (plan.searchRssQueries || []).slice(
		0,
		opts.maxSearchRss ?? MAX_SEARCH_RSS,
	);

	const summary = {
		siteId,
		googleQueries: plan.googleQueries,
		searchRssQueries: plan.searchRssQueries,
		seedSubreddits: plan.seedSubreddits,
		googlePosts: 0,
		searchRssPosts: 0,
		rssPosts: 0,
		signals: 0,
		saved: 0,
		skippedDuplicates: 0,
		rejectedEmpty: 0,
		topics: [],
		errors: [],
	};

	// 1) Google site:reddit.com discovery
	log("Google Reddit search", `${plan.googleQueries.length} queries`);
	const google = await googleReddit(plan.googleQueries, {
		baseUrl,
		num: opts.numPerQuery || 8,
	});
	summary.googlePosts = google.posts.length;
	summary.errors.push(...(google.errors || []).map((e) => ({ step: "google", ...e })));

	// 2) Reddit search.rss feeds (capped to reduce rate limits)
	log("Search RSS", `${searchRssQueries.length} queries`);
	const searchRss = await fetchSearchRssPosts(searchRssQueries);
	summary.searchRssPosts = searchRss.posts.length;
	summary.errors.push(...searchRss.errors.map((e) => ({ step: "search_rss", ...e })));

	let signals = postsToSignals(google, searchRss);
	summary.signals = signals.length;
	log("Reddit signals (phase 1)", `${signals.length} from Google + search RSS`);

	let saved = [];
	let skipped = 0;
	let rejectedEmpty = 0;
	let usedFallback = false;

	// 3) Save CRM topics early — don't wait for slow subreddit RSS
	if (signals.length) {
		const phase1 = await saveRedditTopics({
			siteId,
			site,
			signals,
			existingContent,
			existingTopics,
			limit,
			useLlm,
			model: opts.model,
		});
		saved = phase1.saved;
		skipped = phase1.skipped;
		rejectedEmpty = phase1.rejectedEmpty;
		usedFallback = phase1.usedFallback;

		if (saved.length) {
			log(
				"Reddit CRM topics saved (phase 1)",
				`${saved.length} → content_sites/${siteId}/topics`,
			);
		}
	}

	// 4) Optional subreddit RSS for more signals (skip if quota met)
	const skipSubRss = opts.skipSubredditRss === true || saved.length >= limit;
	let subs = [];

	if (!skipSubRss) {
		subs = [...new Set([...plan.seedSubreddits, ...google.subreddits])];
		if (useLlm && google.subreddits.length) {
			try {
				const picked = await pickSubreddits({
					prompt: "AirdropBounty crypto airdrop and bounty content research",
					plan: {
						goal: "Find airdrop hunter discussions and content ideas",
						seedSubreddits: plan.seedSubreddits,
					},
					googleSubs: google.subreddits,
					sampleTitles: google.posts.map((p) => p.title).slice(0, 25),
					model: opts.model,
				});
				subs = [...new Set([...subs, ...picked.map((s) => s.name)])];
			} catch (err) {
				console.warn("[reddit-airdrop] subreddit pick failed:", err?.message);
			}
		}
		subs = subs.slice(0, opts.maxSubreddits ?? MAX_SUBREDDITS);
		summary.seedSubreddits = subs;

		if (subs.length) {
			log("Subreddit RSS", `${subs.length} communities`);
			const rssSummary = await runRssAgent(
				{ ...REDDIT_AGENT, subreddits: subs },
				{ subreddits: subs, baseUrl, llm: false, model: opts.model },
			);
			summary.rssPosts = rssSummary.newPosts;
			summary.errors.push(
				...(rssSummary.errors || []).map((e) => ({ step: "subreddit_rss", ...e })),
			);

			const rssForSignals = rssSummary.scrapedPosts?.length
				? rssSummary.scrapedPosts
				: rssSummary.relevant || [];

			signals = postsToSignals(google, searchRss, rssForSignals);
			summary.signals = signals.length;
			log("Reddit signals (phase 2)", `${signals.length} total with subreddit RSS`);

			if (signals.length && saved.length < limit) {
				const phase2 = await saveRedditTopics({
					siteId,
					site,
					signals,
					existingContent,
					existingTopics: [...existingTopics, ...saved],
					limit: limit - saved.length,
					useLlm,
					model: opts.model,
				});
				saved.push(...phase2.saved);
				skipped += phase2.skipped;
				rejectedEmpty += phase2.rejectedEmpty;
				usedFallback = usedFallback || phase2.usedFallback;
			}
		}
	}

	if (!signals.length) {
		return { success: true, ...summary, reason: "no_signals" };
	}

	const researchId = await saveResearchRun(siteId, {
		source: "reddit-airdrop-bounty-scraper",
		queries: [...plan.googleQueries, ...plan.searchRssQueries],
		signalCount: signals.length,
		googlePosts: summary.googlePosts,
		searchRssPosts: summary.searchRssPosts,
		rssPosts: summary.rssPosts,
		topicCount: saved.length,
		skippedDuplicates: skipped,
		rejectedEmpty,
		subreddits: subs,
	});

	await upsertSite(siteId, {
		lastRedditScrapeAt: new Date().toISOString(),
		lastRedditResearchId: researchId,
	});

	summary.researchId = researchId;
	summary.saved = saved.length;
	summary.skippedDuplicates = skipped;
	summary.rejectedEmpty = rejectedEmpty;
	summary.usedFallback = usedFallback;
	summary.topics = saved;

	log(
		"Reddit CRM topics saved",
		`${saved.length} → content_sites/${siteId}/topics (${skipped} dupes, ${rejectedEmpty} rejected${usedFallback ? ", fallback" : ""})`,
	);

	return { success: true, ...summary };
}
