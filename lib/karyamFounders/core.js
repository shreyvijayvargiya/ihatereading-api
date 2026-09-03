/**
 * Karyam founder lead core — extract contacts, classify roles, Firestore.
 */

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import { KARYAM_AGENT, KARYAM_PITCH } from "./configs.js";

export const DEFAULT_MODEL =
	process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE =
	/(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}/g;
const X_HANDLE_RE =
	/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i;
const LI_PERSON_RE =
	/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([A-Za-z0-9_-]+)/i;
const LI_COMPANY_RE =
	/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/company\/([A-Za-z0-9_-]+)/i;
const IG_RE =
	/(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)/i;
const MAILTO_RE = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;

const JUNK_EMAIL =
	/example\.com|sentry|wixpress|noreply|no-reply|donotreply|privacy@|legal@|webmaster@|\.png$|\.jpg$|\.gif$|\.webp$|godaddy|cloudflare|schema\.org|w3\.org|github\.com|googlemail\.invalid/i;

export const JUNK_HOST_RE =
	/wikipedia\.|wikimedia\.|pinterest\.|quora\.|tiktok\.|youtube\.com|youtu\.be|facebook\.com|instagram\.com|threads\.net|reddit\.com|news\.ycombinator|indeed\.com|glassdoor\.|ambitionbox\.|levels\.fyi|stackoverflow\.|github\.com\/topics|medium\.com\/tag|forbes\.com|techcrunch\.com\/tag|gmail\.com|google\.com|bing\.com|yahoo\.com|duckduckgo/i;

const CONTACT_PATH_RE =
	/\/(contact|contact-us|about|about-us|team|our-team|founders|people|company|imprint|legal|careers|jobs)(\/|$|\.html?)/i;

export function createSeenMap() {
	return new Map();
}

export function normalizeUrl(raw) {
	const s = String(raw || "").trim();
	if (!s) return "";
	try {
		const u = new URL(s.startsWith("http") ? s : `https://${s}`);
		u.hash = "";
		if (u.pathname === "/") u.pathname = "";
		return u.href.replace(/\/$/, "");
	} catch {
		return s;
	}
}

export function hostnameOf(raw) {
	try {
		return new URL(normalizeUrl(raw)).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return "";
	}
}

export function isJunkHost(url) {
	const host = hostnameOf(url);
	if (!host) return true;
	return JUNK_HOST_RE.test(host);
}

export function leadDocId(lead) {
	const key =
		lead.website ||
		lead.linkedinUrl ||
		lead.email ||
		lead.sourceUrl ||
		`${lead.company || ""}|${lead.name || ""}`;
	return createHash("sha256")
		.update(String(key).toLowerCase().trim())
		.digest("hex")
		.slice(0, 32);
}

export function seenKey(lead) {
	if (lead.website) return `web:${hostnameOf(lead.website)}`;
	if (lead.linkedinHandle) return `li:${String(lead.linkedinHandle).toLowerCase()}`;
	if (lead.email) return `email:${String(lead.email).toLowerCase()}`;
	if (lead.sourceUrl) return `url:${normalizeUrl(lead.sourceUrl)}`;
	return `name:${String(lead.company || lead.name || "").toLowerCase()}`;
}

export function extractEmails(text) {
	const set = new Set();
	for (const m of String(text || "").match(EMAIL_RE) || []) {
		const e = m.toLowerCase();
		if (JUNK_EMAIL.test(e)) continue;
		set.add(e);
	}
	for (const m of String(text || "").matchAll(MAILTO_RE)) {
		const e = String(m[1] || "").toLowerCase();
		if (e && !JUNK_EMAIL.test(e)) set.add(e);
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
	return [...set].slice(0, 4);
}

export function extractX(text, url) {
	const fromUrl = String(url || "").match(X_HANDLE_RE);
	if (fromUrl) return { handle: fromUrl[1], url: `https://x.com/${fromUrl[1]}` };
	const fromText = String(text || "").match(X_HANDLE_RE);
	if (fromText) return { handle: fromText[1], url: `https://x.com/${fromText[1]}` };
	return { handle: "", url: "" };
}

export function extractLinkedIn(text, url) {
	const fromUrl = String(url || "").match(LI_PERSON_RE);
	if (fromUrl) {
		return {
			handle: fromUrl[1],
			url: `https://www.linkedin.com/in/${fromUrl[1]}`,
			companyHandle: "",
			companyUrl: "",
		};
	}
	const person = String(text || "").match(LI_PERSON_RE);
	const company = String(text || "").match(LI_COMPANY_RE);
	return {
		handle: person?.[1] || "",
		url: person?.[1] ? `https://www.linkedin.com/in/${person[1]}` : "",
		companyHandle: company?.[1] || "",
		companyUrl: company?.[1]
			? `https://www.linkedin.com/company/${company[1]}`
			: "",
	};
}

export function extractInstagram(text) {
	const m = String(text || "").match(IG_RE);
	if (!m) return { handle: "", url: "" };
	const handle = m[1];
	if (/p|reel|stories/i.test(handle)) return { handle: "", url: "" };
	return { handle, url: `https://www.instagram.com/${handle}` };
}

export function classifyEmail(email) {
	const local = String(email || "")
		.split("@")[0]
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
	if (/^(founder|cofounder|ceo|owner|hello|hi|hey)$/.test(local)) return "founder";
	if (/^(cto|tech|engineering|dev|developer)$/.test(local)) return "cto";
	if (/^(hr|careers|jobs|talent|people|recruiting)$/.test(local)) return "hr";
	if (/^(sales|partnerships|bd|bizdev)$/.test(local)) return "sales";
	if (/^(info|contact|support|admin|office|team|mail)$/.test(local)) return "generic";
	if (/^[a-z]{2,}\.?[a-z]{2,}$/.test(local) || /^[a-z]+\.[a-z]+$/.test(String(email || "").split("@")[0])) {
		return "person";
	}
	return "generic";
}

export function pickRoleEmails(emails) {
	const classified = (emails || []).map((e) => ({ email: e, role: classifyEmail(e) }));
	const first = (role) => classified.find((c) => c.role === role)?.email || null;
	return {
		founderEmail: first("founder") || first("person") || null,
		ctoEmail: first("cto") || null,
		hrEmail: first("hr") || null,
		salesEmail: first("sales") || null,
		genericEmail: first("generic") || null,
		email:
			first("founder") ||
			first("person") ||
			first("cto") ||
			first("sales") ||
			first("generic") ||
			emails?.[0] ||
			null,
		emailRoles: classified,
	};
}

export function guessNameFromTitle(title) {
	const t = String(title || "")
		.replace(/\s*[|\-–—].*$/, "")
		.replace(/\s*on\s+(X|Twitter|LinkedIn).*$/i, "")
		.replace(/\(@[^)]+\)/g, "")
		.trim();
	if (!t || t.length > 90) return "";
	return t;
}

export function guessCompanyFromHost(url) {
	const host = hostnameOf(url);
	if (!host) return "";
	const parts = host.split(".");
	const name = parts.length > 2 ? parts[parts.length - 2] : parts[0];
	if (!name || name.length < 2) return "";
	return name.charAt(0).toUpperCase() + name.slice(1);
}

export function hrefOfLink(item) {
	if (!item) return "";
	if (typeof item === "string") return item;
	return item.href || item.url || "";
}

export function extractLinks(row) {
	const raw = Array.isArray(row?.data?.links)
		? row.data.links
		: Array.isArray(row?.links)
			? row.links
			: [];
	return raw.map(hrefOfLink).filter(Boolean);
}

/**
 * Same-domain contact / about / team pages for nested scrape.
 */
export function pickNestedContactUrls(links, pageUrl, limit = 3) {
	const origin = (() => {
		try {
			return new URL(normalizeUrl(pageUrl)).origin;
		} catch {
			return "";
		}
	})();
	const out = [];
	const seen = new Set();
	for (const href of links) {
		if (out.length >= limit) break;
		let abs = "";
		try {
			abs = new URL(href, origin || undefined).href;
		} catch {
			continue;
		}
		const norm = normalizeUrl(abs);
		if (!norm || seen.has(norm)) continue;
		if (origin && hostnameOf(norm) !== hostnameOf(origin)) continue;
		if (!CONTACT_PATH_RE.test(norm) && !/contact|about|team|founder/i.test(norm)) {
			continue;
		}
		seen.add(norm);
		out.push(norm);
	}
	return out;
}

/**
 * Company / profile URLs from a listicle or directory page.
 */
export function pickOutboundCompanyUrls(links, pageUrl, limit = 5) {
	const pageHost = hostnameOf(pageUrl);
	const out = [];
	const seen = new Set();
	for (const href of links) {
		if (out.length >= limit) break;
		let abs = "";
		try {
			abs = new URL(href, pageUrl).href;
		} catch {
			continue;
		}
		const host = hostnameOf(abs);
		if (!host || host === pageHost) continue;
		if (isJunkHost(abs)) continue;
		if (seen.has(host)) continue;
		seen.add(host);
		out.push(normalizeUrl(abs));
	}
	return out;
}

export function mergeContacts(base, extra) {
	const emails = [
		...new Set([...(base.emails || []), ...(extra.emails || [])]),
	];
	const phones = [
		...new Set([...(base.phones || []), ...(extra.phones || [])]),
	].slice(0, 4);
	const roles = pickRoleEmails(emails);
	return {
		...base,
		...roles,
		emails,
		phones,
		phone: base.phone || extra.phone || phones[0] || null,
		xHandle: base.xHandle || extra.xHandle || null,
		xUrl: base.xUrl || extra.xUrl || null,
		linkedinHandle: base.linkedinHandle || extra.linkedinHandle || null,
		linkedinUrl: base.linkedinUrl || extra.linkedinUrl || null,
		linkedinCompanyUrl:
			base.linkedinCompanyUrl || extra.linkedinCompanyUrl || null,
		instagramHandle: base.instagramHandle || extra.instagramHandle || null,
		instagramUrl: base.instagramUrl || extra.instagramUrl || null,
		website: base.website || extra.website || null,
		name: base.name || extra.name || "",
		company: base.company || extra.company || "",
		enrichedFrom: [
			...new Set(
				[...(base.enrichedFrom || []), extra.enrichedFrom].filter(Boolean),
			),
		],
	};
}

export function contactsFromText(text, pageUrl) {
	const emails = extractEmails(text);
	const phones = extractPhones(text);
	const x = extractX(text, pageUrl);
	const li = extractLinkedIn(text, pageUrl);
	const ig = extractInstagram(text);
	const roles = pickRoleEmails(emails);
	const hostSite = !/linkedin\.com|x\.com|twitter\.com/i.test(pageUrl || "")
		? normalizeUrl(pageUrl)
		: null;
	return {
		...roles,
		emails,
		phones,
		phone: phones[0] || null,
		xHandle: x.handle || null,
		xUrl: x.url || null,
		linkedinHandle: li.handle || null,
		linkedinUrl: li.url || null,
		linkedinCompanyUrl: li.companyUrl || null,
		instagramHandle: ig.handle || null,
		instagramUrl: ig.url || null,
		website: hostSite,
		enrichedFrom: pageUrl ? [normalizeUrl(pageUrl)] : [],
	};
}

export function candidateFromSerp(row, meta = {}) {
	const url = normalizeUrl(row.url || row.link);
	const title = String(row.title || "").trim();
	const snippet = String(row.snippet || "").trim();
	const blob = `${title}\n${snippet}\n${url}`;
	const contacts = contactsFromText(blob, url);
	const isLi = /linkedin\.com/i.test(url);
	const isX = /x\.com|twitter\.com/i.test(url);

	return {
		name: guessNameFromTitle(title) || contacts.linkedinHandle || contacts.xHandle || "",
		company:
			(!isLi && !isX ? guessCompanyFromHost(url) : "") ||
			guessNameFromTitle(title) ||
			"",
		title,
		snippet,
		sourceUrl: url,
		sourcePlatform: isLi ? "linkedin" : isX ? "x" : "google",
		intent: meta.intent || null,
		searchQuery: meta.query || null,
		queryId: meta.queryId || null,
		country: meta.country || null,
		website: contacts.website,
		...contacts,
		role: "unknown",
		outreachStatus: "new",
	};
}

export async function leadExists(collection, candidate) {
	const id = leadDocId(candidate);
	const snap = await firestore.collection(collection).doc(id).get();
	return snap.exists;
}

export async function saveLead(collection, lead) {
	const id = leadDocId(lead);
	const { createdAt: _ca, ...rest } = lead;
	const plain = JSON.parse(JSON.stringify({ ...rest, id }));
	const ref = firestore.collection(collection).doc(id);
	const existing = await ref.get();
	plain.updatedAt = new Date().toISOString();
	if (!existing.exists) {
		plain.createdAt = FieldValue.serverTimestamp();
		plain.createdAtIso = new Date().toISOString();
	}
	await ref.set(plain, { merge: true });
	return id;
}

export async function getLead(collection, id) {
	const snap = await firestore.collection(collection).doc(String(id)).get();
	if (!snap.exists) return null;
	return { id: snap.id, ...snap.data() };
}

export async function loadQueryCursor(stateCollection, agentId) {
	const snap = await firestore.collection(stateCollection).doc(agentId).get();
	if (!snap.exists) return { lastQueryIndex: 0, querySetVersion: 0 };
	const data = snap.data() || {};
	return {
		lastQueryIndex: Number(data.lastQueryIndex) || 0,
		querySetVersion: Number(data.querySetVersion) || 0,
	};
}

export async function saveQueryCursor(stateCollection, agentId, index, version) {
	await firestore
		.collection(stateCollection)
		.doc(agentId)
		.set(
			{
				agentId,
				lastQueryIndex: index,
				querySetVersion: version,
				updatedAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
}

export async function scoreLeadsWithLlm(leads, opts = {}) {
	if (!leads.length) return [];

	const { content } = await openRouterChat({
		model: opts.model || DEFAULT_MODEL,
		jsonMode: true,
		temperature: 0.25,
		maxTokens: 4000,
		messages: [
			{
				role: "system",
				content: `You score B2B founder / operator leads for karyam.xyz outreach.

${KARYAM_PITCH}

Score 1-5:
5 = clear founder/owner/CTO who likely needs custom software, AI agents, apps, CRM, automations, or scraping
4 = strong fit (SaaS / agency-buyers / indie builders)
3 = maybe / unclear role
1-2 = job seeker, recruiter spam, listicle, student, or not a buyer

For each lead return:
- id (same as input)
- score (1-5)
- reason (short)
- name (cleaned person name if possible)
- company (cleaned)
- role: "founder" | "ceo" | "cto" | "owner" | "solo" | "creator" | "hr" | "unknown"
- suggestedOffer: one karyam service that fits
- draftSubject: short email subject
- draftMessage: 4-7 sentence founder-to-founder email. Not spammy. Mention karyam.xyz once. Offer a specific next step. Sign off as Karyam.

Return ONLY JSON:
{ "results": [{ "id": "", "score": 0, "reason": "", "name": "", "company": "", "role": "", "suggestedOffer": "", "draftSubject": "", "draftMessage": "" }] }
Include every id from input.`,
			},
			{
				role: "user",
				content: JSON.stringify(
					leads.map((lead) => ({
						id: lead.id || leadDocId(lead),
						name: lead.name,
						company: lead.company,
						title: lead.title,
						snippet: lead.snippet,
						intent: lead.intent,
						website: lead.website,
						linkedinUrl: lead.linkedinUrl,
						emails: lead.emails || [],
						founderEmail: lead.founderEmail,
						ctoEmail: lead.ctoEmail,
						hrEmail: lead.hrEmail,
						phone: lead.phone,
					})),
				),
			},
		],
	});

	try {
		const raw = parseJsonFromLLM(content);
		return Array.isArray(raw.results) ? raw.results : [];
	} catch (err) {
		console.error("[karyam-founders] score parse failed:", err?.message);
		return leads.map((lead) => ({
			id: lead.id || leadDocId(lead),
			score: 0,
			reason: "llm_parse_failed",
			draftSubject: "",
			draftMessage: "",
			role: "unknown",
			suggestedOffer: "",
		}));
	}
}

export async function listLeads(
	collection = KARYAM_AGENT.collection,
	{ minScore = 0, intent, hasEmail, outreachStatus, limit = 100 } = {},
) {
	let rows = [];
	try {
		const snap = await firestore
			.collection(collection)
			.where("relevanceScore", ">=", minScore)
			.get();
		rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	} catch {
		const snap = await firestore.collection(collection).limit(500).get();
		rows = snap.docs
			.map((d) => ({ id: d.id, ...d.data() }))
			.filter((r) => (Number(r.relevanceScore) || 0) >= minScore);
	}
	if (intent) {
		const i = String(intent).toLowerCase();
		rows = rows.filter((r) => String(r.intent || "").toLowerCase() === i);
	}
	if (hasEmail === true) {
		rows = rows.filter((r) =>
			Boolean(r.email || r.founderEmail || r.ctoEmail || r.hrEmail),
		);
	}
	if (outreachStatus) {
		const s = String(outreachStatus).toLowerCase();
		rows = rows.filter(
			(r) => String(r.outreachStatus || "new").toLowerCase() === s,
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

export function bestEmail(lead) {
	return (
		lead?.founderEmail ||
		lead?.email ||
		lead?.ctoEmail ||
		lead?.salesEmail ||
		lead?.genericEmail ||
		lead?.hrEmail ||
		(Array.isArray(lead?.emails) ? lead.emails[0] : null) ||
		null
	);
}
