/**
 * Compact wrappers around existing scrape primitives for the Claude agent.
 */

import { fetchMapsPlaces } from "../mapsAgents/core.js";
import { googleSearch, resolveResearchBaseUrl } from "../contentResearch/http.js";
import { resolveScrapeBaseUrl, scrapeUrl } from "../scrapefast.js";
import { scrapeInstagramProfile } from "../socialScrapers/instagram.js";
import { scrapeXProfile } from "../socialScrapers/x.js";
import { scrapeYoutubeChannel } from "../socialScrapers/youtube.js";

const MD_MAX = 8000;
const LINKS_MAX = 25;
const PLACES_MAX = 30;
const SEARCH_MAX = 10;

function clip(text, n = MD_MAX) {
	const s = String(text || "");
	return s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s;
}

function compactScrape(data, url) {
	const md =
		data?.chunkedMarkdown ||
		data?.markdown ||
		data?.semanticContent ||
		data?.content ||
		"";
	const links = Array.isArray(data?.links) ? data.links.slice(0, LINKS_MAX) : [];
	return {
		success: data?.success !== false,
		url: data?.url || url,
		title: data?.metadata?.title || data?.title || null,
		description: data?.metadata?.description || data?.description || null,
		markdown: clip(typeof md === "string" ? md : JSON.stringify(md)),
		links,
	};
}

export async function toolScrapeWebsite(url, ctx) {
	if (!url || !/^https?:\/\//i.test(String(url))) {
		throw new Error("url must be http(s)");
	}
	const data = await scrapeUrl(String(url), {
		baseUrl: ctx.baseUrl,
		timeoutMs: 90_000,
	});
	return compactScrape(data, url);
}

export async function toolGoogleSearch(query, ctx) {
	const q = String(query || "").trim();
	if (!q) throw new Error("query is required");
	const results = await googleSearch(q, {
		baseUrl: ctx.baseUrl || resolveResearchBaseUrl(),
		num: SEARCH_MAX,
	});
	return {
		query: q,
		count: results.length,
		results: results.slice(0, SEARCH_MAX).map((r) => ({
			title: r.title || r.name || null,
			url: r.link || r.url || r.href || null,
			snippet: clip(r.snippet || r.description || "", 400),
		})),
	};
}

export async function toolScrapeMaps(query, ctx) {
	const q = String(query || "").trim();
	if (!q) throw new Error("query is required");
	const places = await fetchMapsPlaces(q, ctx.baseUrl);
	return {
		query: q,
		count: places.length,
		places: places.slice(0, PLACES_MAX).map((p) => ({
			name: p.name || p.title || null,
			address: p.address || p.formattedAddress || null,
			phone: p.phone || p.phoneNumber || null,
			website: p.website || p.site || null,
			rating: p.rating ?? null,
			reviews: p.reviews ?? p.reviewCount ?? null,
			category: p.category || p.type || null,
			mapsUrl: p.mapsUrl || p.url || null,
		})),
	};
}

export async function toolScrapeX(input) {
	const data = await scrapeXProfile({
		handle: input.handle || input.username,
		url: input.url,
	});
	return {
		success: data?.success !== false,
		platform: "x",
		handle: data?.handle,
		name: data?.name,
		bio: data?.bio,
		followersCount: data?.followersCount,
		followingCount: data?.followingCount,
		profileUrl: data?.profileUrl,
		verified: data?.verified,
		avatar: data?.avatar,
	};
}

export async function toolScrapeInstagram(input) {
	const data = await scrapeInstagramProfile({
		username: input.username || input.handle,
		url: input.url,
	});
	return {
		success: data?.success !== false,
		platform: "instagram",
		handle: data?.handle,
		name: data?.name,
		bio: data?.bio,
		followersCount: data?.followersCount,
		followingCount: data?.followingCount,
		postsCount: data?.postsCount,
		website: data?.website,
		profileUrl: data?.profileUrl,
		verified: data?.verified,
	};
}

export async function toolScrapeYoutube(input, ctx) {
	const url = String(input.url || "");
	const isVideo = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)/i.test(
		url,
	);
	if (isVideo) {
		const root = (ctx.baseUrl || resolveScrapeBaseUrl()).replace(/\/$/, "");
		const res = await fetch(`${root}/scrape-youtube`, {
			method: "POST",
			signal: AbortSignal.timeout(90_000),
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok || data.success === false) {
			throw new Error(data.error || `YouTube scrape HTTP ${res.status}`);
		}
		return {
			success: true,
			kind: "video",
			url,
			title: data.title || data.metadata?.title || null,
			markdown: clip(data.markdown || data.transcript || data.chunkedMarkdown || ""),
		};
	}
	const data = await scrapeYoutubeChannel({
		handle: input.handle || input.username,
		url: input.url,
		channelId: input.channelId,
	});
	return {
		success: data?.success !== false,
		kind: "channel",
		platform: "youtube",
		handle: data?.handle,
		name: data?.name,
		description: clip(data?.description || data?.bio || "", 2000),
		followersCount: data?.followersCount,
		profileUrl: data?.profileUrl,
	};
}

export async function toolScrapeGithub(url, ctx) {
	const u = String(url || "").trim();
	if (!/github\.com/i.test(u)) {
		throw new Error("url must be a github.com URL");
	}
	const root = (ctx.baseUrl || resolveScrapeBaseUrl()).replace(/\/$/, "");
	const res = await fetch(`${root}/scrape-git`, {
		method: "POST",
		signal: AbortSignal.timeout(90_000),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ url: u }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.success === false) {
		const fallback = await scrapeUrl(u, { baseUrl: ctx.baseUrl });
		return compactScrape(fallback, u);
	}
	return {
		success: true,
		url: u,
		title: data.metadata?.title || data.title || null,
		description: data.metadata?.description || data.description || null,
		stars: data.stars ?? null,
		markdown: clip(data.markdown || data.chunkedMarkdown || ""),
		links: Array.isArray(data.links) ? data.links.slice(0, LINKS_MAX) : [],
	};
}

export async function toolScrapeProductHunt(input, ctx) {
	let url = String(input.url || "").trim();
	if (!url && input.query) {
		const results = await googleSearch(
			`site:producthunt.com ${input.query}`,
			{ baseUrl: ctx.baseUrl, num: 5 },
		);
		url = results[0]?.link || results[0]?.url || "";
		if (!url) {
			return { query: input.query, results, note: "no Product Hunt URL found" };
		}
	}
	if (!url) throw new Error("url or query is required");
	if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
	const data = await scrapeUrl(url, { baseUrl: ctx.baseUrl });
	return compactScrape(data, url);
}

export async function toolScrapeLinkedIn(input, ctx) {
	const url = String(input.url || "").trim();
	if (url && /linkedin\.com/i.test(url)) {
		try {
			const data = await scrapeUrl(url, { baseUrl: ctx.baseUrl });
			return compactScrape(data, url);
		} catch (err) {
			return {
				url,
				blocked: true,
				error: err?.message || String(err),
				hint: "LinkedIn often blocks scrapes — use google_search with site:linkedin.com",
			};
		}
	}
	const q = String(input.query || "").trim();
	if (!q) throw new Error("query or linkedin url is required");
	const results = await googleSearch(`site:linkedin.com ${q}`, {
		baseUrl: ctx.baseUrl,
		num: SEARCH_MAX,
	});
	return {
		query: q,
		count: results.length,
		results: results.slice(0, SEARCH_MAX).map((r) => ({
			title: r.title || null,
			url: r.link || r.url || null,
			snippet: clip(r.snippet || r.description || "", 400),
		})),
	};
}
