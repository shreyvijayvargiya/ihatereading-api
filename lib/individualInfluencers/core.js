/**
 * Individual influencers — hash dedupe, Firestore, LLM purify + niche tags.
 */

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import { INFLUENCER_AGENT, INFLUENCER_NICHES } from "./configs.js";
import {
	instagramUsernameFrom,
	parseFollowerPhrase,
	xHandleFrom,
	youtubeFrom,
} from "../socialScrapers/parse.js";

export const DEFAULT_MODEL =
	process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";

const BRAND_HANDLE_RE =
	/official|agency|studios?|records|magazine|network|news|tv$|hq$|inc$|llc|brand|company|org$/i;

export function createSeenMap() {
	return new Map();
}

export function normalizeUrl(raw) {
	const s = String(raw || "").trim();
	if (!s) return "";
	try {
		const u = new URL(s.startsWith("http") ? s : `https://${s}`);
		u.hash = "";
		return u.href.replace(/\/$/, "");
	} catch {
		return s;
	}
}

export function influencerDocId(row) {
	const platform = String(row.platform || row.sourcePlatform || "web").toLowerCase();
	const handle = String(row.handle || row.channelId || row.profileUrl || row.name || "")
		.toLowerCase()
		.trim();
	return createHash("sha256")
		.update(`${platform}:${handle}`)
		.digest("hex")
		.slice(0, 32);
}

export function seenKey(c) {
	const p = String(c.platform || c.sourcePlatform || "").toLowerCase();
	if (c.handle) return `${p}:${String(c.handle).toLowerCase()}`;
	if (c.channelId) return `yt:${c.channelId}`;
	if (c.profileUrl) return `url:${normalizeUrl(c.profileUrl)}`;
	return `name:${String(c.name || "").toLowerCase()}`;
}

export function guessNameFromTitle(title) {
	const t = String(title || "")
		.replace(/\s*[|\-–—•].*$/, "")
		.replace(/\s*\(@[^)]+\)\s*/g, " ")
		.replace(/\s+on\s+(X|Twitter|Instagram|YouTube).*$/i, "")
		.replace(/\s*-\s*YouTube\s*$/i, "")
		.trim();
	if (!t || t.length > 80) return "";
	return t;
}

/**
 * Build a candidate from a Google SERP row.
 */
export function candidateFromSerp(row, meta = {}) {
	const url = normalizeUrl(row.url || row.link);
	const title = String(row.title || "").trim();
	const snippet = String(row.snippet || "").trim();
	const blob = `${title}\n${snippet}\n${url}`;
	const platform = String(meta.platform || "web").toLowerCase();

	let handle = "";
	let profileUrl = url;
	let channelId = "";

	if (platform === "instagram" || /instagram\.com/i.test(url)) {
		handle = instagramUsernameFrom(url) || instagramUsernameFrom(blob);
		if (handle) profileUrl = `https://www.instagram.com/${handle}/`;
	} else if (platform === "x" || /(?:x|twitter)\.com/i.test(url)) {
		handle = xHandleFrom(url) || xHandleFrom(blob);
		if (handle) profileUrl = `https://x.com/${handle}`;
	} else if (platform === "youtube" || /youtube\.com/i.test(url)) {
		const yt = youtubeFrom(url);
		handle = yt.handle;
		channelId = yt.channelId;
		profileUrl = yt.url || url;
	}

	if (!handle && !channelId) return null;

	return {
		name: guessNameFromTitle(title) || handle,
		title,
		snippet,
		sourceUrl: url,
		profileUrl,
		platform:
			/instagram\.com/i.test(url)
				? "instagram"
				: /(?:x|twitter)\.com/i.test(url)
					? "x"
					: /youtube\.com/i.test(url)
						? "youtube"
						: platform,
		niche: meta.niche || null,
		searchQuery: meta.query || null,
		handle: handle || null,
		channelId: channelId || null,
		followersCount: parseFollowerPhrase(blob),
		website: null,
		bio: snippet || null,
	};
}

export async function influencerExists(collection, candidate) {
	const id = influencerDocId(candidate);
	const snap = await firestore.collection(collection).doc(id).get();
	return snap.exists;
}

export async function saveInfluencer(collection, row) {
	const id = influencerDocId(row);
	const { createdAt: _ca, ...rest } = row;
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

export async function loadQueryCursor(stateCollection, agentId) {
	const snap = await firestore.collection(stateCollection).doc(agentId).get();
	if (!snap.exists) return 0;
	return Number(snap.data()?.lastQueryIndex) || 0;
}

export async function saveQueryCursor(stateCollection, agentId, index) {
	await firestore
		.collection(stateCollection)
		.doc(agentId)
		.set(
			{
				agentId,
				lastQueryIndex: index,
				updatedAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
}

export async function countInfluencers(collection = INFLUENCER_AGENT.collection) {
	const snap = await firestore.collection(collection).count().get();
	return snap.data().count || 0;
}

export function looksLikeBrandHandle(handle, name) {
	const h = String(handle || "");
	const n = String(name || "");
	if (BRAND_HANDLE_RE.test(h) || BRAND_HANDLE_RE.test(n)) return true;
	if (/\b(inc|llc|ltd|agency|official|studios)\b/i.test(n)) return true;
	return false;
}

/**
 * LLM: keep only individual people, assign niche tags, purify names.
 */
export async function purifyInfluencersWithLlm(rows, opts = {}) {
	if (!rows.length) return [];
	const niches = INFLUENCER_NICHES.join(", ");
	const { content } = await openRouterChat({
		model: opts.model || DEFAULT_MODEL,
		jsonMode: true,
		temperature: 0.2,
		maxTokens: 4000,
		messages: [
			{
				role: "system",
				content: `You purify social creators for Firestore "individual-influencers".

KEEP only a real individual person (one human). REJECT brands, companies, agencies, media orgs, news handles, official product accounts.

Tags MUST be chosen from: ${niches}
Also add "top influencers" if they clearly have large public following / notable personal brand.

For each row return:
- id (same as input)
- reject: true if not an individual person
- rejectReason: short if reject
- name: cleaned person name
- tags: string[] from the allowed list (include Spirituality when relevant)
- category: primary niche (one of the allowed tags)
- bio: cleaned short bio
- isPerson: true/false
- relevanceScore: 1-5 (5 = strong personal creator in a clear niche, ≥10k followers likely)
- relevanceReason: short

Do not invent follower counts. Do not keep companies.

Return ONLY JSON:
{ "results": [{ "id": "", "reject": false, "rejectReason": "", "name": "", "tags": [], "category": "", "bio": "", "isPerson": true, "relevanceScore": 0, "relevanceReason": "" }] }
Include every input id.`,
			},
			{
				role: "user",
				content: JSON.stringify(
					rows.map((r) => ({
						id: r.id || influencerDocId(r),
						name: r.name,
						handle: r.handle,
						platform: r.platform,
						bio: r.bio,
						snippet: r.snippet,
						title: r.title,
						followersCount: r.followersCount,
						nicheHint: r.niche,
						profileUrl: r.profileUrl,
						website: r.website,
						verified: r.verified,
					})),
				),
			},
		],
	});

	try {
		const raw = parseJsonFromLLM(content);
		return Array.isArray(raw.results) ? raw.results : [];
	} catch (err) {
		console.error("[influencers] purify parse failed:", err?.message);
		return rows.map((r) => ({
			id: r.id || influencerDocId(r),
			reject: looksLikeBrandHandle(r.handle, r.name),
			rejectReason: "llm_parse_failed",
			name: r.name,
			tags: r.niche ? [r.niche] : [],
			category: r.niche || "",
			bio: r.bio || "",
			isPerson: !looksLikeBrandHandle(r.handle, r.name),
			relevanceScore: 0,
			relevanceReason: "llm_parse_failed",
		}));
	}
}

export async function listInfluencers(
	collection = INFLUENCER_AGENT.collection,
	{ minScore = 0, platform, tag, limit = 100 } = {},
) {
	const snap = await firestore.collection(collection).get();
	let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	rows = rows.filter((r) => r.isPerson !== false && r.reject !== true);
	if (minScore) {
		rows = rows.filter((r) => Number(r.relevanceScore) >= minScore);
	}
	if (platform) {
		const p = String(platform).toLowerCase();
		rows = rows.filter((r) => String(r.platform || "").toLowerCase() === p);
	}
	if (tag) {
		const t = String(tag).toLowerCase();
		rows = rows.filter((r) =>
			(r.tags || []).some((x) => String(x).toLowerCase() === t),
		);
	}
	rows.sort((a, b) => {
		const sa = Number(a.relevanceScore) || 0;
		const sb = Number(b.relevanceScore) || 0;
		if (sb !== sa) return sb - sa;
		return (Number(b.followersCount) || 0) - (Number(a.followersCount) || 0);
	});
	return rows.slice(0, limit);
}
