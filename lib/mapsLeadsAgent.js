/**
 * Maps + Google Search leads agent — one conversational endpoint.
 *
 * 1. classifierAgent  — scrape 1–3 seed URLs, then ask questions or skip
 * 2. queryGeneratorAgent — 2–8 maps/search/scrape queries
 * 3. answerAgent — synthesize lead objects from parallel scrape results
 */

import { randomUUID } from "node:crypto";
import { extractUrlsFromText } from "./inkgestAgent.js";
import { openRouterChat } from "./openrouter.js";
import { parseJsonFromLLM } from "./geoPipeline/parseLlmJson.js";
import {
	mergeOpenRouterUsage,
	normalizeOpenRouterUsage,
	toTokenUsageCamel,
} from "./openRouterUsage.js";
import { resolveScrapeBaseUrl, scrapeUrl } from "./scrapefast.js";

const SESSION_TTL_MS =
	Number.parseInt(process.env.MAPS_LEADS_SESSION_TTL_MS || "", 10) ||
	45 * 60 * 1000;
const MIN_QUERIES = 2;
const MAX_QUERIES = 8;
const MAX_SEED_URLS = 3;

/** @type {Map<string, object>} */
const sessions = new Map();

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
function pruneSessions() {
	const now = Date.now();
	for (const [id, s] of sessions) {
		if (now - (s.updatedAt || s.createdAt) > SESSION_TTL_MS) {
			sessions.delete(id);
		}
	}
}

function getOrCreateSession(sessionId) {
	pruneSessions();
	if (sessionId && sessions.has(sessionId)) {
		const s = sessions.get(sessionId);
		s.updatedAt = Date.now();
		return s;
	}
	const id = sessionId || randomUUID();
	const s = {
		id,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		prompt: "",
		answers: {},
		questionsAsked: [],
		siteContext: [],
		queries: [],
		queryResults: [],
		phase: "new",
		usage: normalizeOpenRouterUsage(null),
	};
	sessions.set(id, s);
	return s;
}

function apiBase(c) {
	return resolveScrapeBaseUrl(c).replace(/\/$/, "");
}

function mergeAnswers(existing, incoming) {
	const out = { ...(existing || {}) };
	if (!incoming) return out;
	if (Array.isArray(incoming)) {
		incoming.forEach((a, i) => {
			if (a == null) return;
			if (typeof a === "object" && (a.id || a.questionId)) {
				out[String(a.id || a.questionId)] = a.answer ?? a.value ?? a.text ?? "";
			} else {
				out[`a${i + 1}`] = String(a);
			}
		});
		return out;
	}
	if (typeof incoming === "object") {
		for (const [k, v] of Object.entries(incoming)) out[k] = v;
		return out;
	}
	if (typeof incoming === "string" && incoming.trim()) {
		out.freeform = incoming.trim();
	}
	return out;
}

function answersAsText(answers, questions) {
	const lines = [];
	const qs = Array.isArray(questions) ? questions : [];
	for (const q of qs) {
		const id = q.id || q.questionId;
		const ans = answers?.[id];
		if (ans != null && String(ans).trim()) {
			lines.push(`Q: ${q.question || q.text || id}\nA: ${String(ans)}`);
		}
	}
	for (const [k, v] of Object.entries(answers || {})) {
		if (qs.some((q) => (q.id || q.questionId) === k)) continue;
		if (v != null && String(v).trim()) lines.push(`${k}: ${String(v)}`);
	}
	return lines.join("\n\n") || "(no answers)";
}

function extractBareDomains(text) {
	if (!text) return [];
	const matches = String(text).match(
		/(?:^|[\s,;])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})(?=[\s,;]|$)/gi,
	);
	return [...new Set((matches || []).map((m) => m.trim().replace(/^[,;]+/, "")))]
		.filter((d) => !d.includes("@") && !/\.(png|jpg|js|css)$/i.test(d))
		.map((d) => `https://${d.replace(/^https?:\/\//i, "")}`);
}

function collectSeedUrls(prompt, extraUrls = []) {
	const fromText = extractUrlsFromText(prompt);
	const bare = extractBareDomains(prompt);
	const extra = Array.isArray(extraUrls) ? extraUrls.filter(Boolean) : [];
	const all = [...fromText, ...bare, ...extra]
		.map((u) => {
			const s = String(u).trim();
			if (!s) return null;
			if (/^https?:\/\//i.test(s)) return s;
			return `https://${s}`;
		})
		.filter(Boolean);
	return [...new Set(all)].slice(0, MAX_SEED_URLS);
}

function emailsFromText(text) {
	const set = new Set();
	for (const m of String(text || "").match(EMAIL_RE) || []) {
		const e = m.toLowerCase();
		if (e.endsWith(".png") || e.includes("example.com")) continue;
		set.add(e);
	}
	return [...set];
}

function socialsFromLinks(links = []) {
	const out = {
		linkedin: [],
		instagram: [],
		facebook: [],
		twitter: [],
		youtube: [],
		github: [],
		other: [],
	};
	for (const raw of links) {
		const href = typeof raw === "string" ? raw : raw?.href || raw?.url || "";
		if (!href) continue;
		let host = "";
		try {
			host = new URL(href).hostname.replace(/^www\./, "").toLowerCase();
		} catch {
			continue;
		}
		if (host.includes("linkedin.com")) out.linkedin.push(href);
		else if (host.includes("instagram.com")) out.instagram.push(href);
		else if (host.includes("facebook.com")) out.facebook.push(href);
		else if (host === "x.com" || host.includes("twitter.com"))
			out.twitter.push(href);
		else if (host.includes("youtube.com")) out.youtube.push(href);
		else if (host.includes("github.com")) out.github.push(href);
	}
	for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].slice(0, 8);
	return out;
}

async function llmJson(messages, { maxTokens = 1600, temperature = 0.2 } = {}) {
	const { content, usage, model } = await openRouterChat({
		messages,
		jsonMode: true,
		maxTokens,
		temperature,
	});
	let parsed = {};
	try {
		parsed = parseJsonFromLLM(content);
	} catch {
		parsed = {};
	}
	return { parsed, usage, model, content };
}

async function scrapeSeedUrls(urls, baseUrl) {
	if (!urls.length) return [];
	const res = await fetch(`${baseUrl}/scrape-multiple`, {
		method: "POST",
		signal: AbortSignal.timeout(180_000),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			urls,
			includeSemanticContent: true,
			includeImages: false,
			includeLinks: true,
			extractMetadata: true,
			timeout: 45_000,
		}),
	});
	const data = await res.json().catch(() => ({}));
	const rows = Array.isArray(data.results) ? data.results : [];
	return rows.map((row) => {
		const markdown = String(row.markdown || "").slice(0, 8000);
		const title = row.data?.title || row.data?.metadata?.title || "";
		const links = row.data?.links || [];
		return {
			url: row.url,
			ok: row.success !== false,
			title,
			markdown,
			emails: emailsFromText(markdown),
			socials: socialsFromLinks(links),
			error: row.error || null,
		};
	});
}

async function runMapsQueryHttp(query, baseUrl) {
	const res = await fetch(`${baseUrl}/scrape-google-maps`, {
		method: "POST",
		signal: AbortSignal.timeout(180_000),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ singleQuery: query }),
	});
	const data = await res.json().catch(() => ({}));
	return {
		type: "maps",
		query,
		ok: data.success === true,
		places: data.data?.results || data.data?.places || data.data || [],
		error: data.error || null,
	};
}

async function runGoogleSearchHttp(query, baseUrl, geo = "in") {
	const res = await fetch(`${baseUrl}/google-search`, {
		method: "POST",
		signal: AbortSignal.timeout(90_000),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			query,
			num: 8,
			country: geo,
			language: "en",
		}),
	});
	const data = await res.json().catch(() => ({}));
	const results = data.results || [];
	return {
		type: "search",
		query,
		ok: Array.isArray(results),
		results: results.slice(0, 8),
		emails: emailsFromText(
			`${data.markdown || ""} ${results.map((r) => `${r.title} ${r.snippet || r.description || ""}`).join(" ")}`,
		),
		error: data.error || null,
	};
}

async function runSiteScrapeHttp(url, baseUrl) {
	try {
		const row = await scrapeUrl(url, { baseUrl, includeImages: false });
		const markdown = String(row.markdown || "").slice(0, 8000);
		const links = row.data?.links || [];
		return {
			type: "scrape",
			query: url,
			ok: true,
			url,
			title: row.data?.title || "",
			markdown,
			emails: emailsFromText(markdown),
			socials: socialsFromLinks(links),
			phone: "",
			website: url,
		};
	} catch (err) {
		return {
			type: "scrape",
			query: url,
			ok: false,
			url,
			error: err?.message || String(err),
		};
	}
}

/**
 * Classifier: after optional seed-site scrape, ask form questions or skip.
 */
export async function classifierAgent({ prompt, siteContext, skipClarification }) {
	if (skipClarification) {
		return {
			needClarification: false,
			understoodContext: prompt,
			questions: [],
			message: "Skipping questions — running search.",
			usage: normalizeOpenRouterUsage(null),
		};
	}

	const siteBlob = (siteContext || [])
		.map(
			(s) =>
				`URL: ${s.url}\nTitle: ${s.title}\nEmails: ${(s.emails || []).join(", ")}\nSnippet:\n${String(s.markdown || "").slice(0, 2500)}`,
		)
		.join("\n\n---\n\n");

	const r = await llmJson(
		[
			{
				role: "system",
				content: `You are the classifier for a Google Maps + Google Search lead agent.
Decide if the user prompt is enough to generate Maps/search queries, or if 1–4 short form questions would materially improve results.

Need clarification when: missing city/geo, vague "leads", no business type, or a website was scraped but ICP/geo/offer is unclear.
Skip questions when: prompt already has business type + location (e.g. "cafes in Kota") or "find X in Y".

Return ONLY JSON:
{
  "needClarification": true|false,
  "understoodContext": "1-3 sentences",
  "intent": "maps_leads|website_enrich|local_businesses|other",
  "questions": [
    { "id": "q1", "question": "...", "why": "...", "options": ["optional"] }
  ],
  "message": "short message to the user"
}
Max 4 questions. Prefer multiple-choice. Never invent facts from the scraped site.`,
			},
			{
				role: "user",
				content: `User prompt:\n${prompt}\n\nScraped seed sites (may be empty):\n${siteBlob || "(none)"}`,
			},
		],
		{ maxTokens: 900, temperature: 0.15 },
	);

	const p = r.parsed || {};
	const questions = Array.isArray(p.questions)
		? p.questions.slice(0, 4)
		: [];
	const needClarification =
		p.needClarification === true && questions.length > 0;
	return {
		needClarification,
		understoodContext: p.understoodContext || prompt,
		intent: p.intent || "maps_leads",
		questions,
		message: p.message || "",
		usage: r.usage,
		model: r.model,
	};
}

/**
 * Query generator: 2–8 maps / google-search / scrape jobs.
 */
export async function queryGeneratorAgent({ prompt, answersText, siteContext, geo }) {
	const siteBlob = (siteContext || [])
		.map((s) => `${s.url} — ${s.title} — ${(s.emails || []).slice(0, 3).join(", ")}`)
		.join("\n");

	const r = await llmJson(
		[
			{
				role: "system",
				content: `You generate 2 to 8 scrape jobs for a Maps + Google Search lead agent.
Each job is one of:
- type "maps": Google Maps search string (local businesses)
- type "search": Google web search (emails, founder, LinkedIn, contact)
- type "scrape": a concrete https URL to scrape (contact/about pages only if known)

Return ONLY JSON:
{
  "problemContext": "what we are looking for",
  "queries": [
    { "id": "m1", "type": "maps"|"search"|"scrape", "query": "string", "url": "optional for scrape" }
  ]
}

Rules:
- Between 2 and 8 queries inclusive.
- At least one "maps" query if the goal is local businesses.
- At least one "search" query for emails/founders/socials when websites or business names are known.
- Maps queries must include a city/region when known.
- Do not invent URLs. scrape.url only if it appeared in the prompt or seed scrape.
- Keep maps queries short, like a Maps search box.`,
			},
			{
				role: "user",
				content: `Prompt:\n${prompt}\n\nUser answers:\n${answersText}\n\nGeo hint: ${geo || "unspecified"}\n\nSeed sites:\n${siteBlob || "(none)"}`,
			},
		],
		{ maxTokens: 1200, temperature: 0.25 },
	);

	let queries = Array.isArray(r.parsed?.queries) ? r.parsed.queries : [];
	queries = queries
		.filter((q) => q && q.query)
		.map((q, i) => ({
			id: q.id || `q${i + 1}`,
			type: ["maps", "search", "scrape"].includes(q.type) ? q.type : "search",
			query: String(q.query).trim(),
			url: q.url || (q.type === "scrape" ? q.query : undefined),
		}))
		.slice(0, MAX_QUERIES);
	if (queries.length < MIN_QUERIES) {
		queries = [
			{ id: "m1", type: "maps", query: prompt },
			{ id: "s1", type: "search", query: `${prompt} email contact founder` },
		];
	}
	return {
		problemContext: r.parsed?.problemContext || prompt,
		queries,
		usage: r.usage,
		model: r.model,
	};
}

export async function runQueryJobs(queries, { baseUrl, geo }) {
	const jobs = queries.slice(0, MAX_QUERIES).map(async (q) => {
		if (q.type === "maps") return runMapsQueryHttp(q.query, baseUrl);
		if (q.type === "scrape" && (q.url || /^https?:\/\//i.test(q.query))) {
			return runSiteScrapeHttp(q.url || q.query, baseUrl);
		}
		return runGoogleSearchHttp(q.query, baseUrl, geo);
	});
	return Promise.all(jobs);
}

/**
 * Final LLM: turn parallel scrape payload into lead objects.
 */
export async function answerAgent({ prompt, problemContext, queryResults, answersText }) {
	const compact = queryResults.map((r) => {
		if (r.type === "maps") {
			const places = Array.isArray(r.places)
				? r.places
				: r.places?.results || [];
			return {
				type: "maps",
				query: r.query,
				places: (Array.isArray(places) ? places : [])
					.slice(0, 10)
					.map((p) => ({
						name: p.name,
						address: p.address,
						phone: p.phone,
						website: p.website,
						mapsUrl: p.url,
						category: p.category,
						rating: p.rating,
					})),
			};
		}
		if (r.type === "scrape") {
			return {
				type: "scrape",
				url: r.url,
				title: r.title,
				emails: r.emails,
				socials: r.socials,
				snippet: String(r.markdown || "").slice(0, 2000),
			};
		}
		return {
			type: "search",
			query: r.query,
			emails: r.emails,
			results: (r.results || []).slice(0, 6).map((x) => ({
				title: x.title,
				link: x.link,
				snippet: x.snippet || x.description,
			})),
		};
	});

	const r = await llmJson(
		[
			{
				role: "system",
				content: `You are the answer agent. Merge Google Maps places + Google search + website scrapes into lead objects.
Do NOT invent emails, phones, or social URLs. Only include contact data present in the evidence.

Return ONLY JSON:
{
  "summary": "2-5 sentences",
  "leads": [
    {
      "name": "",
      "address": "",
      "phone": "",
      "website": "",
      "mapsUrl": "",
      "emails": { "contact": [], "founder": [], "manager": [] },
      "socials": { "linkedin": [], "instagram": [], "facebook": [], "twitter": [] },
      "people": [{ "name": "", "role": "", "source": "" }],
      "notes": ""
    }
  ],
  "message": "short note to the user"
}

Prefer one lead per Maps place. Attach emails/socials from search/scrape when the name/domain matches.`,
			},
			{
				role: "user",
				content: `Prompt: ${prompt}\n\nProblem: ${problemContext}\n\nAnswers:\n${answersText}\n\nEvidence:\n${JSON.stringify(compact).slice(0, 28000)}`,
			},
		],
		{ maxTokens: 2500, temperature: 0.2 },
	);

	const leads = Array.isArray(r.parsed?.leads) ? r.parsed.leads : [];
	return {
		summary: r.parsed?.summary || "",
		leads,
		message: r.parsed?.message || "",
		usage: r.usage,
		model: r.model,
	};
}

/**
 * One turn of the maps leads agent.
 */
export async function runMapsLeadsTurn({
	prompt,
	sessionId,
	answers,
	skipClarification = false,
	geo = "in",
	c = null,
} = {}) {
	const session = getOrCreateSession(sessionId);
	const baseUrl = apiBase(c);

	if (prompt && String(prompt).trim()) session.prompt = String(prompt).trim();
	if (!session.prompt) {
		return {
			success: false,
			status: "error",
			code: "MISSING_PROMPT",
			error: "prompt is required",
		};
	}

	session.answers = mergeAnswers(session.answers, answers);
	let usage = session.usage || normalizeOpenRouterUsage(null);

	if (session.phase === "new" || !session.siteContext?.length) {
		const urls = collectSeedUrls(session.prompt);
		if (urls.length) {
			session.siteContext = await scrapeSeedUrls(urls, baseUrl);
		} else {
			session.siteContext = session.siteContext || [];
		}
		session.phase = "classified";
	}

	const hasAnswers =
		Object.keys(session.answers || {}).length > 0 &&
		Object.values(session.answers).some((v) => String(v || "").trim());

	if (session.phase !== "complete" && !hasAnswers) {
		const classified = await classifierAgent({
			prompt: session.prompt,
			siteContext: session.siteContext,
			skipClarification,
		});
		usage = mergeOpenRouterUsage(usage, classified.usage);
		session.usage = usage;
		session.questionsAsked = classified.questions || [];
		session.understoodContext = classified.understoodContext;

		if (classified.needClarification) {
			session.phase = "clarifying";
			return {
				success: true,
				status: "clarifying",
				sessionId: session.id,
				message: classified.message,
				understoodContext: classified.understoodContext,
				intent: classified.intent,
				questions: classified.questions,
				siteContext: session.siteContext.map((s) => ({
					url: s.url,
					title: s.title,
					ok: s.ok,
					emails: s.emails,
				})),
				usage,
				tokenUsage: toTokenUsageCamel(usage),
			};
		}
	}

	const answersText = answersAsText(session.answers, session.questionsAsked);
	const generated = await queryGeneratorAgent({
		prompt: session.prompt,
		answersText,
		siteContext: session.siteContext,
		geo,
	});
	usage = mergeOpenRouterUsage(usage, generated.usage);
	session.queries = generated.queries;
	session.problemContext = generated.problemContext;

	const queryResults = await runQueryJobs(generated.queries, { baseUrl, geo });
	session.queryResults = queryResults;

	const answered = await answerAgent({
		prompt: session.prompt,
		problemContext: generated.problemContext,
		queryResults,
		answersText,
	});
	usage = mergeOpenRouterUsage(usage, answered.usage);
	session.usage = usage;
	session.phase = "complete";

	return {
		success: true,
		status: "complete",
		sessionId: session.id,
		message: answered.message,
		summary: answered.summary,
		leads: answered.leads,
		problemContext: generated.problemContext,
		queries: generated.queries,
		queryResults: queryResults.map((r) => ({
			type: r.type,
			query: r.query,
			ok: r.ok !== false,
			error: r.error || null,
			placeCount: Array.isArray(r.places)
				? r.places.length
				: r.places?.results?.length || 0,
			resultCount: Array.isArray(r.results) ? r.results.length : 0,
			emails: r.emails || undefined,
		})),
		siteContext: session.siteContext.map((s) => ({
			url: s.url,
			title: s.title,
			ok: s.ok,
			emails: s.emails,
		})),
		usage,
		tokenUsage: toTokenUsageCamel(usage),
	};
}
