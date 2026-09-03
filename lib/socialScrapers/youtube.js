/**
 * Public YouTube channel scrape — no RapidAPI.
 * 1) YouTube Data API when YOUTUBE_API_KEY is set
 * 2) Direct HTML ytInitialData (no browser)
 * 3) Puppeteer fallback
 */

import browserPool from "../../browser-pool.js";
import { applyStealthToPage } from "../prepareScreenshotPage.js";
import {
	extractAssignedJson,
	extractJsonScripts,
	extractMeta,
	parseCount,
	parseFollowerPhrase,
	sleep,
	walkFind,
	youtubeFrom,
} from "./parse.js";

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function youtubeDataApi(handle, channelId) {
	const key = process.env.YOUTUBE_API_KEY?.trim();
	if (!key) return null;
	const params = new URLSearchParams({
		part: "snippet,statistics,brandingSettings",
		key,
	});
	if (channelId) params.set("id", channelId);
	else if (handle) params.set("forHandle", handle.replace(/^@/, ""));
	else return null;

	try {
		const res = await fetch(
			`https://www.googleapis.com/youtube/v3/channels?${params}`,
			{ signal: AbortSignal.timeout(15_000) },
		);
		const data = await res.json().catch(() => ({}));
		const item = data.items?.[0];
		if (!item) return null;
		const sn = item.snippet || {};
		const st = item.statistics || {};
		return {
			handle: sn.customUrl?.replace(/^@/, "") || handle || null,
			channelId: item.id,
			name: sn.title || null,
			bio: sn.description || null,
			avatar: sn.thumbnails?.high?.url || sn.thumbnails?.default?.url || null,
			followersCount:
				st.subscriberCount != null ? Number(st.subscriberCount) : null,
			postsCount: st.videoCount != null ? Number(st.videoCount) : null,
			viewCount: st.viewCount != null ? Number(st.viewCount) : null,
			country: sn.country || null,
			source: "youtube_data_api",
		};
	} catch {
		return null;
	}
}

function fromYtInitial(blobs) {
	for (const blob of blobs) {
		if (!blob) continue;
		const headers = walkFind(
			blob,
			(n) =>
				n &&
				typeof n === "object" &&
				(n.subscriberCountText ||
					(n.channelId && (n.title || n.subscriberCountText))),
		);
		for (const h of headers) {
			const name = h.title || h.channelName || h.name || null;
			const subText =
				h.subscriberCountText?.simpleText ||
				h.subscriberCountText?.runs?.map((r) => r.text).join("") ||
				"";
			const channelId = h.channelId || null;
			if (name || subText || channelId) {
				return {
					name: typeof name === "string" ? name : name?.simpleText || null,
					channelId,
					followersCount: parseFollowerPhrase(subText) || parseCount(subText),
					bio:
						typeof h.description === "string"
							? h.description
							: h.descriptionSnippet || null,
					handle:
						String(h.vanityChannelUrl || h.canonicalBaseUrl || "")
							.replace(/^.*@/, "")
							.replace(/\/.*$/, "") || null,
				};
			}
		}
	}
	return null;
}

function blobsFromHtml(html) {
	return [
		extractAssignedJson(html, "ytInitialData"),
		...extractJsonScripts(html),
	].filter(Boolean);
}

async function fetchChannelHtml(url) {
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(20_000),
			headers: {
				"User-Agent": UA,
				Accept: "text/html",
				"Accept-Language": "en-US,en;q=0.9",
			},
			redirect: "follow",
		});
		if (!res.ok) return { html: "", finalUrl: url };
		return { html: await res.text(), finalUrl: res.url || url };
	} catch {
		return { html: "", finalUrl: url };
	}
}

function resultFromHtml(html, { handle, channelId, url, finalUrl, source }) {
	const meta = extractMeta(html);
	const fromYt = fromYtInitial(blobsFromHtml(html));
	const name = String(meta.ogTitle || meta.title || "")
		.replace(/\s*-\s*YouTube\s*$/i, "")
		.trim();
	const followersCount =
		fromYt?.followersCount ??
		parseFollowerPhrase(`${meta.ogDescription}\n${meta.title}\n${html.slice(0, 80_000)}`) ??
		null;
	return {
		success: true,
		platform: "youtube",
		handle: fromYt?.handle || handle || null,
		channelId: fromYt?.channelId || channelId || null,
		profileUrl: url,
		name: fromYt?.name || name || handle,
		bio: fromYt?.bio || meta.ogDescription || meta.description || null,
		avatar: meta.image || null,
		followersCount:
			fromYt?.followersCount ??
			parseFollowerPhrase(
				`${meta.ogDescription}\n${meta.title}\n${String(html).slice(0, 80_000)}`,
			) ??
			null,
		postsCount: null,
		loginWall: false,
		source: fromYt?.followersCount != null ? source || "yt_initial_data" : "og_meta",
		finalUrl: finalUrl || url,
	};
}

/**
 * @param {{ username?: string, handle?: string, url?: string, channelId?: string, timeoutMs?: number }} input
 */
export async function scrapeYoutubeChannel(input = {}) {
	const parsed = youtubeFrom(input.url || input.handle || input.username || "");
	const handle =
		parsed.handle ||
		String(input.handle || input.username || "").replace(/^@/, "");
	const channelId = input.channelId || parsed.channelId || "";
	if (!handle && !channelId) {
		throw new Error("YouTube handle, channel id, or channel URL is required");
	}
	const url =
		parsed.url ||
		(channelId
			? `https://www.youtube.com/channel/${channelId}`
			: `https://www.youtube.com/@${encodeURIComponent(handle)}`);

	const api = await youtubeDataApi(handle, channelId);
	if (api?.followersCount != null || api?.name) {
		return {
			success: true,
			platform: "youtube",
			profileUrl: url,
			...api,
			handle: api.handle || handle || null,
			loginWall: false,
		};
	}

	const fetched = await fetchChannelHtml(url);
	if (fetched.html.length > 500) {
		const fromFetch = resultFromHtml(fetched.html, {
			handle,
			channelId,
			url,
			finalUrl: fetched.finalUrl,
			source: "html_fetch",
		});
		if (fromFetch.followersCount != null || fromFetch.name) {
			return fromFetch;
		}
	}

	const timeout = input.timeoutMs || 45_000;
	try {
		const pageResult = await browserPool.withPage(async (page) => {
			await applyStealthToPage(page);
			await page.setUserAgent(UA);
			await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
			await page.goto(url, { waitUntil: "domcontentloaded", timeout });
			await sleep(2200);
			const html = await page.content();
			const title = await page.title().catch(() => "");
			return { html, title, finalUrl: page.url() };
		});
		return resultFromHtml(pageResult.html, {
			handle,
			channelId,
			url,
			finalUrl: pageResult.finalUrl,
			source: "yt_initial_data",
		});
	} catch (err) {
		console.warn(
			`[scrape-youtube-channel] puppeteer failed for ${handle || channelId}:`,
			err?.message || err,
		);
		if (fetched.html) {
			return resultFromHtml(fetched.html, {
				handle,
				channelId,
				url,
				finalUrl: fetched.finalUrl,
				source: "html_fetch",
			});
		}
		return {
			success: true,
			platform: "youtube",
			handle: handle || null,
			channelId: channelId || null,
			profileUrl: url,
			name: handle || channelId,
			bio: null,
			avatar: null,
			followersCount: null,
			postsCount: null,
			loginWall: false,
			source: "error",
			error: err?.message || String(err),
			finalUrl: url,
		};
	}
}
