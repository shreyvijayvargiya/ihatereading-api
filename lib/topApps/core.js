/**
 * Top-apps core — hash dedupe, Firestore, contact/social extract, LLM layers.
 */

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { scrapeUrl } from "../scrapefast.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import {
	JUNK_NAME_RE,
	TOP_MOBILE_APPS_AGENT,
} from "./configs.js";

export const DEFAULT_MODEL =
	process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const APP_STORE_RE =
	/https?:\/\/(?:apps\.apple\.com|itunes\.apple\.com)\/[^\s)"'<>]+/gi;
const PLAY_STORE_RE =
	/https?:\/\/play\.google\.com\/store\/apps\/details\?[^\s)"'<>]+/gi;
const SOCIAL_RES = {
	twitter: /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:\/status\/\d+)?/gi,
	linkedin:
		/https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/([A-Za-z0-9_-]+)/gi,
	instagram: /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)/gi,
	facebook: /https?:\/\/(?:www\.)?facebook\.com\/([A-Za-z0-9.]+)/gi,
	youtube: /https?:\/\/(?:www\.)?youtube\.com\/(?:@|c\/|channel\/)?([A-Za-z0-9_-]+)/gi,
	github: /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+))?/gi,
	producthunt: /https?:\/\/(?:www\.)?producthunt\.com\/(?:products|posts|@)\/([A-Za-z0-9_-]+)/gi,
	crunchbase: /https?:\/\/(?:www\.)?crunchbase\.com\/(?:organization|person)\/([A-Za-z0-9_-]+)/gi,
};

const GITHUB_ORG_RE =
	/https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+))?/gi;
const GITHUB_SKIP = /^(features|topics|collections|marketplace|sponsors|settings|login|join|about|pricing|enterprise|security|customer-stories|readme|pulls|issues|orgs|explore|notifications)$/i;

export function createSeenMap() {
	return new Map();
}

export function normalizeUrl(raw) {
	const s = String(raw || "").trim();
	if (!s) return "";
	try {
		const u = new URL(s.startsWith("http") ? s : `https://${s}`);
		u.hash = "";
		u.search = u.search; // keep query for play store
		if (!/play\.google\.com|apps\.apple\.com/i.test(u.hostname)) {
			// strip tracking params for normal sites
			["utm_source", "utm_medium", "utm_campaign", "ref"].forEach((k) =>
				u.searchParams.delete(k),
			);
		}
		return u.href.replace(/\/$/, "");
	} catch {
		return s;
	}
}

export function domainFromUrl(url) {
	try {
		return new URL(normalizeUrl(url)).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return "";
	}
}

export function normalizeName(name) {
	return String(name || "")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.trim()
		.replace(/\s+/g, " ")
		.slice(0, 120);
}

/** @deprecated */
export const TOP_APPS_AGENT = TOP_MOBILE_APPS_AGENT;

function unwrapUrl(raw) {
	let s = String(raw || "").trim();
	if (!s) return "";
	try {
		const u = new URL(s.startsWith("http") ? s : `https://${s}`);
		if (u.hostname.includes("google.") && u.pathname === "/url") {
			s = u.searchParams.get("q") || u.searchParams.get("url") || s;
		}
		if (u.hostname.includes("duckduckgo.com") && u.searchParams.get("uddg")) {
			s = decodeURIComponent(u.searchParams.get("uddg"));
		}
	} catch {
		/* keep */
	}
	return s;
}

const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Resolve relative Play / App Store hrefs before parsing. */
export function resolveStoreUrl(raw, pageUrl = "") {
	let s = String(raw || "").trim();
	if (!s) return "";
	if (s.startsWith("//")) s = `https:${s}`;
	if (s.startsWith("/store/")) s = `https://play.google.com${s}`;
	if (/^\/(?:[a-z]{2}\/)?(?:app|genre|charts)\//i.test(s)) {
		s = `https://apps.apple.com${s}`;
	}
	try {
		if (pageUrl && !/^https?:\/\//i.test(s)) {
			s = new URL(s, pageUrl).href;
		}
	} catch {
		/* keep */
	}
	return normalizeUrl(s);
}

export function isMobileStoreListing(url) {
	const u = unwrapUrl(resolveStoreUrl(url));
	return (
		/(?:play\.google\.com)?\/store\/apps\/details\?[^#]*id=[^&]+/i.test(u) ||
		/apps\.apple\.com\/[^/]+\/app\/[^/]+\/id\d+/i.test(u) ||
		/apps\.apple\.com\/app\/[^/]+\/id\d+/i.test(u)
	);
}

export function parsePlayStoreId(url) {
	const u = unwrapUrl(resolveStoreUrl(url));
	const m =
		u.match(/play\.google\.com\/store\/apps\/details\?[^#]*[?&]?id=([^&\s]+)/i) ||
		u.match(/\/store\/apps\/details\?[^#]*id=([^&\s]+)/i);
	if (!m) return null;
	try {
		return decodeURIComponent(m[1]);
	} catch {
		return m[1];
	}
}

export function parseAppStoreId(url) {
	const u = unwrapUrl(resolveStoreUrl(url));
	const m =
		u.match(/apps\.apple\.com\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id(\d+)/i) ||
		u.match(/itunes\.apple\.com\/[^\s]*[?&]id=(\d+)/i) ||
		u.match(/\/id(\d+)(?:\?|$)/i);
	return m ? m[1] : null;
}

export function extractPlayIdsFromText(text) {
	const ids = new Set();
	const re = /(?:play\.google\.com)?\/store\/apps\/details\?id=([a-zA-Z][\w.]{1,180})/g;
	let m;
	while ((m = re.exec(String(text || "")))) {
		try {
			ids.add(decodeURIComponent(m[1]));
		} catch {
			ids.add(m[1]);
		}
	}
	return [...ids];
}

export function extractAppleIdsFromText(text) {
	const ids = new Set();
	const re = /apps\.apple\.com\/[^\s)"'<>]+\/id(\d+)/gi;
	let m;
	while ((m = re.exec(String(text || "")))) ids.add(m[1]);
	return [...ids];
}

export async function fetchText(url, { timeoutMs = 25_000 } = {}) {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(timeoutMs),
		redirect: "follow",
		headers: {
			"User-Agent": BROWSER_UA,
			Accept: "text/html,application/json,application/xhtml+xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return res.text();
}

export async function fetchJson(url, opts = {}) {
	const text = await fetchText(url, opts);
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Invalid JSON from ${url}`);
	}
}

function pageFromHtml(target, html) {
	const raw = String(html || "");
	const title =
		raw.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim() ||
		raw.match(/property="og:title" content="([^"]+)"/i)?.[1] ||
		"";
	const ogImage =
		raw.match(/property="og:image" content="([^"]+)"/i)?.[1] || null;
	const desc =
		raw.match(/property="og:description" content="([^"]+)"/i)?.[1] || "";
	const images = [
		...new Set(raw.match(/https:\/\/play-lh\.googleusercontent\.com\/[^"\\\s]+/g) || []),
	].slice(0, 40);
	const links = [];
	for (const id of extractPlayIdsFromText(raw)) {
		links.push({
			href: `https://play.google.com/store/apps/details?id=${encodeURIComponent(id)}`,
			text: id.split(".").pop() || id,
		});
	}
	for (const id of extractAppleIdsFromText(raw)) {
		links.push({
			href: `https://apps.apple.com/app/id${id}`,
			text: `id${id}`,
		});
	}
	return {
		url: target,
		title: title.replace(/\s+/g, " ").slice(0, 200),
		markdown: [title, desc].filter(Boolean).join("\n"),
		html: raw,
		links,
		images,
		ogImage,
		via: "http",
	};
}

export async function itunesLookup(id, country = "us") {
	if (!id) return null;
	const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&country=${country}`;
	const data = await fetchJson(url);
	return (data.results || [])[0] || null;
}

export function appFromItunesResult(r, meta = {}) {
	if (!r?.trackId && !r?.trackName) return null;
	const screenshots = [
		...(r.screenshotUrls || []),
		...(r.ipadScreenshotUrls || []),
	].filter(Boolean);
	const icon = r.artworkUrl512 || r.artworkUrl100 || r.artworkUrl60 || null;
	return {
		name: normalizeName(r.trackName),
		category: meta.category || r.primaryGenreName || null,
		platform: "ios",
		store: "apple_app_store",
		appStoreId: String(r.trackId),
		playStoreId: null,
		appStoreUrl: r.trackViewUrl ? String(r.trackViewUrl).split("?")[0] : null,
		playStoreUrl: null,
		developer: r.sellerName || r.artistName || null,
		developerUrl: r.sellerUrl || r.artistViewUrl || null,
		website: r.sellerUrl || null,
		rating: r.averageUserRating != null ? Number(r.averageUserRating) : null,
		reviewCount: r.userRatingCount != null ? Number(r.userRatingCount) : null,
		downloads: null,
		priceLabel: r.formattedPrice || (r.price === 0 ? "Free" : null),
		oneLiner: String(r.description || "").replace(/\s+/g, " ").slice(0, 280),
		iconUrl: icon,
		screenshots: screenshots.slice(0, 12),
		images: [icon, ...screenshots].filter(Boolean).slice(0, 16),
		bundleId: r.bundleId || null,
		sourceUrl: r.trackViewUrl || null,
		reviewsUrl: r.trackViewUrl || null,
		mobileOnly: true,
	};
}

export function parsePlayDetailsHtml(html, app = {}) {
	const text = String(html || "");
	const ogTitle = text.match(/property="og:title" content="([^"]+)"/i)?.[1] || "";
	const ogDesc = text.match(/property="og:description" content="([^"]+)"/i)?.[1] || "";
	const ogImage = text.match(/property="og:image" content="([^"]+)"/i)?.[1] || null;
	const name = guessNameFromTitle(ogTitle) || app.name;
	const developer =
		text.match(/"author"[^}]{0,240}?"name"\s*:\s*"([^"]+)"/i)?.[1] ||
		text.match(/Offered By<\/[^>]+>\s*<[^>]+>([^<]+)/i)?.[1] ||
		app.developer ||
		null;
	const ratingRaw =
		text.match(/Rated\s+([\d.]+)\s+stars/i)?.[1] ||
		text.match(/"ratingValue"\s*:\s*"?([0-9.]+)/i)?.[1];
	const downloads =
		text.match(/([\d,.]+[KkMm]?\+)\s*(?:Downloads|Installs)/i)?.[1] ||
		text.match(/"([\d]{1,3}(?:,\d{3}){1,4}\+)"/)?.[1] ||
		null;
	const website =
		text.match(/"url"\s*:\s*"(https?:\/\/(?!play\.google)[^"]+)"/i)?.[1] ||
		null;
	const rawImgs = text.match(/https:\/\/play-lh\.googleusercontent\.com\/[^"\\\s]+/g) || [];
	const byBase = new Map();
	for (const u of rawImgs) {
		if (/=s(?:20|40|64)\b/i.test(u)) continue;
		const base = u.split("=")[0];
		const prev = byBase.get(base);
		if (!prev || u.length > prev.length) byBase.set(base, u);
	}
	const images = [...byBase.values()].slice(0, 16);
	const iconUrl = ogImage || images[0] || app.iconUrl || null;
	const screenshots = images.filter((u) => u !== iconUrl && u.split("=")[0] !== (iconUrl || "").split("=")[0]).slice(0, 12);
	return {
		name: name || app.name,
		oneLiner: ogDesc.replace(/\s+/g, " ").slice(0, 280) || app.oneLiner || "",
		developer: developer ? String(developer).trim().slice(0, 120) : app.developer || null,
		website: website || app.website || null,
		developerUrl: website || app.developerUrl || null,
		rating: ratingRaw != null ? Number(ratingRaw) : app.rating ?? null,
		downloads: downloads || app.downloads || null,
		iconUrl,
		screenshots: screenshots.length ? screenshots : app.screenshots || [],
		images: [iconUrl, ...screenshots].filter(Boolean).slice(0, 16),
		ogImage,
	};
}

/**
 * Parse a mobile app directly from a Google SERP row (App Store / Play listing URL).
 */
export function parseMobileAppFromSerp(row, meta = {}) {
	const rawUrl = unwrapUrl(row.url || row.link || "");
	if (!rawUrl) return null;

	const playId = parsePlayStoreId(rawUrl);
	const appleId = parseAppStoreId(rawUrl);
	if (!playId && !appleId) return null;

	const title = String(row.title || "").trim();
	const snippet = String(row.snippet || "").trim();
	let name = guessNameFromTitle(title);
	if (!name || name.length < 2) {
		if (appleId) {
			const slug = rawUrl.match(/\/app\/([^/]+)\/id/i);
			if (slug) name = normalizeName(slug[1].replace(/-/g, " "));
		}
		if (playId && !name) name = playId.split(".").pop() || playId;
	}
	if (!name || isJunkName(name)) return null;

	const ratingMatch = snippet.match(/([1-5]\.[0-9])\s*(?:stars?|★|out of)/i);
	const reviewsMatch = snippet.match(/([\d,.]+[KkMm]?)\s*(?:reviews?|ratings?)/i);
	const downloadsMatch = snippet.match(/([\d,.]+[KkMm+]*)\s*(?:downloads?|installs?)/i);

	return {
		name,
		title,
		snippet,
		category: meta.category || null,
		platform: playId ? "android" : "ios",
		store: meta.store || (playId ? "google_play" : "apple_app_store"),
		playStoreId: playId,
		appStoreId: appleId,
		playStoreUrl: playId
			? `https://play.google.com/store/apps/details?id=${encodeURIComponent(playId)}`
			: null,
		appStoreUrl: appleId ? rawUrl.split("?")[0] : null,
		sourceUrl: rawUrl,
		reviewsUrl: rawUrl,
		rating: ratingMatch ? Number(ratingMatch[1]) : null,
		reviewCount: reviewsMatch ? reviewsMatch[1].replace(/,/g, "") : null,
		downloads: downloadsMatch ? downloadsMatch[1] : null,
		searchQuery: meta.query || null,
	};
}

/** Stable hash — Play package id or App Store id */
export function appDocId(app) {
	const key =
		app.playStoreId ||
		app.appStoreId ||
		app.playStoreUrl ||
		app.appStoreUrl ||
		`${normalizeName(app.name).toLowerCase()}|${app.platform || ""}`;
	return createHash("sha256")
		.update(String(key).toLowerCase().trim())
		.digest("hex")
		.slice(0, 32);
}

export function seenKey(app) {
	if (app.playStoreId) return `play:${app.playStoreId.toLowerCase()}`;
	if (app.appStoreId) return `apple:${app.appStoreId}`;
	if (app.playStoreUrl) return `playurl:${normalizeUrl(app.playStoreUrl)}`;
	if (app.appStoreUrl) return `appleurl:${normalizeUrl(app.appStoreUrl)}`;
	return `name:${normalizeName(app.name).toLowerCase()}|${app.platform || ""}`;
}

/** Non-mobile SaaS / directory hosts (store URLs are NOT directories) */
const NON_MOBILE_HOST_RE =
	/g2\.com|capterra|producthunt|ycombinator|alternativeto|saashub|getapp|medium\.com|forbes\.com/i;

export function isDirectoryUrl(url) {
	const d = domainFromUrl(url);
	return Boolean(d && NON_MOBILE_HOST_RE.test(d));
}

export function isJunkName(name) {
	return !normalizeName(name) || JUNK_NAME_RE.test(normalizeName(name));
}

export function extractEmails(text) {
	const set = new Set();
	for (const m of String(text || "").match(EMAIL_RE) || []) {
		const e = m.toLowerCase();
		if (
			/example\.com|\.png$|\.jpg$|sentry|wixpress|noreply|privacy@/i.test(e)
		)
			continue;
		set.add(e);
	}
	return [...set];
}

export function extractStoreUrls(text) {
	const appStore = [...new Set(String(text || "").match(APP_STORE_RE) || [])].map(
		normalizeUrl,
	);
	const playStore = [
		...new Set(String(text || "").match(PLAY_STORE_RE) || []),
	].map(normalizeUrl);
	return { appStoreUrl: appStore[0] || null, playStoreUrl: playStore[0] || null, appStoreUrls: appStore, playStoreUrls: playStore };
}

export function extractSocials(text) {
	const social = {};
	for (const [network, re] of Object.entries(SOCIAL_RES)) {
		re.lastIndex = 0;
		const m = re.exec(String(text || ""));
		if (m) {
			const handle = m[1];
			if (network === "github" && GITHUB_SKIP.test(handle)) continue;
			if (network === "twitter" && /^(intent|share|home|explore|search|i)$/i.test(handle))
				continue;
			social[network] = normalizeUrl(m[0].replace(/\/status\/\d+.*$/, ""));
			social[`${network}Handle`] = handle;
			if (network === "github" && m[2] && !GITHUB_SKIP.test(m[2])) {
				social.githubRepo = normalizeUrl(
					`https://github.com/${handle}/${m[2]}`,
				);
				social.githubRepoName = m[2];
			}
		}
	}
	return social;
}

/** Collect all github org / user / repo URLs from text */
export function extractGithubUrls(text) {
	const orgs = new Set();
	const repos = new Set();
	GITHUB_ORG_RE.lastIndex = 0;
	let m;
	const blob = String(text || "");
	while ((m = GITHUB_ORG_RE.exec(blob))) {
		const org = m[1];
		if (GITHUB_SKIP.test(org)) continue;
		orgs.add(normalizeUrl(`https://github.com/${org}`));
		if (m[2] && !GITHUB_SKIP.test(m[2])) {
			repos.add(normalizeUrl(`https://github.com/${org}/${m[2]}`));
		}
	}
	return {
		githubUrl: [...orgs][0] || null,
		githubUrls: [...orgs],
		githubRepos: [...repos],
	};
}

export function mergeFounders(existing = [], incoming = []) {
	const byKey = new Map();
	for (const f of [...existing, ...incoming]) {
		if (!f || !f.name) continue;
		const key = String(f.name).toLowerCase().trim();
		const prev = byKey.get(key) || { name: normalizeName(f.name) };
		byKey.set(key, {
			...prev,
			...Object.fromEntries(
				Object.entries(f).filter(([, v]) => v != null && v !== ""),
			),
			name: normalizeName(f.name || prev.name),
			role: f.role || prev.role || null,
			email: f.email || prev.email || null,
			github: f.github || prev.github || null,
			githubHandle: f.githubHandle || prev.githubHandle || null,
			twitter: f.twitter || prev.twitter || null,
			twitterHandle: f.twitterHandle || prev.twitterHandle || null,
			linkedin: f.linkedin || prev.linkedin || null,
			linkedinHandle: f.linkedinHandle || prev.linkedinHandle || null,
			website: f.website || prev.website || null,
			bio: f.bio || prev.bio || null,
			image: f.image || prev.image || null,
		});
	}
	return [...byKey.values()].slice(0, 12);
}

/**
 * Heuristic founder lines from about/team markdown.
 * Looks for "Founder", "CEO", "Co-founder" near names / links.
 */
export function extractFoundersFromText(text) {
	const founders = [];
	const lines = String(text || "").split(/\n+/);
	for (const line of lines) {
		if (!/founder|co-?founder|ceo|creator|built by|made by/i.test(line)) continue;
		const nameMatch =
			line.match(
				/\*\*?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\*\*?/,
			) ||
			line.match(
				/(?:Founder|Co-?founder|CEO|Creator)[:\s,—-]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/,
			);
		if (!nameMatch) continue;
		const name = normalizeName(nameMatch[1]);
		if (!name || name.length < 3) continue;
		const socials = extractSocials(line);
		const emails = extractEmails(line);
		const gh = extractGithubUrls(line);
		founders.push({
			name,
			role: /ceo/i.test(line)
				? "CEO"
				: /co-?founder/i.test(line)
					? "Co-founder"
					: /creator/i.test(line)
						? "Creator"
						: "Founder",
			email: emails[0] || null,
			github: gh.githubUrl || socials.github || null,
			githubHandle: socials.githubHandle || null,
			twitter: socials.twitter || null,
			twitterHandle: socials.twitterHandle || null,
			linkedin: socials.linkedin || null,
			linkedinHandle: socials.linkedinHandle || null,
		});
	}
	return mergeFounders([], founders);
}

/**
 * AI layer — extract founders/creators + github/socials from scraped snippets.
 */
export async function extractFoundersWithLlm(app, snippets, opts = {}) {
	if (!snippets?.length) return { founders: [], creators: [], socials: {}, github: null };
	const { content } = await openRouterChat({
		model: opts.model || DEFAULT_MODEL,
		jsonMode: true,
		temperature: 0.1,
		maxTokens: 2500,
		messages: [
			{
				role: "system",
				content: `Extract founders, creators, and social/GitHub profiles for a software product.

Return ONLY JSON:
{
  "founders": [{ "name": "", "role": "Founder|Co-founder|CEO|CTO|Creator", "email": null, "github": null, "githubHandle": null, "twitter": null, "twitterHandle": null, "linkedin": null, "linkedinHandle": null, "website": null, "bio": null }],
  "creators": [{ "name": "", "role": "Creator|Maker|Indie hacker", "twitter": null, "github": null, "linkedin": null }],
  "companyGithub": null,
  "companyGithubOrg": null,
  "socials": { "twitter": null, "linkedin": null, "github": null, "youtube": null, "instagram": null, "facebook": null, "producthunt": null, "crunchbase": null },
  "aboutPageUrl": null,
  "teamPageUrl": null
}
Only include people you are confident about. Prefer official profiles. Empty arrays OK.`,
			},
			{
				role: "user",
				content: JSON.stringify({
					product: app.name,
					website: app.website,
					category: app.category,
					snippets: snippets.slice(0, 8).map((s) => ({
						url: s.url,
						title: s.title,
						text: String(s.text || "").slice(0, 2500),
					})),
				}),
			},
		],
	});
	try {
		return parseJsonFromLLM(content);
	} catch {
		return { founders: [], creators: [], socials: {}, companyGithub: null };
	}
}

export function extractImages(text, html = "") {
	const urls = new Set();
	const blob = `${text}\n${html}`;
	const re = /https?:\/\/[^\s)"'<>]+\.(?:png|jpg|jpeg|webp|gif|svg)(?:\?[^\s)"'<>]*)?/gi;
	for (const m of blob.match(re) || []) {
		if (/pixel|tracking|1x1|sprite|favicon/i.test(m)) continue;
		urls.add(normalizeUrl(m));
		if (urls.size >= 20) break;
	}
	return [...urls];
}

export function collectStoreImages({ markdown = "", html = "", images = [] } = {}) {
	const out = [];
	const seen = new Set();
	const push = (raw) => {
		const n = normalizeUrl(typeof raw === "string" ? raw : raw?.src || raw?.url || "");
		if (!n || seen.has(n)) return;
		if (/pixel|1x1|favicon|sprite|blank|placeholder|data:image/i.test(n)) return;
		const isStoreCdn =
			/mzstatic\.com|play-lh\.googleusercontent\.com|lh3\.googleusercontent\.com|googleusercontent\.com\/.*[=/]w\d+/i.test(
				n,
			);
		const isFile = /\.(png|jpe?g|webp|gif)(\?|$)/i.test(n);
		if (!isStoreCdn && !isFile) return;
		seen.add(n);
		out.push(n);
	};
	for (const img of images || []) push(img);
	const blob = `${markdown}\n${html}`;
	const cdnRe =
		/https?:\/\/(?:is\d+-ssl\.mzstatic\.com|play-lh\.googleusercontent\.com|lh3\.googleusercontent\.com)\/[^\s)"'<>]+/gi;
	for (const m of blob.match(cdnRe) || []) push(m);
	for (const m of extractImages(blob)) push(m);
	return out.slice(0, 24);
}

export function pickIconAndScreenshots(urls = []) {
	const icon =
		urls.find((u) => /AppIcon|512x512|icon|1024x1024/i.test(u)) || urls[0] || null;
	const screenshots = urls.filter((u) => u !== icon).slice(0, 12);
	const images = [icon, ...screenshots].filter(Boolean);
	return { iconUrl: icon, screenshots, images };
}

export function guessNameFromTitle(title) {
	return normalizeName(
		String(title || "")
			.replace(/\s*[|\-–—:].*$/, "")
			.replace(/\s+on the App Store.*$/i, "")
			.replace(/\s+-\s+Apps on Google Play.*$/i, "")
			.replace(/\s+(reviews?|alternatives?|pricing).*$/i, "")
			.slice(0, 80),
	);
}

export async function countApps(collection = TOP_MOBILE_APPS_AGENT.collection) {
	const snap = await firestore.collection(collection).count().get();
	return snap.data().count || 0;
}

export async function appExists(collection, app) {
	const id = appDocId(app);
	const snap = await firestore.collection(collection).doc(id).get();
	return snap.exists;
}

export async function saveApp(collection, app) {
	const id = appDocId(app);
	const { createdAt: _c, ...rest } = app;
	const plain = JSON.parse(JSON.stringify({ ...rest, id }));
	const ref = firestore.collection(collection).doc(id);
	const existing = await ref.get();
	plain.updatedAt = new Date().toISOString();
	if (!existing.exists) {
		plain.createdAt = FieldValue.serverTimestamp();
	}
	await ref.set(plain, { merge: true });
	return id;
}

export async function loadCursor(stateCollection, agentId) {
	const snap = await firestore.collection(stateCollection).doc(agentId).get();
	if (!snap.exists) return { sourceIndex: 0 };
	return {
		sourceIndex: Number(snap.data()?.sourceIndex) || 0,
	};
}

export async function saveCursor(stateCollection, agentId, data) {
	await firestore
		.collection(stateCollection)
		.doc(agentId)
		.set(
			{
				agentId,
				...data,
				updatedAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
}

export async function scrapePage(url, baseUrl, extra = {}) {
	const target = resolveStoreUrl(url) || normalizeUrl(url);
	if (!target) return null;

	const preferHttp = /play\.google\.com|itunes\.apple\.com/i.test(target);
	if (preferHttp) {
		try {
			const html = await fetchText(target);
			return pageFromHtml(target, html);
		} catch (err) {
			console.warn(`[top-mobile-apps:http] ${target} → ${err?.message || err}`);
		}
	}

	try {
		const waitForSelector = /apps\.apple\.com/i.test(target)
			? 'a[href*="/app/"]'
			: /play\.google\.com/i.test(target)
				? 'a[href*="store/apps/details"]'
				: null;
		const row = await scrapeUrl(target, {
			baseUrl,
			timeoutMs: 75_000,
			timeout: 50_000,
			includeImages: true,
			includeLinks: true,
			waitForSelector,
			takeScreenshot: extra.takeScreenshot === true,
		});
		return {
			url: target,
			title: row.title || row.data?.title || row.data?.metadata?.title || "",
			markdown: row.markdown || row.data?.markdown || "",
			html: row.html || row.data?.html || row.data?.content?.html || "",
			links: row.links || row.data?.links || row.data?.content?.links || [],
			images:
				row.images ||
				row.data?.images ||
				row.data?.content?.images ||
				[],
			ogImage:
				row.data?.metadata?.ogImage ||
				row.data?.metadata?.["og:image"] ||
				row.data?.ogImage ||
				null,
			screenshot: row.screenshot || row.data?.screenshot || null,
			via: "puppeteer",
		};
	} catch (err) {
		if (!preferHttp) {
			try {
				const html = await fetchText(target);
				return pageFromHtml(target, html);
			} catch {
				/* ignore */
			}
		}
		return { url: target, error: err?.message || String(err) };
	}
}

/**
 * AI layer 1 — invent high-signal discovery queries (avoid ads / sponsored listicles).
 */
export async function inventDiscoveryQueries(source, opts = {}) {
	const { content } = await openRouterChat({
		model: opts.model || DEFAULT_MODEL,
		jsonMode: true,
		temperature: 0.4,
		maxTokens: 1200,
		messages: [
			{
				role: "system",
				content: `You invent Google search queries to discover REAL software products / apps that are top-rated and doing well.

Avoid advertising / affiliate spam. Prefer:
- editorial "best of" from reputable publishers
- site:producthunt.com, g2.com/products, apps.apple.com, play.google.com
- year-stamped lists (2025, 2026)
- exclude: sponsored, advertisement, coupon, deal

Return ONLY JSON:
{ "queries": ["...", "..."] }
Max 4 queries. Category hint: ${source.category || "all SaaS / apps"}.
Source: ${source.label || source.id}.`,
			},
			{
				role: "user",
				content: JSON.stringify({
					seedQuery: source.seedQuery,
					site: source.site || null,
					category: source.category || null,
					type: source.type,
				}),
			},
		],
	});
	try {
		const raw = parseJsonFromLLM(content);
		const qs = Array.isArray(raw.queries) ? raw.queries : [];
		return qs.map(String).filter(Boolean).slice(0, 4);
	} catch {
		return source.seedQuery ? [source.seedQuery] : [];
	}
}

/**
 * AI layer 2 — extract real products from SERP rows (reject ads / listicle hosts as product websites).
 */
export async function extractProductsFromSerp(serpRows, meta = {}) {
	if (!serpRows.length) return [];
	const { content } = await openRouterChat({
		model: meta.model || DEFAULT_MODEL,
		jsonMode: true,
		temperature: 0.15,
		maxTokens: 3500,
		messages: [
			{
				role: "system",
				content: `You extract REAL software products / apps from Google SERP results for a discovery agent.

Rules:
- Each product needs name + official website (product domain, NOT g2/capterra/producthunt/medium/forbes as website)
- category from context or guess (CRM, Project Management, etc.)
- score 1-5 how "top / doing well" it looks (ratings, brand recognition, review volume signals in snippet)
- reject: ads, coupon sites, pure listicle pages without a clear product, job posts
- directory URLs can be sourceUrl but website must be the product's own domain when you can infer it

Return ONLY JSON:
{ "products": [{ "name": "", "website": "", "category": "", "score": 0, "reason": "", "sourceUrl": "", "oneLiner": "" }] }`,
			},
			{
				role: "user",
				content: JSON.stringify({
					categoryHint: meta.category || null,
					source: meta.sourceLabel || null,
					results: serpRows.map((r) => ({
						title: r.title,
						url: r.url || r.link,
						snippet: r.snippet,
					})),
				}),
			},
		],
	});
	try {
		const raw = parseJsonFromLLM(content);
		return Array.isArray(raw.products) ? raw.products : [];
	} catch {
		return [];
	}
}

/**
 * Purify mobile apps for Firestore top-mobile-apps.
 */
export async function purifyAppsWithLlm(apps, opts = {}) {
	if (!apps.length) return [];
	const { content } = await openRouterChat({
		model: opts.model || DEFAULT_MODEL,
		jsonMode: true,
		temperature: 0.2,
		maxTokens: 4000,
		messages: [
			{
				role: "system",
				content: `You purify MOBILE APP listings (iOS App Store + Google Play only) for Firestore "top-mobile-apps".

For each app return:
- id (same as input)
- name, category, oneLiner
- platform: "ios" | "android" | "both"
- store: "apple_app_store" | "google_play"
- appStoreUrl, playStoreUrl, appStoreId, playStoreId
- developer, developerUrl, website (developer site if known)
- iconUrl, screenshots (string[]), images
- rating, reviewCount, downloads, priceLabel
- relevanceScore (1-5) — top-rated / popular / doing well on store
- relevanceReason, tags, draftPitch (one line why this app matters)
- reject: true if NOT a real mobile app listing (chart page, category page, junk)

Keep store URLs. Do NOT invent apps.

Return ONLY JSON: { "apps": [ { ... } ] }
Include every input id.`,
			},
			{
				role: "user",
				content: JSON.stringify(
					apps.map((a) => ({
						id: a.id || appDocId(a),
						name: a.name,
						website: a.website,
						category: a.category,
						oneLiner: a.oneLiner || a.snippet,
						sourceUrl: a.sourceUrl,
						source: a.source,
						email: a.email,
						emails: a.emails,
						appStoreUrl: a.appStoreUrl,
						playStoreUrl: a.playStoreUrl,
						reviewsUrl: a.reviewsUrl,
						g2Url: a.g2Url,
						socials: a.socials,
						images: a.images,
						iconUrl: a.iconUrl,
						screenshots: a.screenshots,
						rating: a.rating,
						reviewCount: a.reviewCount,
						downloads: a.downloads,
						storeMetadata: a.storeMetadata,
						founders: a.founders,
						creators: a.creators,
						githubUrl: a.githubUrl,
						githubOrg: a.githubOrg,
						githubRepos: a.githubRepos,
						founderEmails: a.founderEmails,
						companyLinkedIn: a.companyLinkedIn,
						companyTwitter: a.companyTwitter,
						companyGithub: a.companyGithub,
						aboutPageUrl: a.aboutPageUrl,
						teamPageUrl: a.teamPageUrl,
						crunchbaseUrl: a.crunchbaseUrl,
						productHuntUrl: a.productHuntUrl,
						enrichmentPreview: a.enrichmentPreview,
						founderScrapePreview: a.founderScrapePreview,
					})),
				),
			},
		],
	});
	try {
		const raw = parseJsonFromLLM(content);
		return Array.isArray(raw.apps) ? raw.apps : [];
	} catch (err) {
		console.error("[top-apps] purify parse failed:", err?.message);
		return apps.map((a) => ({
			id: a.id || appDocId(a),
			name: a.name,
			website: a.website,
			category: a.category,
			relevanceScore: Number(a.score) || 3,
			relevanceReason: "llm_parse_failed",
			reject: false,
		}));
	}
}

export async function listApps(
	collection = TOP_MOBILE_APPS_AGENT.collection,
	{ minScore = 0, category, limit = 100 } = {},
) {
	let rows;
	if (minScore > 0) {
		const snap = await firestore
			.collection(collection)
			.where("relevanceScore", ">=", minScore)
			.get();
		rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	} else {
		const snap = await firestore.collection(collection).limit(limit * 2).get();
		rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	}
	if (category) {
		const c = String(category).toLowerCase();
		rows = rows.filter((r) => String(r.category || "").toLowerCase().includes(c));
	}
	rows.sort(
		(a, b) => (Number(b.relevanceScore) || 0) - (Number(a.relevanceScore) || 0),
	);
	return rows.slice(0, limit);
}
