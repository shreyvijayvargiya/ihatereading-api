/**
 * Public Instagram profile scrape — no login, no modal dismiss, no RapidAPI.
 * Uses OG/meta + any JSON the page already emits (intercepted or in scripts).
 */

import browserPool from "../../browser-pool.js";
import { applyStealthToPage } from "../prepareScreenshotPage.js";
import {
	extractJsonScripts,
	extractMeta,
	instagramUsernameFrom,
	looksLikeLoginWall,
	parseIgOgDescription,
	sleep,
	walkFind,
} from "./parse.js";

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function userFromIgJson(obj) {
	if (!obj || typeof obj !== "object") return null;
	const u =
		obj.data?.user ||
		obj.graphql?.user ||
		obj.user ||
		(obj.username && (obj.edge_followed_by || obj.follower_count) ? obj : null);
	if (!u || typeof u !== "object") return null;
	if (!u.username && !u.full_name) return null;
	const followers =
		u.edge_followed_by?.count ??
		u.follower_count ??
		u.followers ??
		null;
	const following =
		u.edge_follow?.count ?? u.following_count ?? u.following ?? null;
	const posts =
		u.edge_owner_to_timeline_media?.count ?? u.media_count ?? u.posts ?? null;
	return {
		handle: u.username || null,
		name: u.full_name || u.username || null,
		bio: u.biography || u.bio || null,
		avatar: u.profile_pic_url_hd || u.profile_pic_url || null,
		followersCount: typeof followers === "number" ? followers : null,
		followingCount: typeof following === "number" ? following : null,
		postsCount: typeof posts === "number" ? posts : null,
		verified: Boolean(u.is_verified),
		isPrivate: Boolean(u.is_private),
		isBusiness: Boolean(u.is_business_account),
		website: u.external_url || null,
	};
}

function pickBestUser(blobs) {
	let best = null;
	for (const blob of blobs) {
		const hits = walkFind(
			blob,
			(n) =>
				n &&
				typeof n === "object" &&
				(n.username || n.full_name) &&
				(n.edge_followed_by || n.follower_count != null || n.biography),
		);
		for (const hit of hits) {
			const u = userFromIgJson(hit) || userFromIgJson({ user: hit });
			if (!u) continue;
			if (!best || (u.followersCount || 0) > (best.followersCount || 0)) best = u;
		}
		const direct = userFromIgJson(blob);
		if (direct && (!best || (direct.followersCount || 0) > (best.followersCount || 0))) {
			best = direct;
		}
	}
	return best;
}

/**
 * @param {{ username?: string, url?: string, timeoutMs?: number }} input
 */
export async function scrapeInstagramProfile(input = {}) {
	const username = instagramUsernameFrom(input.username || input.url || "");
	if (!username) {
		throw new Error("Instagram username or profile URL is required");
	}
	const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;
	const timeout = input.timeoutMs || 45_000;
	const jsonBlobs = [];

	const pageResult = await browserPool.withPage(async (page) => {
		await applyStealthToPage(page);
		await page.setUserAgent(UA);
		await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

		page.on("response", async (res) => {
			try {
				const ru = res.url();
				if (
					!/web_profile_info|graphql|\/api\/v1\/users\//i.test(ru)
				) {
					return;
				}
				const ct = String(res.headers()["content-type"] || "");
				if (!ct.includes("json") && !ct.includes("javascript")) return;
				const data = await res.json().catch(() => null);
				if (data) jsonBlobs.push(data);
			} catch {
				/* ignore intercept errors */
			}
		});

		await page.goto(url, { waitUntil: "domcontentloaded", timeout });
		await sleep(2200);
		const html = await page.content();
		const title = await page.title().catch(() => "");
		return { html, title, finalUrl: page.url() };
	});

	const meta = extractMeta(pageResult.html);
	const fromOg = parseIgOgDescription(meta.ogDescription || meta.description);
	const fromScripts = pickBestUser(extractJsonScripts(pageResult.html));
	const fromNet = pickBestUser(jsonBlobs);
	const merged = {
		...(fromScripts || {}),
		...(fromNet || {}),
	};

	const nameFromTitle = String(meta.ogTitle || meta.title || "")
		.replace(/\s*\(@[^)]+\).*$/, "")
		.replace(/\s*[•|].*$/, "")
		.replace(/\s+on Instagram.*$/i, "")
		.trim();

	const loginWall = looksLikeLoginWall(pageResult.html, meta.title || pageResult.title);
	const followersCount =
		merged.followersCount ?? fromOg.followersCount ?? null;

	return {
		success: true,
		platform: "instagram",
		handle: merged.handle || username,
		profileUrl: url,
		name: merged.name || nameFromTitle || username,
		bio: merged.bio || (fromOg.followersCount ? null : meta.ogDescription) || null,
		avatar: merged.avatar || meta.image || null,
		website: merged.website || null,
		followersCount,
		followingCount: merged.followingCount ?? fromOg.followingCount ?? null,
		postsCount: merged.postsCount ?? fromOg.postsCount ?? null,
		verified: Boolean(merged.verified),
		isPrivate: Boolean(merged.isPrivate),
		isBusiness: Boolean(merged.isBusiness),
		loginWall,
		source: fromNet
			? "network_json"
			: fromScripts
				? "page_json"
				: fromOg.followersCount
					? "og_description"
					: loginWall
						? "login_wall"
						: "og_meta",
		finalUrl: pageResult.finalUrl,
	};
}
