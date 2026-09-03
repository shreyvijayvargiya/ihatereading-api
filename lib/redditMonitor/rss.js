/**
 * Parse Reddit public RSS/Atom feeds (posts only).
 */

import { load } from "cheerio";

function stripHtml(html) {
	return String(html || "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&#32;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim();
}

function parseDate(raw) {
	if (!raw) return null;
	const d = new Date(raw);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function redditPermalink(link, id) {
	if (link && link.includes("reddit.com")) {
		try {
			return new URL(link).pathname;
		} catch {
			return link;
		}
	}
	if (id && String(id).includes("reddit.com")) {
		try {
			return new URL(id).pathname;
		} catch {
			/* ignore */
		}
	}
	return link || id || null;
}

/** @param {string} subreddit */
export function buildNewPostFeedUrl(subreddit) {
	const sub = String(subreddit).replace(/^r\//i, "").trim();
	return `https://www.reddit.com/r/${sub}/new/.rss`;
}

/**
 * @param {string} xml
 * @param {string} subreddit
 */
export function parseRedditPostFeed(xml, subreddit) {
	const $ = load(xml, { xmlMode: true });
	const items = [];

	$("entry, item").each((_, el) => {
		const node = $(el);
		const title = node.find("title").first().text().trim();
		const link =
			node.find("link").attr("href") ||
			node.find("link").first().text().trim() ||
			"";
		const id = node.find("id").first().text().trim();
		const author =
			node.find("author name").first().text().trim() ||
			node.find("dc\\:creator, creator").first().text().trim() ||
			"unknown";
		const updated =
			node.find("updated").first().text().trim() ||
			node.find("pubDate").first().text().trim();
		const content =
			node.find("content").first().text().trim() ||
			node.find("description").first().text().trim() ||
			"";

		const permalink = redditPermalink(link, id);
		if (!permalink) return;

		const body = stripHtml(content);
		items.push({
			subreddit,
			title: title || body.slice(0, 120) || "(untitled)",
			body,
			author,
			permalink,
			publishedAt: parseDate(updated),
		});
	});

	return items;
}
