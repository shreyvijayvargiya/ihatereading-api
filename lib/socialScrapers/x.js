/**
 * Public X/Twitter profile scrape — no login modal, no RapidAPI.
 * 1) Twitter follow-button widget JSON
 * 2) Direct HTML OG tags
 * 3) Puppeteer + intercepted GraphQL (best effort)
 */

import browserPool from "../../browser-pool.js";
import { applyStealthToPage } from "../prepareScreenshotPage.js";
import {
	extractAssignedJson,
	extractJsonScripts,
	extractMeta,
	looksLikeLoginWall,
	parseFollowerPhrase,
	sleep,
	walkFind,
	xHandleFrom,
} from "./parse.js";

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchFollowButton(handle) {
	const url = `https://cdn.syndication.twimg.com/widgets/followbutton/info.json?screen_names=${encodeURIComponent(handle)}`;
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(12_000),
			headers: {
				Accept: "application/json",
				"User-Agent": UA,
			},
		});
		if (!res.ok) return null;
		const data = await res.json();
		const row = Array.isArray(data) ? data[0] : data;
		if (!row || typeof row !== "object") return null;
		const followers = row.followers_count ?? row.followersCount ?? null;
		if (row.screen_name || followers != null) {
			return {
				handle: row.screen_name || handle,
				name: row.name || null,
				followersCount: typeof followers === "number" ? followers : null,
			};
		}
	} catch {
		/* widget often blocked */
	}
	return null;
}

async function fetchProfileHtml(url) {
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(15_000),
			headers: {
				"User-Agent": UA,
				Accept: "text/html,application/xhtml+xml",
				"Accept-Language": "en-US,en;q=0.9",
			},
			redirect: "follow",
		});
		if (!res.ok) return "";
		return await res.text();
	} catch {
		return "";
	}
}

function userFromXJson(obj) {
	if (!obj || typeof obj !== "object") return null;
	const u =
		obj.data?.user?.result ||
		obj.data?.user_result?.result ||
		obj.legacy ||
		(obj.screen_name || obj.legacy?.screen_name ? obj : null);
	const legacy = u?.legacy || u;
	if (!legacy || typeof legacy !== "object") return null;
	const handle = legacy.screen_name || u?.core?.screen_name;
	if (!handle) return null;
	return {
		handle,
		name: legacy.name || u?.core?.name || null,
		bio: legacy.description || null,
		avatar: legacy.profile_image_url_https || null,
		followersCount:
			typeof legacy.followers_count === "number" ? legacy.followers_count : null,
		followingCount:
			typeof legacy.friends_count === "number" ? legacy.friends_count : null,
		postsCount:
			typeof legacy.statuses_count === "number" ? legacy.statuses_count : null,
		verified: Boolean(legacy.verified || u?.is_blue_verified),
		website: legacy.entities?.url?.urls?.[0]?.expanded_url || null,
	};
}

function pickBestUser(blobs) {
	let best = null;
	for (const blob of blobs) {
		const direct = userFromXJson(blob);
		if (
			direct &&
			(!best || (direct.followersCount || 0) > (best.followersCount || 0))
		) {
			best = direct;
		}
		const hits = walkFind(
			blob,
			(n) =>
				n &&
				typeof n === "object" &&
				(n.screen_name || n.legacy?.screen_name) &&
				(n.followers_count != null || n.legacy?.followers_count != null),
		);
		for (const hit of hits) {
			const u = userFromXJson(hit);
			if (u && (!best || (u.followersCount || 0) > (best.followersCount || 0))) {
				best = u;
			}
		}
	}
	return best;
}

function nameFromXTitle(title) {
	return String(title || "")
		.replace(/\s*\(@[^)]+\).*$/, "")
		.replace(/\s*\/\s*X\s*$/i, "")
		.replace(/\s+on\s+X.*$/i, "")
		.trim();
}

function profileFromHtml(html, titleHint = "") {
	const meta = extractMeta(html);
	const blobs = [
		...extractJsonScripts(html),
		extractAssignedJson(html, "__NEXT_DATA__"),
		extractAssignedJson(html, "ytInitialData"),
	].filter(Boolean);
	const fromScripts = pickBestUser(blobs);
	const loginWall = looksLikeLoginWall(html, meta.title || titleHint);
	return {
		meta,
		fromScripts,
		loginWall,
		followersFromText: parseFollowerPhrase(
			`${meta.ogDescription}\n${meta.description}\n${meta.title}\n${titleHint}`,
		),
	};
}

/**
 * @param {{ username?: string, handle?: string, url?: string, timeoutMs?: number }} input
 */
export async function scrapeXProfile(input = {}) {
	const handle = xHandleFrom(input.handle || input.username || input.url || "");
	if (!handle) {
		throw new Error("X/Twitter handle or profile URL is required");
	}
	const url = `https://x.com/${encodeURIComponent(handle)}`;
	const timeout = input.timeoutMs || 45_000;

	const widget = await fetchFollowButton(handle);
	const htmlDirect = await fetchProfileHtml(url);
	const fromDirect = htmlDirect ? profileFromHtml(htmlDirect) : null;

	let pageResult = null;
	let jsonBlobs = [];
	try {
		pageResult = await browserPool.withPage(async (page) => {
			await applyStealthToPage(page);
			await page.setUserAgent(UA);
			await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

			page.on("response", async (res) => {
				try {
					const ru = res.url();
					if (!/UserByScreenName|UserByRestId|\/graphql\//i.test(ru)) return;
					const ct = String(res.headers()["content-type"] || "");
					if (!ct.includes("json") && !ct.includes("javascript")) return;
					const data = await res.json().catch(() => null);
					if (data) jsonBlobs.push(data);
				} catch {
					/* ignore */
				}
			});

			await page.goto(url, { waitUntil: "domcontentloaded", timeout });
			await sleep(2200);
			const html = await page.content();
			const title = await page.title().catch(() => "");
			return { html, title, finalUrl: page.url() };
		});
	} catch (err) {
		console.warn(`[scrape-x] puppeteer failed for @${handle}:`, err?.message || err);
	}

	const fromPage = pageResult
		? profileFromHtml(pageResult.html, pageResult.title)
		: null;
	const fromNet = pickBestUser(jsonBlobs);
	const merged = {
		...(fromDirect?.fromScripts || {}),
		...(fromPage?.fromScripts || {}),
		...(fromNet || {}),
	};
	const meta = fromPage?.meta || fromDirect?.meta || {};
	const loginWall = Boolean(fromPage?.loginWall || fromDirect?.loginWall);
	const followersCount =
		merged.followersCount ??
		widget?.followersCount ??
		fromPage?.followersFromText ??
		fromDirect?.followersFromText ??
		null;

	return {
		success: true,
		platform: "x",
		handle: merged.handle || widget?.handle || handle,
		profileUrl: url,
		name:
			merged.name ||
			widget?.name ||
			nameFromXTitle(meta.ogTitle || meta.title) ||
			handle,
		bio: merged.bio || meta.ogDescription || meta.description || null,
		avatar: merged.avatar || meta.image || null,
		website: merged.website || null,
		followersCount,
		followingCount: merged.followingCount ?? null,
		postsCount: merged.postsCount ?? null,
		verified: Boolean(merged.verified),
		loginWall,
		source: fromNet
			? "network_json"
			: merged.handle
				? "page_json"
				: widget?.followersCount != null
					? "follow_button"
					: loginWall
						? "login_wall"
						: "og_meta",
		finalUrl: pageResult?.finalUrl || url,
	};
}
