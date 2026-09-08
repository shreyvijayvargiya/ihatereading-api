/**
 * Parse a16z.com/portfolio HTML.
 *
 * Cards on the grid are Alpine/JS-rendered from `data-companies="[{...}]"`
 * (HTML-entity encoded JSON). Clicking a card only opens a modal of that
 * same object — no extra network call. Socials are tagged by host/domain.
 */

import { load } from "cheerio";
import { normalizeName, normalizeUrl } from "../ycCompanies/core.js";

const A16Z_COMPANY_PATH = /a16z\.com\/companies\/([a-z0-9-]+)\/?/i;

const SOCIAL_HOSTS = [
	{ re: /(^|\.)linkedin\.com$/i, key: "linkedin" },
	{ re: /(^|\.)(twitter\.com|x\.com)$/i, key: "twitter" },
	{ re: /(^|\.)github\.com$/i, key: "github" },
	{ re: /(^|\.)facebook\.com$/i, key: "facebook" },
	{ re: /(^|\.)instagram\.com$/i, key: "instagram" },
];

const ICON_KEY = {
	"icon-twitter": "twitter",
	"icon-linkedin": "linkedin",
	"icon-github": "github",
	"icon-facebook-a": "facebook",
	"icon-facebook": "facebook",
	"icon-instagram": "instagram",
	"icon-globe": "website",
	"icon-link": "website",
};

export function decodeHtmlEntities(s) {
	return String(s || "")
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#x2f;/gi, "/")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&amp;/g, "&");
}

export function slugFromA16zUrl(url) {
	const m = String(url || "").match(A16Z_COMPANY_PATH);
	return m ? m[1].toLowerCase() : null;
}

export function hostOf(url) {
	try {
		return new URL(normalizeUrl(url) || url).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return "";
	}
}

/**
 * Map a16z modal socials[] to { twitter, linkedin, github, ... } by domain, then icon.
 */
export function socialsFromA16z(raw) {
	const out = {
		twitter: null,
		linkedin: null,
		github: null,
		facebook: null,
		instagram: null,
		website: null,
	};
	const list = Array.isArray(raw) ? raw : [];
	for (const item of list) {
		const url = normalizeUrl(item?.url || item?.href || "");
		if (!url) continue;
		const host = hostOf(url);
		const icon = String(
			item?.["constants.select.social_icons"]?.value ||
				item?.icon ||
				item?.label ||
				"",
		).toLowerCase();
		let key = SOCIAL_HOSTS.find((row) => row.re.test(host))?.key || null;
		if (!key) key = ICON_KEY[icon] || null;
		if (!key && /twitter|\bx\b/.test(icon)) key = "twitter";
		if (!key && /linkedin/.test(icon)) key = "linkedin";
		if (!key && /github/.test(icon)) key = "github";
		if (!key) key = "website";
		if (!out[key]) out[key] = url;
	}
	return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}

export function parseFounders(raw) {
	if (Array.isArray(raw)) {
		return raw
			.map((f) => normalizeName(typeof f === "string" ? f : f?.name))
			.filter((n) => n.length >= 2 && n.length < 80)
			.slice(0, 12);
	}
	const s = String(raw || "").trim();
	if (!s) return [];
	return s
		.split(/\s*(?:,|;|\band\b)\s*/i)
		.map((n) => normalizeName(n))
		.filter((n) => n.length >= 2 && n.length < 80)
		.slice(0, 12);
}

export function mapA16zStatus(row) {
	const status = String(row.status || row.website_current_status || "").trim();
	const tag = String(row.tag || "").trim();
	const ticker = String(row.ticker_symbol || "").trim();
	const acquirer = String(row.acquirer || "").trim();
	if (/Active/i.test(status)) return "Active";
	if (ticker || /^IPO/i.test(tag)) return "Public";
	if (acquirer || /Acquired/i.test(tag)) return "Acquired";
	if (/Exits?/i.test(status) || /^Exit/i.test(tag)) return "Acquired";
	if (status) return status;
	return "unknown";
}

export function isActiveStatus(row) {
	const status = String(row.status || row.website_current_status || "");
	return /(^|;)Active(;|$)/i.test(status);
}

function asStringList(raw) {
	if (Array.isArray(raw)) return raw.map((x) => String(x || "").trim()).filter(Boolean);
	const s = String(raw || "").trim();
	if (!s) return [];
	return s.split(/\s*;\s*/).map((x) => x.trim()).filter(Boolean);
}

function parseJsonFrom(source, start) {
	const open = source[start];
	if (open !== "{" && open !== "[") return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if (inStr) {
			if (esc) {
				esc = false;
				continue;
			}
			if (ch === "\\") {
				esc = true;
				continue;
			}
			if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') {
			inStr = true;
			continue;
		}
		if (ch === "{" || ch === "[") depth += 1;
		else if (ch === "}" || ch === "]") {
			depth -= 1;
			if (depth === 0) {
				try {
					return JSON.parse(source.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

function rowsFromDataCompaniesAttr(html) {
	const $ = load(html);
	const decoded = $("[data-companies]").first().attr("data-companies");
	if (decoded) {
		try {
			const data = JSON.parse(decoded);
			if (Array.isArray(data) && data.length) return data;
		} catch {
			/* fall through */
		}
	}
	const marker = 'data-companies="';
	const p = html.indexOf(marker);
	if (p < 0) return [];
	const s = p + marker.length;
	const end = html.indexOf('"', s);
	if (end < 0) return [];
	try {
		const data = JSON.parse(decodeHtmlEntities(html.slice(s, end)));
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

function rowsFromWindowGlobal(html) {
	const marker = "window.a16z_portfolio_companies";
	const p = html.indexOf(marker);
	if (p < 0) return [];
	const eq = html.indexOf("=", p);
	if (eq < 0) return [];
	let i = eq + 1;
	while (i < html.length && /\s/.test(html[i])) i += 1;
	const data = parseJsonFrom(html, i);
	return Array.isArray(data) ? data : [];
}

function rowsFromDataCompanyCards(html) {
	const out = [];
	const marker = "data-company='";
	let from = 0;
	while (from < html.length) {
		const p = html.indexOf(marker, from);
		if (p < 0) break;
		const s = p + marker.length;
		const data = parseJsonFrom(html, s);
		if (data && typeof data === "object") out.push(data);
		from = s + 1;
	}
	return out;
}

/**
 * Map one a16z portfolio object onto the yc-companies field set.
 */
export function candidateFromA16zRecord(row, meta = {}) {
	const name = normalizeName(row.name || row.post_title || row.title || row.display_name);
	if (!name) return null;

	const permalink = normalizeUrl(row.permalink || "") || null;
	const slug =
		slugFromA16zUrl(permalink) ||
		String(row.id || "")
			.trim()
			.toLowerCase() ||
		null;
	const website = normalizeUrl(
		row.url || row.company_url || row.external_url || row.web || "",
	);
	const socials = socialsFromA16z(row.socials);
	if (website && !socials.website) socials.website = website;

	const focus = asStringList(row.focus_areas);
	const verticals = asStringList(row.verticals);
	const industries = [...new Set([...focus, ...verticals])];
	const stages = asStringList(row.stages);
	const stage =
		stages[0] ||
		(Array.isArray(row.stage) ? String(row.stage[0] || "") : String(row.stage || "")) ||
		null;
	const jobCount = Number(row.number_of_jobs || row.jobs) || 0;
	const founders = parseFounders(row.founders_list || row.founders);
	const oneLiner = String(row.website_description || row.overview || "").trim();
	const status = mapA16zStatus(row);
	const a16zUrl = permalink || null;
	const email = String(row.email || "").trim() || null;

	return {
		slug,
		name,
		ycUrl: a16zUrl,
		a16zUrl,
		a16zId: row.id != null ? String(row.id) : null,
		website: website || socials.website || null,
		sourceUrl: meta.sourceUrl || null,
		sourceType: "a16z",
		statusHint: status,
		status,
		statusRaw: row.status || row.website_current_status || null,
		tag: row.tag || null,
		batch: stage,
		batchRaw: stages.length ? stages.join(", ") : null,
		oneLiner,
		longDescription: oneLiner,
		snippet: oneLiner,
		industry: industries[0] || row.website_supercategory || null,
		industries,
		subindustry: industries[1] || null,
		tags: [...new Set([row.tag, ...industries].filter(Boolean))],
		teamSize: null,
		isHiring: jobCount > 0,
		jobCount,
		address: null,
		regions: [],
		stage,
		stages,
		logoUrl: row.logo || null,
		founders,
		emails: email ? [email] : [],
		email,
		investmentAmount: null,
		valuation: null,
		jobs: [],
		ycId: null,
		socials,
		linkedinUrl: socials.linkedin || null,
		twitterUrl: socials.twitter || null,
		githubUrl: socials.github || null,
		yearFounded: String(row.year_founded || "").trim() || null,
		tickerSymbol: String(row.ticker_symbol || "").trim() || null,
		acquirer: String(row.acquirer || "").trim() || null,
		focusAreas: focus,
	};
}

export function parseA16zPortfolioHtml(html, opts = {}) {
	const statusWant = String(opts.status || "Active").trim();
	let rows = rowsFromDataCompaniesAttr(html);
	if (!rows.length) rows = rowsFromWindowGlobal(html);
	if (!rows.length) rows = rowsFromDataCompanyCards(html);

	const seen = new Set();
	const companies = [];
	for (const row of rows) {
		const c = candidateFromA16zRecord(row, opts);
		if (!c) continue;
		const key = c.a16zId || c.slug || c.website || c.name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		if (statusWant && statusWant.toLowerCase() !== "all") {
			const want = statusWant.toLowerCase();
			if (want === "active" && !isActiveStatus(row) && c.status !== "Active") continue;
			if ((want === "exit" || want === "exits") && !/exit/i.test(String(row.status || "")))
				continue;
		}
		companies.push(c);
	}
	return {
		totalRaw: rows.length,
		companies,
	};
}
