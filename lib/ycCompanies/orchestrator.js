/**
 * YC companies orchestrator.
 * yc-oss real startups → page/Google enrich → LLM → Firestore (hash dedupe).
 */

import { isUseAiOn } from "../useAi.js";
import { ALL_SOURCES, YC_AGENT } from "./configs.js";
import {
	companyDocId,
	companyExists,
	computeConfidence,
	createSeenMap,
	isJunkCandidate,
	listCompanies,
	loadSourceCursor,
	saveCompany,
	saveSourceCursor,
	synthesizeCompaniesWithLlm,
} from "./core.js";
import { enrichCompanies, runDiscoverySource } from "./sources.js";

/**
 * @param {{
 *   baseUrl?: string,
 *   sourcesPerRun?: number,
 *   status?: string,
 *   hiring?: boolean,
 *   enrich?: boolean,
 *   useAI?: boolean,
 * }} [opts]
 */
export async function runYcCompaniesAgent(opts = {}) {
	const agent = YC_AGENT;
	const baseUrl = opts.baseUrl;
	const perRun = opts.sourcesPerRun ?? agent.sourcesPerRun ?? 1;
	const doEnrich = opts.enrich !== false;
	const useAI = isUseAiOn(opts);

	let sourcePool = ALL_SOURCES;
	if (opts.status) {
		const s = String(opts.status).toLowerCase();
		sourcePool = ALL_SOURCES.filter((src) => {
			const hint = String(src.statusHint || "").toLowerCase();
			if (s === "funded") return hint === "funded" || hint === "active";
			if (s === "hiring") return Boolean(src.preferHiring);
			return hint === s;
		});
	}
	if (opts.hiring) {
		sourcePool = ALL_SOURCES.filter((s) => s.preferHiring);
		if (!sourcePool.length) sourcePool = ALL_SOURCES.filter((s) => s.id.includes("hiring"));
	}
	if (!sourcePool.length) {
		throw new Error("No YC discovery sources for selected filter");
	}

	const cursor = await loadSourceCursor(agent.stateCollection, agent.id);
	const sourceIndex = cursor.sourceIndex % sourcePool.length;
	const source = sourcePool[sourceIndex];
	const batch = [source];
	// Advance source after finishing a full feed cycle (offset wrap handled below)
	let feedOffset = cursor.feedOffset || 0;

	const summary = {
		agentId: agent.id,
		collection: agent.collection,
		sourcesRun: batch.map((s) => s.id),
		sourceCursor: {
			sourceIndex,
			feedOffset,
			totalSources: sourcePool.length,
		},
		discovered: 0,
		newCompanies: 0,
		enriched: 0,
		useAI,
		synthesized: 0,
		saved: 0,
		skippedJunk: 0,
		companies: [],
		errors: [],
	};

	const seen = createSeenMap();
	const discovered = [];
	let nextFeedOffset = 0;

	for (const src of batch) {
		try {
			const result = await runDiscoverySource(src, {
				baseUrl,
				seen,
				feedOffset,
				pageSize: agent.pageSize,
			});
			discovered.push(...(result.companies || []));
			nextFeedOffset = result.nextOffset || 0;
			summary.sourceCursor.feedTotal = result.feedTotal;
		} catch (err) {
			summary.errors.push({
				source: src.id,
				error: err?.message || String(err),
			});
		}
	}
	summary.discovered = discovered.length;

	// Move cursor: if feed wrapped, go to next source
	const nextSourceIndex =
		nextFeedOffset === 0
			? (sourceIndex + 1) % sourcePool.length
			: sourceIndex;
	await saveSourceCursor(agent.stateCollection, agent.id, {
		sourceIndex: nextSourceIndex,
		feedOffset: nextFeedOffset,
	});
	summary.sourceCursor.to = {
		sourceIndex: nextSourceIndex,
		feedOffset: nextFeedOffset,
	};

	const fresh = [];
	for (const c of discovered) {
		if (isJunkCandidate(c)) {
			summary.skippedJunk += 1;
			continue;
		}
		try {
			const exists = await companyExists(agent.collection, c);
			if (exists) continue;
			fresh.push(c);
		} catch (err) {
			summary.errors.push({
				company: c.name,
				error: err?.message || String(err),
			});
		}
	}
	summary.newCompanies = fresh.length;

	let enriched = fresh;
	if (doEnrich && fresh.length) {
		console.log(
			`[yc] enriching up to ${agent.enrichPerRun} of ${fresh.length} new real companies`,
		);
		enriched = await enrichCompanies(fresh, {
			baseUrl,
			limit: agent.enrichPerRun,
			google: true,
		});
		summary.enriched = Math.min(fresh.length, agent.enrichPerRun);
	}

	const toSynth = enriched
		.filter((c) => !isJunkCandidate(c))
		.map((c) => ({
			...c,
			id: companyDocId(c),
			fetchedAt: new Date().toISOString(),
		}));

	for (let i = 0; i < toSynth.length; i += agent.scoreBatchSize) {
		const chunk = toSynth.slice(i, i + agent.scoreBatchSize);
		let results = [];
		if (useAI) {
			try {
				results = await synthesizeCompaniesWithLlm(chunk, agent);
				summary.synthesized += results.length;
			} catch (err) {
				summary.errors.push({
					stage: "llm",
					error: err?.message || String(err),
				});
				results = [];
			}
		}
		if (!results.length) {
			results = chunk.map((c) => ({
				id: c.id,
				reject: false,
				name: c.name,
				status: c.status || c.statusHint || "unknown",
				industry: c.industry || null,
				summary: c.oneLiner || c.snippet || "",
				confidence: computeConfidence(c),
			}));
		}

		for (const c of chunk) {
			const match = results.find((r) => r.id === c.id) || {};
			if (match.reject) {
				summary.skippedJunk += 1;
				continue;
			}

			const industry =
				match.industry && !/^[WSF]\d{2}$/i.test(match.industry)
					? match.industry
					: c.industry || null;

			const confidence =
				Number(match.confidence) || computeConfidence({ ...c, ...match });

			const doc = {
				...c,
				name: match.name || c.name,
				status: match.status || c.status || c.statusHint || "unknown",
				batch: match.batch || c.batch || null,
				oneLiner: match.oneLiner || c.oneLiner || "",
				industry,
				industries: Array.isArray(match.industries)
					? match.industries
					: c.industries || [],
				founders: Array.isArray(match.founders)
					? match.founders
					: c.founders || [],
				isHiring:
					typeof match.isHiring === "boolean"
						? match.isHiring
						: Boolean(c.isHiring),
				jobs: Array.isArray(match.jobs) ? match.jobs : c.jobs || [],
				teamSize: match.teamSize ?? c.teamSize ?? null,
				investmentAmount:
					match.investmentAmount ?? c.investmentAmount ?? null,
				valuation: match.valuation ?? c.valuation ?? null,
				email: match.email || c.email || null,
				emails: Array.isArray(match.emails) ? match.emails : c.emails || [],
				website: match.website || c.website || null,
				address: match.address || c.address || null,
				ycUrl: match.ycUrl || c.ycUrl || null,
				summary: match.summary || c.oneLiner || c.snippet || "",
				confidence,
				score: confidence,
				synthesizedAt: new Date().toISOString(),
			};
			delete doc.enrichmentText;
			if (c.enrichmentText) {
				doc.enrichmentPreview = String(c.enrichmentText).slice(0, 1500);
			}

			await saveCompany(agent.collection, doc);
			summary.saved += 1;
			summary.companies.push({
				id: doc.id,
				name: doc.name,
				status: doc.status,
				batch: doc.batch,
				industry: doc.industry,
				isHiring: doc.isHiring,
				jobs: doc.jobs,
				website: doc.website,
				ycUrl: doc.ycUrl,
				email: doc.email,
				founders: doc.founders,
				teamSize: doc.teamSize,
				investmentAmount: doc.investmentAmount,
				valuation: doc.valuation,
				address: doc.address,
				confidence: doc.confidence,
				score: doc.score,
				summary: doc.summary,
			});
		}
	}

	console.log(
		`[yc] done — discovered ${summary.discovered}, new ${summary.newCompanies}, saved ${summary.saved}, junk skipped ${summary.skippedJunk} → ${agent.collection}`,
	);
	return summary;
}

export { listCompanies, ALL_SOURCES, YC_AGENT };
