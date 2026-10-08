/**
 * Outbound B2B prospect pipeline — Google + Maps → scrape contacts → optional LLM drafts.
 * CLI / POST only. Does NOT auto-start on npm run dev.
 */

import { isUseAiOn, resolveAgentLlmModel } from "../useAi.js";
import {
	DISCOVERY_JOBS,
	jobsForFilter,
	OUTBOUND_AGENT,
	QUERY_SET_VERSION,
} from "./configs.js";
import {
	createSeenMap,
	leadDocId,
	leadExists,
	loadJobCursor,
	saveJobCursor,
	saveLead,
	scoreLeadsWithLlm,
} from "./core.js";
import { runDiscoveryJobs } from "./discover.js";
import { enrichLeads } from "./enrich.js";

/**
 * @param {{
 *   baseUrl?: string,
 *   jobsPerRun?: number,
 *   brand?: string,
 *   intent?: string,
 *   channel?: string,
 *   country?: string,
 *   jobId?: string,
 *   enrich?: boolean,
 *   useAI?: boolean,
 *   model?: string,
 * }} [opts]
 */
export async function runOutboundProspectsAgent(opts = {}) {
	const agent = { ...OUTBOUND_AGENT, model: resolveAgentLlmModel(opts.model) };
	const baseUrl = opts.baseUrl;
	const perRun = opts.jobsPerRun ?? agent.jobsPerRun ?? 4;
	const doEnrich = opts.enrich !== false;
	const useAI = isUseAiOn(opts);

	const jobPool = jobsForFilter({
		brand: opts.brand,
		intent: opts.intent,
		channel: opts.channel,
		country: opts.country,
		jobId: opts.jobId,
	});
	if (!jobPool.length) {
		throw new Error("No outbound prospect discovery jobs for selected filter");
	}

	const stored = await loadJobCursor(agent.stateCollection, agent.id);
	let cursor = stored.lastJobIndex;
	if (stored.querySetVersion !== QUERY_SET_VERSION) cursor = 0;

	const batch = [];
	for (let i = 0; i < perRun; i++) {
		const idx = (cursor + i) % jobPool.length;
		batch.push({ ...jobPool[idx], jobIndex: idx });
	}
	const nextCursor = (cursor + perRun) % jobPool.length;
	await saveJobCursor(
		agent.stateCollection,
		agent.id,
		nextCursor,
		QUERY_SET_VERSION,
	);

	const summary = {
		agentId: agent.id,
		collection: agent.collection,
		brands: agent.brands,
		jobsRun: batch.map((j) => j.id),
		jobCursor: {
			from: cursor,
			to: nextCursor,
			total: jobPool.length,
			version: QUERY_SET_VERSION,
		},
		candidates: 0,
		newLeads: 0,
		enriched: 0,
		withContact: 0,
		useAI,
		scored: 0,
		relevant: [],
		errors: [],
	};

	const seen = createSeenMap();
	let discovered = [];
	try {
		discovered = await runDiscoveryJobs(batch, { baseUrl, seen });
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
				lead: c.sourceUrl || c.company,
				error: err?.message || String(err),
			});
		}
	}

	let working = fresh;
	if (doEnrich && fresh.length) {
		console.log(
			`[outbound-prospects] enriching up to ${agent.enrichPerRun} of ${fresh.length}`,
		);
		working = await enrichLeads(fresh, {
			baseUrl,
			limit: agent.enrichPerRun,
		});
		summary.enriched = working.length;
		summary.withContact = working.filter((l) => l.hasContact).length;
	}

	if (useAI && working.length) {
		const toScore = working.slice(0, agent.scoreBatchSize);
		const scored = await scoreLeadsWithLlm(toScore, {
			model: agent.model,
			scoreBatchSize: agent.scoreBatchSize,
		});
		const byId = new Map(scored.map((l) => [leadDocId(l), l]));
		const scoredIds = new Set(toScore.map((l) => leadDocId(l)));
		working = working.map((l) =>
			scoredIds.has(leadDocId(l)) ? byId.get(leadDocId(l)) || l : l,
		);
		summary.scored = toScore.length;
		summary.relevant = working
			.filter((l) => (l.relevanceScore ?? 0) >= agent.relevanceMin)
			.map((l) => ({
				id: leadDocId(l),
				name: l.name,
				company: l.company,
				score: l.relevanceScore,
				email: l.email,
				brandFit: l.brandFit,
			}));
		const parseFails = working.filter(
			(l) => scoredIds.has(leadDocId(l)) && l.relevanceReason === "llm_parse_failed",
		).length;
		if (parseFails) {
			summary.errors.push({
				stage: "llm",
				error: `${parseFails} lead(s) could not be scored (JSON parse failed)`,
			});
		}
	}

	for (const lead of working) {
		try {
			const id = await saveLead(agent.collection, lead);
			summary.newLeads += 1;
			if (!lead.id) lead.id = id;
		} catch (err) {
			summary.errors.push({
				lead: lead.sourceUrl || lead.company,
				error: err?.message || String(err),
			});
		}
	}

	console.log(
		`[outbound-prospects] done — ${summary.newLeads} saved, ${summary.withContact} with contact, ${summary.relevant.length} relevant (≥${agent.relevanceMin}) → ${agent.collection}`,
	);

	return summary;
}

export { DISCOVERY_JOBS, OUTBOUND_AGENT };
