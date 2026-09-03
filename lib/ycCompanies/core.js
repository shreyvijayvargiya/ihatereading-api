/**
 * YC companies core — hash dedupe, Firestore, LLM synthesis.
 */

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { scrapeUrl } from "../scrapefast.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import { JUNK_HOST_RE, JUNK_NAME_RE, YC_AGENT } from "./configs.js";

export const DEFAULT_MODEL =
	process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const YC_COMPANY_PATH = /ycombinator\.com\/companies\/([a-z0-9-]+)/i;

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

export function normalizeName(name) {
	return String(name || "")
		.trim()
		.replace(/\s+/g, " ")
		.slice(0, 120);
}

export function slugFromYcUrl(url) {
	const m = String(url || "").match(YC_COMPANY_PATH);
	return m ? m[1].toLowerCase() : null;
}

export function companyDocId(company) {
	const slug =
		company.slug ||
		slugFromYcUrl(company.ycUrl) ||
		slugFromYcUrl(company.sourceUrl);
	const key =
		slug ||
		company.ycUrl ||
		company.website ||
		`${normalizeName(company.name).toLowerCase()}|${company.batch || ""}`;
	return createHash("sha256")
		.update(String(key).toLowerCase().trim())
		.digest("hex")
		.slice(0, 32);
}

export function seenKey(company) {
	const slug =
		company.slug ||
		slugFromYcUrl(company.ycUrl) ||
		slugFromYcUrl(company.sourceUrl);
	if (slug) return `slug:${slug}`;
	if (company.ycUrl) return `yc:${normalizeUrl(company.ycUrl)}`;
	if (company.website) return `web:${normalizeUrl(company.website)}`;
	return `name:${normalizeName(company.name).toLowerCase()}|${String(company.batch || "").toLowerCase()}`;
}

/** Reject listicles / directory sites / non-company titles */
export function isJunkCandidate(company) {
	const name = normalizeName(company.name);
	if (!name || name.length < 2) return true;
	if (JUNK_NAME_RE.test(name)) return true;
	const hosts = [company.website, company.sourceUrl, company.ycUrl]
		.filter(Boolean)
		.map((u) => {
			try {
				return new URL(normalizeUrl(u)).hostname;
			} catch {
				return "";
			}
		});
	if (hosts.some((h) => JUNK_HOST_RE.test(h))) return true;
	// Must look like a real company: prefer YC slug/url
	const hasYc =
		Boolean(company.slug) ||
		Boolean(slugFromYcUrl(company.ycUrl)) ||
		Boolean(slugFromYcUrl(company.sourceUrl));
	if (!hasYc && company.sourceType === "google-discover") return true;
	return false;
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
			e.includes("wixpress") ||
			e.includes("noreply")
		)
			continue;
		set.add(e);
	}
	return [...set];
}

export function guessWebsiteFromText(text, fallback = null) {
	const m = String(text || "").match(
		/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.(?:com|io|ai|co|app|dev|net|org|so|xyz))(?:\/[^\s)<>]*)?/i,
	);
	if (!m) return fallback;
	const host = m[1].toLowerCase();
	if (
		JUNK_HOST_RE.test(host) ||
		/ycombinator|news\.ycombinator|linkedin|twitter|x\.com|facebook|crunchbase/i.test(
			host,
		)
	)
		return fallback;
	return normalizeUrl(`https://${host}`);
}

export function mapYcStatus(raw) {
	const s = String(raw || "").trim();
	const lower = s.toLowerCase();
	if (lower === "active") return "Active";
	if (lower === "inactive") return "Inactive";
	if (lower === "acquired") return "Acquired";
	if (lower === "public") return "Public";
	if (/shut|dead/i.test(lower)) return "shutdown";
	if (/reject/i.test(lower)) return "rejected";
	if (s) return s;
	return "unknown";
}

export function normalizeBatch(raw) {
	const s = String(raw || "").trim();
	if (!s) return null;
	// "Winter 2025" → "W25", "W25" stays
	const short = s.match(/^([WS])(\d{2})$/i);
	if (short) return `${short[1].toUpperCase()}${short[2]}`;
	const long = s.match(/^(Winter|Summer|Fall|Spring)\s+20(\d{2})$/i);
	if (long) {
		const letter = /^Winter/i.test(long[1])
			? "W"
			: /^Summer/i.test(long[1])
				? "S"
				: /^Fall/i.test(long[1])
					? "F"
					: "P";
		return `${letter}${long[2]}`;
	}
	return s;
}

/**
 * Map a yc-oss / Algolia-style hit into our company shape.
 */
export function candidateFromYcRecord(row, meta = {}) {
	const slug = String(row.slug || "").toLowerCase();
	const name = normalizeName(row.name);
	if (!slug || !name) return null;
	const ycUrl =
		row.url ||
		(slug ? `https://www.ycombinator.com/companies/${slug}` : null);
	const industries = Array.isArray(row.industries)
		? row.industries
		: row.industry
			? [row.industry]
			: [];
	return {
		slug,
		name,
		ycUrl: normalizeUrl(ycUrl),
		website: row.website ? normalizeUrl(row.website) : null,
		sourceUrl: normalizeUrl(ycUrl),
		sourceType: meta.sourceType || "yc-oss",
		statusHint: mapYcStatus(row.status || meta.statusHint),
		status: mapYcStatus(row.status || meta.statusHint),
		batch: normalizeBatch(row.batch || meta.batch),
		batchRaw: row.batch || null,
		oneLiner: row.one_liner || row.oneLiner || "",
		longDescription: row.long_description || row.longDescription || "",
		snippet: row.one_liner || row.long_description || "",
		industry: row.industry || industries[0] || null,
		industries,
		subindustry: row.subindustry || null,
		tags: Array.isArray(row.tags) ? row.tags : [],
		teamSize: row.team_size ?? row.teamSize ?? null,
		isHiring: Boolean(row.isHiring),
		address: row.all_locations || row.locations || null,
		regions: Array.isArray(row.regions) ? row.regions : [],
		stage: row.stage || null,
		logoUrl: row.small_logo_thumb_url || row.logoUrl || null,
		founders: Array.isArray(row.founders)
			? row.founders.map((f) => (typeof f === "string" ? f : f?.name)).filter(Boolean)
			: [],
		emails: [],
		email: null,
		investmentAmount: null,
		valuation: null,
		jobs: [],
		ycId: row.id ?? null,
	};
}

export async function companyExists(collection, company) {
	const id = companyDocId(company);
	const snap = await firestore.collection(collection).doc(id).get();
	return snap.exists;
}

export async function saveCompany(collection, company) {
	const id = companyDocId(company);
	const { createdAt: _ca, ...rest } = company;
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

export async function loadSourceCursor(stateCollection, agentId) {
	const snap = await firestore.collection(stateCollection).doc(agentId).get();
	if (!snap.exists) return { sourceIndex: 0, feedOffset: 0 };
	const data = snap.data() || {};
	return {
		sourceIndex: Number(data.lastSourceIndex) || 0,
		feedOffset: Number(data.feedOffset) || 0,
	};
}

export async function saveSourceCursor(stateCollection, agentId, patch) {
	await firestore
		.collection(stateCollection)
		.doc(agentId)
		.set(
			{
				agentId,
				lastSourceIndex: patch.sourceIndex ?? 0,
				feedOffset: patch.feedOffset ?? 0,
				updatedAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
}

export async function scrapePage(url, baseUrl) {
	const target = normalizeUrl(url);
	if (!target) return { markdown: "", title: "", links: [], html: "", error: "empty_url" };
	try {
		const row = await scrapeUrl(target, {
			baseUrl,
			timeoutMs: 60_000,
			includeImages: false,
		});
		return {
			markdown: String(row.markdown || "").slice(0, 50_000),
			title: row.title || row.data?.title || "",
			links: Array.isArray(row.data?.links) ? row.data.links : row.links || [],
			html: String(row.html || row.data?.html || "").slice(0, 80_000),
			url: target,
		};
	} catch (err) {
		return {
			markdown: "",
			title: "",
			links: [],
			html: "",
			url: target,
			error: err?.message || String(err),
		};
	}
}

/**
 * Score 1-5 from how complete the company record is (for UI SCORE column).
 */
export function computeConfidence(company) {
	let score = 1;
	if (company.ycUrl || company.slug) score += 1;
	if (company.website) score += 1;
	if (company.oneLiner || company.longDescription) score += 0.5;
	if (company.industry || (company.industries || []).length) score += 0.5;
	if ((company.founders || []).length) score += 0.5;
	if (company.isHiring || (company.jobs || []).length) score += 0.5;
	if (company.email || (company.emails || []).length) score += 0.5;
	if (company.teamSize) score += 0.25;
	if (company.address) score += 0.25;
	return Math.max(1, Math.min(5, Math.round(score)));
}

export async function synthesizeCompaniesWithLlm(companies, opts = {}) {
	if (!companies.length) return [];

	const { content } = await openRouterChat({
		model: opts.model || DEFAULT_MODEL,
		jsonMode: true,
		temperature: 0.1,
		maxTokens: 4500,
		messages: [
			{
				role: "system",
				content: `You clean and complete REAL Y Combinator startup company records.

Rules:
- Only real companies (Stripe, Airbnb, CircuitHub-style). Reject directory sites / listicles — set reject:true for those.
- Prefer input facts; do NOT invent emails, valuations, funding, or addresses.
- status: Active | Inactive | Acquired | Public | shutdown | rejected | unknown
- industry: real industry string (SaaS, Fintech, Industrials…) — NEVER a batch code like W25
- batch: short form like W25 / S24 when known
- isHiring: boolean
- jobs: short list of open role titles if present
- confidence 1-5 based on data quality

Return ONLY JSON:
{
  "results": [{
    "id": "",
    "reject": false,
    "name": "",
    "status": "",
    "batch": "" | null,
    "oneLiner": "",
    "industry": "" | null,
    "industries": [],
    "founders": [],
    "isHiring": false,
    "jobs": [],
    "teamSize": null,
    "investmentAmount": null,
    "valuation": null,
    "email": null,
    "emails": [],
    "website": null,
    "address": null,
    "ycUrl": null,
    "summary": "",
    "confidence": 1
  }]
}
Include every id.`,
			},
			{
				role: "user",
				content: JSON.stringify(
					companies.map((c) => ({
						id: c.id || companyDocId(c),
						name: c.name,
						slug: c.slug,
						status: c.status || c.statusHint,
						batch: c.batch,
						oneLiner: c.oneLiner,
						industry: c.industry,
						industries: c.industries,
						ycUrl: c.ycUrl,
						website: c.website,
						isHiring: c.isHiring,
						teamSize: c.teamSize,
						jobs: c.jobs,
						founders: c.founders,
						emails: c.emails,
						address: c.address,
						investmentAmount: c.investmentAmount,
						valuation: c.valuation,
						longDescription: String(c.longDescription || "").slice(0, 1500),
						enrichmentText: String(c.enrichmentText || "").slice(0, 2500),
					})),
				),
			},
		],
	});

	try {
		const raw = parseJsonFromLLM(content);
		return Array.isArray(raw.results) ? raw.results : [];
	} catch (err) {
		console.error("[yc] LLM synthesize parse failed:", err?.message);
		return companies.map((c) => ({
			id: c.id || companyDocId(c),
			reject: false,
			name: c.name,
			status: c.status || c.statusHint || "unknown",
			batch: c.batch || null,
			oneLiner: c.oneLiner || "",
			industry: c.industry || null,
			industries: c.industries || [],
			founders: c.founders || [],
			isHiring: Boolean(c.isHiring),
			jobs: c.jobs || [],
			teamSize: c.teamSize ?? null,
			investmentAmount: c.investmentAmount || null,
			valuation: c.valuation || null,
			email: c.email || null,
			emails: c.emails || [],
			website: c.website || null,
			address: c.address || null,
			ycUrl: c.ycUrl || null,
			summary: c.oneLiner || c.snippet || "",
			confidence: computeConfidence(c),
			reason: "llm_parse_failed",
		}));
	}
}

export async function listCompanies(
	collection = YC_AGENT.collection,
	{ status, hiring, limit = 100, minConfidence = 0 } = {},
) {
	const snap = await firestore.collection(collection).get();
	let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	if (status) {
		const s = String(status).toLowerCase();
		rows = rows.filter((r) => String(r.status || "").toLowerCase() === s);
	}
	if (hiring === true || hiring === "true" || hiring === "1") {
		rows = rows.filter((r) => r.isHiring === true);
	}
	if (minConfidence > 0) {
		rows = rows.filter((r) => Number(r.confidence || r.score || 0) >= minConfidence);
	}
	rows.sort((a, b) => {
		const ca = Number(a.confidence || a.score) || 0;
		const cb = Number(b.confidence || b.score) || 0;
		if (cb !== ca) return cb - ca;
		return (
			new Date(b.fetchedAt || b.updatedAt || 0).getTime() -
			new Date(a.fetchedAt || a.updatedAt || 0).getTime()
		);
	});
	return rows.slice(0, limit);
}
