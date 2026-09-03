/**
 * Company seed + blog topics + AI visibility.
 *
 * POST /company-seed          scrape via /scrape|/scrape-multiple, store schema
 * GET  /company-seed/:userId
 * GET  /company-seed/:userId/:sourceId
 * POST /blog-topics           rerun daily; reuses seed; Sonar for demand/keywords
 * POST /ai-visibility         few competitors + visibility brief (Sonar, domain-scoped)
 */

import { Hono } from "hono";
import { createHash } from "node:crypto";
import { firestore } from "../config/firebase.js";
import {
	normalizeOpenRouterUsage,
	mergeOpenRouterUsage,
	toTokenUsageCamel,
} from "./openRouterUsage.js";

export const companySeedRouter = new Hono();

const COLLECTION = "companySeeds";
const MARKDOWN_MAX = 12_000;
const SNIPPET_MAX = 8_000;
const MAX_URLS = 8;
const SCRAPE_TIMEOUT_MS = 180_000;
const SONAR_TIMEOUT_MS = 120_000;
const LLM_TIMEOUT_MS = 90_000;

const SONAR_MODEL =
	process.env.OPENROUTER_SONAR_MODEL || "perplexity/sonar-pro";
const SCHEMA_MODEL =
	process.env.OPENROUTER_MODEL ||
	process.env.OPENROUTER_AGENT_MODEL ||
	"google/gemini-2.5-flash";

const COMMUNITY_DOMAINS = [
	"reddit.com",
	"youtube.com",
	"x.com",
	"twitter.com",
];
const COMPETITOR_DOMAINS = [
	"g2.com",
	"capterra.com",
	"trustradius.com",
	"producthunt.com",
	"reddit.com",
];

function openRouterKey() {
	const key = process.env.OPENROUTER_API_KEY?.trim();
	if (!key) {
		throw new Error("OPENROUTER_API_KEY is required");
	}
	return key;
}

function scrapeBaseUrl(c) {
	const envHint = (
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		""
	).trim();
	if (envHint) return envHint.replace(/\/$/, "");
	try {
		const origin = new URL(c.req.url).origin;
		if (origin && origin !== "null") return origin;
	} catch {
		/* ignore */
	}
	return `http://127.0.0.1:${process.env.PORT || 3002}`;
}

function assertPublicHttpUrl(urlString) {
	let u;
	try {
		u = new URL(urlString);
	} catch {
		throw new Error(`Invalid URL: ${urlString}`);
	}
	if (!["http:", "https:"].includes(u.protocol)) {
		throw new Error("Only http(s) URLs are allowed");
	}
	const host = u.hostname.toLowerCase();
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "0.0.0.0" ||
		host.startsWith("127.") ||
		host === "::1" ||
		host.startsWith("169.254.") ||
		host.startsWith("10.") ||
		host.startsWith("192.168.")
	) {
		throw new Error("Private / local URLs are not allowed");
	}
	return u;
}

function canonicalUrl(raw) {
	const u = assertPublicHttpUrl(raw);
	u.hash = "";
	u.search = "";
	u.hostname = u.hostname.replace(/^www\./i, "").toLowerCase();
	u.pathname = u.pathname.replace(/\/+$/, "") || "/";
	return `${u.protocol}//${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
}

function hostOf(raw) {
	try {
		return new URL(canonicalUrl(raw)).hostname;
	} catch {
		return "";
	}
}

function sourceIdFor(raw) {
	return createHash("sha256").update(canonicalUrl(raw)).digest("hex").slice(0, 16);
}

function userDocRef(userId) {
	return firestore.collection(COLLECTION).doc(userId);
}

function sourceDocRef(userId, sourceId) {
	return userDocRef(userId).collection("sources").doc(sourceId);
}

function stripUndefined(value) {
	if (Array.isArray(value)) return value.map(stripUndefined);
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			if (v === undefined) continue;
			out[k] = stripUndefined(v);
		}
		return out;
	}
	return value;
}

function parseJsonFromLLM(text) {
	let s = String(text || "").trim();
	if (!s) throw new Error("Empty LLM content");
	const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
	if (fence) s = fence[1].trim();
	const objFirst = s.indexOf("{");
	const objLast = s.lastIndexOf("}");
	const arrFirst = s.indexOf("[");
	const arrLast = s.lastIndexOf("]");
	if (objFirst !== -1 && objLast > objFirst) {
		// Prefer object unless the payload is clearly a root array
		if (arrFirst !== -1 && arrFirst < objFirst && arrLast > arrFirst) {
			s = s.slice(arrFirst, arrLast + 1);
		} else {
			s = s.slice(objFirst, objLast + 1);
		}
	} else if (arrFirst !== -1 && arrLast > arrFirst) {
		s = s.slice(arrFirst, arrLast + 1);
	}
	return JSON.parse(s);
}

/** Parse LLM JSON without throwing; returns { ok, value, error, rawPreview }. */
function tryParseJsonFromLLM(text) {
	const raw = String(text || "");
	try {
		return {
			ok: true,
			value: parseJsonFromLLM(raw),
			error: null,
			rawPreview: raw.slice(0, 400),
		};
	} catch (err) {
		return {
			ok: false,
			value: null,
			error: err?.message || "json_parse_failed",
			rawPreview: raw.slice(0, 400),
		};
	}
}

function normalizeKeywordList(raw) {
	if (!raw) return [];
	if (Array.isArray(raw)) {
		return raw
			.map((p) => {
				if (typeof p === "string") return { phrase: p.trim() };
				if (p && typeof p === "object") {
					const phrase = String(
						p.phrase || p.keyword || p.query || p.text || "",
					).trim();
					if (!phrase) return null;
					return {
						phrase,
						intent: p.intent || undefined,
						source: p.source || undefined,
					};
				}
				return null;
			})
			.filter(Boolean);
	}
	if (typeof raw === "object") {
		return normalizeKeywordList(
			raw.keywords || raw.phrases || raw.items || raw.keyword_phrases,
		);
	}
	return [];
}

function normalizeTopicList(raw) {
	if (!raw) return [];
	const list = Array.isArray(raw)
		? raw
		: Array.isArray(raw.topics)
			? raw.topics
			: Array.isArray(raw.ideas)
				? raw.ideas
				: [];
	return list
		.map((t) => {
			if (typeof t === "string") {
				return {
					title: t.trim(),
					angle: "",
					primaryKeyword: "",
					supporting: [],
					whyNow: "",
					novelty: "new",
				};
			}
			if (!t || typeof t !== "object") return null;
			const title = String(t.title || t.topic || t.headline || "").trim();
			if (!title) return null;
			return {
				title,
				angle: String(t.angle || t.summary || "").trim(),
				primaryKeyword: String(t.primaryKeyword || t.keyword || "").trim(),
				supporting: Array.isArray(t.supporting)
					? t.supporting.map(String)
					: [],
				whyNow: String(t.whyNow || t.why || "").trim(),
				novelty: t.novelty === "existing" ? "existing" : "new",
			};
		})
		.filter(Boolean);
}

/** Build keyword phrases from company seed when Sonar/Gemini return nothing. */
function keywordsFromSeed(seed, keywordHint = "") {
	const s = seed.schema || {};
	const out = [];
	const push = (phrase, intent = "informational", source = "seed") => {
		const p = String(phrase || "").trim();
		if (!p || p.length < 3) return;
		out.push({ phrase: p.slice(0, 120), intent, source });
	};
	if (keywordHint) push(keywordHint, "commercial", "user");
	for (const prod of s.products || []) push(prod, "commercial", "seed");
	for (const t of s.existingTopics || []) push(t, "informational", "seed");
	for (const d of s.differentiators || []) push(d, "commercial", "seed");
	if (s.category) push(s.category, "informational", "seed");
	if (s.oneLiner) {
		const short = s.oneLiner.split(/[.!?]/)[0]?.trim();
		if (short) push(short, "informational", "seed");
	}
	if (s.brandName) {
		push(`${s.brandName} tutorial`, "informational", "seed");
		push(`${s.brandName} alternatives`, "comparison", "seed");
	}
	// Dedupe by lowercase phrase
	const seen = new Set();
	return out.filter((k) => {
		const key = k.phrase.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	}).slice(0, 20);
}

/** Deterministic topic ideas from seed + keywords when LLM returns none. */
function topicsFromSeedAndKeywords(seed, keywords = [], keywordHint = "") {
	const s = seed.schema || {};
	const brand = s.brandName || seed.host || "this product";
	const phrases = (keywords || [])
		.map((k) => (typeof k === "string" ? k : k.phrase))
		.filter(Boolean);
	const products = (s.products || []).slice(0, 6);
	const topics = [];

	const add = (title, angle, primaryKeyword, whyNow) => {
		if (!title) return;
		topics.push({
			title,
			angle,
			primaryKeyword: primaryKeyword || phrases[0] || brand,
			supporting: phrases.slice(0, 3),
			whyNow,
			novelty: "new",
		});
	};

	if (keywordHint) {
		add(
			`How ${brand} helps with ${keywordHint}`,
			`Practical guide tying ${brand} to ${keywordHint}`,
			keywordHint,
			"Matches the angle you requested",
		);
	}
	for (const prod of products) {
		add(
			`${prod}: what it is and who it's for`,
			`Explain the product clearly for SEO and first-time visitors`,
			prod,
			"Grounded in your product list",
		);
		add(
			`Building with ${prod} — a practical starter guide`,
			`Hands-on content that ranks for builder intent`,
			`${prod} guide`,
			"Tutorial-style posts convert and rank",
		);
	}
	for (const phrase of phrases.slice(0, 8)) {
		add(
			`${phrase}: a complete guide for ${s.audience || "builders"}`,
			`Long-form SEO post around "${phrase}"`,
			phrase,
			"Derived from research/seed keywords",
		);
	}
	if (s.differentiators?.length) {
		add(
			`Why ${brand} is different: ${s.differentiators[0]}`,
			"Comparison/positioning content for commercial intent",
			`${brand} vs alternatives`,
			"Highlights your differentiators",
		);
	}
	add(
		`${brand} vs alternatives — how to choose in ${new Date().getFullYear()}`,
		"Comparison post for buyers researching options",
		`${brand} alternatives`,
		"Comparison queries convert",
	);

	const seen = new Set();
	return topics
		.filter((t) => {
			const key = t.title.toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, 12);
}

/** Pull quoted / bullet phrases from Sonar prose when JSON extract is empty. */
function keywordsFromResearchText(...texts) {
	const out = [];
	const seen = new Set();
	const push = (phrase, source) => {
		const p = String(phrase || "")
			.replace(/^[-*•\d.)\s]+/, "")
			.replace(/["']/g, "")
			.trim();
		if (p.length < 4 || p.length > 100) return;
		const key = p.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ phrase: p, intent: "informational", source });
	};
	for (const text of texts) {
		const raw = String(text || "");
		for (const m of raw.matchAll(/["“]([^"”]{4,80})["”]/g)) {
			push(m[1], "research-quote");
		}
		for (const line of raw.split("\n")) {
			if (/^\s*[-*•]|\d+\./.test(line)) push(line, "research-bullet");
		}
	}
	return out.slice(0, 20);
}

function headingsFromScrape(data) {
	const content = data?.content || {};
	const list = [];
	for (const tag of ["h1", "h2", "h3"]) {
		const vals = content[tag];
		if (Array.isArray(vals)) {
			for (const v of vals) {
				const t = String(v || "").trim();
				if (t) list.push({ tag, text: t });
			}
		}
	}
	return list.slice(0, 40);
}

function mapScrapeToPage(row) {
	const data = row?.data || {};
	const meta = data.metadata || {};
	const markdown = String(row?.markdown || "").slice(0, MARKDOWN_MAX);
	const title =
		data.title ||
		meta.title ||
		meta["og:title"] ||
		meta["twitter:title"] ||
		"";
	const metaDescription =
		meta.description ||
		meta["og:description"] ||
		meta["twitter:description"] ||
		"";
	return {
		url: row.url,
		domain: hostOf(row.url),
		title: String(title).trim(),
		metaDescription: String(metaDescription).trim(),
		headings: headingsFromScrape(data),
		contentSnippet: markdown.slice(0, SNIPPET_MAX),
		markdown,
		scrapedAt: new Date().toISOString(),
	};
}

async function scrapeUrls(baseUrl, urls) {
	const unique = [...new Set(urls.map(canonicalUrl))];
	const body = {
		urls: unique,
		timeout: 55_000,
		includeSemanticContent: true,
		includeImages: false,
		includeLinks: true,
		extractMetadata: true,
		includeCache: false,
		takeScreenshot: false,
		aiSummary: false,
	};
	const path = unique.length === 1 ? "/scrape" : "/scrape-multiple";
	const payload =
		unique.length === 1 ? { ...body, url: unique[0], urls: undefined } : body;

	const res = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data?.error || data?.details || `Scrape failed HTTP ${res.status}`);
	}

	const rows = Array.isArray(data.results)
		? data.results
		: [{ ...data, url: data.url || unique[0] }];

	return rows.map((row) => {
		if (row.success === false) {
			return {
				url: row.url,
				ok: false,
				error: row.error || row.details || "Scrape failed",
			};
		}
		return { url: row.url, ok: true, page: mapScrapeToPage(row) };
	});
}

function extractCitations(data) {
	const urls = [];
	const push = (v) => {
		if (typeof v === "string" && /^https?:\/\//i.test(v)) urls.push(v);
		else if (v && typeof v === "string") {
			/* skip */
		} else if (v?.url) urls.push(v.url);
	};
	if (Array.isArray(data?.citations)) data.citations.forEach(push);
	const msg = data?.choices?.[0]?.message;
	if (Array.isArray(msg?.citations)) msg.citations.forEach(push);
	if (Array.isArray(msg?.annotations)) {
		for (const a of msg.annotations) {
			push(a?.url || a?.citation?.url || a?.web?.url || a?.url_citation?.url);
		}
	}
	return [...new Set(urls.filter(Boolean))];
}

function hostMatchesAllowed(url, allowed) {
	if (!allowed?.length) return true;
	let host = "";
	try {
		host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
	} catch {
		return false;
	}
	return allowed.some((d) => {
		const dom = String(d).replace(/^www\./i, "").toLowerCase();
		return host === dom || host.endsWith(`.${dom}`);
	});
}

function citationScope(citations, allowedDomains) {
	if (!allowedDomains?.length) {
		return { scoped: true, matched: citations, unmatched: [], degraded: false };
	}
	const matched = citations.filter((u) => hostMatchesAllowed(u, allowedDomains));
	const unmatched = citations.filter((u) => !hostMatchesAllowed(u, allowedDomains));
	const degraded =
		citations.length > 0 ? unmatched.length / citations.length > 0.4 : false;
	return { scoped: unmatched.length === 0, matched, unmatched, degraded };
}

async function openRouterChat({
	model,
	messages,
	maxTokens = 1200,
	jsonMode = false,
	timeoutMs = LLM_TIMEOUT_MS,
	extra = {},
}) {
	const { temperature = 0.3, ...rest } = extra;
	const body = {
		model,
		messages,
		temperature,
		max_tokens: maxTokens,
		...rest,
	};
	if (jsonMode) body.response_format = { type: "json_object" };

	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${openRouterKey()}`,
			"HTTP-Referer": "https://ihatereading.in",
			"X-Title": "IHateReading Company Seed",
		},
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const msg = data?.error?.message || data?.error || `HTTP ${res.status}`;
		const err = new Error(`OpenRouter error: ${msg}`);
		err.status = res.status;
		err.payload = data;
		throw err;
	}
	const text = data?.choices?.[0]?.message?.content || "";
	return {
		text,
		citations: extractCitations(data),
		usage: normalizeOpenRouterUsage(data?.usage),
		tokenUsage: toTokenUsageCamel(data?.usage),
		model: data?.model || model,
		raw: data,
	};
}

/**
 * Perplexity Sonar via OpenRouter with domain allowlist.
 * Sends both Perplexity `search_domain_filter` and OpenRouter
 * `web_search_options.allowed_domains`. If OpenRouter rejects the native
 * param, retries without it. Citations are post-filtered either way.
 */
async function callSonar({ prompt, allowedDomains = [], maxTokens = 1600 }) {
	const messages = [
		{
			role: "system",
			content:
				"You are a market-research analyst. Use only live web evidence. Be specific (product names, URLs, quotes). If a domain allowlist is set, stay on those sites. Return concrete findings, not generic SEO advice.",
		},
		{ role: "user", content: prompt },
	];

	const domainPayload = allowedDomains.length
		? {
				search_domain_filter: allowedDomains,
				web_search_options: {
					search_context_size: "medium",
					allowed_domains: allowedDomains,
				},
			}
		: {
				web_search_options: { search_context_size: "medium" },
			};

	let result;
	let droppedNativeFilter = false;
	try {
		result = await openRouterChat({
			model: SONAR_MODEL,
			messages,
			maxTokens,
			timeoutMs: SONAR_TIMEOUT_MS,
			extra: { temperature: 0.2, ...domainPayload },
		});
	} catch (err) {
		const msg = String(err?.message || "");
		const looksUnsupported =
			err.status === 400 ||
			/unknown|unsupported|unrecognized|extra_forbidden|search_domain/i.test(
				msg,
			);
		if (!looksUnsupported || !allowedDomains.length) throw err;
		droppedNativeFilter = true;
		result = await openRouterChat({
			model: SONAR_MODEL,
			messages,
			maxTokens,
			timeoutMs: SONAR_TIMEOUT_MS,
			extra: {
				temperature: 0.2,
				web_search_options: {
					search_context_size: "medium",
					allowed_domains: allowedDomains,
				},
			},
		});
	}

	const scope = citationScope(result.citations, allowedDomains);
	return {
		text: result.text,
		citations: scope.matched.length ? scope.matched : result.citations,
		allCitations: result.citations,
		unmatchedCitations: scope.unmatched,
		domainFilter: {
			requested: allowedDomains,
			nativeSearchDomainFilterDropped: droppedNativeFilter,
			citationsDegraded: scope.degraded,
			note: droppedNativeFilter
				? "OpenRouter rejected Perplexity search_domain_filter; retried with web_search_options.allowed_domains only. Citations were post-filtered."
				: scope.degraded
					? "Citations include hosts outside the allowlist — treat domain scoping as degraded and rely on post-filter."
					: "Domain allowlist applied (search_domain_filter + web_search_options.allowed_domains) and citations mostly match.",
		},
		usage: result.usage,
		tokenUsage: result.tokenUsage,
		model: result.model,
	};
}

async function extractSchema(page) {
	const r = await openRouterChat({
		model: SCHEMA_MODEL,
		jsonMode: true,
		maxTokens: 900,
		messages: [
			{
				role: "system",
				content: `Extract a reusable company seed schema from the scraped page. Return ONLY JSON:
{
  "brandName": "",
  "oneLiner": "",
  "products": [""],
  "audience": "",
  "tone": "",
  "existingTopics": [""],
  "differentiators": [""],
  "geoHint": "",
  "category": ""
}
Do not invent products or claims that are not on the page. Keep lists short (max 8).`,
			},
			{
				role: "user",
				content: JSON.stringify({
					url: page.url,
					title: page.title,
					metaDescription: page.metaDescription,
					headings: page.headings,
					contentSnippet: page.contentSnippet,
				}).slice(0, 14000),
			},
		],
	});
	let schema;
	try {
		schema = parseJsonFromLLM(r.text);
	} catch {
		schema = {
			brandName: page.title || page.domain,
			oneLiner: page.metaDescription || "",
			products: [],
			audience: "",
			tone: "",
			existingTopics: (page.headings || []).slice(0, 8).map((h) => h.text),
			differentiators: [],
			geoHint: "",
			category: "",
		};
	}
	return { schema, usage: r.usage, tokenUsage: r.tokenUsage, model: r.model };
}

function seedPromptBlock(seed) {
	const s = seed.schema || {};
	return [
		`Brand: ${s.brandName || seed.host}`,
		`URL: ${seed.url}`,
		`One-liner: ${s.oneLiner || ""}`,
		`Category: ${s.category || ""}`,
		`Products: ${(s.products || []).join(", ")}`,
		`Audience: ${s.audience || ""}`,
		`Differentiators: ${(s.differentiators || []).join("; ")}`,
		`Existing topics: ${(s.existingTopics || []).join("; ")}`,
		`Geo: ${s.geoHint || ""}`,
	].join("\n");
}

async function ensureUserDoc(userId) {
	const ref = userDocRef(userId);
	const snap = await ref.get();
	if (!snap.exists) {
		await ref.set({
			userId,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			sourceIndex: [],
		});
	}
	return ref;
}

async function upsertSourceIndex(userId, entry) {
	const ref = userDocRef(userId);
	const snap = await ref.get();
	const data = snap.exists ? snap.data() : { sourceIndex: [] };
	const index = Array.isArray(data.sourceIndex) ? [...data.sourceIndex] : [];
	const i = index.findIndex((x) => x.sourceId === entry.sourceId);
	if (i >= 0) index[i] = { ...index[i], ...entry };
	else index.push(entry);
	await ref.set(
		{
			userId,
			updatedAt: new Date().toISOString(),
			defaultSourceId: data.defaultSourceId || entry.sourceId,
			sourceIndex: index,
			...(snap.exists ? {} : { createdAt: new Date().toISOString() }),
		},
		{ merge: true },
	);
}

async function loadSeed(userId, { url, sourceId }) {
	if (!userId) throw Object.assign(new Error("userId is required"), { status: 400 });
	let id = sourceId;
	if (!id && url) id = sourceIdFor(url);
	if (!id) {
		throw Object.assign(
			new Error("url or sourceId is required"),
			{ status: 400, code: "SEED_REQUIRED" },
		);
	}
	const snap = await sourceDocRef(userId, id).get();
	if (!snap.exists) {
		throw Object.assign(
			new Error(
				"No company seed for this URL. Call POST /company-seed first.",
			),
			{ status: 400, code: "SEED_REQUIRED", sourceId: id },
		);
	}
	return { sourceId: id, ...snap.data() };
}

function mergeUsage(...parts) {
	return parts.filter(Boolean).reduce(
		(acc, u) => mergeOpenRouterUsage(acc, u),
		normalizeOpenRouterUsage(null),
	);
}

function noveltyKeywords(phrases, previous = []) {
	const prev = new Set(
		(previous || []).map((p) =>
			String(typeof p === "string" ? p : p.phrase || "")
				.toLowerCase()
				.trim(),
		),
	);
	return (phrases || [])
		.map((p) => (typeof p === "string" ? { phrase: p } : p))
		.filter((p) => p.phrase)
		.map((p) => ({
			...p,
			novelty: prev.has(String(p.phrase).toLowerCase().trim())
				? "existing"
				: "new",
		}));
}

async function buildSeedForUrl({ userId, url, page, usageParts }) {
	const sourceId = sourceIdFor(url);
	const { schema, usage, model } = await extractSchema(page);
	usageParts.push(usage);
	const now = new Date().toISOString();
	const seed = stripUndefined({
		sourceId,
		userId,
		url: canonicalUrl(url),
		host: hostOf(url),
		canonicalUrl: canonicalUrl(url),
		scraped: page,
		schema,
		schemaModel: model,
		updatedAt: now,
		createdAt: now,
	});
	const existing = await sourceDocRef(userId, sourceId).get();
	if (existing.exists) {
		const prev = existing.data() || {};
		seed.createdAt = prev.createdAt || now;
		seed.lastKeywordRun = prev.lastKeywordRun || null;
		seed.lastTopics = prev.lastTopics || null;
		seed.lastVisibility = prev.lastVisibility || null;
	}
	await sourceDocRef(userId, sourceId).set(seed, { merge: true });
	await upsertSourceIndex(userId, {
		sourceId,
		host: seed.host,
		url: seed.url,
		title: page.title || schema.brandName || seed.host,
		updatedAt: now,
	});
	return seed;
}

companySeedRouter.post("/company-seed", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const userId = String(body.userId || "").trim();
		const refresh = body.refresh === true;
		if (!userId) {
			return c.json({ success: false, error: "userId is required" }, 400);
		}

		const rawUrls = Array.isArray(body.urls)
			? body.urls
			: body.url
				? [body.url]
				: [];
		if (!rawUrls.length) {
			return c.json(
				{ success: false, error: "url or urls[] is required" },
				400,
			);
		}
		if (rawUrls.length > MAX_URLS) {
			return c.json(
				{ success: false, error: `Maximum ${MAX_URLS} URLs per request` },
				400,
			);
		}

		const urls = rawUrls.map((u) => canonicalUrl(String(u).trim()));
		await ensureUserDoc(userId);

		const toScrape = [];
		const reused = [];
		for (const url of urls) {
			const id = sourceIdFor(url);
			const snap = await sourceDocRef(userId, id).get();
			if (snap.exists && !refresh) {
				reused.push({ sourceId: id, ...snap.data(), reused: true });
			} else {
				toScrape.push(url);
			}
		}

		const usageParts = [];
		const scrapedSeeds = [];
		const failures = [];

		if (toScrape.length) {
			const rows = await scrapeUrls(scrapeBaseUrl(c), toScrape);
			for (const row of rows) {
				if (!row.ok) {
					failures.push({ url: row.url, error: row.error });
					continue;
				}
				try {
					const seed = await buildSeedForUrl({
						userId,
						url: row.url,
						page: row.page,
						usageParts,
					});
					scrapedSeeds.push({ ...seed, reused: false });
				} catch (err) {
					failures.push({ url: row.url, error: err.message });
				}
			}
		}

		if (!reused.length && !scrapedSeeds.length) {
			return c.json(
				{
					success: false,
					error: "Failed to create any company seed",
					failures,
				},
				500,
			);
		}

		const usage = mergeUsage(...usageParts);
		return c.json({
			success: true,
			userId,
			seeds: [...reused, ...scrapedSeeds],
			failures,
			refreshed: toScrape.length > 0,
			usage,
			tokenUsage: toTokenUsageCamel(usage),
		});
	} catch (err) {
		console.error("[company-seed]", err);
		return c.json(
			{ success: false, error: err.message || "Failed to create company seed" },
			err.status || 500,
		);
	}
});

companySeedRouter.get("/company-seed/:userId", async (c) => {
	const userId = c.req.param("userId");
	const snap = await userDocRef(userId).get();
	if (!snap.exists) {
		return c.json({ success: false, error: "No seeds for this userId" }, 404);
	}
	return c.json({ success: true, userId, ...snap.data() });
});

companySeedRouter.get("/company-seed/:userId/:sourceId", async (c) => {
	const { userId, sourceId } = c.req.param();
	const snap = await sourceDocRef(userId, sourceId).get();
	if (!snap.exists) {
		return c.json({ success: false, error: "Seed not found" }, 404);
	}
	return c.json({ success: true, userId, sourceId, seed: snap.data() });
});

companySeedRouter.post("/blog-topics", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const userId = String(body.userId || "").trim();
		const keyword = body.keyword ? String(body.keyword).trim() : "";
		const geo = String(body.geo || "US").slice(0, 2).toUpperCase();
		const refreshKeywords = body.refreshKeywords !== false;
		const warnings = [];

		const seed = await loadSeed(userId, {
			url: body.url,
			sourceId: body.sourceId,
		});

		const usageParts = [];
		let research = seed.lastKeywordRun || null;
		let phraseParse = null;
		let topicParse = null;

		if (refreshKeywords || !research) {
			const brand = seed.schema?.brandName || seed.host;
			const products = (seed.schema?.products || []).slice(0, 6).join(", ");
			const extra = keyword ? ` Extra angle: ${keyword}.` : "";
			const base = seedPromptBlock(seed);
			const researchFocus =
				keyword ||
				products ||
				seed.schema?.category ||
				seed.schema?.oneLiner ||
				brand;

			// Community + reviews stay domain-scoped; add an open-web pass so niche
			// brands still get usable SEO phrases when social/review sites are empty.
			const [community, reviews, web] = await Promise.all([
				callSonar({
					allowedDomains: COMMUNITY_DOMAINS,
					prompt: `${base}

Research demand for topics related to: ${researchFocus}.
Do NOT require the exact brand name "${brand}" to appear — search for the category, products, and buyer problems (${products || researchFocus}).${extra}
Find what people on Reddit, YouTube, and X/Twitter ask, complain about, or want.
Return: recurring questions, content gaps, and 12-20 keyword/topic phrases a blog could rank for. Geo hint: ${geo}.`,
				}),
				callSonar({
					allowedDomains: COMPETITOR_DOMAINS,
					prompt: `${base}

From G2, Capterra, Product Hunt, TrustRadius, and Reddit: how do buyers evaluate products like "${researchFocus}" / alternatives to ${brand}?${extra}
Focus on the product category (${products || researchFocus}), not only the brand name.
Return: competitor names, missing content themes, and 8-12 SEO blog angles. Geo hint: ${geo}.`,
				}),
				callSonar({
					allowedDomains: [],
					maxTokens: 1400,
					prompt: `${base}

Open-web SEO keyword research for a blog about: ${researchFocus}.
Brand: ${brand}. Products/themes: ${products || "n/a"}.${extra}
Ignore domain limits. Return 15-25 specific search phrases (questions + commercial intent) that would drive traffic to this site. Geo: ${geo}.
Prefer concrete phrases over generic SEO advice.`,
				}),
			]);
			usageParts.push(community.usage, reviews.usage, web.usage);

			const phrasePass = await openRouterChat({
				model: SCHEMA_MODEL,
				jsonMode: true,
				maxTokens: 1200,
				messages: [
					{
						role: "system",
						content: `Extract keyword phrases from research. Return ONLY a JSON object:
{ "seedKeyword": "", "keywords": [{ "phrase": "", "intent": "informational|commercial|comparison", "source": "community|reviews|web|seed" }] }
Rules:
- Always return at least 10 keywords when any research text is present.
- Prefer specific phrases over generic ones.
- If research is thin, invent plausible SEO phrases strictly from the brand seed (products, audience, category) — never return an empty keywords array.`,
					},
					{
						role: "user",
						content: `Brand seed:\n${base}\n\nOptional keyword: ${keyword || "(none)"}\n\nCommunity research:\n${community.text.slice(0, 5000)}\n\nReview/competitor research:\n${reviews.text.slice(0, 5000)}\n\nOpen-web research:\n${web.text.slice(0, 5000)}`,
					},
				],
			});
			usageParts.push(phrasePass.usage);
			phraseParse = tryParseJsonFromLLM(phrasePass.text);
			let extractedKeywords = phraseParse.ok
				? normalizeKeywordList(phraseParse.value)
				: [];
			if (!phraseParse.ok) {
				warnings.push(`keyword_json_parse_failed: ${phraseParse.error}`);
			}

			if (!extractedKeywords.length) {
				extractedKeywords = keywordsFromResearchText(
					community.text,
					reviews.text,
					web.text,
				);
				if (extractedKeywords.length) {
					warnings.push("keywords_extracted_from_research_prose");
				}
			}
			if (!extractedKeywords.length) {
				extractedKeywords = keywordsFromSeed(seed, keyword);
				warnings.push("keywords_fallback_from_company_seed");
			}

			const prevPhrases = research?.keywords || [];
			research = {
				ranAt: new Date().toISOString(),
				geo,
				seedKeyword:
					(phraseParse.ok && phraseParse.value?.seedKeyword) ||
					keyword ||
					brand,
				keywords: noveltyKeywords(extractedKeywords, prevPhrases),
				community: {
					text: community.text,
					citations: community.citations,
					model: community.model,
				},
				reviews: {
					text: reviews.text,
					citations: reviews.citations,
					model: reviews.model,
				},
				web: {
					text: web.text,
					citations: web.citations,
					model: web.model,
				},
				domainFilter: {
					community: community.domainFilter,
					reviews: reviews.domainFilter,
					web: web.domainFilter,
				},
			};
		}

		// Ensure we always have keywords before topic generation
		if (!research.keywords?.length) {
			research = {
				...research,
				keywords: noveltyKeywords(
					keywordsFromSeed(seed, keyword),
					research?.keywords || [],
				),
			};
			warnings.push("keywords_backfilled_from_seed_before_topics");
		}

		const topicPass = await openRouterChat({
			model: SCHEMA_MODEL,
			jsonMode: true,
			maxTokens: 1800,
			extra: { temperature: 0.55 },
			messages: [
				{
					role: "system",
					content: `You write SEO blog topic ideas grounded in a company seed and keyword research.
Return ONLY a JSON object:
{
  "topics": [
    {
      "title": "",
      "angle": "",
      "primaryKeyword": "",
      "supporting": [""],
      "whyNow": "",
      "novelty": "new|existing"
    }
  ]
}
Rules:
- Return 8 to 15 topics. NEVER return an empty topics array.
- Prefer novelty=new keywords when available; if keywords are thin, use products and audience from the seed.
- Do not invent products that are not in the seed. Titles should be publishable.`,
				},
				{
					role: "user",
					content: `${seedPromptBlock(seed)}\n\nKeyword hint: ${keyword || "(none)"}\nGeo: ${geo}\n\nKeywords:\n${JSON.stringify((research.keywords || []).slice(0, 25))}\n\nCommunity notes:\n${String(research.community?.text || "").slice(0, 2500)}\n\nCompetitor notes:\n${String(research.reviews?.text || "").slice(0, 2500)}\n\nOpen-web notes:\n${String(research.web?.text || "").slice(0, 2500)}`,
				},
			],
		});
		usageParts.push(topicPass.usage);

		topicParse = tryParseJsonFromLLM(topicPass.text);
		let topics = topicParse.ok ? normalizeTopicList(topicParse.value) : [];
		if (!topicParse.ok) {
			warnings.push(`topic_json_parse_failed: ${topicParse.error}`);
		}
		if (!topics.length) {
			topics = topicsFromSeedAndKeywords(seed, research.keywords, keyword);
			warnings.push("topics_fallback_from_seed_and_keywords");
		}

		const lastTopics = {
			generatedAt: new Date().toISOString(),
			keyword: keyword || null,
			geo,
			topics,
			refreshedKeywords: refreshKeywords || !seed.lastKeywordRun,
			warnings,
		};

		await sourceDocRef(userId, seed.sourceId).set(
			stripUndefined({
				lastKeywordRun: research,
				lastTopics,
				updatedAt: new Date().toISOString(),
			}),
			{ merge: true },
		);
		await upsertSourceIndex(userId, {
			sourceId: seed.sourceId,
			host: seed.host,
			url: seed.url,
			title: seed.schema?.brandName || seed.host,
			updatedAt: new Date().toISOString(),
		});

		const usage = mergeUsage(...usageParts);
		return c.json({
			success: true,
			userId,
			sourceId: seed.sourceId,
			url: seed.url,
			usedSeed: {
				brandName: seed.schema?.brandName,
				oneLiner: seed.schema?.oneLiner,
				products: seed.schema?.products,
			},
			keywords: research.keywords,
			topics,
			domainFilter: research.domainFilter,
			refreshedKeywords: lastTopics.refreshedKeywords,
			warnings,
			debug:
				warnings.length > 0
					? {
							keywordRawPreview: phraseParse?.rawPreview || null,
							topicRawPreview: topicParse?.rawPreview || null,
							communityPreview: String(research.community?.text || "").slice(
								0,
								300,
							),
							webPreview: String(research.web?.text || "").slice(0, 300),
						}
					: undefined,
			usage,
			tokenUsage: toTokenUsageCamel(usage),
			model: { sonar: SONAR_MODEL, synth: SCHEMA_MODEL },
		});
	} catch (err) {
		console.error("[blog-topics]", err);
		return c.json(
			{
				success: false,
				error: err.message || "Failed to generate blog topics",
				code: err.code,
			},
			err.status || 500,
		);
	}
});

companySeedRouter.post("/ai-visibility", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const userId = String(body.userId || "").trim();
		const geo = String(body.geo || "US").slice(0, 2).toUpperCase();
		const maxCompetitors = Math.min(
			Math.max(Number(body.maxCompetitors) || 5, 3),
			8,
		);

		const seed = await loadSeed(userId, {
			url: body.url,
			sourceId: body.sourceId,
		});
		const brand = seed.schema?.brandName || seed.host;
		const ownHost = seed.host;

		const sonar = await callSonar({
			allowedDomains: COMPETITOR_DOMAINS,
			maxTokens: 1800,
			prompt: `${seedPromptBlock(seed)}

AI visibility + competitor scan for "${brand}" (${seed.url}).
Stay on G2, Capterra, TrustRadius, Product Hunt, and Reddit.
Find ${maxCompetitors} real competing products (not ${ownHost}).
For each: name, url if known, how they show up vs ${brand}, content they publish that ${brand} lacks.
Also: how visible is ${brand} on these review/community sites? Gaps?
Geo: ${geo}.`,
		});

		const synth = await openRouterChat({
			model: SCHEMA_MODEL,
			jsonMode: true,
			maxTokens: 1100,
			messages: [
				{
					role: "system",
					content: `Turn research into a structured AI-visibility brief. Return ONLY JSON:
{
  "brief": "2-4 sentence visibility summary",
  "competitors": [
    { "name": "", "url": "", "source": "", "whyItMatters": "" }
  ],
  "gaps": [""],
  "contentOpportunities": [""]
}
Max ${maxCompetitors} competitors. Drop anything that is the same company as ${ownHost}. Do not invent review scores.`,
				},
				{
					role: "user",
					content: `${seedPromptBlock(seed)}\n\nSonar research:\n${sonar.text.slice(0, 8000)}\n\nCitations:\n${(sonar.citations || []).join("\n")}`,
				},
			],
		});

		let parsed = {
			brief: sonar.text.slice(0, 600),
			competitors: [],
			gaps: [],
			contentOpportunities: [],
		};
		try {
			parsed = { ...parsed, ...parseJsonFromLLM(synth.text) };
		} catch {
			/* keep fallback */
		}
		parsed.competitors = (parsed.competitors || [])
			.filter((comp) => {
				const u = String(comp.url || "");
				try {
					if (u && hostOf(u) === ownHost) return false;
				} catch {
					/* keep */
				}
				return Boolean(comp.name);
			})
			.slice(0, maxCompetitors);

		const lastVisibility = {
			generatedAt: new Date().toISOString(),
			geo,
			brief: parsed.brief,
			competitors: parsed.competitors,
			gaps: parsed.gaps || [],
			contentOpportunities: parsed.contentOpportunities || [],
			citations: sonar.citations,
			domainFilter: sonar.domainFilter,
		};

		await sourceDocRef(userId, seed.sourceId).set(
			stripUndefined({
				lastVisibility,
				updatedAt: new Date().toISOString(),
			}),
			{ merge: true },
		);

		const usage = mergeUsage(sonar.usage, synth.usage);
		return c.json({
			success: true,
			userId,
			sourceId: seed.sourceId,
			url: seed.url,
			usedSeed: {
				brandName: seed.schema?.brandName,
				oneLiner: seed.schema?.oneLiner,
				products: seed.schema?.products,
			},
			...parsed,
			citations: sonar.citations,
			domainFilter: sonar.domainFilter,
			usage,
			tokenUsage: toTokenUsageCamel(usage),
			model: { sonar: sonar.model, synth: synth.model },
		});
	} catch (err) {
		console.error("[ai-visibility]", err);
		return c.json(
			{
				success: false,
				error: err.message || "Failed to run AI visibility",
				code: err.code,
			},
			err.status || 500,
		);
	}
});
