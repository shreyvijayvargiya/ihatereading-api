/**
 * Angel / seed investor orchestrator.
 * X → LinkedIn → Google agents → enrich scrape → LLM score → Firestore.
 * CLI / POST only — does NOT auto-start on npm run dev.
 */

import { isUseAiOn } from "../useAi.js";
import { ANGEL_AGENT, ALL_QUERIES } from "./configs.js";
import {
	createSeenMap,
	investorDocId,
	investorExists,
	listInvestors,
	loadQueryCursor,
	saveInvestor,
	saveQueryCursor,
	scoreInvestorsWithLlm,
	seenKey,
} from "./core.js";
import {
	enrichCandidates,
	runGoogleAgent,
	runLinkedInAgent,
	runXAgent,
} from "./platforms.js";

/**
 * @param {{
 *   baseUrl?: string,
 *   queriesPerRun?: number,
 *   platform?: "x" | "linkedin" | "google",
 *   enrich?: boolean,
 *   useAI?: boolean,
 * }} [opts]
 */
export async function runAngelInvestorsAgent(opts = {}) {
	const agent = ANGEL_AGENT;
	const baseUrl = opts.baseUrl;
	const perRun = opts.queriesPerRun ?? agent.queriesPerRun ?? 3;
	const doEnrich = opts.enrich !== false;
	const useAI = isUseAiOn(opts);

	let queryPool = ALL_QUERIES;
	if (opts.platform) {
		const p = String(opts.platform).toLowerCase();
		queryPool = ALL_QUERIES.filter((q) => q.platform === p);
	}
	if (!queryPool.length) {
		throw new Error("No angel search queries for selected platform");
	}

	const cursor = await loadQueryCursor(agent.stateCollection, agent.id);
	const batch = [];
	for (let i = 0; i < perRun; i++) {
		const idx = (cursor + i) % queryPool.length;
		batch.push({ ...queryPool[idx], queryIndex: idx });
	}
	const nextCursor = (cursor + perRun) % queryPool.length;
	await saveQueryCursor(agent.stateCollection, agent.id, nextCursor);

	const summary = {
		agentId: agent.id,
		collection: agent.collection,
		queriesRun: batch.length,
		queryCursor: { from: cursor, to: nextCursor, total: queryPool.length },
		platforms: {
			x: 0,
			linkedin: 0,
			google: 0,
		},
		candidates: 0,
		newInvestors: 0,
		useAI,
		scored: 0,
		relevant: [],
		errors: [],
	};

	const seen = createSeenMap();
	const agentOpts = { baseUrl, seen };

	// 1) Platform agents (share seen hashmap)
	let fromX = [];
	let fromLi = [];
	let fromG = [];
	try {
		fromX = await runXAgent(batch, agentOpts);
		summary.platforms.x = fromX.length;
	} catch (err) {
		summary.errors.push({ platform: "x", error: err?.message || String(err) });
	}
	try {
		fromLi = await runLinkedInAgent(batch, agentOpts);
		summary.platforms.linkedin = fromLi.length;
	} catch (err) {
		summary.errors.push({
			platform: "linkedin",
			error: err?.message || String(err),
		});
	}
	try {
		fromG = await runGoogleAgent(batch, agentOpts);
		summary.platforms.google = fromG.length;
	} catch (err) {
		summary.errors.push({
			platform: "google",
			error: err?.message || String(err),
		});
	}

	// Merge + re-dedupe
	const merged = [];
	const mergeSeen = createSeenMap();
	for (const c of [...fromX, ...fromLi, ...fromG]) {
		const k = seenKey(c);
		if (mergeSeen.has(k)) continue;
		mergeSeen.set(k, true);
		merged.push(c);
	}
	summary.candidates = merged.length;

	// Skip already in Firestore
	const fresh = [];
	for (const c of merged) {
		const exists = await investorExists(agent.collection, c);
		if (exists) continue;
		fresh.push(c);
	}

	// 2) Enrich via /scrape for contacts
	let enriched = fresh;
	if (doEnrich && fresh.length) {
		console.log(
			`[angel] enriching up to ${agent.enrichPerRun} of ${fresh.length} new`,
		);
		enriched = await enrichCandidates(fresh, {
			baseUrl,
			limit: agent.enrichPerRun,
		});
	}

	const toScore = enriched.map((c) => ({
		...c,
		id: investorDocId(c),
		fetchedAt: new Date().toISOString(),
		relevanceScore: 0,
		relevanceReason: "",
		draftMessage: "",
		investorType: "unknown",
		checkSize: "unknown",
		sectors: c.sector ? [c.sector] : [],
		scored: false,
	}));

	summary.newInvestors = toScore.length;

	if (!useAI) {
		console.log(
			`[angel] scrape-only — saving ${toScore.length} (pass --use-ai to score)`,
		);
		for (const inv of toScore) {
			inv.relevanceScore = 0;
			inv.relevanceReason = "scrape_only";
			inv.scored = false;
			await saveInvestor(agent.collection, inv);
			summary.relevant.push({
				id: inv.id,
				name: inv.name,
				sourcePlatform: inv.sourcePlatform,
				email: inv.email,
				emails: inv.emails,
				phone: inv.phone,
				phones: inv.phones,
				xUrl: inv.xUrl,
				linkedinUrl: inv.linkedinUrl,
				website: inv.website,
				sectors: inv.sectors,
				checkSize: inv.checkSize,
				investorType: inv.investorType,
				relevanceScore: 0,
				relevanceReason: "scrape_only",
				draftMessage: "",
				sourceUrl: inv.sourceUrl,
			});
		}
	} else {
		for (let i = 0; i < toScore.length; i += agent.scoreBatchSize) {
			const chunk = toScore.slice(i, i + agent.scoreBatchSize);
			const scored = await scoreInvestorsWithLlm(chunk, agent);
			for (const inv of chunk) {
				const match = scored.find((s) => s.id === inv.id);
				const score = Number(match?.score) || 0;
				inv.name = match?.name || inv.name;
				inv.relevanceScore = score;
				inv.relevanceReason = match?.reason || "";
				inv.draftMessage = match?.draftMessage || "";
				inv.investorType = match?.investorType || "unknown";
				inv.checkSize = match?.checkSize || "unknown";
				inv.sectors = Array.isArray(match?.sectors)
					? match.sectors
					: inv.sectors;
				inv.scored = true;
				inv.scoredAt = new Date().toISOString();

				await saveInvestor(agent.collection, inv);
				summary.scored += 1;

				if (score >= (agent.relevanceMin ?? 4)) {
					summary.relevant.push({
						id: inv.id,
						name: inv.name,
						sourcePlatform: inv.sourcePlatform,
						email: inv.email,
						emails: inv.emails,
						phone: inv.phone,
						phones: inv.phones,
						xUrl: inv.xUrl,
						linkedinUrl: inv.linkedinUrl,
						website: inv.website,
						sectors: inv.sectors,
						checkSize: inv.checkSize,
						investorType: inv.investorType,
						relevanceScore: score,
						relevanceReason: inv.relevanceReason,
						draftMessage: inv.draftMessage,
						sourceUrl: inv.sourceUrl,
					});
				}
			}
		}
	}

	console.log(
		`[angel] done — ${summary.candidates} candidates, ${summary.newInvestors} new, ${summary.scored} scored, ${summary.relevant.length} relevant${useAI ? ` (≥${agent.relevanceMin})` : " (scrape-only)"} → ${agent.collection}`,
	);
	return summary;
}

export { listInvestors, ALL_QUERIES, ANGEL_AGENT };
