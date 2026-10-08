import { fetchRssFeed } from "../../../scrapefast.js";
import { googleReddit } from "../../../redditAiScraper/discover.js";
import { threadUrl, normalizeSub, permalinkDocId } from "../../../redditAgents/core.js";
import {
	buildSearchFeedUrl,
	parseRedditPostFeed,
} from "../../../redditMonitor/rss.js";
import { log } from "../../utils.js";

function subFromPermalink(permalink) {
	const m = String(permalink || "").match(/\/r\/([^/]+)/i);
	return m ? normalizeSub(m[1]) : "";
}

function postsToSignals(posts) {
	const seen = new Set();
	const out = [];
	for (const post of posts) {
		const url = post.threadUrl || threadUrl(post.permalink);
		const key = permalinkDocId(post.permalink) || url;
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push({
			query: post.query || "reddit",
			title: String(post.title || "").trim(),
			url,
			snippet: String(post.body || post.snippet || "").slice(0, 500),
			content: String(post.body || "").slice(0, 2000),
			sourceType: "reddit",
			domain: "reddit.com",
			subreddit: post.subreddit || "",
		});
	}
	return out;
}

async function fetchSearchRssPosts(queries) {
	const posts = [];
	const errors = [];
	for (const query of queries) {
		try {
			const xml = await fetchRssFeed(buildSearchFeedUrl(query));
			const parsed = parseRedditPostFeed(xml, "");
			for (const p of parsed) {
				posts.push({
					...p,
					subreddit: p.subreddit || subFromPermalink(p.permalink),
					threadUrl: threadUrl(p.permalink),
					query,
				});
			}
			log("Agent37 Reddit RSS", `${query} → ${parsed.length}`);
		} catch (err) {
			errors.push({ query, error: err?.message || String(err) });
		}
	}
	return { posts, errors };
}

/**
 * @param {{ redditQueries?: string[], redditSearchRss?: string[] }} plan
 */
export async function collectRedditSignals(plan, opts = {}) {
	const queries = (plan.redditQueries || []).map((q) =>
		/site:\s*reddit\.com/i.test(q) ? q : `site:reddit.com ${q}`,
	);
	const errors = [];

	let googlePosts = [];
	if (queries.length) {
		const google = await googleReddit(queries, {
			baseUrl: opts.baseUrl,
			num: opts.numPerQuery || 6,
		});
		googlePosts = google.posts;
		errors.push(...(google.errors || []).map((e) => ({ ...e, channel: "reddit" })));
	}

	const rss = await fetchSearchRssPosts(plan.redditSearchRss || []);
	errors.push(...rss.errors.map((e) => ({ ...e, channel: "reddit_rss" })));

	const signals = postsToSignals([...googlePosts, ...rss.posts]);
	return { channel: "reddit", signals, errors, count: signals.length };
}
