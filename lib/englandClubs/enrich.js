/**
 * Enrich England clubs from Firestore: Wikidata + Wikipedia + search + site HTML.
 * Batch of 4. Chrome Maps is skipped (it hung and returned empty).
 */

import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import { hasOpenRouterKey, isUseAiOn, resolveAgentLlmModel } from "../useAi.js";
import {
	ENGLAND_CLUBS_AGENT,
	ENRICH_BATCH_SIZE,
	LOCAL_API_BASE,
	TOTAL_CLUBS,
} from "./configs.js";
import {
	countClubs,
	countEnrichedClubs,
	loadEnrichCursor,
	nextUnenrichedBatch,
	saveEnrichCursor,
	updateClubDoc,
} from "./core.js";
import { mergeClubPeople, searchClubPeopleEmails } from "./peopleEmail.js";
import { clubGoogleSearch, isVendorKeyError } from "./webSearch.js";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE =
	/(?:\+44[\s-]?(?:\d[\s-]?){9,10}|\b0\d{2,4}[\s-]?\d{3}[\s-]?\d{3,4}\b)/g;
const JUNK_SITE =
	/soccerwiki|wikipedia|transfermarkt|sofascore|flashscore|skysports|bbc\.com|goal\.com|premierleague\.com|uefa\.com|fifa\.com|espn\.|fotmob|whoscored|90min|theathletic|reddit\.com|facebook\.com\/watch/i;

function unique(arr) {
	return [...new Set((arr || []).map((s) => String(s).trim()).filter(Boolean))];
}

function hostOf(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return "";
	}
}

function compact(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj || {})) {
		if (v == null || v === "") continue;
		if (Array.isArray(v)) {
			if (v.length) out[k] = v;
			continue;
		}
		if (typeof v === "object" && !(v instanceof Date)) {
			const inner = compact(v);
			if (Object.keys(inner).length) out[k] = inner;
			continue;
		}
		out[k] = v;
	}
	return out;
}

function pickOfficialUrl(results, clubName) {
	const needle = String(clubName || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
	for (const r of results || []) {
		const url = r.url || r.link || "";
		if (!url || JUNK_SITE.test(url)) continue;
		const host = hostOf(url);
		if (!host) continue;
		const compactHost = host.replace(/[^a-z0-9]+/g, "");
		if (
			needle &&
			(compactHost.includes(needle.slice(0, 8)) ||
				needle.includes(compactHost.slice(0, 8)))
		) {
			try {
				const u = new URL(url);
				return `${u.protocol}//${u.host}/`;
			} catch {
				return url;
			}
		}
	}
	for (const r of results || []) {
		const url = r.url || r.link || "";
		if (url && !JUNK_SITE.test(url) && !/google\.com|facebook\.com|twitter\.com|x\.com/i.test(url))
			return url;
	}
	return "";
}

function isJunkEmail(email) {
	return /noreply|no-reply|donotreply|sentry|wixpress|example\.com|privacy@|webmaster@|webpack|github\.|cloudflare|schema\.org|w3\.org|googleapis/i.test(
		email,
	);
}

function emailsFromText(text) {
	return unique(
		(String(text || "").match(EMAIL_RE) || [])
			.map((e) => e.toLowerCase())
			.filter((e) => !isJunkEmail(e)),
	);
}

function clubHostNeedle(clubName) {
	return String(clubName || "")
		.toLowerCase()
		.replace(/^(afc|fc)\s+/i, "")
		.replace(/\s+(fc|afc|united|town|city|rovers|athletic|albion|wanderers)$/i, "")
		.replace(/[^a-z0-9]+/g, "");
}

function scoreEmail(email, clubName, clubHost) {
	const [user, domain] = String(email).toLowerCase().split("@");
	if (!user || !domain) return -10;
	let s = 1;
	const host = String(clubHost || "")
		.replace(/^www\./, "")
		.toLowerCase();
	const needle = clubHostNeedle(clubName);
	if (host && (domain === host || domain.endsWith(`.${host}`))) s += 12;
	if (needle && domain.replace(/[^a-z0-9]/g, "").includes(needle.slice(0, 8))) s += 10;
	if (
		/^(info|enquir(?:y|ies)?|contact|hello|office|admin|club|fans|community|reception|secretary|boxoffice)$/.test(
			user,
		)
	)
		s += 8;
	if (
		/^(media|press|commercial|ticket|tickets|ticketing|sales|marketing|partnerships|sponsorship|cmo)$/.test(
			user,
		)
	)
		s += 9;
	if (
		/^(it|digital|web|website|developer|tech|itdepartment|webmaster|comms|communications)$/.test(
			user,
		)
	)
		s += 6;
	if (needle && user.includes(needle.slice(0, 6))) s += 4;
	if (/gmail|googlemail|hotmail|outlook|yahoo|icloud/.test(domain)) s += 2;
	return s;
}

function pickBestEmail(emails, clubName, clubHost) {
	const ranked = unique(emails)
		.map((email) => ({ email, score: scoreEmail(email, clubName, clubHost) }))
		.filter((r) => r.score > 0)
		.sort((a, b) => b.score - a.score);
	return ranked[0]?.email || "";
}

const PERSON_ROLE_RE =
	/\b(head of (?:ticketing|marketing|digital|media|communications|commercial|it)|ticketing (?:manager|director)|cmo|chief marketing officer|marketing (?:director|manager|head)|digital (?:director|manager|lead|officer)|it (?:manager|director|lead)|webmaster|web (?:developer|manager)|website (?:manager|developer)|commercial director|media (?:manager|officer|director)|press officer|communications (?:manager|director))\b/i;

function personFromSnippet(snippet, email) {
	const text = String(snippet || "").replace(/\s+/g, " ");
	const idx = text.toLowerCase().indexOf(String(email || "").toLowerCase());
	const window = idx >= 0 ? text.slice(Math.max(0, idx - 90), idx) : text.slice(0, 160);
	const name =
		window.match(
			/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b(?:\s*[-–,|]|,\s*(?:head|director|manager|lead|officer|developer|digital|it)\b)/,
		)?.[1] || "";
	const role = text.match(PERSON_ROLE_RE)?.[1] || "";
	return { name: name.trim(), role: role.trim() };
}

function personFromSearchRow(row) {
	const title = String(row.title || "").replace(/\s+/g, " ");
	const snippet = String(row.snippet || row.description || "").replace(/\s+/g, " ");
	const url = String(row.url || row.link || "");
	const blob = `${title} ${snippet}`;
	let name = "";
	if (/linkedin\.com/i.test(url)) {
		name =
			title
				.replace(/\s*[\-|–]\s*LinkedIn.*$/i, "")
				.split(/\s[-–|]\s|\sat\s/i)[0]
				.replace(/\s*\(.*\)\s*$/, "")
				.trim() || "";
		if (!/^([A-Z][a-z]+)(\s+[A-Z][a-z]+){0,2}$/.test(name)) name = "";
	}
	if (!name) {
		name =
			blob.match(
				/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b(?:\s*[-–,|]|,\s*)(?=head|director|manager|lead|officer|developer|digital|it\b)/i,
			)?.[1] || "";
	}
	const role = blob.match(PERSON_ROLE_RE)?.[1] || "";
	if (!name && !role) return null;
	return {
		name,
		role: role.trim(),
		source: url,
		query: row.query || "",
	};
}

export function contactSearchQueries(name, location = "") {
	const loc = location ? ` ${location}` : "";
	return [
		`${name} official website${loc}`,
		`${name} FC contact email`,
		`${name} football club stadium phone`,
	];
}

function isContactResult(row) {
	const url = String(row.url || row.link || "").toLowerCase();
	const title = String(row.title || "").toLowerCase();
	const blob = `${url} ${title}`;
	return /contact|enquir|staff|commercial|media|about|directory|get-in-touch|getintouch|ticket|marketing|press/.test(
		blob,
	);
}

function skipScrapeUrl(url) {
	return /linkedin\.com|facebook\.com|twitter\.com|x\.com|instagram\.com|youtube\.com|tiktok\.com/i.test(
		String(url || ""),
	);
}

async function searchOne(query, opts = {}) {
	try {
		const rows = await clubGoogleSearch(query, {
			baseUrl: opts.baseUrl,
			num: 6,
		});
		return { query, rows, error: "" };
	} catch (err) {
		const msg = err?.message || String(err);
		if (isVendorKeyError(msg)) return { query, rows: [], error: "" };
		return { query, rows: [], error: msg };
	}
}

async function searchMany(queries, opts = {}) {
	const settled = await Promise.all((queries || []).map((q) => searchOne(q, opts)));
	const out = [];
	const errors = [];
	for (const row of settled) {
		for (const r of row.rows || []) out.push({ ...r, query: row.query });
		if (!row.rows?.length && row.error) errors.push({ query: row.query, error: row.error });
	}
	return { results: out, errors };
}

async function llmExtractClubContact(club, evidence, model) {
	const content = (await openRouterChat({
		model,
		jsonMode: false,
		temperature: 0.1,
		maxTokens: 800,
		timeoutMs: 25_000,
		messages: [
			{
				role: "system",
				content: `Extract public contact details for an English football club from the evidence.
Reply with JSON only (no markdown):
{"website":"","email":"","emails":[],"phone":"","contactName":"","contactRole":"","staff":[{"name":"","role":"","email":""}]}
Prefer named staff emails (Head of Ticketing / HT, CMO, Head of Marketing) when they appear in the evidence, then club-domain marketing@ / tickets@ / commercial@ / press@.
Never invent an email that is not in the evidence. Empty string if unknown.`,
			},
			{
				role: "user",
				content: JSON.stringify({
					club: {
						name: club.name,
						league: club.league || "",
						stadium: club.stadium || "",
						location: club.location || "",
					},
					evidence,
				}),
			},
		],
	})).content;
	try {
		const raw = parseJsonFromLLM(content);
		return raw && typeof raw === "object" ? raw : null;
	} catch {
		return null;
	}
}

const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchPageHtml(url) {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(18_000),
		redirect: "follow",
		headers: {
			"User-Agent": BROWSER_UA,
			Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-GB,en;q=0.9",
		},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.text();
}

function linksFromHtml(html, pageUrl) {
	const hrefs = String(html || "").match(/https?:\/\/[^\s"'<>]+/gi) || [];
	const rel = [...String(html || "").matchAll(/\bhref=["']([^"']+)["']/gi)].map(
		(m) => {
			try {
				return new URL(m[1], pageUrl).href;
			} catch {
				return "";
			}
		},
	);
	return unique([...hrefs, ...rel]).filter((u) => /^https?:\/\//i.test(u));
}

async function scrapeContactsFast(url) {
	const html = await fetchPageHtml(url);
	const links = linksFromHtml(html, url);
	const markdown = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
	return {
		...extractContacts(
			{
				markdown: markdown.slice(0, 50_000),
				html: html.slice(0, 40_000),
				links,
				title: (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || "",
			},
			url,
		),
		pageText: markdown.replace(/\s+/g, " ").trim().slice(0, 12_000),
	};
}

function contactPageGuesses(website) {
	try {
		const origin = new URL(website).origin;
		return [
			`${origin}/contact`,
			`${origin}/contact-us`,
			`${origin}/club/contact`,
			`${origin}/get-in-touch`,
			`${origin}/enquiries`,
			`${origin}/tickets`,
			`${origin}/ticketing`,
			`${origin}/commercial`,
			`${origin}/staff`,
			`${origin}/media`,
		];
	} catch {
		return [];
	}
}

function extractContacts(page, pageUrl) {
	const blob = [page.markdown, page.html, JSON.stringify(page.links || [])].join(
		"\n",
	);
	const emails = unique(
		[
			...(blob.match(EMAIL_RE) || []),
			...(blob.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi) || []).map(
				(m) => m.replace(/^mailto:/i, ""),
			),
		]
			.map((e) => e.toLowerCase())
			.filter((e) => !isJunkEmail(e)),
	);
	const phones = unique((blob.match(PHONE_RE) || []).map((p) => p.replace(/\s+/g, " ")));
	const links = [];
	for (const l of page.links || []) {
		const href = typeof l === "string" ? l : l.href || l.url || l.link;
		if (href) links.push(href);
	}
	links.push(...(blob.match(/https?:\/\/[^\s"'<>]+/gi) || []));
	const socials = {
		twitter: "",
		instagram: "",
		facebook: "",
		linkedin: "",
		youtube: "",
		tiktok: "",
	};
	for (const href of links) {
		const u = String(href);
		if (/twitter\.com\/|x\.com\//i.test(u) && !socials.twitter)
			socials.twitter = u.split("?")[0];
		else if (/instagram\.com\//i.test(u) && !socials.instagram)
			socials.instagram = u.split("?")[0];
		else if (/facebook\.com\//i.test(u) && !socials.facebook)
			socials.facebook = u.split("?")[0];
		else if (/linkedin\.com\//i.test(u) && !socials.linkedin)
			socials.linkedin = u.split("?")[0];
		else if (/youtube\.com\/|youtu\.be\//i.test(u) && !socials.youtube)
			socials.youtube = u.split("?")[0];
		else if (/tiktok\.com\//i.test(u) && !socials.tiktok)
			socials.tiktok = u.split("?")[0];
	}
	return {
		website: pageUrl || "",
		emails,
		email: emails[0] || "",
		phones,
		phone: phones[0] || "",
		socials,
		pageTitle: page.title || "",
	};
}

function coordsFromMapsUrl(url) {
	const s = String(url || "");
	const lat = s.match(/[!,]3d(-?[\d.]+)/);
	const lng = s.match(/[!,]4d(-?[\d.]+)/);
	if (lat && lng) {
		return { lat: Number(lat[1]), lng: Number(lng[1]) };
	}
	const at = s.match(/@(-?[\d.]+),(-?[\d.]+)/);
	if (at) return { lat: Number(at[1]), lng: Number(at[2]) };
	return null;
}

let geoLock = Promise.resolve();
function withGeoLock(fn) {
	const run = geoLock.then(fn, fn);
	geoLock = run.then(
		() => {},
		() => {},
	);
	return run;
}

let llmLock = Promise.resolve();
function withLlmLock(fn) {
	const run = llmLock.then(fn, fn);
	llmLock = run.then(
		() => {},
		() => {},
	);
	return run;
}

async function fetchJson(url, timeoutMs = 12_000) {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			"User-Agent": BROWSER_UA,
			Accept: "application/json",
		},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

function withTimeout(promise, ms, label) {
	let timer;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
		}),
	]);
}

function wikidataValues(entity, prop) {
	return (entity?.claims?.[prop] || [])
		.map((c) => c?.mainsnak?.datavalue)
		.filter(Boolean);
}

function factsFromWikidataEntity(entity) {
	const site = wikidataValues(entity, "P856")[0]?.value;
	const coord = wikidataValues(entity, "P625")[0]?.value;
	const phone = wikidataValues(entity, "P1329")[0]?.value;
	const mailRaw = wikidataValues(entity, "P968")[0]?.value;
	const email = String(mailRaw || "")
		.replace(/^mailto:/i, "")
		.trim();
	return {
		website: typeof site === "string" && !JUNK_SITE.test(site) ? site : "",
		phone: typeof phone === "string" ? phone.trim() : "",
		email: email.includes("@") && !isJunkEmail(email) ? email.toLowerCase() : "",
		coords:
			coord && typeof coord.latitude === "number"
				? { lat: coord.latitude, lng: coord.longitude }
				: null,
	};
}

function pickWikidataId(hits, club) {
	const name = String(club.name || "").toLowerCase();
	const scored = (hits || []).map((h) => {
		const label = String(h.label || "").toLowerCase();
		const desc = String(h.description || "").toLowerCase();
		let s = 0;
		if (label === name || label === `${name} f.c.` || label === `${name} fc`) s += 12;
		if (label.includes(name) || name.includes(label.replace(/\s*f\.?c\.?\s*$/i, "").trim()))
			s += 6;
		if (/football club|association football|soccer club/.test(desc)) s += 8;
		if (/stadium|ground/.test(desc) && /football|soccer/.test(desc)) s += 4;
		if (/village|surname|album|film|band\b|given name/.test(desc)) s -= 12;
		return { id: h.id, s };
	});
	scored.sort((a, b) => b.s - a.s);
	return scored[0]?.s > 0 ? scored[0].id : "";
}

async function lookupWikidata(club) {
	const search = await fetchJson(
		`https://www.wikidata.org/w/api.php?${new URLSearchParams({
			action: "wbsearchentities",
			search: `${club.name} football club`,
			language: "en",
			uselang: "en",
			type: "item",
			limit: "6",
			format: "json",
		})}`,
	);
	const id = pickWikidataId(search.search, club);
	if (!id) return { website: "", phone: "", email: "", coords: null };
	const payload = await fetchJson(
		`https://www.wikidata.org/w/api.php?${new URLSearchParams({
			action: "wbgetentities",
			ids: id,
			props: "claims",
			languages: "en",
			format: "json",
		})}`,
	);
	const entity = payload.entities?.[id] || {};
	const facts = factsFromWikidataEntity(entity);
	if (facts.coords && facts.phone) return facts;
	const venueId = wikidataValues(entity, "P115")[0]?.value?.id || "";
	if (!venueId) return facts;
	const venuePayload = await fetchJson(
		`https://www.wikidata.org/w/api.php?${new URLSearchParams({
			action: "wbgetentities",
			ids: venueId,
			props: "claims",
			languages: "en",
			format: "json",
		})}`,
	);
	const venue = factsFromWikidataEntity(venuePayload.entities?.[venueId] || {});
	return {
		...facts,
		coords: facts.coords || venue.coords,
		phone: facts.phone || venue.phone,
		email: facts.email || venue.email,
	};
}

async function lookupWikipedia(club) {
	const data = await fetchJson(
		`https://en.wikipedia.org/w/api.php?${new URLSearchParams({
			action: "query",
			list: "search",
			srsearch: `${club.name} football club`,
			srlimit: "3",
			format: "json",
			origin: "*",
		})}`,
	);
	const title = data.query?.search?.[0]?.title;
	if (!title) return { website: "", coords: null, links: [] };
	const [summary, linksPayload] = await Promise.all([
		fetchJson(
			`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
		).catch(() => ({})),
		fetchJson(
			`https://en.wikipedia.org/w/api.php?${new URLSearchParams({
				action: "query",
				prop: "extlinks",
				titles: title,
				ellimit: "40",
				format: "json",
				origin: "*",
			})}`,
		).catch(() => ({})),
	]);
	const coords = summary?.coordinates
		? { lat: Number(summary.coordinates.lat), lng: Number(summary.coordinates.lon) }
		: null;
	const page = Object.values(linksPayload.query?.pages || {})[0] || {};
	const links = (page.extlinks || [])
		.map((e) => e["*"] || e.url || "")
		.filter((u) => /^https?:\/\//i.test(u) && !JUNK_SITE.test(u) && !skipScrapeUrl(u));
	const website = pickOfficialUrl(
		links.map((url) => ({ url, title: "wikipedia", snippet: "" })),
		club.name,
	);
	return {
		website,
		coords: Number.isFinite(coords?.lat) ? coords : null,
		links: links.slice(0, 12).map((url) => ({
			url,
			link: url,
			title,
			snippet: "Wikipedia external link",
		})),
	};
}

async function lookupNominatim(club) {
	const queries = unique(
		[club.stadium, `${club.name} stadium`, `${club.name} football club`].filter(Boolean),
	);
	return withGeoLock(async () => {
		let list = [];
		for (const q of queries) {
			const res = await fetch(
				`https://nominatim.openstreetmap.org/search?${new URLSearchParams({
					q,
					format: "jsonv2",
					limit: "3",
					countrycodes: "gb",
				})}`,
				{
					signal: AbortSignal.timeout(12_000),
					headers: {
						"User-Agent": "ihatereading-api/1.0 (england-clubs-enrich)",
						Accept: "application/json",
					},
				},
			);
			if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
			const rows = await res.json();
			list = Array.isArray(rows) ? rows : [];
			if (list.length) break;
			await new Promise((r) => setTimeout(r, 1100));
		}
		const hit =
			list.find((r) =>
				/stadium|sport|pitch|football|soccer/i.test(
					`${r.type} ${r.category || r.class} ${r.display_name}`,
				),
			) || list[0];
		if (!hit?.lat || !hit?.lon) return null;
		return {
			name: hit.name || hit.display_name || "",
			address: hit.display_name || "",
			coordinates: { lat: Number(hit.lat), lng: Number(hit.lon) },
			url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${hit.lat},${hit.lon}`)}`,
			mapsUrl: `https://www.openstreetmap.org/?mlat=${hit.lat}&mlon=${hit.lon}#map=16/${hit.lat}/${hit.lon}`,
			website: "",
			phone: "",
			source: "nominatim",
		};
	});
}

function officialLinksFromWikiHtml(html, pageUrl, clubName) {
	const labeled =
		String(html || "").match(
			/official\s+(?:club\s+)?website[\s\S]{0,240}?href=["'](https?:\/\/[^"']+)/i,
		)?.[1] || "";
	const all = linksFromHtml(html, pageUrl);
	const picked = pickOfficialUrl(
		[{ url: labeled }, ...all.map((url) => ({ url }))],
		clubName,
	);
	const needle = clubHostNeedle(clubName);
	const matching = all.filter((u) => {
		if (JUNK_SITE.test(u) || skipScrapeUrl(u) || /soccerwiki/i.test(u)) return false;
		const h = hostOf(u).replace(/[^a-z0-9]/g, "");
		return needle && h.includes(needle.slice(0, 6));
	});
	return unique([picked, ...matching].filter(Boolean)).slice(0, 8);
}

/**
 * Wikidata / Wikipedia / Nominatim + search snippets + official-site HTML.
 * Pass --use-ai to let OpenRouter extract emails (same model the CLI passed).
 */
export async function enrichClub(club, opts = {}) {
	const name = String(club.name || "").trim();
	if (!name) throw new Error("club name is required");

	const useAI = isUseAiOn(opts) && hasOpenRouterKey();
	const model = resolveAgentLlmModel(opts.model);
	let llmError = "";
	let wikiError = "";
	let geoError = "";

	const contactQueries = contactSearchQueries(name, club.location || "");
	const mapsQuery = [name, club.stadium, "football club stadium", club.location, "England"]
		.filter(Boolean)
		.join(" ");

	const wikiUrl = String(club.wikiUrl || club.squadUrl || "").trim();
	let wikiLinks = [];
	let siteSeed = {
		website: "",
		emails: [],
		phones: [],
		phone: "",
		socials: {},
		pageTitle: "",
	};
	if (wikiUrl) {
		try {
			const html = await fetchPageHtml(wikiUrl);
			wikiLinks = officialLinksFromWikiHtml(html, wikiUrl, name).map((url) => ({
				url,
				link: url,
				title: `${name} official site`,
				snippet: "from Soccer Wiki",
			}));
			const wikiHits = extractContacts(
				{
					markdown: html.replace(/<[^>]+>/g, " ").slice(0, 30_000),
					html: html.slice(0, 20_000),
					links: wikiLinks.map((r) => r.url),
					title: club.name,
				},
				wikiUrl,
			);
			siteSeed = {
				...siteSeed,
				website: wikiLinks[0]?.url || "",
				emails: wikiHits.emails || [],
				phones: wikiHits.phones || [],
				phone: wikiHits.phone || "",
				socials: wikiHits.socials || {},
			};
		} catch (err) {
			wikiError = err?.message || String(err);
		}
	}

	const [wikidata, wikipedia, searched] = await Promise.all([
		withTimeout(
			lookupWikidata(club).catch((err) => {
				geoError = geoError || err?.message || String(err);
				return { website: "", phone: "", email: "", coords: null };
			}),
			18_000,
			"wikidata",
		).catch((err) => {
			geoError = geoError || err?.message || String(err);
			return { website: "", phone: "", email: "", coords: null };
		}),
		withTimeout(
			lookupWikipedia(club).catch((err) => {
				geoError = geoError || err?.message || String(err);
				return { website: "", coords: null, links: [] };
			}),
			18_000,
			"wikipedia",
		).catch((err) => {
			geoError = geoError || err?.message || String(err);
			return { website: "", coords: null, links: [] };
		}),
		withTimeout(searchMany(contactQueries, { baseUrl: opts.baseUrl }), 18_000, "search").catch((err) => ({
			results: [],
			errors: [{ query: contactQueries[0], error: err?.message || String(err) }],
		})),
	]);

	const googleResults = [
		...wikiLinks,
		...(wikipedia.links || []),
		...(searched.results || []),
	];
	let googleSearchError = searched.errors.find((e) => !isVendorKeyError(e.error))?.error || "";

	const snippetEmails = [];
	let people = [];
	for (const r of googleResults) {
		const blob = `${r.title || ""} ${r.snippet || r.description || ""} ${r.url || r.link || ""}`;
		for (const email of emailsFromText(blob)) {
			snippetEmails.push(email);
			const person = personFromSnippet(blob, email);
			if (person.name || person.role) {
				people.push({ ...person, email, source: r.url || r.link || "", query: r.query || "" });
			}
		}
		const fromTitle = personFromSearchRow(r);
		if (fromTitle && !people.some((p) => p.name && p.name === fromTitle.name)) {
			people.push(fromTitle);
		}
	}
	if (wikidata.email) snippetEmails.push(wikidata.email);

	const website =
		wikidata.website ||
		wikipedia.website ||
		siteSeed.website ||
		pickOfficialUrl(googleResults, name);
	const clubHost = hostOf(website);

	let peopleSearch = {
		people: [],
		emails: [],
		queries: [],
		byRole: {},
		outreachEmail: "",
		outreachName: "",
		outreachRole: "",
	};
	try {
		peopleSearch = await withTimeout(
			searchClubPeopleEmails(name, {
				baseUrl: opts.baseUrl,
				host: clubHost,
				location: club.location || "",
			}),
			28_000,
			"people-email",
		);
		people = mergeClubPeople(people, peopleSearch.people);
		snippetEmails.push(...(peopleSearch.emails || []));
	} catch (err) {
		if (!googleSearchError && !isVendorKeyError(err?.message || err)) {
			googleSearchError = err?.message || String(err);
		}
	}

	const contactUrls = unique(
		googleResults
			.filter(isContactResult)
			.map((r) => r.url || r.link || "")
			.filter((u) => u && !JUNK_SITE.test(u) && !skipScrapeUrl(u)),
	).slice(0, 4);

	const pagesToScrape = unique(
		[website, ...contactUrls, ...(website ? contactPageGuesses(website).slice(0, 3) : [])]
			.filter(Boolean)
			.filter((u) => !skipScrapeUrl(u) && !JUNK_SITE.test(u)),
	).slice(0, 4);

	let site = {
		website: website || "",
		emails: unique([...(siteSeed.emails || []), ...snippetEmails]),
		email: "",
		phones: unique([...(siteSeed.phones || []), wikidata.phone].filter(Boolean)),
		phone: wikidata.phone || siteSeed.phone || "",
		socials: siteSeed.socials || {},
		pageTitle: "",
		pageText: "",
		scrapeError: "",
	};

	for (const url of pagesToScrape) {
		try {
			const extra = await scrapeContactsFast(url);
			site.emails = unique([...(site.emails || []), ...(extra.emails || [])]);
			site.phones = unique([...(site.phones || []), ...(extra.phones || [])]);
			site.socials = { ...site.socials, ...compact(extra.socials) };
			if (!site.website || JUNK_SITE.test(site.website)) site.website = extra.website || url;
			if (!site.pageTitle) site.pageTitle = extra.pageTitle || "";
			if (!site.phone) site.phone = extra.phone || "";
			if (extra.pageText) {
				site.pageText = `${site.pageText || ""} ${extra.pageText}`.replace(/\s+/g, " ").trim().slice(0, 12_000);
			}
		} catch (err) {
			if (!site.emails.length && !site.phone && !site.scrapeError) {
				site.scrapeError = err?.message || String(err);
			}
		}
	}

	let mapsPlace = null;
	let mapsError = "";
	const seedCoords = wikidata.coords || wikipedia.coords;
	if (seedCoords) {
		mapsPlace = {
			name: club.stadium || name,
			address: club.location || "",
			coordinates: seedCoords,
			url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${seedCoords.lat},${seedCoords.lng}`)}`,
			mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${club.stadium || "stadium"}`)}`,
			website: wikidata.website || "",
			phone: wikidata.phone || "",
			source: "wikidata",
		};
	} else {
		try {
			mapsPlace = await lookupNominatim(club);
		} catch (err) {
			mapsError = err?.message || String(err);
		}
	}

	const coords =
		mapsPlace?.coordinates || coordsFromMapsUrl(mapsPlace?.url || mapsPlace?.mapsUrl);
	const mapsPhone = String(mapsPlace?.phone || "").trim();
	const mapsWebsite = String(mapsPlace?.website || "").trim();
	const mapsAddress = String(mapsPlace?.address || "").trim();
	let phone = mapsPhone || site.phone || "";
	let emails = unique([
		...(site.emails || []),
		...snippetEmails,
		...(peopleSearch.emails || []),
	]);
	for (const p of people) {
		if (p.email) emails.push(p.email);
		if (Array.isArray(p.emails)) emails.push(...p.emails);
	}
	emails = unique(emails);
	let email =
		peopleSearch.outreachEmail ||
		pickBestEmail(emails, name, clubHost || hostOf(mapsWebsite)) ||
		emails[0] ||
		"";
	let person =
		people.find((p) => p.email && p.email === email) ||
		people.find((p) => p.email && /ticketing|cmo|marketing|commercial/i.test(`${p.role} ${p.roleId}`)) ||
		people.find((p) => p.email) ||
		people.find((p) => /digital|it |webmaster|developer/i.test(p.role || "")) ||
		people[0] ||
		{};
	if (peopleSearch.outreachEmail && peopleSearch.outreachName) {
		person = {
			...person,
			name: peopleSearch.outreachName || person.name,
			role: peopleSearch.outreachRole || person.role,
			email: peopleSearch.outreachEmail,
		};
	}
	let officialSite = mapsWebsite || site.website;

	const llmEvidence = {
		queries: [...contactQueries, ...(peopleSearch.queries || [])],
		results: [
			...(searched.results || []).slice(0, 8),
			...(peopleSearch.results || []).slice(0, 8),
		].map((r) => ({
			title: r.title || "",
			snippet: r.snippet || r.description || "",
			url: r.url || r.link || "",
		})),
		scrapedEmails: emails,
		scrapedPhones: unique([mapsPhone, ...(site.phones || [])].filter(Boolean)),
		website: officialSite,
		people: people.slice(0, 8),
		pageText: (site.pageText || "").slice(0, 8_000),
	};
	const hasLlmEvidence = Boolean(
		llmEvidence.results.length || emails.length || officialSite || phone,
	);

	if (useAI && hasLlmEvidence) {
		try {
			const extracted = await withLlmLock(() =>
				llmExtractClubContact(club, llmEvidence, model),
			);
			if (extracted) {
				const llmEmails = unique(
					[extracted.email, ...(Array.isArray(extracted.emails) ? extracted.emails : [])]
						.map((e) => String(e || "").toLowerCase().trim())
						.filter((e) => e.includes("@") && !isJunkEmail(e)),
				);
				emails = unique([...llmEmails, ...emails]);
				const llmBest =
					pickBestEmail(llmEmails, name, clubHost || hostOf(extracted.website || officialSite)) ||
					extracted.email ||
					"";
				if (llmBest && !isJunkEmail(llmBest)) email = String(llmBest).toLowerCase();
				if (extracted.phone && !phone) phone = String(extracted.phone).trim();
				if (
					extracted.website &&
					!officialSite &&
					!JUNK_SITE.test(extracted.website) &&
					!skipScrapeUrl(extracted.website)
				) {
					officialSite = String(extracted.website).trim();
				}
				if (extracted.contactName) person = { ...person, name: extracted.contactName };
				if (extracted.contactRole) person = { ...person, role: extracted.contactRole };
				if (Array.isArray(extracted.staff) && extracted.staff.length) {
					people = mergeClubPeople(
						people,
						extracted.staff.map((s) => ({
							name: String(s?.name || ""),
							role: String(s?.role || ""),
							email: String(s?.email || "").toLowerCase(),
							source: "llm",
							platform: "google",
						})),
					);
				}
			}
		} catch (err) {
			if (!llmError) llmError = err?.message || String(err);
		}
	}

	const hasAnything = Boolean(email || phone || officialSite || coords?.lat);
	const enrichError = [
		mapsError,
		site.scrapeError,
		googleSearchError,
		llmError,
		wikiError,
		geoError,
	]
		.filter((m) => m && !isVendorKeyError(m))
		.join(" | ");
	console.log(
		`[england-clubs-enrich] ${name} search=${(searched.results || []).length} people=${people.length} wiki=${wikiLinks.length} pages=${pagesToScrape.length} maps=${mapsPlace ? "yes" : "no"} email=${email || "-"} site=${officialSite || "-"} ${enrichError ? `err=${enrichError}` : "ok"}`,
	);

	return compact({
		website: officialSite,
		websiteTitle: site.pageTitle,
		email,
		emails,
		contactEmail: email,
		outreachEmail: peopleSearch.outreachEmail || email,
		contactName: person.name || "",
		contactRole: person.role || "",
		contacts: people.slice(0, 12),
		staff: people.slice(0, 12),
		staffByRole: peopleSearch.byRole || null,
		peopleQueries: peopleSearch.queries || [],
		phone,
		phones: unique([mapsPhone, ...(site.phones || [])].filter(Boolean)),
		socials: site.socials,
		contact: {
			email,
			name: person.name || "",
			role: person.role || "",
			phone,
			website: officialSite,
			socials: site.socials,
			ht: peopleSearch.byRole?.ht || null,
			cmo: peopleSearch.byRole?.cmo || null,
			marketingHead: peopleSearch.byRole?.marketingHead || null,
		},
		stadiumAddress: mapsAddress,
		address: mapsAddress,
		latitude: coords?.lat ?? null,
		longitude: coords?.lng ?? null,
		coordinates: coords,
		mapsUrl: mapsPlace?.url || mapsPlace?.mapsUrl || "",
		mapsName: mapsPlace?.name || "",
		mapsRating: mapsPlace?.rating ?? null,
		mapsReviews: mapsPlace?.reviews || "",
		mapsCategory: mapsPlace?.category || "",
		mapsImage: mapsPlace?.image || "",
		maps: mapsPlace
			? {
					name: mapsPlace.name || "",
					address: mapsAddress,
					phone: mapsPhone,
					website: mapsWebsite,
					url: mapsPlace.url || mapsPlace.mapsUrl || "",
					rating: mapsPlace.rating ?? null,
					reviews: mapsPlace.reviews || "",
					category: mapsPlace.category || "",
					image: mapsPlace.image || "",
					coordinates: coords,
				}
			: null,
		googleQuery: contactQueries[0],
		contactQueries,
		mapsQuery,
		useAI,
		llmModel: useAI ? model : "",
		googleHits: googleResults.length,
		mapsHits: mapsPlace ? 1 : 0,
		enrichError,
		enrichedAt: new Date().toISOString(),
		enrichStatus: hasAnything ? "done" : "empty",
	});
}

export async function enrichAndSaveClub(club, opts = {}) {
	const patch = await enrichClub(club, opts);
	await updateClubDoc(club.id, patch);
	return {
		id: club.id,
		name: club.name,
		email: patch.email || "",
		outreachEmail: patch.outreachEmail || patch.email || "",
		contactName: patch.contactName || "",
		contactRole: patch.contactRole || "",
		staff: Array.isArray(patch.staff) ? patch.staff.length : 0,
		phone: patch.phone || "",
		website: patch.website || "",
		latitude: patch.latitude ?? null,
		longitude: patch.longitude ?? null,
		mapsUrl: patch.mapsUrl || "",
		useAI: Boolean(patch.useAI),
		llmModel: patch.llmModel || "",
		googleHits: patch.googleHits || 0,
		mapsHits: patch.mapsHits || 0,
		enrichError: patch.enrichError || "",
		enrichStatus: patch.enrichStatus,
	};
}

/**
 * One tick: enrich up to 4 unenriched Firestore clubs in parallel, then advance.
 */
export async function runEnglandClubsEnrichAgent(opts = {}) {
	const batchSize = ENRICH_BATCH_SIZE;
	const baseUrl = String(opts.baseUrl || LOCAL_API_BASE).replace(/\/$/, "");
	let cursor = opts.reset
		? { afterId: "", enriched: 0, done: false }
		: await loadEnrichCursor();

	if (opts.reset) {
		cursor = { afterId: "", enriched: 0, done: false };
		await saveEnrichCursor(cursor);
	}

	const stored = await countClubs().catch(() => 0);
	const already = await countEnrichedClubs().catch(() => cursor.enriched || 0);

	const summary = {
		agentId: "england-clubs-enrich",
		collection: ENGLAND_CLUBS_AGENT.collection,
		batchSize,
		stored,
		enrichedBefore: already,
		useAI: isUseAiOn(opts),
		llmModel: isUseAiOn(opts) ? resolveAgentLlmModel(opts.model) : "",
		fetched: 0,
		updated: 0,
		failed: 0,
		done: false,
		clubs: [],
		errors: [],
	};

	if (cursor.done && already >= stored && stored > 0 && !opts.reset) {
		summary.done = true;
		summary.enriched = already;
		summary.note = `All ${already}/${stored} clubs already enriched. Pass --reset to run again.`;
		return summary;
	}

	const batch = await nextUnenrichedBatch({
		afterId: cursor.afterId,
		limit: batchSize,
	});
	summary.fetched = batch.clubs.length;
	summary.afterIdFrom = cursor.afterId;
	summary.afterIdTo = batch.afterId;
	summary.scanned = batch.scanned;

	if (!batch.clubs.length) {
		const done = batch.exhausted || stored === 0;
		await saveEnrichCursor({
			afterId: done ? "" : batch.afterId,
			enriched: already,
			done,
		});
		summary.done = done;
		summary.enriched = already;
		summary.note = done
			? `Enrichment complete — ${already}/${stored} clubs.`
			: "No pending clubs in this window — cursor advanced.";
		return summary;
	}

	console.log(
		`[england-clubs-enrich] ${batch.clubs.length} clubs: ${batch.clubs.map((c) => c.name).join(", ")}`,
	);

	const settled = await Promise.allSettled(
		batch.clubs.map((club) =>
			enrichAndSaveClub(club, {
				baseUrl,
				useAI: opts.useAI,
				llm: opts.llm,
				model: opts.model,
			}),
		),
	);

	for (let i = 0; i < settled.length; i++) {
		const club = batch.clubs[i];
		const row = settled[i];
		if (row.status === "fulfilled") {
			summary.updated += 1;
			summary.clubs.push(row.value);
		} else {
			summary.failed += 1;
			const message = row.reason?.message || String(row.reason);
			summary.errors.push({ id: club.id, name: club.name, error: message });
			await updateClubDoc(club.id, {
				enrichStatus: "error",
				enrichError: message,
				enrichedAt: new Date().toISOString(),
			}).catch(() => {});
			summary.clubs.push({
				id: club.id,
				name: club.name,
				enrichStatus: "error",
				error: message,
			});
		}
	}

	const filled = summary.clubs.filter((c) => c.enrichStatus === "done").length;
	const enrichedNow = already + filled;
	const done = Boolean(batch.exhausted && batch.clubs.length < batchSize);
	await saveEnrichCursor({
		afterId: done ? "" : batch.afterId,
		enriched: enrichedNow,
		done,
	});

	summary.enriched = enrichedNow;
	summary.done = done;
	summary.target = stored || TOTAL_CLUBS;
	console.log(
		`[england-clubs-enrich] updated ${summary.updated} failed ${summary.failed} — ${enrichedNow}/${stored}${done ? " done" : ""}`,
	);
	return summary;
}
