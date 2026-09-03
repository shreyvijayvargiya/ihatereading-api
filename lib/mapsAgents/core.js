/**
 * Maps lead agent core — scrape via /scrape-google-maps, dedupe, Firestore.
 */

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { resolveScrapeBaseUrl, scrapeUrl } from "../scrapefast.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export const DEFAULT_MODEL =
	process.env.REDDIT_CLAUDE_SONNET ||
	process.env.OPENROUTER_MODEL ||
	"anthropic/claude-sonnet-4";

export function placeDocId(place) {
	const key =
		place.mapsUrl ||
		place.url ||
		`${place.name || ""}|${place.phone || ""}|${place.address || ""}`;
	return createHash("sha256")
		.update(String(key).toLowerCase())
		.digest("hex")
		.slice(0, 32);
}

function normalizeWebsite(raw) {
	const s = String(raw || "").trim();
	if (!s) return "";
	try {
		const u = new URL(s.startsWith("http") ? s : `https://${s}`);
		return u.href;
	} catch {
		return s;
	}
}

function emailsFromText(text) {
	const set = new Set();
	for (const m of String(text || "").match(EMAIL_RE) || []) {
		const e = m.toLowerCase();
		if (!e.includes("example.com") && !e.endsWith(".png")) set.add(e);
	}
	return [...set];
}

async function fetchMapsPlacesHttp(query, baseUrl) {
	const root = (baseUrl || resolveScrapeBaseUrl()).replace(/\/$/, "");
	const res = await fetch(`${root}/scrape-google-maps`, {
		method: "POST",
		signal: AbortSignal.timeout(180_000),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ singleQuery: query }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.success === false) {
		throw new Error(data.error || `Maps scrape HTTP ${res.status}`);
	}
	const places = data.data?.results || data.data?.places || data.data || [];
	return Array.isArray(places) ? places : [];
}

/** Scrape Maps in-process (default) or via HTTP when MAPS_USE_HTTP_SCRAPE=true. */
export async function fetchMapsPlaces(query, baseUrl) {
	if (process.env.MAPS_USE_HTTP_SCRAPE === "true") {
		return fetchMapsPlacesHttp(query, baseUrl);
	}
	const { scrapeMapsQuery } = await import("../mapsScrape.js");
	return scrapeMapsQuery(query);
}

/** Batch scrape with one browser — used by the karyam agent CLI. */
export async function fetchMapsPlacesBatch(queries, baseUrl) {
	if (process.env.MAPS_USE_HTTP_SCRAPE === "true") {
		const out = [];
		for (const query of queries) {
			try {
				const places = await fetchMapsPlacesHttp(query, baseUrl);
				out.push({ query, places });
			} catch (err) {
				out.push({ query, places: [], error: err?.message || String(err) });
			}
		}
		return out;
	}
	const { scrapeMapsQueries } = await import("../mapsScrape.js");
	return scrapeMapsQueries(queries);
}

async function enrichEmailFromWebsite(website, baseUrl) {
	const url = normalizeWebsite(website);
	if (!url || /instagram\.com|facebook\.com|wa\.me|whatsapp/i.test(url)) {
		return [];
	}
	try {
		const row = await scrapeUrl(url, {
			baseUrl,
			timeoutMs: 45_000,
			includeImages: false,
		});
		return emailsFromText(row.markdown || "");
	} catch {
		return [];
	}
}

export function normalizePlace(raw, meta = {}) {
	const mapsUrl = raw.url || raw.mapsUrl || "";
	return {
		name: String(raw.name || "").trim(),
		address: String(raw.address || "").trim(),
		phone: String(raw.phone || "").trim(),
		website: normalizeWebsite(raw.website),
		image: String(raw.image || "").trim(),
		category: String(raw.category || meta.category || "").trim(),
		rating: raw.rating != null ? Number(raw.rating) : null,
		reviews: raw.reviews != null ? String(raw.reviews) : null,
		coordinates: raw.coordinates || null,
		mapsUrl,
		cityId: meta.cityId || null,
		city: meta.city || null,
		state: meta.state || null,
		country: meta.country || null,
		searchQuery: meta.query || null,
		searchCategory: meta.category || null,
	};
}

export async function leadExists(collection, place) {
	const id = placeDocId(place);
	const snap = await firestore.collection(collection).doc(id).get();
	return snap.exists;
}

export async function saveLead(collection, lead) {
	const id = placeDocId(lead);
	const { createdAt: _ca, ...rest } = lead;
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
	const ref = firestore.collection(stateCollection).doc(agentId);
	const snap = await ref.get();
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

/**
 * Score leads for karyam.xyz website outreach.
 * @param {object[]} leads
 * @param {object} agentConfig
 */
export async function scoreLeadsWithLlm(leads, agentConfig) {
	if (!leads.length) return [];

	const { content } = await openRouterChat({
		model: agentConfig.model || DEFAULT_MODEL,
		jsonMode: true,
		temperature: 0.2,
		maxTokens: 3000,
		messages: [
			{
				role: "system",
				content: `You score Google Maps local businesses for karyam.xyz — a software agency that builds websites, landing pages, and ecommerce for physical businesses in India.

Goal: find cafes, restaurants, shops, salons, clinics, etc. in Kota/Jaipur who NEED a professional website (no site, broken site, only Instagram/Facebook, or very weak web presence).

Score 1-5:
5 = strong website lead (no website OR only social/WhatsApp OR clearly outdated — phone listed, active on Maps, would benefit from karyam website)
4 = good lead (basic site but poor/outdated, or missing key info)
3 = maybe
1-2 = already has a good website, franchise, or not a fit

For each lead return:
- score (1-5)
- reason (short)
- websiteStatus: "none" | "social_only" | "basic" | "good" | "unknown"
- draftMessage: ONE friendly line to open outreach (WhatsApp/call style, not spammy, mention website help)
- outreachChannel: "call" | "whatsapp" | "email" | "visit"

Return ONLY JSON:
{ "results": [{ "id": "<lead id>", "score": number, "reason": "", "websiteStatus": "", "draftMessage": "", "outreachChannel": "" }] }
Include every lead id from input.`,
			},
			{
				role: "user",
				content: JSON.stringify(
					leads.map((l) => ({
						id: l.id || placeDocId(l),
						name: l.name,
						category: l.category,
						city: l.city,
						address: l.address,
						phone: l.phone,
						website: l.website,
						emails: l.emails || [],
						rating: l.rating,
						reviews: l.reviews,
					})),
				),
			},
		],
	});

	try {
		const raw = parseJsonFromLLM(content);
		return Array.isArray(raw.results) ? raw.results : [];
	} catch (err) {
		console.error("[maps-agent] score parse failed:", err?.message);
		return leads.map((l) => ({
			id: l.id || placeDocId(l),
			score: 0,
			reason: "llm_parse_failed",
			draftMessage: "",
			websiteStatus: "unknown",
			outreachChannel: "call",
		}));
	}
}

export async function listMapsLeads(
	collection,
	{ minScore = 0, city, cityId, limit = 100 } = {},
) {
	let q = firestore.collection(collection).where("relevanceScore", ">=", minScore);
	const snap = await q.get();
	let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	const cityFilter = cityId || city;
	if (cityFilter) {
		const c = String(cityFilter).toLowerCase();
		rows = rows.filter((r) => {
			const id = String(r.cityId || "").toLowerCase();
			const name = String(r.city || "").toLowerCase();
			return id === c || name === c || name.includes(c);
		});
	}
	rows.sort((a, b) => {
		const sa = Number(a.relevanceScore) || 0;
		const sb = Number(b.relevanceScore) || 0;
		if (sb !== sa) return sb - sa;
		return (
			new Date(b.fetchedAt || 0).getTime() - new Date(a.fetchedAt || 0).getTime()
		);
	});
	return rows.slice(0, limit);
}

export { enrichEmailFromWebsite, emailsFromText };
