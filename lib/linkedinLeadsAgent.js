/**
 * LinkedIn Leads Agent — conversational loop on one endpoint.
 *
 * Flow (session-based):
 *  1. User sends { prompt } → AI may ask clarifying questions (ICP / clients / investors)
 *  2. User answers with { sessionId, answers } → AI builds 2–5 LinkedIn search queries
 *  3. Parallel Composio tool calls; empty results trigger alternate queries
 *  4. AI synthesizes final lead brief
 *
 * Env: OPENROUTER_API_KEY, COMPOSIO_API_KEY, COMPOSIO_LINKEDIN_SEARCH_TOOL, …
 */

import { randomUUID } from "node:crypto";
import {
	normalizeOpenRouterUsage,
	mergeOpenRouterUsage,
	toTokenUsageCamel,
} from "./openRouterUsage.js";
import {
	buildSearchToolArguments,
	checkComposioReady,
	executeComposioTool,
	extractLeadsFromToolResult,
	getLinkedInSearchToolSlug,
} from "./composioClient.js";

const SESSION_TTL_MS =
	Number.parseInt(process.env.LINKEDIN_LEADS_SESSION_TTL_MS || "", 10) ||
	30 * 60 * 1000;
const MAX_QUERIES = 5;
const MIN_QUERIES = 2;
const OPENROUTER_TIMEOUT_MS =
	Number.parseInt(process.env.OPENROUTER_TIMEOUT_MS || "", 10) || 90_000;

/** @type {Map<string, object>} */
const sessions = new Map();

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
		searchQueries: [],
		leads: [],
		phase: "new",
		history: [],
	};
	sessions.set(id, s);
	return s;
}

function openRouterModel() {
	return (
		process.env.OPENROUTER_LINKEDIN_LEADS_MODEL?.trim() ||
		process.env.OPENROUTER_AGENT_MODEL?.trim() ||
		process.env.OPENROUTER_MODEL?.trim() ||
		"openai/gpt-4o-mini"
	);
}

async function openRouterJson(messages, { maxTokens = 2500, temperature = 0.3 } = {}) {
	const apiKey = process.env.OPENROUTER_API_KEY?.trim();
	if (!apiKey) {
		throw new Error("OPENROUTER_API_KEY not configured");
	}
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			...(process.env.OPENROUTER_HTTP_REFERER
				? { "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER }
				: {}),
			...(process.env.OPENROUTER_APP_TITLE
				? { "X-Title": process.env.OPENROUTER_APP_TITLE }
				: { "X-Title": "linkedin-leads" }),
		},
		body: JSON.stringify({
			model: openRouterModel(),
			messages,
			temperature,
			max_tokens: maxTokens,
			response_format: { type: "json_object" },
		}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(
			data?.error?.message || `OpenRouter error (${res.status})`,
		);
	}
	const content = String(data?.choices?.[0]?.message?.content || "").trim();
	const usage = normalizeOpenRouterUsage(data?.usage);
	let parsed = {};
	try {
		parsed = JSON.parse(
			content.replace(/^```json\s*/i, "").replace(/```$/i, "").trim(),
		);
	} catch {
		parsed = { raw: content };
	}
	return { parsed, usage, content, model: openRouterModel() };
}

function mergeAnswers(existing, incoming) {
	const out = { ...(existing || {}) };
	if (!incoming) return out;
	if (Array.isArray(incoming)) {
		incoming.forEach((a, i) => {
			if (a == null) return;
			if (typeof a === "object" && (a.id || a.questionId)) {
				out[String(a.id || a.questionId)] =
					a.answer ?? a.value ?? a.text ?? "";
			} else {
				out[`a${i + 1}`] = String(a);
			}
		});
		return out;
	}
	if (typeof incoming === "object") {
		for (const [k, v] of Object.entries(incoming)) {
			out[k] = v;
		}
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
		if (v != null && String(v).trim()) {
			lines.push(`${k}: ${String(v)}`);
		}
	}
	return lines.join("\n\n") || "(no answers yet)";
}

const CLARIFY_SYSTEM = `You are an expert B2B lead-research strategist for LinkedIn prospecting.
The user wants leads: clients, ICP (ideal customer profiles), investors, customers, partners, or hiring talent.

Decide whether you have enough context to design precise LinkedIn search queries.
If context is thin, ask 1–4 SHORT clarifying questions (max 4). Prefer multiple-choice when helpful.
If context is already rich, set needClarification=false and summarize the ICP.

Return ONLY valid JSON:
{
  "needClarification": true|false,
  "understoodContext": "1-3 sentence summary of what they want",
  "leadType": "clients|icp|investors|customers|partners|talent|other",
  "questions": [
    { "id": "q1", "question": "...", "why": "brief", "options": ["optional","choices"] }
  ],
  "message": "short friendly message to the user"
}

Rules:
- Never invent company facts.
- Questions should unlock better search filters: role/title, industry, geo, company size, funding stage, tech stack, or buyer persona.
- If the prompt already specifies role + industry + location clearly, set needClarification=false.`;

const QUERY_SYSTEM = `You design LinkedIn prospecting searches executed via Composio tools.
Default tool slug will be provided. Build 2–5 DISTINCT search queries (min 2, max 5).

Return ONLY valid JSON:
{
  "icpSummary": "concise ICP statement",
  "queries": [
    {
      "id": "q1",
      "label": "human label",
      "rationale": "why this query",
      "q": "keywords string",
      "jobTitle": "optional",
      "location": "optional",
      "company": "optional",
      "industry": "optional",
      "keywords": "optional",
      "filters": {},
      "limit": 10
    }
  ]
}

Rules:
- Queries must diversify angles (title variants, adjacent roles, geo/industry wedges) so empty primary searches still find leads.
- Prefer concrete job titles and locations over vague keywords.
- Do not exceed 5 queries.`;

const RETRY_SYSTEM = `Some LinkedIn searches returned zero leads. Propose 2–4 ALTERNATE queries with different titles/keywords/geo.
Return ONLY JSON: { "queries": [ { "id": "alt1", "label": "...", "q": "...", "jobTitle": "...", "location": "...", "industry": "...", "keywords": "...", "filters": {}, "limit": 10 } ] }`;

const SYNTH_SYSTEM = `You turn LinkedIn prospecting results into a clear lead brief for the user.
Return ONLY valid JSON:
{
  "summary": "executive overview in 2-5 sentences",
  "topLeads": [
    {
      "name": "...",
      "title": "...",
      "company": "...",
      "location": "...",
      "linkedinUrl": "...",
      "whyFit": "1 sentence why they match ICP",
      "outreachAngle": "1 short personalized opener idea"
    }
  ],
  "gaps": ["what is still missing or weak in the result set"],
  "nextSteps": ["actionable next steps"],
  "message": "friendly closing note to the user"
}

Use only people present in the provided leads data. Do not invent profiles.`;

/**
 * Run one turn of the LinkedIn leads agent.
 *
 * @param {{
 *   prompt?: string,
 *   sessionId?: string,
 *   answers?: object|array|string,
 *   skipClarification?: boolean,
 *   userId?: string,
 * }} input
 */
export async function runLinkedInLeadsTurn(input = {}) {
	const prompt = String(input.prompt || "").trim();
	const skipClarification = Boolean(input.skipClarification);
	const session = getOrCreateSession(input.sessionId);
	let usageTotal = normalizeOpenRouterUsage(null);
	const openRouterCalls = [];

	if (prompt) {
		session.prompt = prompt;
		session.history.push({ role: "user", content: prompt, at: new Date().toISOString() });
	}
	if (!session.prompt) {
		return {
			success: false,
			status: "error",
			error: "prompt is required on the first call (or provide a valid sessionId with prior prompt)",
			code: "MISSING_PROMPT",
		};
	}

	if (input.answers != null) {
		session.answers = mergeAnswers(session.answers, input.answers);
		session.history.push({
			role: "user",
			content: `Answers:\n${answersAsText(session.answers, session.questionsAsked)}`,
			at: new Date().toISOString(),
		});
	}

	const hasAnswers = Object.keys(session.answers || {}).length > 0;
	const shouldClarify =
		!skipClarification &&
		!hasAnswers &&
		session.phase !== "ready_to_search" &&
		session.phase !== "complete";

	// ── Phase A: clarify ─────────────────────────────────────────────────────
	if (shouldClarify || session.phase === "clarifying") {
		if (!hasAnswers) {
			const clarify = await openRouterJson(
				[
					{ role: "system", content: CLARIFY_SYSTEM },
					{
						role: "user",
						content: `User prompt:\n${session.prompt}`,
					},
				],
				{ maxTokens: 1800 },
			);
			usageTotal = mergeOpenRouterUsage(usageTotal, clarify.usage);
			openRouterCalls.push({ label: "clarify", usage: clarify.usage });

			const need = clarify.parsed?.needClarification !== false;
			const questions = Array.isArray(clarify.parsed?.questions)
				? clarify.parsed.questions.slice(0, 4)
				: [];

			if (need && questions.length > 0) {
				session.phase = "clarifying";
				session.questionsAsked = questions;
				session.understoodContext = clarify.parsed?.understoodContext || "";
				session.leadType = clarify.parsed?.leadType || "other";
				return {
					success: true,
					status: "clarifying",
					sessionId: session.id,
					message:
						clarify.parsed?.message ||
						"A few details will sharpen the LinkedIn search.",
					understoodContext: session.understoodContext,
					leadType: session.leadType,
					questions,
					usage: usageTotal,
					tokenUsage: toTokenUsageCamel(usageTotal),
					openRouterCalls,
					model: clarify.model,
				};
			}
			session.phase = "ready_to_search";
			session.understoodContext =
				clarify.parsed?.understoodContext || session.prompt;
			session.leadType = clarify.parsed?.leadType || "other";
		} else {
			session.phase = "ready_to_search";
		}
	} else if (skipClarification && session.phase === "new") {
		session.phase = "ready_to_search";
		session.understoodContext = session.prompt;
	}

	// ── Phase B: build queries ───────────────────────────────────────────────
	const toolSlug = getLinkedInSearchToolSlug();

	const composioReady = await checkComposioReady(toolSlug);
	if (!composioReady.ok) {
		return {
			success: false,
			status: "error",
			sessionId: session.id,
			error: composioReady.message,
			code: composioReady.code,
			tool: toolSlug,
			toolkit: composioReady.toolkit || null,
			usage: usageTotal,
			tokenUsage: toTokenUsageCamel(usageTotal),
			openRouterCalls,
			fix:
				"Update COMPOSIO_API_KEY in .env with a valid key from https://app.composio.dev, ensure Wiza is connected, then restart npm run dev.",
		};
	}

	const answersText = answersAsText(session.answers, session.questionsAsked);
	const queryPlan = await openRouterJson(
		[
			{ role: "system", content: QUERY_SYSTEM },
			{
				role: "user",
				content: `User prompt:\n${session.prompt}\n\nUnderstood context:\n${session.understoodContext || "(none)"}\n\nLead type: ${session.leadType || "unknown"}\n\nClarifying answers:\n${answersText}\n\nComposio tool slug to target: ${toolSlug}\nProduce ${MIN_QUERIES}-${MAX_QUERIES} search queries.`,
			},
		],
		{ maxTokens: 2200 },
	);
	usageTotal = mergeOpenRouterUsage(usageTotal, queryPlan.usage);
	openRouterCalls.push({ label: "query_plan", usage: queryPlan.usage });

	let queries = Array.isArray(queryPlan.parsed?.queries)
		? queryPlan.parsed.queries
		: [];
	queries = queries
		.filter((q) => q && (q.q || q.jobTitle || q.keywords || q.filters || q.arguments))
		.slice(0, MAX_QUERIES);

	if (queries.length < MIN_QUERIES) {
		// Soft-fill so we always attempt at least 2
		const base = session.prompt.slice(0, 120);
		while (queries.length < MIN_QUERIES) {
			queries.push({
				id: `fallback_${queries.length + 1}`,
				label: `Fallback search ${queries.length + 1}`,
				q: base,
				keywords: base,
				limit: 10,
			});
		}
	}

	session.searchQueries = queries;
	session.icpSummary = queryPlan.parsed?.icpSummary || session.understoodContext;

	// ── Phase C: parallel Composio searches + empty retry ────────────────────
	const searchRuns = await runQueriesInParallel(queries, toolSlug, input.userId);
	let allLeads = dedupeLeads(searchRuns.flatMap((r) => r.leads));
	const emptyIds = searchRuns.filter((r) => r.leads.length === 0).map((r) => r.queryId);

	let retryRuns = [];
	if (emptyIds.length > 0 && allLeads.length < 3) {
		const retryPlan = await openRouterJson(
			[
				{ role: "system", content: RETRY_SYSTEM },
				{
					role: "user",
					content: `Original prompt: ${session.prompt}\nICP: ${session.icpSummary}\nAnswers:\n${answersText}\n\nEmpty / weak queries:\n${JSON.stringify(queries.filter((q) => emptyIds.includes(q.id)), null, 2)}\n\nLeads found so far: ${allLeads.length}`,
				},
			],
			{ maxTokens: 1600 },
		);
		usageTotal = mergeOpenRouterUsage(usageTotal, retryPlan.usage);
		openRouterCalls.push({ label: "retry_queries", usage: retryPlan.usage });

		const alt = (Array.isArray(retryPlan.parsed?.queries)
			? retryPlan.parsed.queries
			: []
		).slice(0, 4);
		if (alt.length) {
			retryRuns = await runQueriesInParallel(alt, toolSlug, input.userId);
			allLeads = dedupeLeads([...allLeads, ...retryRuns.flatMap((r) => r.leads)]);
			session.searchQueries = [...queries, ...alt];
		}
	}

	session.leads = allLeads;

	// ── Phase D: synthesize ──────────────────────────────────────────────────
	const synth = await openRouterJson(
		[
			{ role: "system", content: SYNTH_SYSTEM },
			{
				role: "user",
				content: `User prompt:\n${session.prompt}\n\nICP summary:\n${session.icpSummary}\n\nAnswers:\n${answersText}\n\nSearch queries used:\n${JSON.stringify(session.searchQueries, null, 2)}\n\nLeads (${allLeads.length}):\n${JSON.stringify(allLeads.slice(0, 40).map(stripRaw), null, 2)}`,
			},
		],
		{ maxTokens: 2800, temperature: 0.35 },
	);
	usageTotal = mergeOpenRouterUsage(usageTotal, synth.usage);
	openRouterCalls.push({ label: "synthesize", usage: synth.usage });

	session.phase = "complete";
	session.updatedAt = Date.now();

	return {
		success: true,
		status: "complete",
		sessionId: session.id,
		message: synth.parsed?.message || "Here are the LinkedIn leads I found.",
		icpSummary: session.icpSummary,
		leadType: session.leadType || null,
		searchQueries: session.searchQueries,
		searchResults: [...searchRuns, ...retryRuns].map((r) => ({
			queryId: r.queryId,
			label: r.label,
			successful: r.successful,
			leadCount: r.leads.length,
			error: r.error,
			tool: r.tool,
		})),
		leads: allLeads.map(stripRaw),
		summary: synth.parsed?.summary || null,
		topLeads: Array.isArray(synth.parsed?.topLeads)
			? synth.parsed.topLeads
			: [],
		gaps: Array.isArray(synth.parsed?.gaps) ? synth.parsed.gaps : [],
		nextSteps: Array.isArray(synth.parsed?.nextSteps)
			? synth.parsed.nextSteps
			: [],
		usage: usageTotal,
		tokenUsage: toTokenUsageCamel(usageTotal),
		openRouterCalls,
		model: synth.model,
		tool: toolSlug,
	};
}

async function runQueriesInParallel(queries, toolSlug, userId) {
	return Promise.all(
		queries.map(async (q) => {
			const args = buildSearchToolArguments(q, toolSlug);
			const exec = await executeComposioTool(toolSlug, args, { userId });
			const leads = exec.successful
				? extractLeadsFromToolResult(exec)
				: [];
			return {
				queryId: q.id || q.label || randomUUID(),
				label: q.label || q.q || q.jobTitle || "search",
				tool: toolSlug,
				successful: exec.successful,
				error: exec.error,
				leads,
				arguments: args,
			};
		}),
	);
}

function dedupeLeads(leads) {
	const seen = new Set();
	const out = [];
	for (const lead of leads) {
		if (!lead) continue;
		const key = (
			lead.linkedinUrl ||
			`${lead.name || ""}|${lead.company || ""}|${lead.title || ""}`
		)
			.toLowerCase()
			.trim();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(lead);
	}
	return out;
}

function stripRaw(lead) {
	if (!lead) return lead;
	const { raw, ...rest } = lead;
	return rest;
}

export function getLinkedInLeadsSession(sessionId) {
	pruneSessions();
	return sessions.get(sessionId) || null;
}
