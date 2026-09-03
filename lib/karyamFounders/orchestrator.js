/**
 * Karyam founder lead orchestrator.
 * Google queries → nested enrich → optional LLM drafts → Firestore.
 * Optional AutoSend is explicit (--send / { send: true }), never default.
 * CLI / POST only — does NOT auto-start on npm run dev.
 */

import { isUseAiOn } from "../useAi.js";
import {
	ALL_QUERIES,
	KARYAM_AGENT,
	QUERY_SET_VERSION,
	queriesForIntent,
} from "./configs.js";
import {
	bestEmail,
	createSeenMap,
	getLead,
	leadDocId,
	leadExists,
	listLeads,
	loadQueryCursor,
	saveLead,
	saveQueryCursor,
	scoreLeadsWithLlm,
} from "./core.js";
import { runGoogleDiscovery } from "./discover.js";
import { enrichCandidates, expandRelated } from "./enrich.js";
import { defaultDraft, sendAutosendEmail } from "./autosend.js";

function pickQueryPool(opts = {}) {
	let pool = ALL_QUERIES;
	if (opts.intent) pool = queriesForIntent(opts.intent);
	if (opts.queryId) {
		const id = String(opts.queryId).trim();
		pool = pool.filter((q) => q.id === id);
	}
	if (!pool.length) {
		throw new Error("No Karyam founder search queries for selected filter");
	}
	return pool;
}

/**
 * @param {{
 *   baseUrl?: string,
 *   queriesPerRun?: number,
 *   intent?: string,
 *   queryId?: string,
 *   enrich?: boolean,
 *   useAI?: boolean,
 *   send?: boolean,
 *   sendMinScore?: number,
 * }} [opts]
 */
export async function runKaryamFoundersAgent(opts = {}) {
	const agent = KARYAM_AGENT;
	const baseUrl = opts.baseUrl;
	const perRun = opts.queriesPerRun ?? agent.queriesPerRun ?? 3;
	const doEnrich = opts.enrich !== false;
	const useAI = isUseAiOn(opts);
	const doSend = opts.send === true;
	const queryPool = pickQueryPool(opts);

	const stored = await loadQueryCursor(agent.stateCollection, agent.id);
	let cursor = stored.lastQueryIndex;
	if (stored.querySetVersion !== QUERY_SET_VERSION) cursor = 0;

	const batch = [];
	for (let i = 0; i < perRun; i++) {
		const idx = (cursor + i) % queryPool.length;
		batch.push({ ...queryPool[idx], queryIndex: idx });
	}
	const nextCursor = (cursor + perRun) % queryPool.length;
	await saveQueryCursor(
		agent.stateCollection,
		agent.id,
		nextCursor,
		QUERY_SET_VERSION,
	);

	const summary = {
		agentId: agent.id,
		collection: agent.collection,
		queriesRun: batch.map((q) => q.id),
		queryCursor: {
			from: cursor,
			to: nextCursor,
			total: queryPool.length,
			version: QUERY_SET_VERSION,
		},
		candidates: 0,
		newLeads: 0,
		enriched: 0,
		useAI,
		scored: 0,
		sent: 0,
		relevant: [],
		errors: [],
	};

	const seen = createSeenMap();
	let discovered = [];
	try {
		discovered = await runGoogleDiscovery(batch, { baseUrl, seen });
	} catch (err) {
		summary.errors.push({ stage: "discover", error: err?.message || String(err) });
	}
	summary.candidates = discovered.length;

	const fresh = [];
	for (const c of discovered) {
		try {
			if (await leadExists(agent.collection, c)) continue;
			fresh.push(c);
		} catch (err) {
			summary.errors.push({
				lead: c.sourceUrl,
				error: err?.message || String(err),
			});
		}
	}

	let enriched = fresh;
	if (doEnrich && fresh.length) {
		console.log(
			`[karyam-founders] enriching up to ${agent.enrichPerRun} of ${fresh.length} new`,
		);
		enriched = await enrichCandidates(fresh, {
			baseUrl,
			limit: agent.enrichPerRun,
		});
		summary.enriched = Math.min(agent.enrichPerRun, fresh.length);

		const related = expandRelated(enriched, seen, 8);
		const relatedFresh = [];
		for (const c of related) {
			try {
				if (await leadExists(agent.collection, c)) continue;
				relatedFresh.push(c);
			} catch {
				/* skip */
			}
		}
		if (relatedFresh.length) {
			console.log(`[karyam-founders] nested outbound +${relatedFresh.length}`);
			const nestedLimit = Math.min(4, relatedFresh.length);
			const nestedEnriched = await enrichCandidates(relatedFresh, {
				baseUrl,
				limit: nestedLimit,
			});
			enriched = [...enriched, ...nestedEnriched];
			summary.enriched += nestedLimit;
			summary.candidates += relatedFresh.length;
		}
	}

	const toScore = enriched.map((c) => ({
		...c,
		id: leadDocId(c),
		fetchedAt: new Date().toISOString(),
		relevanceScore: 0,
		relevanceReason: "",
		draftSubject: "",
		draftMessage: "",
		suggestedOffer: "",
		role: c.role || "unknown",
		scored: false,
		outreachStatus: c.outreachStatus || "new",
	}));
	summary.newLeads = toScore.length;

	if (!useAI) {
		console.log(
			`[karyam-founders] scrape-only — saving ${toScore.length} (pass --use-ai to draft)`,
		);
		for (const lead of toScore) {
			lead.relevanceScore = 0;
			lead.relevanceReason = "scrape_only";
			const id = await saveLead(agent.collection, lead);
			summary.relevant.push(summarizeLead({ ...lead, id }));
		}
	} else {
		for (let i = 0; i < toScore.length; i += agent.scoreBatchSize) {
			const chunk = toScore.slice(i, i + agent.scoreBatchSize);
			const scored = await scoreLeadsWithLlm(chunk, agent);
			for (const lead of chunk) {
				const match = scored.find((s) => s.id === lead.id);
				const score = Number(match?.score) || 0;
				lead.name = match?.name || lead.name;
				lead.company = match?.company || lead.company;
				lead.relevanceScore = score;
				lead.relevanceReason = match?.reason || "";
				lead.draftSubject = match?.draftSubject || "";
				lead.draftMessage = match?.draftMessage || "";
				lead.suggestedOffer = match?.suggestedOffer || "";
				lead.role = match?.role || lead.role || "unknown";
				lead.scored = true;
				lead.scoredAt = new Date().toISOString();
				if (lead.draftMessage) lead.outreachStatus = "drafted";

				const id = await saveLead(agent.collection, lead);
				summary.scored += 1;
				if (score >= (agent.relevanceMin ?? 4) || !score) {
					summary.relevant.push(summarizeLead({ ...lead, id }));
				}
			}
		}
	}

	if (doSend) {
		const minScore = Number(opts.sendMinScore ?? agent.relevanceMin ?? 4);
		const sendable = toScore.filter((lead) => {
			if (!bestEmail(lead)) return false;
			if (lead.outreachStatus === "sent") return false;
			if (useAI && (Number(lead.relevanceScore) || 0) < minScore) return false;
			return true;
		});
		for (const lead of sendable) {
			try {
				const result = await sendLeadEmail(lead);
				summary.sent += 1;
				const row = summary.relevant.find((r) => r.id === lead.id);
				if (row) {
					row.outreachStatus = "sent";
					row.autosendEmailId = result.emailId;
				}
			} catch (err) {
				summary.errors.push({
					stage: "send",
					id: lead.id,
					error: err?.message || String(err),
				});
			}
		}
	}

	console.log(
		`[karyam-founders] done — ${summary.candidates} candidates, ${summary.newLeads} new, ${summary.scored} scored, ${summary.sent} sent → ${agent.collection}`,
	);
	return summary;
}

function summarizeLead(lead) {
	return {
		id: lead.id,
		name: lead.name,
		company: lead.company,
		role: lead.role,
		intent: lead.intent,
		email: bestEmail(lead),
		emails: lead.emails,
		founderEmail: lead.founderEmail,
		ctoEmail: lead.ctoEmail,
		hrEmail: lead.hrEmail,
		phone: lead.phone,
		linkedinUrl: lead.linkedinUrl,
		website: lead.website,
		relevanceScore: lead.relevanceScore || 0,
		relevanceReason: lead.relevanceReason || "",
		draftSubject: lead.draftSubject || "",
		draftMessage: lead.draftMessage || "",
		suggestedOffer: lead.suggestedOffer || "",
		outreachStatus: lead.outreachStatus || "new",
		sourceUrl: lead.sourceUrl,
	};
}

export async function sendLeadEmail(lead, opts = {}) {
	if (lead.outreachStatus === "sent" && !opts.force) {
		throw new Error("Already sent — pass force to resend");
	}
	const to = opts.to || bestEmail(lead);
	if (!to) throw new Error("Lead has no email");
	const fallback = defaultDraft(lead);
	const subject = opts.subject || lead.draftSubject || fallback.subject;
	const text = opts.text || lead.draftMessage || fallback.text;
	const result = await sendAutosendEmail({
		to,
		toName: lead.name || lead.company || "",
		subject,
		text,
		html: opts.html,
		replyTo: opts.replyTo,
	});
	await saveLead(KARYAM_AGENT.collection, {
		...lead,
		id: lead.id || leadDocId(lead),
		outreachStatus: "sent",
		lastEmailedAt: new Date().toISOString(),
		lastEmailedTo: to,
		autosendEmailId: result.emailId,
		autosendMessage: result.message,
	});
	return result;
}

export async function sendLeadsByIds(ids, opts = {}) {
	const results = [];
	for (const id of ids) {
		const lead = await getLead(KARYAM_AGENT.collection, id);
		if (!lead) {
			results.push({ id, success: false, error: "not_found" });
			continue;
		}
		try {
			const sent = await sendLeadEmail(lead, opts);
			results.push({ id, success: true, emailId: sent.emailId, to: bestEmail(lead) });
		} catch (err) {
			await saveLead(KARYAM_AGENT.collection, {
				...lead,
				outreachStatus: "failed",
				outreachError: err?.message || String(err),
			});
			results.push({ id, success: false, error: err?.message || String(err) });
		}
	}
	return results;
}

export { listLeads, ALL_QUERIES, KARYAM_AGENT, bestEmail };
