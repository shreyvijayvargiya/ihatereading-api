/**
 * Angel investor core — hash dedupe, Firestore, contact extraction helpers.
 */

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { scrapeUrl } from "../scrapefast.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import { ANGEL_AGENT } from "./configs.js";

export const DEFAULT_MODEL =
	process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE =
	/(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}/g;
const X_HANDLE_RE =
	/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i;
const LI_URL_RE =
	/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([A-Za-z0-9_-]+)/i;

/** In-memory run-level dedupe so we don't process the same person twice in one batch. */
export function createSeenMap() {
	return new Map();
}

export function investorDocId(investor) {
	const key =
		investor.xUrl ||
		investor.linkedinUrl ||
		investor.website ||
		investor.email ||
		`${investor.name || ""}|${investor.xHandle || ""}|${investor.linkedinHandle || ""}`;
	return createHash("sha256")
		.update(String(key).toLowerCase().trim())
		.digest("hex")
		.slice(0, 32);
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

export function extractEmails(text) {
	const set = new Set();
	for (const m of String(text || "").match(EMAIL_RE) || []) {
		const e = m.toLowerCase();
		if (
			e.includes("example.com") ||
			e.endsWith(".png") ||
			e.endsWith(".jpg") ||
			e.includes("sentry") ||
			e.includes("wixpress")
		)
			continue;
		set.add(e);
	}
	return [...set];
}

export function extractPhones(text) {
	const set = new Set();
	for (const m of String(text || "").match(PHONE_RE) || []) {
		const digits = m.replace(/\D/g, "");
		if (digits.length < 10 || digits.length > 15) continue;
		set.add(m.trim());
	}
	return [...set].slice(0, 3);
}

export function extractX(text, url) {
	const fromUrl = String(url || "").match(X_HANDLE_RE);
	if (fromUrl) {
		return {
			handle: fromUrl[1],
			url: `https://x.com/${fromUrl[1]}`,
		};
	}
	const fromText = String(text || "").match(X_HANDLE_RE);
	if (fromText) {
		return {
			handle: fromText[1],
			url: `https://x.com/${fromText[1]}`,
		};
	}
	return { handle: "", url: "" };
}

export function extractLinkedIn(text, url) {
	const fromUrl = String(url || "").match(LI_URL_RE);
	if (fromUrl) {
		return {
			handle: fromUrl[1],
			url: `https://www.linkedin.com/in/${fromUrl[1]}`,
		};
	}
	const fromText = String(text || "").match(LI_URL_RE);
	if (fromText) {
		return {
			handle: fromText[1],
			url: `https://www.linkedin.com/in/${fromText[1]}`,
		};
	}
	return { handle: "", url: "" };
}

export function guessNameFromTitle(title) {
	const t = String(title || "")
		.replace(/\s*[|\-–—].*$/, "")
		.replace(/\s*on\s+(X|Twitter|LinkedIn).*$/i, "")
		.replace(/\(@[^)]+\)/g, "")
		.trim();
	if (!t || t.length > 80) return "";
	return t;
}

/**
 * Build a candidate from a SERP row + platform meta.
 */
export function candidateFromSerp(row, meta = {}) {
	const url = normalizeUrl(row.url || row.link);
	const title = String(row.title || "").trim();
	const snippet = String(row.snippet || "").trim();
	const blob = `${title}\n${snippet}\n${url}`;

	const x = extractX(blob, url);
	const li = extractLinkedIn(blob, url);
	const emails = extractEmails(blob);
	const phones = extractPhones(blob);

	let platform = meta.platform || "google";
	if (x.url && /x\.com|twitter\.com/i.test(url)) platform = "x";
	if (li.url && /linkedin\.com/i.test(url)) platform = "linkedin";

	return {
		name: guessNameFromTitle(title) || x.handle || li.handle || "",
		title,
		snippet,
		sourceUrl: url,
		sourcePlatform: platform,
		sector: meta.sector || null,
		searchQuery: meta.query || null,
		xHandle: x.handle || null,
		xUrl: x.url || null,
		linkedinHandle: li.handle || null,
		linkedinUrl: li.url || null,
		website: !/x\.com|twitter\.com|linkedin\.com/i.test(url) ? url : null,
		emails,
		email: emails[0] || null,
		phones,
		phone: phones[0] || null,
	};
}

export function seenKey(candidate) {
	if (candidate.xHandle) return `x:${candidate.xHandle.toLowerCase()}`;
	if (candidate.linkedinHandle)
		return `li:${candidate.linkedinHandle.toLowerCase()}`;
	if (candidate.email) return `email:${candidate.email.toLowerCase()}`;
	if (candidate.sourceUrl) return `url:${normalizeUrl(candidate.sourceUrl)}`;
	return `name:${String(candidate.name || "").toLowerCase()}`;
}

export async function investorExists(collection, candidate) {
	const id = investorDocId(candidate);
	const snap = await firestore.collection(collection).doc(id).get();
	return snap.exists;
}

export async function saveInvestor(collection, investor) {
	const id = investorDocId(investor);
	const { createdAt: _ca, ...rest } = investor;
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

/**
 * Scrape a URL (profile or personal site) for email / phone / socials.
 */
export async function enrichFromUrl(url, baseUrl) {
	const target = normalizeUrl(url);
	if (!target) return {};
	try {
		const row = await scrapeUrl(target, {
			baseUrl,
			timeoutMs: 45_000,
			includeImages: false,
		});
		const text = `${row.markdown || ""}\n${row.title || ""}`;
		const emails = extractEmails(text);
		const phones = extractPhones(text);
		const x = extractX(text, target);
		const li = extractLinkedIn(text, target);
		const websiteMatch = text.match(
			/(?:website|site|portfolio)[:\s]+(https?:\/\/[^\s)<>]+)/i,
		);
		return {
			emails,
			email: emails[0] || null,
			phones,
			phone: phones[0] || null,
			xHandle: x.handle || null,
			xUrl: x.url || null,
			linkedinHandle: li.handle || null,
			linkedinUrl: li.url || null,
			website: websiteMatch?.[1]
				? normalizeUrl(websiteMatch[1])
				: /linkedin\.com|x\.com|twitter\.com/i.test(target)
					? null
					: target,
			enrichedFrom: target,
		};
	} catch (err) {
		return { enrichError: err?.message || String(err) };
	}
}

/**
 * LLM orchestrator — score + normalize investor records.
 */
export async function scoreInvestorsWithLlm(investors, opts = {}) {
	if (!investors.length) return [];

	const { content } = await openRouterChat({
		model: opts.model || DEFAULT_MODEL,
		jsonMode: true,
		temperature: 0.2,
		maxTokens: 3500,
		messages: [
			{
				role: "system",
				content: `You score angel / seed investors for founders raising capital.

Target: angels and seed investors who write cheques in tech, AI, SaaS, food/agri, deep tech, indie hackers / bootstrappers.

Score 1-5:
5 = clear angel/seed who writes cheques in our sectors (active, public signal)
4 = likely angel/seed with good fit
3 = maybe / unclear stage
1-2 = VC partner only, accelerator employee, spam list, or not an investor

For each investor return:
- id (same as input)
- score (1-5)
- reason (short)
- name (cleaned if needed)
- checkSize (guess like "$5k-$25k" or "unknown")
- sectors (string array from: AI, SaaS, deep tech, food, agriculture, indie, fintech, climate, general)
- draftMessage: ONE friendly founder-to-angel line (not spammy)
- investorType: "angel" | "seed" | "micro-vc" | "unknown"

Return ONLY JSON:
{ "results": [{ "id": "", "score": 0, "reason": "", "name": "", "checkSize": "", "sectors": [], "draftMessage": "", "investorType": "" }] }
Include every id from input.`,
			},
			{
				role: "user",
				content: JSON.stringify(
					investors.map((inv) => ({
						id: inv.id || investorDocId(inv),
						name: inv.name,
						title: inv.title,
						snippet: inv.snippet,
						sourcePlatform: inv.sourcePlatform,
						sector: inv.sector,
						xUrl: inv.xUrl,
						linkedinUrl: inv.linkedinUrl,
						website: inv.website,
						emails: inv.emails || [],
						phones: inv.phones || [],
					})),
				),
			},
		],
	});

	try {
		const raw = parseJsonFromLLM(content);
		return Array.isArray(raw.results) ? raw.results : [];
	} catch (err) {
		console.error("[angel] score parse failed:", err?.message);
		return investors.map((inv) => ({
			id: inv.id || investorDocId(inv),
			score: 0,
			reason: "llm_parse_failed",
			draftMessage: "",
			investorType: "unknown",
			sectors: [],
			checkSize: "unknown",
		}));
	}
}

export async function listInvestors(
	collection = ANGEL_AGENT.collection,
	{ minScore = 0, platform, limit = 100 } = {},
) {
	const snap = await firestore
		.collection(collection)
		.where("relevanceScore", ">=", minScore)
		.get();
	let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	if (platform) {
		const p = String(platform).toLowerCase();
		rows = rows.filter(
			(r) => String(r.sourcePlatform || "").toLowerCase() === p,
		);
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
