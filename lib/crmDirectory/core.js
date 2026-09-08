/**
 * CRM directory core — domain hash, Firestore, URL helpers.
 */

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { firecrawlScrape } from "../contentResearch/http.js";
import { scrapeUrl } from "../scrapefast.js";
import { CRM_AGENT, DIRECTORY_HOST_RE, JUNK_HOST_RE } from "./configs.js";

export function createSeenMap() {
	return new Map();
}

export function normalizeUrl(raw) {
	const s = String(raw || "").trim();
	if (!s) return "";
	try {
		const u = new URL(s.startsWith("http") ? s : `https://${s}`);
		if (u.protocol !== "http:" && u.protocol !== "https:") return "";
		u.hash = "";
		u.hostname = u.hostname.replace(/^www\./, "").toLowerCase();
		["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "fbclid"].forEach(
			(k) => u.searchParams.delete(k),
		);
		if (!u.search) u.search = "";
		return `${u.protocol}//${u.hostname}${u.pathname.replace(/\/+$/, "") || ""}${u.search}`.replace(
			/\/$/,
			"",
		);
	} catch {
		return "";
	}
}

export function domainOf(url) {
	try {
		return new URL(normalizeUrl(url) || url).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return "";
	}
}

/** Company root host: hubspot.com from product.hubspot.com (keeps .co.uk). */
export function registrableDomain(urlOrHost) {
	const host = (domainOf(urlOrHost) || String(urlOrHost || "").replace(/^www\./, "")).toLowerCase();
	if (!host || !host.includes(".")) return host;
	if (/\.(co\.uk|com\.au|co\.in|com\.br|co\.jp|co\.za|com\.mx)$/.test(host)) {
		return host.split(".").slice(-3).join(".");
	}
	const parts = host.split(".");
	if (parts.length <= 2) return host;
	return parts.slice(-2).join(".");
}

export function originOf(url) {
	const host = registrableDomain(url);
	return host ? `https://${host}` : "";
}

export function crmDocId(crm) {
	const key = registrableDomain(crm.website || crm.domain) || String(crm.name || "").toLowerCase();
	return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export function seenKey(crm) {
	const d = registrableDomain(crm.website || crm.domain);
	return d ? `host:${d}` : `name:${String(crm.name || "").toLowerCase()}`;
}

export function isDirectoryHost(url) {
	const host = domainOf(url);
	const root = registrableDomain(url);
	return DIRECTORY_HOST_RE.test(host || url) || DIRECTORY_HOST_RE.test(root || "");
}

export function isJunkHost(url) {
	const host = domainOf(url);
	const root = registrableDomain(url);
	if (!host && !root) return true;
	if (JUNK_HOST_RE.test(host) || JUNK_HOST_RE.test(root)) return true;
	if (DIRECTORY_HOST_RE.test(host) || DIRECTORY_HOST_RE.test(root)) return true;
	return false;
}

export function nameFromHost(host) {
	const h = String(host || "")
		.replace(/^www\./, "")
		.split(".")[0];
	if (!h) return "";
	return h
		.replace(/[-_]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.slice(0, 80);
}

export function nameFromTitle(title, host) {
	let t = String(title || "")
		.replace(/\s*[|\-–—:].*$/, "")
		.replace(/\s+(CRM|Software|App|Platform|Inc\.?|LLC)\s*$/i, "")
		.replace(/^(Best|Top|\d+\s+Best)\s+/i, "")
		.trim();
	if (t.length < 2 || t.length > 60 || /crm software|best crm|list of/i.test(t)) {
		return nameFromHost(host);
	}
	return t.slice(0, 80);
}

export function looksLikeCrmText(text) {
	return /\bcrm\b|customer relationship|sales pipeline|contact management|lead management/i.test(
		String(text || ""),
	);
}

/** Review roundups / comparison articles — scrape for outbound product sites, do not store as CRMs. */
export function looksLikeListPage(url, title = "") {
	if (isDirectoryHost(url)) return true;
	const blob = `${title} ${url}`;
	if (
		/best crm|top crm|crm software list|crm comparison|crm alternatives|list of crm|crm vendors|best .{0,50}crm|top \d*.{0,40}crm/i.test(
			blob,
		)
	) {
		return true;
	}
	try {
		const path = new URL(normalizeUrl(url) || url).pathname || "";
		if (/\/(best-|top-\d|comparison|alternatives|list-of|roundup|versus)/i.test(path)) return true;
		if (/\/(blog|articles?|resources?|guides?)\/.+/i.test(path) && looksLikeCrmText(`${title} ${path}`)) {
			return true;
		}
	} catch {
		/* ignore */
	}
	return false;
}

const BRAND_STOP = new Set(
	"best top free open source small business enterprise software system systems vendor vendors tool tools platform platforms comparison list guide review reviews alternative alternatives customer relationship management cloud sales marketing the and for with your this that from new official website".split(
		" ",
	),
);

export function extractCrmBrands(text) {
	const names = [];
	const seen = new Set();
	const add = (raw) => {
		const n = String(raw || "")
			.replace(/\s+/g, " ")
			.trim();
		if (n.length < 2 || n.length > 40) return;
		if (BRAND_STOP.has(n.toLowerCase())) return;
		if (/^\d+$/.test(n)) return;
		const k = n.toLowerCase();
		if (seen.has(k)) return;
		seen.add(k);
		names.push(n);
	};
	const s = String(text || "");
	for (const m of s.matchAll(
		/\b([A-Z][A-Za-z0-9&.+-]{1,28}(?:\s+[A-Z][A-Za-z0-9&.+-]{1,20}){0,2})\s+CRM\b/g,
	)) {
		add(m[1]);
	}
	return names;
}

export function extractProductUrlsFromText(text) {
	const urls = [];
	for (const m of String(text || "").matchAll(/https?:\/\/[^\s)\]>'"]+/gi)) {
		urls.push(m[0].replace(/[.,;]+$/, ""));
	}
	for (const m of String(text || "").matchAll(
		/\b(?:www\.)?([a-z0-9][a-z0-9-]{1,40}\.(?:com|io|ai|net|app|org))\b/gi,
	)) {
		urls.push(`https://${m[1]}`);
	}
	return urls;
}

const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export function linksFromHtml(html, pageUrl) {
	const out = [];
	for (const m of String(html || "").matchAll(
		/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
	)) {
		let href = m[1];
		try {
			href = new URL(href, pageUrl).href;
		} catch {
			continue;
		}
		const text = String(m[2] || "")
			.replace(/<[^>]+>/g, "")
			.replace(/\s+/g, " ")
			.trim();
		const n = normalizeUrl(href);
		if (n) out.push({ href: n, text });
	}
	return out;
}

export function titleFromHtml(html) {
	const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return m
		? m[1].replace(/\s+/g, " ").replace(/<[^>]+>/g, "").trim().slice(0, 200)
		: "";
}

async function fetchHtmlPage(url) {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(20_000),
		redirect: "follow",
		headers: {
			"User-Agent": BROWSER_UA,
			Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const html = String(await res.text()).slice(0, 500_000);
	return {
		url,
		title: titleFromHtml(html),
		html,
		markdown: "",
		links: linksFromHtml(html, url),
	};
}

export async function crmExists(crm, collection = CRM_AGENT.collection) {
	const id = crmDocId(crm);
	const snap = await firestore.collection(collection).doc(id).get();
	return snap.exists;
}

export async function saveCrm(crm, collection = CRM_AGENT.collection) {
	const id = crmDocId(crm);
	const { createdAt: _ca, id: _id, ...rest } = crm;
	const plain = JSON.parse(
		JSON.stringify({ ...rest, id, domain: registrableDomain(crm.website) || domainOf(crm.website) }),
	);
	const ref = firestore.collection(collection).doc(id);
	const existing = await ref.get();
	plain.updatedAt = new Date().toISOString();
	if (!existing.exists) {
		plain.createdAt = FieldValue.serverTimestamp();
	}
	await ref.set(plain, { merge: true });
	return id;
}

export async function loadAgentState() {
	const snap = await firestore
		.collection(CRM_AGENT.stateCollection)
		.doc(CRM_AGENT.id)
		.get();
	const d = snap.data() || {};
	return {
		lastQueryIndex: Number(d.lastQueryIndex) || 0,
		lastWikiNameIndex: Number(d.lastWikiNameIndex) || 0,
	};
}

export async function saveAgentState(patch) {
	await firestore
		.collection(CRM_AGENT.stateCollection)
		.doc(CRM_AGENT.id)
		.set(
			{
				agentId: CRM_AGENT.id,
				...patch,
				updatedAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
}

export async function loadQueryCursor() {
	const s = await loadAgentState();
	return s.lastQueryIndex;
}

export async function saveQueryCursor(index) {
	await saveAgentState({ lastQueryIndex: index });
}

export async function countCrms(collection = CRM_AGENT.collection) {
	const snap = await firestore.collection(collection).count().get();
	return snap.data().count || 0;
}

export async function listCrms(collection = CRM_AGENT.collection, { limit = 80 } = {}) {
	const snap = await firestore.collection(collection).limit(Math.min(limit, 300)).get();
	const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	rows.sort(
		(a, b) =>
			new Date(b.fetchedAt || b.updatedAt || 0).getTime() -
			new Date(a.fetchedAt || a.updatedAt || 0).getTime(),
	);
	return rows.slice(0, limit);
}

export async function scrapePage(url, baseUrl) {
	const target = normalizeUrl(url);
	if (!target) return { error: "empty_url", links: [], markdown: "", title: "" };
	const errors = [];

	try {
		const direct = await fetchHtmlPage(target);
		if ((direct.html && direct.html.length > 400) || (direct.links || []).length) {
			return { ...direct, via: "direct" };
		}
	} catch (err) {
		errors.push(`direct: ${err?.message || err}`);
	}

	try {
		const fc = await firecrawlScrape(target);
		if (!fc.error && (fc.markdown || fc.html || (fc.links || []).length)) {
			const html = String(fc.html || "");
			const links = [
				...(fc.links || []).map((href) => ({ href: normalizeUrl(href), text: "" })),
				...linksFromHtml(html, target),
			];
			return {
				url: target,
				title: fc.title || titleFromHtml(html),
				markdown: String(fc.markdown || "").slice(0, 40_000),
				html: html.slice(0, 80_000),
				links: links.filter((l) => l.href),
				via: "firecrawl",
			};
		}
		if (fc.error && fc.error !== "no_key") errors.push(`firecrawl: ${fc.error}`);
	} catch (err) {
		errors.push(`firecrawl: ${err?.message || err}`);
	}

	try {
		const row = await scrapeUrl(target, {
			baseUrl,
			timeoutMs: 45_000,
			includeImages: false,
		});
		const html = String(row.html || row.data?.html || "");
		return {
			url: target,
			title: row.title || row.data?.title || titleFromHtml(html),
			markdown: String(row.markdown || "").slice(0, 40_000),
			html: html.slice(0, 80_000),
			links: row.links || row.data?.links || row.data?.content?.links || [],
			via: "api",
		};
	} catch (err) {
		errors.push(`api: ${err?.message || err}`);
	}

	return {
		url: target,
		error: errors.join(" | ") || "scrape failed",
		links: [],
		markdown: "",
		title: "",
	};
}

export function collectPageLinks(page) {
	const out = [];
	for (const l of page.links || []) {
		const href = typeof l === "string" ? l : l?.href || l?.url || "";
		const text = typeof l === "string" ? "" : String(l?.text || l?.title || "");
		if (href) out.push({ href: normalizeUrl(href), text });
	}
	const md = String(page.markdown || "");
	for (const m of md.matchAll(/\[([^\]]{1,80})\]\((https?:\/\/[^)\s]+)\)/g)) {
		out.push({ href: normalizeUrl(m[2]), text: m[1] });
	}
	if (page.html) out.push(...linksFromHtml(page.html, page.url));
	return out.filter((x) => x.href);
}
