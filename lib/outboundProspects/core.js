/**
 * Outbound prospect leads — Firestore + contact extraction + optional LLM scoring.
 */

import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import { resolveAgentLlmModel } from "../useAi.js";
import {
	candidateFromSerp,
	createSeenMap,
	extractEmails,
	extractPhones,
	hostnameOf,
	isJunkHost,
	leadDocId,
	normalizeUrl,
	seenKey,
} from "../karyamFounders/core.js";
import {
	KARYAM_PITCH,
	OUTBOUND_AGENT,
	SAASCRM_PITCH,
} from "./configs.js";

export {
	createSeenMap,
	leadDocId,
	seenKey,
	isJunkHost,
	normalizeUrl,
	hostnameOf,
	extractEmails,
	extractPhones,
	candidateFromSerp,
};

export function candidateFromMapsPlace(place, job) {
	const website = normalizeUrl(place.website || "");
	const name = String(place.name || "").trim();
	return {
		name,
		company: name,
		title: place.category || "",
		snippet: [place.address, place.category].filter(Boolean).join(" · "),
		phone: String(place.phone || "").trim(),
		emails: [],
		website,
		address: String(place.address || "").trim(),
		mapsUrl: place.mapsUrl || place.url || "",
		rating: place.rating ?? null,
		sourceUrl: website || place.mapsUrl || place.url || "",
		sourcePlatform: "maps",
		channel: "maps",
		brand: job.brand,
		intent: job.intent,
		country: job.country,
		searchQuery: job.query,
		jobId: job.id,
		outreachStatus: "new",
		role: "unknown",
	};
}

export function mergeContactFields(lead, contacts = {}) {
	const emails = [
		...(lead.emails || []),
		...(contacts.emails || []),
		lead.email ? [lead.email] : [],
	].filter(Boolean);
	const uniqueEmails = [...new Set(emails.map((e) => e.toLowerCase()))];
	const phones = [
		...(lead.phones || []),
		...(contacts.phones || []),
		lead.phone ? [lead.phone] : [],
	].filter(Boolean);
	const uniquePhones = [...new Set(phones)];
	return {
		...lead,
		...contacts,
		emails: uniqueEmails,
		phones: uniquePhones,
		email: uniqueEmails[0] || lead.email || "",
		phone: uniquePhones[0] || lead.phone || "",
		website: contacts.website || lead.website || "",
		linkedinUrl: contacts.linkedinUrl || lead.linkedinUrl || "",
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

export async function listLeads(collection, { limit = 50, minScore = 0 } = {}) {
	const cap = Math.min(limit, 200);
	let snap;
	try {
		snap = await firestore
			.collection(collection)
			.orderBy("updatedAt", "desc")
			.limit(cap)
			.get();
	} catch {
		snap = await firestore.collection(collection).limit(cap).get();
	}
	const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	return rows.filter((r) => (r.relevanceScore ?? 0) >= minScore);
}

export async function loadJobCursor(stateCollection, agentId) {
	const snap = await firestore.collection(stateCollection).doc(agentId).get();
	if (!snap.exists) return { lastJobIndex: 0, querySetVersion: 0 };
	const data = snap.data() || {};
	return {
		lastJobIndex: Number(data.lastJobIndex) || 0,
		querySetVersion: Number(data.querySetVersion) || 0,
	};
}

export async function saveJobCursor(stateCollection, agentId, index, version) {
	await firestore
		.collection(stateCollection)
		.doc(agentId)
		.set(
			{
				agentId,
				lastJobIndex: index,
				querySetVersion: version,
				updatedAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
}

function leadScorePayload(lead) {
	return {
		id: lead.id || leadDocId(lead),
		brand: lead.brand,
		intent: lead.intent,
		name: lead.name,
		company: lead.company,
		title: lead.title,
		snippet: String(lead.snippet || "").slice(0, 350),
		country: lead.country,
		website: lead.website,
		email: lead.email,
		phone: lead.phone,
		linkedinUrl: lead.linkedinUrl,
		channel: lead.channel,
	};
}

function applyScoreHit(lead, hit) {
	if (!hit) {
		return {
			...lead,
			relevanceScore: lead.relevanceScore ?? 0,
			relevanceReason: lead.relevanceReason || "llm_missing",
		};
	}
	return {
		...lead,
		relevanceScore: Number(hit.score) || 0,
		relevanceReason: hit.reason || "",
		name: hit.name || lead.name,
		company: hit.company || lead.company,
		role: hit.role || lead.role,
		brandFit: hit.brandFit || lead.brand,
		painPoint: hit.painPoint || "",
		suggestedOffer: hit.suggestedOffer || "",
		draftSubject: hit.draftSubject || "",
		draftMessage: hit.draftMessage || "",
		llmScoredAt: new Date().toISOString(),
	};
}

function scoreSystemPrompt({ drafts = true } = {}) {
	const draftFields = drafts
		? `"draftSubject": "under 60 chars",
  "draftMessage": "2-3 short sentences. No line breaks. Escape quotes. One CTA."`
		: `"draftSubject": "",
  "draftMessage": ""`;

	return `You score B2B outbound prospects for two offers:

1) ${KARYAM_PITCH}
2) ${SAASCRM_PITCH}

Pick brand fit per lead: karyam | saascrm | both.

Score 1-5:
5 = founder/owner/CEO/CTO or agency principal with clear software/AI/CRM need
4 = strong operator or agency buyer
3 = unclear
1-2 = listicle, job board, student, recruiter, or junk

Return ONLY valid JSON (no markdown). Keep strings short. Escape double quotes inside strings.
{ "results": [{
  "id": "",
  "score": 0,
  "reason": "",
  "name": "",
  "company": "",
  "role": "founder|ceo|cto|owner|agency|unknown",
  "brandFit": "karyam|saascrm|both",
  "painPoint": "one short line",
  "suggestedOffer": "specific service",
  ${draftFields}
}] }
Include every input id exactly once.`;
}

async function requestLeadScores(leads, opts, { drafts = true } = {}) {
	const { content } = await openRouterChat({
		model: resolveAgentLlmModel(opts.model),
		jsonMode: true,
		temperature: 0.15,
		maxTokens: drafts ? 2800 : 1200,
		messages: [
			{ role: "system", content: scoreSystemPrompt({ drafts }) },
			{
				role: "user",
				content: JSON.stringify(leads.map(leadScorePayload)),
			},
		],
	});

	const parsed = parseJsonFromLLM(content);
	return Array.isArray(parsed?.results) ? parsed.results : [];
}

async function scoreLeadChunk(leads, opts) {
	if (!leads.length) return [];

	try {
		return await requestLeadScores(leads, opts, { drafts: true });
	} catch (err) {
		console.error(
			`[outbound-prospects] score parse failed (${leads.length} leads):`,
			err?.message || err,
		);
	}

	if (leads.length > 1) {
		const merged = [];
		for (const lead of leads) {
			merged.push(...(await scoreLeadChunk([lead], opts)));
		}
		return merged;
	}

	try {
		return await requestLeadScores(leads, opts, { drafts: false });
	} catch (err) {
		console.error(
			"[outbound-prospects] score-only fallback failed:",
			err?.message || err,
		);
		return [
			{
				id: leads[0].id || leadDocId(leads[0]),
				score: 0,
				reason: "llm_parse_failed",
			},
		];
	}
}

export async function scoreLeadsWithLlm(leads, opts = {}) {
	if (!leads.length) return [];

	const chunkSize = Math.max(
		1,
		Number(opts.chunkSize || opts.scoreBatchSize || OUTBOUND_AGENT.scoreBatchSize || 3),
	);
	const allHits = [];

	for (let i = 0; i < leads.length; i += chunkSize) {
		const chunk = leads.slice(i, i + chunkSize);
		const hits = await scoreLeadChunk(chunk, opts);
		allHits.push(...hits);
	}

	const byId = new Map(allHits.map((r) => [r.id, r]));
	return leads.map((lead) =>
		applyScoreHit(lead, byId.get(lead.id || leadDocId(lead))),
	);
}

export function applyLlmScores(leads, scored, relevanceMin = OUTBOUND_AGENT.relevanceMin) {
	const byId = new Map(scored.map((l) => [l.id || leadDocId(l), l]));
	return leads
		.map((l) => byId.get(l.id || leadDocId(l)) || l)
		.filter((l) => !l.relevanceScore || l.relevanceScore >= relevanceMin || !l.llmScoredAt);
}
