/**
 * Karyam LinkedIn leads — compressed 3-layer agent.
 * 1) Google → LinkedIn profiles  2) Google enrich  3) LLM (+ optional re-scrape)
 *
 * Geo: default India (IN). Pass geo=world|us|uk|… or city=Bangalore via CLI/API.
 */

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import {
	firecrawlSearch,
	googleSearch,
	resolveResearchBaseUrl,
} from "../contentResearch/http.js";
import { scrapeUrl } from "../scrapefast.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import { isUseAiOn } from "../useAi.js";
import {
	dataForSeoLocationCode,
	fetchGoogleSerp,
	hasDataForSeoCredentials,
} from "../dataforseo.js";

export const AGENT = {
	id: "karyam-linkedin",
	name: "Karyam LinkedIn Leads",
	agency: "https://karyam.xyz",
	collection: "karyamLinkedInLeads",
	stateCollection: "karyamLinkedInState",
	queriesPerRun: Number(process.env.KARYAM_LI_QUERIES_PER_RUN || "3"),
	enrichPerRun: Number(process.env.KARYAM_LI_ENRICH_PER_RUN || "6"),
	relevanceMin: 4,
	model: process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4",
};

/** Bump when query templates change so cursor resets */
export const QUERY_SET_VERSION = 7;

/**
 * Geos for CLI --geo / API body.geo (default: in).
 * countryCode → Google gl= param. label → injected into search text (empty = worldwide).
 */
export const GEOS = [
	{ id: "in", label: "India", countryCode: "in", aliases: ["india", "IN"] },
	{
		id: "world",
		label: "",
		countryCode: "us",
		global: true,
		aliases: ["global", "all", "worldwide", "ww"],
	},
	{ id: "us", label: "United States", countryCode: "us", aliases: ["usa", "US"] },
	{ id: "uk", label: "United Kingdom", countryCode: "uk", aliases: ["gb", "UK"] },
	{ id: "ae", label: "UAE", countryCode: "ae", aliases: ["dubai", "uae"] },
	{ id: "sg", label: "Singapore", countryCode: "sg", aliases: ["singapore"] },
	{ id: "au", label: "Australia", countryCode: "au", aliases: ["australia"] },
	{ id: "ca", label: "Canada", countryCode: "ca", aliases: ["canada"] },
	{ id: "de", label: "Germany", countryCode: "de", aliases: ["germany"] },
	{ id: "nl", label: "Netherlands", countryCode: "nl", aliases: ["netherlands"] },
];

/** Optional city overlays (always available; filter with --city) */
export const CITIES = [
	{ id: "bangalore", label: "Bangalore", geoId: "in", aliases: ["bengaluru"] },
	{ id: "delhi-ncr", label: "Delhi", geoId: "in", aliases: ["delhi", "ncr", "delhi-ncr"] },
	{ id: "mumbai", label: "Mumbai", geoId: "in" },
	{ id: "pune", label: "Pune", geoId: "in" },
	{ id: "hyderabad", label: "Hyderabad", geoId: "in" },
	{ id: "jaipur", label: "Jaipur", geoId: "in" },
	{ id: "chennai", label: "Chennai", geoId: "in" },
	{ id: "sf", label: "San Francisco", geoId: "us", aliases: ["san francisco"] },
	{ id: "nyc", label: "New York", geoId: "us", aliases: ["new york"] },
	{ id: "london", label: "London", geoId: "uk" },
	{ id: "dubai", label: "Dubai", geoId: "ae" },
	{ id: "singapore-city", label: "Singapore", geoId: "sg" },
];

/**
 * Short intents — complex boolean + site:linkedin kills Google/DDG scrapers (0 hits).
 * We search for people pages with plain phrases, then filter LinkedIn URLs from SERP.
 */
const INTENTS = [
	{
		id: "mvp",
		kind: "mvp",
		phrases: [
			"startup founder looking for developers",
			"founder need MVP development",
			"CEO hire software development agency",
		],
	},
	{
		id: "saas",
		kind: "saas",
		phrases: [
			"SaaS founder CTO LinkedIn",
			"SaaS startup founder looking for developers",
			"building SaaS need tech partner",
		],
	},
	{
		id: "mobile-app",
		kind: "mobile-app",
		phrases: [
			"founder looking for app developers",
			"CEO need mobile app built",
			"startup hire React Native developers",
		],
	},
	{
		id: "nextjs",
		kind: "nextjs",
		phrases: [
			"founder Next.js developers agency",
			"CTO looking for React developers",
			"startup hire full stack developers",
		],
	},
	{
		id: "ai",
		kind: "ai-product",
		phrases: [
			"AI startup founder looking for engineers",
			"AI founder need MVP developers",
			"LLM startup CTO hire developers",
		],
	},
	{
		id: "outsource",
		kind: "outsourcing",
		phrases: [
			"founder outsource software development India",
			"CTO hire offshore development team",
			"looking for software development partner",
		],
	},
	{
		id: "ecommerce",
		kind: "ecommerce",
		phrases: [
			"D2C founder need custom ecommerce platform",
			"ecommerce startup hire developers",
			"online store founder looking for tech team",
		],
	},
	{
		id: "rebuild",
		kind: "rebuild",
		phrases: [
			"CTO rebuild app need development partner",
			"founder migrate to Next.js hire agency",
			"startup need tech team fractional CTO",
		],
	},
];

const LI_RE =
	/linkedin\.com\/(?:in|pub|profile)\/([A-Za-z0-9_%-]+)/i;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export function resolveGeo(input) {
	if (!input) return GEOS.find((g) => g.id === "in");
	const raw = String(input).trim().toLowerCase();
	return (
		GEOS.find(
			(g) =>
				g.id === raw ||
				(g.aliases || []).some((a) => String(a).toLowerCase() === raw),
		) || null
	);
}

export function resolveCity(input) {
	if (!input) return null;
	const raw = String(input).trim().toLowerCase();
	return (
		CITIES.find(
			(c) =>
				c.id === raw ||
				c.label.toLowerCase() === raw ||
				(c.aliases || []).some((a) => String(a).toLowerCase() === raw),
		) || null
	);
}

function placeLabel(geo, city) {
	if (city) return city.label;
	if (geo?.global) return "";
	return geo?.label || "India";
}

/** Build SERP variants — Firecrawl handles site:linkedin; keep plain fallbacks too */
function queryVariants(intent, place) {
	const placePart = place ? ` ${place}` : "";
	const geoPlace = place || "India";
	const base = intent.phrases[0] || "startup founder developers";
	const alt = intent.phrases[1] || base;
	return [
		// Firecrawl returns real /in/ hits for site: queries (Puppeteer/DDG do not)
		`site:linkedin.com/in founder ${intent.kind || "startup"} ${geoPlace}`,
		`site:linkedin.com/in ${base}`,
		`site:in.linkedin.com/in ${alt}`,
		`${base}${placePart} linkedin.com/in`,
	].filter(Boolean);
}

/**
 * @param {{ geo?: string, city?: string }} [opts]
 */
export function buildQueries(opts = {}) {
	const geo = resolveGeo(opts.geo || "in") || GEOS[0];
	const city = opts.city ? resolveCity(opts.city) : null;
	const out = [];

	const pushIntent = (intent, place, meta) => {
		const variants = queryVariants(intent, place);
		out.push({
			id: `li-${meta.idSuffix}-${intent.id}`,
			geoId: meta.geoId,
			city: place || meta.cityLabel || "Worldwide",
			countryCode: meta.countryCode,
			kind: intent.kind,
			intent: intent.id,
			query: variants[0],
			variants,
		});
	};

	if (city) {
		for (const intent of INTENTS) {
			pushIntent(intent, city.label, {
				idSuffix: city.id,
				geoId: city.geoId || geo.id,
				countryCode: resolveGeo(city.geoId)?.countryCode || geo.countryCode,
				cityLabel: city.label,
			});
		}
		return out;
	}

	if (geo.global) {
		for (const intent of INTENTS) {
			pushIntent(intent, "", {
				idSuffix: "world",
				geoId: "world",
				countryCode: "us",
				cityLabel: "Worldwide",
			});
		}
		for (const c of CITIES.filter((x) => x.geoId !== "in").slice(0, 4)) {
			for (const intent of INTENTS.slice(0, 3)) {
				pushIntent(intent, c.label, {
					idSuffix: c.id,
					geoId: c.geoId,
					countryCode: resolveGeo(c.geoId)?.countryCode || "us",
					cityLabel: c.label,
				});
			}
		}
		return out;
	}

	// Country-wide first (India) — do NOT burn hours on every city with empty site: queries
	const place = geo.label || "India";
	for (const intent of INTENTS) {
		pushIntent(intent, place, {
			idSuffix: geo.id,
			geoId: geo.id,
			countryCode: geo.countryCode,
			cityLabel: place,
		});
	}
	// Only top 3 cities for this country (optional depth)
	for (const c of CITIES.filter((x) => x.geoId === geo.id).slice(0, 3)) {
		for (const intent of INTENTS.slice(0, 4)) {
			pushIntent(intent, c.label, {
				idSuffix: c.id,
				geoId: geo.id,
				countryCode: geo.countryCode,
				cityLabel: c.label,
			});
		}
	}
	return out;
}

/** Default India query set (backward compatible export) */
export const ALL_QUERIES = buildQueries({ geo: "in" });

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

function docId(lead) {
	const key =
		lead.linkedinUrl ||
		lead.linkedinHandle ||
		lead.email ||
		`${lead.name}|${lead.city}|${lead.kind}`;
	return createHash("sha256")
		.update(String(key).toLowerCase().trim())
		.digest("hex")
		.slice(0, 32);
}

function seenKey(lead) {
	if (lead.linkedinHandle) return `li:${lead.linkedinHandle.toLowerCase()}`;
	if (lead.email) return `e:${lead.email.toLowerCase()}`;
	if (lead.sourceUrl) return `u:${String(lead.sourceUrl).toLowerCase()}`;
	return `n:${String(lead.name || "").toLowerCase()}|${lead.city || ""}|${lead.intent || ""}`;
}

function emailsFrom(text) {
	return [
		...new Set(
			(String(text || "").match(EMAIL_RE) || [])
				.map((e) => e.toLowerCase())
				.filter((e) => !/example\.com|noreply|sentry|wixpress|\.png$/i.test(e)),
		),
	];
}

function guessNameFromTitle(title) {
	const t = String(title || "")
		.replace(/\s*[|\-–—].*$/, "")
		.replace(/\s+-\s+LinkedIn.*$/i, "")
		.replace(/\s+on\s+LinkedIn.*$/i, "")
		.trim();
	if (!t || t.length < 3 || t.length > 80) return "";
	// Prefer "Name - Title at Company" patterns
	const m = t.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})\b/);
	if (m) return m[1];
	return t.slice(0, 60);
}

function fromSerp(row, meta) {
	const url = unwrapUrl(row.url || row.link || "");
	const blob = `${row.title || ""}\n${row.snippet || ""}\n${url}`;
	let m = url.match(LI_RE);
	if (!m) m = blob.match(LI_RE);

	const title = String(row.title || "")
		.replace(/\s*[|\-–—].*$/, "")
		.replace(/\s+-\s+LinkedIn.*$/i, "")
		.trim();
	const snippet = String(row.snippet || "").trim();
	const emails = emailsFrom(`${title} ${snippet}`);

	if (m) {
		const handle = decodeURIComponent(m[1]).replace(/\/$/, "");
		if (!handle || /^(pub|dir|company|school)$/i.test(handle)) return null;
		return {
			name: title.slice(0, 80) || handle,
			title,
			snippet,
			linkedinHandle: handle,
			linkedinUrl: `https://www.linkedin.com/in/${handle}`,
			sourceUrl: url.startsWith("http")
				? url
				: `https://www.linkedin.com/in/${handle}`,
			city: meta.city || null,
			geoId: meta.geoId || null,
			countryCode: meta.countryCode || "in",
			kind: meta.kind || null,
			intent: meta.intent || null,
			searchQuery: meta.query || null,
			emails,
			email: emails[0] || null,
			phone: null,
			website: !/linkedin\.com/i.test(url) ? url : null,
			businessName: null,
		};
	}

	// No LinkedIn URL yet — keep founder-like SERP hits for LinkedIn enrich pass
	const looksFounder =
		/\b(founder|co-?founder|ceo|cto|startup|saas|mvp|building)\b/i.test(blob);
	if (!looksFounder) return null;
	const name = guessNameFromTitle(title);
	if (!name) return null;
	return {
		name,
		title,
		snippet,
		linkedinHandle: null,
		linkedinUrl: null,
		sourceUrl: url || null,
		city: meta.city || null,
		geoId: meta.geoId || null,
		countryCode: meta.countryCode || "in",
		kind: meta.kind || null,
		intent: meta.intent || null,
		searchQuery: meta.query || null,
		emails,
		email: emails[0] || null,
		phone: null,
		website: url && !/linkedin\.com|facebook\.com|twitter\.com|x\.com/i.test(url) ? url : null,
		businessName: null,
		needsLinkedInLookup: true,
	};
}

function cursorDocId(geoId, cityId) {
	return `${AGENT.id}:${geoId || "in"}${cityId ? `:${cityId}` : ""}`;
}

async function loadCursor(cursorKey) {
	const snap = await firestore
		.collection(AGENT.stateCollection)
		.doc(cursorKey)
		.get();
	const data = snap.data() || {};
	if (Number(data.querySetVersion) !== QUERY_SET_VERSION) {
		await saveCursor(cursorKey, 0);
		return 0;
	}
	return Number(data.lastQueryIndex) || 0;
}

async function saveCursor(cursorKey, i) {
	await firestore
		.collection(AGENT.stateCollection)
		.doc(cursorKey)
		.set(
			{
				agentId: AGENT.id,
				cursorKey,
				lastQueryIndex: i,
				querySetVersion: QUERY_SET_VERSION,
				updatedAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
}

async function exists(lead) {
	const snap = await firestore.collection(AGENT.collection).doc(docId(lead)).get();
	return snap.exists;
}

async function save(lead) {
	const id = docId(lead);
	const ref = firestore.collection(AGENT.collection).doc(id);
	const prev = await ref.get();
	const plain = JSON.parse(JSON.stringify({ ...lead, id }));
	plain.updatedAt = new Date().toISOString();
	if (!prev.exists) plain.createdAt = FieldValue.serverTimestamp();
	await ref.set(plain, { merge: true });
	return id;
}

async function searchBing(query, maxResults = 10) {
	const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(15_000),
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
				Accept: "text/html,application/xhtml+xml",
				"Accept-Language": "en-US,en;q=0.9",
			},
		});
		if (!res.ok) return [];
		const html = await res.text();
		const out = [];
		const re =
			/<li class="b_algo"[\s\S]*?<h2>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
		let m;
		while ((m = re.exec(html)) && out.length < maxResults) {
			const href = m[1];
			const title = String(m[2] || "")
				.replace(/<[^>]+>/g, "")
				.replace(/\s+/g, " ")
				.trim();
			out.push({
				title,
				url: href,
				link: href,
				snippet: "",
				source: "bing",
			});
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Multi-engine discovery.
 * Prefer Firecrawl (handles site:linkedin). CSE/DataForSEO/Puppeteer/Wiza are backups.
 */
async function searchLinkedIn(job, { baseUrl, countryCode }) {
	const variants = job.variants?.length
		? job.variants
		: [job.query].filter(Boolean);
	const countries = [countryCode || "in", "us"].filter(
		(c, i, a) => a.indexOf(c) === i,
	);
	const diagnostics = [];

	const useDfs = hasDataForSeoCredentials();
	const qs = variants.slice(0, 3);

	for (const q of qs) {
		// Firecrawl first — only reliable engine right now for LinkedIn SERP
		try {
			const fc = await firecrawlSearch(q, {
				num: 10,
				country: countries[0],
			});
			console.log(
				`[karyam-li:1] serp n=${fc.results?.length || 0} eng=firecrawl q=${q.slice(0, 90)}…`,
			);
			if (fc.results?.length) return { rows: fc.results, diagnostics };
			if (fc.error) diagnostics.push(`firecrawl:${fc.error}`);
			else diagnostics.push("firecrawl=0");
		} catch (err) {
			diagnostics.push(`firecrawl:${err?.message || err}`);
			console.warn(`[karyam-li:1] firecrawl error:`, err?.message || err);
		}

		if (useDfs) {
			for (const country of countries.slice(0, 1)) {
				try {
					const locationCode = dataForSeoLocationCode(country);
					const rows = await fetchGoogleSerp(q, {
						locationCode,
						languageCode: "en",
						depth: 10,
					});
					console.log(
						`[karyam-li:1] serp n=${rows.length} eng=dataforseo loc=${locationCode} q=${q.slice(0, 90)}…`,
					);
					if (rows.length) return { rows, diagnostics };
					diagnostics.push(`dataforseo:${country}=0`);
				} catch (err) {
					diagnostics.push(`dataforseo:${err?.message || err}`);
					console.warn(`[karyam-li:1] dataforseo error:`, err?.message || err);
				}
			}
		}

		for (const country of countries) {
			try {
				const rows = await googleSearch(q, {
					baseUrl,
					num: 10,
					country,
					language: "en",
					useProxy: true,
					debug: true,
				});
				console.log(
					`[karyam-li:1] serp n=${rows.length} eng=google country=${country} q=${q.slice(0, 90)}…`,
				);
				if (rows.length) return { rows, diagnostics };
				diagnostics.push(`google:${country}=0`);
			} catch (err) {
				diagnostics.push(`google:${err?.message || err}`);
				console.warn(`[karyam-li:1] google error:`, err?.message || err);
			}
		}

		const bing = await searchBing(q, 10);
		console.log(
			`[karyam-li:1] serp n=${bing.length} eng=bing q=${q.slice(0, 90)}…`,
		);
		if (bing.length) return { rows: bing, diagnostics };
		diagnostics.push("bing=0");
	}

	// Composio Wiza — real LinkedIn people search when SERP is dead
	try {
		const {
			executeComposioTool,
			getLinkedInSearchToolSlug,
			buildSearchToolArguments,
			extractLeadsFromToolResult,
		} = await import("../composioClient.js");
		if (process.env.COMPOSIO_API_KEY?.trim()) {
			const slug = getLinkedInSearchToolSlug();
			const place =
				job.city && job.city !== "Worldwide" && job.city !== "India"
					? job.city
					: "India";
			const args = buildSearchToolArguments(
				{
					jobTitle: "Founder",
					location: place,
					limit: 10,
				},
				slug,
			);
			args.filters = {
				...(args.filters || {}),
				job_titles: ["Founder", "CEO", "CTO", "Co-Founder"],
				locations: [place, "India"].filter(
					(v, i, a) => a.indexOf(v) === i,
				),
			};
			const exec = await executeComposioTool(slug, args);
			const leads = extractLeadsFromToolResult(exec);
			console.log(
				`[karyam-li:1] composio ${slug} n=${leads.length} place=${place}`,
			);
			if (leads.length) {
				const rows = leads.map((l) => ({
					title: `${l.name || ""} - ${l.title || l.headline || ""}`.trim(),
					url: l.linkedinUrl || l.linkedin_url || "",
					link: l.linkedinUrl || l.linkedin_url || "",
					snippet: [l.company, l.location, l.headline]
						.filter(Boolean)
						.join(" · "),
					source: "composio-wiza",
				}));
				return { rows, diagnostics };
			}
			diagnostics.push(`composio:${slug}=0`);
		}
	} catch (err) {
		diagnostics.push(`composio:${err?.message || err}`);
		console.warn(`[karyam-li:1] composio error:`, err?.message || err);
	}

	return { rows: [], diagnostics };
}

async function resolveLinkedInUrl(lead, baseUrl) {
	if (lead.linkedinUrl) return lead;
	const q = `"${lead.name}" ${lead.city || "India"} (founder OR CEO OR CTO) site:linkedin.com/in`;
	const rows = await googleSearch(q, {
		baseUrl,
		num: 5,
		country: lead.countryCode || "us",
		useProxy: true,
	});
	for (const row of rows) {
		const url = unwrapUrl(row.url || row.link || "");
		const m = url.match(LI_RE) || `${row.title} ${row.snippet}`.match(LI_RE);
		if (!m) continue;
		const handle = decodeURIComponent(m[1]).replace(/\/$/, "");
		return {
			...lead,
			linkedinHandle: handle,
			linkedinUrl: `https://www.linkedin.com/in/${handle}`,
			needsLinkedInLookup: false,
		};
	}
	// Broader without site:
	const rows2 = await googleSearch(
		`"${lead.name}" founder LinkedIn ${lead.city || "India"}`,
		{ baseUrl, num: 5, country: "us", useProxy: true },
	);
	for (const row of rows2) {
		const blob = `${row.title}\n${row.snippet}\n${unwrapUrl(row.url || row.link)}`;
		const m = blob.match(LI_RE);
		if (!m) continue;
		const handle = decodeURIComponent(m[1]).replace(/\/$/, "");
		return {
			...lead,
			linkedinHandle: handle,
			linkedinUrl: `https://www.linkedin.com/in/${handle}`,
			needsLinkedInLookup: false,
		};
	}
	return lead;
}

async function enrichViaGoogle(lead, baseUrl) {
	const place = lead.city && lead.city !== "Worldwide" ? lead.city : "";
	const q = `"${lead.name}" ${place} (founder OR CTO OR startup) (email OR contact OR website OR "${lead.linkedinHandle || ""}") software OR SaaS OR MVP`;
	const results = await googleSearch(q, {
		baseUrl,
		num: 5,
		country: lead.countryCode || "in",
	});
	const emails = new Set(lead.emails || []);
	let website = lead.website;
	let phone = lead.phone;
	const blobs = [];
	for (const row of results) {
		const blob = `${row.title}\n${row.snippet}\n${unwrapUrl(row.url || row.link)}`;
		blobs.push(blob);
		for (const e of emailsFrom(blob)) emails.add(e);
		const w = blob.match(/(?:website|site)[:\s]+(https?:\/\/[^\s)<>]+)/i);
		if (w && !/linkedin\.com/i.test(w[1])) website = w[1].replace(/\/$/, "");
		const p = blob.match(
			/(?:\+91[\s-]?)?[6-9]\d{9}|\+\d{1,3}[\s-]?\d{8,12}/,
		);
		if (p && !phone) phone = p[0];
	}
	const external = results.find((r) => {
		const u = unwrapUrl(r.url || r.link || "");
		return u && !/linkedin\.com/i.test(u);
	});
	if (external?.url || external?.link) {
		try {
			const page = await scrapeUrl(unwrapUrl(external.url || external.link), {
				baseUrl,
				timeoutMs: 40_000,
				includeImages: false,
			});
			const text = `${page.markdown || ""}\n${page.title || ""}`;
			blobs.push(text.slice(0, 4000));
			for (const e of emailsFrom(text)) emails.add(e);
		} catch {
			/* ignore */
		}
	}
	return {
		...lead,
		emails: [...emails],
		email: lead.email || [...emails][0] || null,
		website: website || lead.website,
		phone: phone || lead.phone,
		enrichmentText: blobs.join("\n---\n").slice(0, 8000),
	};
}

async function llmScore(leads) {
	if (!leads.length) return [];
	const { content } = await openRouterChat({
		model: AGENT.model,
		jsonMode: true,
		temperature: 0.2,
		maxTokens: 3500,
		messages: [
			{
				role: "system",
				content: `You score LinkedIn leads for Karyam (karyam.xyz) — a SOFTWARE DEVELOPMENT agency (web apps, mobile apps, MVP, Next.js/React, custom software).

Ideal leads: founders, CEOs, CTOs, product owners who need to BUILD or OUTSOURCE software (MVP, SaaS, mobile app, custom platform) — India or global.
NOT ideal: cafe/restaurant/salon owners, pure marketers, recruiters hiring employees (unless hiring an agency), students, job seekers.

Score 1-5 (5 = actively needs development partner / MVP / app build).
Return JSON:
{ "results": [{ "id": "", "score": 0, "reason": "", "name": "", "businessName": "", "needDev": true, "draftMessage": "", "missing": [], "rescrapeQueries": [] }] }
draftMessage: short founder-to-founder note about helping build their product (not spammy).
missing: email, phone, website, company…
rescrapeQueries: up to 2 Google queries to fill gaps (empty if enough).
Include every id.`,
			},
			{
				role: "user",
				content: JSON.stringify(
					leads.map((l) => ({
						id: l.id || docId(l),
						name: l.name,
						title: l.title,
						snippet: l.snippet,
						city: l.city,
						geoId: l.geoId,
						kind: l.kind,
						intent: l.intent,
						linkedinUrl: l.linkedinUrl,
						emails: l.emails,
						phone: l.phone,
						website: l.website,
						enrichmentText: String(l.enrichmentText || "").slice(0, 2000),
					})),
				),
			},
		],
	});
	try {
		const raw = parseJsonFromLLM(content);
		return Array.isArray(raw.results) ? raw.results : [];
	} catch {
		return leads.map((l) => ({
			id: l.id || docId(l),
			score: 0,
			reason: "llm_parse_failed",
			rescrapeQueries: [],
		}));
	}
}

async function rescrapeMissing(lead, queries, baseUrl) {
	if (!queries?.length) return lead;
	const emails = new Set(lead.emails || []);
	let website = lead.website;
	let phone = lead.phone;
	const blobs = [lead.enrichmentText || ""];
	for (const q of queries.slice(0, 2)) {
		try {
			const results = await googleSearch(q, {
				baseUrl,
				num: 5,
				country: lead.countryCode || "in",
			});
			for (const row of results) {
				const blob = `${row.title}\n${row.snippet}\n${unwrapUrl(row.url || "")}`;
				blobs.push(blob);
				for (const e of emailsFrom(blob)) emails.add(e);
				if (!website) {
					const u = unwrapUrl(row.url || row.link || "");
					if (u && !/linkedin\.com|facebook\.com|instagram\.com/i.test(u)) {
						website = u.replace(/\/$/, "");
					}
				}
				const p = blob.match(
					/(?:\+91[\s-]?)?[6-9]\d{9}|\+\d{1,3}[\s-]?\d{8,12}/,
				);
				if (p && !phone) phone = p[0];
			}
		} catch {
			/* ignore */
		}
	}
	return {
		...lead,
		emails: [...emails],
		email: lead.email || [...emails][0] || null,
		website: website || lead.website,
		phone: phone || lead.phone,
		enrichmentText: blobs.join("\n").slice(0, 8000),
	};
}

/**
 * @param {{
 *   baseUrl?: string,
 *   queriesPerRun?: number,
 *   geo?: string,
 *   city?: string,
 *   useAI?: boolean,
 * }} [opts]
 */
export async function runKaryamLinkedInAgent(opts = {}) {
	const baseUrl = opts.baseUrl || resolveResearchBaseUrl();
	const perRun = opts.queriesPerRun ?? AGENT.queriesPerRun;
	const useAI = isUseAiOn(opts);
	const geo = resolveGeo(opts.geo || "in");
	if (opts.geo && !geo) {
		throw new Error(
			`Unknown geo "${opts.geo}". Use: ${GEOS.map((g) => g.id).join(", ")}`,
		);
	}
	const city = opts.city ? resolveCity(opts.city) : null;
	if (opts.city && !city) {
		throw new Error(
			`Unknown city "${opts.city}". Use: ${CITIES.map((c) => c.id).join(", ")}`,
		);
	}

	const queryPool = buildQueries({
		geo: geo?.id || "in",
		city: city?.id,
	});
	const cursorKey = cursorDocId(geo?.id || "in", city?.id);
	const cursor = await loadCursor(cursorKey);
	const batch = [];
	for (let i = 0; i < perRun; i++) {
		batch.push(queryPool[(cursor + i) % queryPool.length]);
	}
	await saveCursor(cursorKey, (cursor + perRun) % queryPool.length);

	const summary = {
		agentId: AGENT.id,
		collection: AGENT.collection,
		geo: geo?.id || "in",
		city: city?.id || null,
		place: placeLabel(geo, city) || "Worldwide",
		queriesRun: batch.map((q) => q.id),
		candidates: 0,
		newLeads: 0,
		saved: 0,
		useAI,
		relevant: [],
		errors: [],
	};

	const seen = new Map();
	const candidates = [];
	const allDiagnostics = [];

	for (const job of batch) {
		try {
			console.log(`[karyam-li:1] ${job.query}`);
			const searched = await searchLinkedIn(job, {
				baseUrl,
				countryCode: job.countryCode || geo?.countryCode || "in",
			});
			const rows = Array.isArray(searched) ? searched : searched?.rows || [];
			if (searched?.diagnostics?.length) {
				allDiagnostics.push(...searched.diagnostics);
			}
			let matched = 0;
			for (const row of rows) {
				const c = fromSerp(row, job);
				if (!c) continue;
				matched += 1;
				const k = seenKey(c);
				if (seen.has(k)) continue;
				seen.set(k, true);
				candidates.push(c);
			}
			if (rows.length && !matched) {
				console.warn(
					`[karyam-li:1] ${rows.length} SERP hits but 0 usable matches (sample: ${(rows[0]?.url || rows[0]?.link || rows[0]?.title || "").slice(0, 80)})`,
				);
			}
		} catch (err) {
			summary.errors.push({
				stage: "discover",
				error: err?.message || String(err),
			});
		}
	}
	summary.candidates = candidates.length;
	summary.diagnostics = [...new Set(allDiagnostics)].slice(0, 24);

	if (!candidates.length) {
		summary.hint =
			"SERP returned 0 hits. Need FIRECRAWL_API_KEY (preferred) or renew GOOGLE_API_KEY (CSE expired) / verify DataForSEO / top up Wiza api_credits (0). Keep npm run dev on :3002 for enrich scrapes.";
		console.warn(`[karyam-li] ${summary.hint}`);
	}

	const fresh = [];
	for (const c of candidates) {
		if (await exists(c)) continue;
		fresh.push(c);
	}
	summary.newLeads = fresh.length;

	// Resolve LinkedIn URLs for founder SERP hits missing /in/
	const withLi = [];
	for (const c of fresh.slice(0, AGENT.enrichPerRun)) {
		try {
			let lead = c;
			if (c.needsLinkedInLookup || !c.linkedinUrl) {
				console.log(`[karyam-li:1b] linkedin lookup ${c.name}`);
				lead = await resolveLinkedInUrl(c, baseUrl);
			}
			withLi.push(lead);
		} catch {
			withLi.push(c);
		}
	}
	withLi.push(...fresh.slice(AGENT.enrichPerRun));

	const enriched = [];
	for (const c of withLi.slice(0, AGENT.enrichPerRun)) {
		try {
			console.log(`[karyam-li:2] enrich ${c.name}`);
			enriched.push(await enrichViaGoogle(c, baseUrl));
		} catch {
			enriched.push(c);
		}
	}
	enriched.push(...withLi.slice(AGENT.enrichPerRun));

	const toScore = enriched.map((c) => ({
		...c,
		id: docId(c),
		fetchedAt: new Date().toISOString(),
	}));

	for (let i = 0; i < toScore.length; i += 8) {
		const chunk = toScore.slice(i, i + 8);
		let scored = [];
		if (useAI) {
			try {
				console.log(`[karyam-li:3] llm ${chunk.length}`);
				scored = await llmScore(chunk);
			} catch (err) {
				summary.errors.push({ stage: "llm", error: err?.message || String(err) });
			}
		} else {
			console.log(
				`[karyam-li:3] scrape-only ${chunk.length} (pass --use-ai to score)`,
			);
		}

		for (const lead of chunk) {
			let match = scored.find((s) => s.id === lead.id) || {};
			let doc = { ...lead };

			if (useAI && match.rescrapeQueries?.length) {
				try {
					console.log(`[karyam-li:3b] rescrape ${lead.name}`);
					doc = await rescrapeMissing(doc, match.rescrapeQueries, baseUrl);
					const again = await llmScore([doc]);
					match = again[0] || match;
				} catch {
					/* keep first score */
				}
			}

			const score = Number(match.score) || 0;
			doc.name = match.name || doc.name;
			doc.businessName = match.businessName || doc.businessName;
			doc.relevanceScore = score;
			doc.score = score;
			doc.relevanceReason = match.reason || (useAI ? "" : "scrape_only");
			doc.needDev = match.needDev !== false;
			doc.needWebsite = doc.needDev;
			doc.draftMessage = match.draftMessage || "";
			doc.missing = match.missing || [];
			delete doc.enrichmentText;

			await save(doc);
			summary.saved += 1;
			if (!useAI || score >= AGENT.relevanceMin) {
				summary.relevant.push({
					id: doc.id,
					name: doc.name,
					businessName: doc.businessName,
					city: doc.city,
					geoId: doc.geoId,
					kind: doc.kind,
					intent: doc.intent,
					linkedinUrl: doc.linkedinUrl,
					email: doc.email,
					phone: doc.phone,
					website: doc.website,
					score,
					needDev: doc.needDev,
					draftMessage: doc.draftMessage,
				});
			}
		}
	}

	console.log(
		`[karyam-li] done — geo=${summary.geo} city=${summary.city || "-"} ${summary.candidates} candidates, ${summary.saved} saved, ${summary.relevant.length} relevant → ${AGENT.collection}`,
	);
	return summary;
}

export async function listLeads({ minScore = 0, limit = 50, geo, city } = {}) {
	const snap = await firestore
		.collection(AGENT.collection)
		.where("relevanceScore", ">=", minScore)
		.get();
	let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	if (geo) {
		const g = resolveGeo(geo);
		const gid = g?.id || String(geo).toLowerCase();
		rows = rows.filter((r) => String(r.geoId || "").toLowerCase() === gid);
	}
	if (city) {
		const c = resolveCity(city);
		const label = (c?.label || city).toLowerCase();
		rows = rows.filter((r) => String(r.city || "").toLowerCase().includes(label));
	}
	rows.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
	return rows.slice(0, limit);
}
