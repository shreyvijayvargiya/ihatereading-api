/**
 * AI DESIGN.md style prompts orchestrator — Refero catalog → detail → LLM → Firestore.
 */

import { isUseAiOn } from "../useAi.js";
import { AI_STYLES_AGENT } from "./configs.js";
import {
	countPrompts,
	enrichStyleWithLlm,
	listIncompletePrompts,
	listPrompts,
	loadCursor,
	promptExists,
	saveCursor,
	savePrompt,
	mergeLlmIntoStyle,
} from "./core.js";
import { discoverStyleCards, enrichStyleCards } from "./discovery.js";

async function persistHydrated(
	hydrated,
	agent,
	summary,
	{ doLlm, existingCount, enforceCap = true, repairIds = new Set() },
) {
	let newSaved = 0;
	for (const style of hydrated) {
		if (!style?.id) continue;
		const isRepair = repairIds.has(String(style.id).toLowerCase());
		if (
			enforceCap &&
			!isRepair &&
			existingCount + newSaved >= agent.targetCount
		) {
			break;
		}
		if (style.error && !style.designMd && !style.siteName && !style.name) {
			summary.errors.push({ style: style.id, error: style.error });
			continue;
		}

		let llm = {};
		if (doLlm) {
			try {
				llm = await enrichStyleWithLlm(style);
			} catch (err) {
				summary.errors.push({
					style: style.id,
					stage: "llm",
					error: err?.message || String(err),
				});
			}
		}

		const doc = mergeLlmIntoStyle(style, llm);
		doc.fetchedAt = new Date().toISOString();
		doc.createdAtIso = doc.createdAtIso || new Date().toISOString();
		doc.agentId = agent.id;
		delete doc.error;
		delete doc.fullResult;
		delete doc.raw;

		try {
			await savePrompt(agent.collection, doc);
			summary.saved += 1;
			if (!isRepair) newSaved += 1;
			summary.prompts.push({
				id: doc.id,
				name: doc.name,
				url: doc.url,
				siteName: doc.siteName,
				sourceUrl: doc.sourceUrl,
				siteUrl: doc.siteUrl,
				promptChars: (doc.prompt || "").length,
				northStar: doc.northStar,
				category: doc.category,
				tags: doc.tags,
				previewImage: doc.previewImage,
				previewVideo: doc.previewVideo,
				imageCount: (doc.images || []).length,
				videoCount: (doc.videos || []).length,
				designMdChars: (doc.designMd || "").length,
			});
		} catch (err) {
			summary.errors.push({ style: style.id, error: err?.message || String(err) });
		}
	}
}

/**
 * @param {{
 *   baseUrl?: string,
 *   stylesPerRun?: number,
 *   scrape?: boolean,
 *   enrich?: boolean,
 * }} [opts]
 */
export async function runAiStylesPromptsAgent(opts = {}) {
	const agent = AI_STYLES_AGENT;
	const baseUrl = opts.baseUrl;
	const perRun = opts.stylesPerRun ?? agent.stylesPerRun ?? 8;
	const doScrape = opts.scrape !== false;
	const doLlm = isUseAiOn(opts) && Boolean(process.env.OPENROUTER_API_KEY?.trim());

	const existingCount = await countPrompts(agent.collection);
	const summary = {
		agentId: agent.id,
		collection: agent.collection,
		existingCount,
		targetCount: agent.targetCount,
		atCapacity: existingCount >= agent.targetCount,
		useAI: doLlm,
		queries: [],
		discovered: 0,
		newStyles: 0,
		enriched: 0,
		saved: 0,
		skippedDupes: 0,
		repaired: 0,
		prompts: [],
		errors: [],
	};

	const incomplete = await listIncompletePrompts(agent.collection, perRun);
	summary.repaired = incomplete.length;

	if (existingCount >= agent.targetCount && !incomplete.length) {
		console.log(
			`[ai-styles] at capacity (${existingCount}/${agent.targetCount})`,
		);
		return summary;
	}

	const slotsLeft = Math.max(0, agent.targetCount - existingCount);
	const fresh = [...incomplete];
	const seen = new Set(
		fresh.map((c) => c.id).filter(Boolean).map((id) => String(id).toLowerCase()),
	);

	if (slotsLeft > 0) {
		const cursor = await loadCursor(agent.stateCollection, agent.id);
		let list;
		try {
			list = await discoverStyleCards({
				cursor: cursor.listCursor,
				limit: perRun,
				baseUrl,
			});
		} catch (err) {
			summary.errors.push({ stage: "discover", error: err?.message || String(err) });
			if (!fresh.length) return summary;
			list = { cards: [], nextCursor: "", queries: [] };
		}

		summary.queries = list.queries || [];
		summary.listCursor = {
			from: cursor.listCursor || null,
			to: list.nextCursor || null,
		};
		await saveCursor(agent.stateCollection, agent.id, {
			listCursor: list.nextCursor || "",
		});

		const discovered = list.cards || [];
		summary.discovered = discovered.length;

		let added = 0;
		for (const card of discovered) {
			if (added >= Math.min(perRun, slotsLeft)) break;
			try {
				const id = String(card.id || "").toLowerCase();
				if (!id || seen.has(id)) {
					summary.skippedDupes += 1;
					continue;
				}
				if (await promptExists(agent.collection, card)) {
					summary.skippedDupes += 1;
					continue;
				}
				seen.add(id);
				fresh.push(card);
				added += 1;
			} catch (err) {
				summary.errors.push({ style: card.id, error: err?.message || String(err) });
			}
		}
	} else if (incomplete.length) {
		console.log(
			`[ai-styles] at capacity but ${incomplete.length} incomplete — repairing`,
		);
		summary.atCapacity = false;
	}

	summary.newStyles = Math.max(0, fresh.length - incomplete.length);

	if (!fresh.length) {
		summary.finalCount = existingCount;
		console.log(
			`[ai-styles] done — discovered ${summary.discovered}, saved 0 → ${agent.collection} (${existingCount}/${agent.targetCount})`,
		);
		return summary;
	}

	console.log(
		`[ai-styles] hydrating ${fresh.length} style pages (${incomplete.length} repair, ${summary.newStyles} new)`,
	);
	const hydrated = await enrichStyleCards(fresh, {
		baseUrl,
		scrape: doScrape,
		takeScreenshot: false,
	});
	summary.enriched = hydrated.filter((h) => !h.error).length;

	await persistHydrated(hydrated, agent, summary, {
		doLlm,
		existingCount,
		enforceCap: true,
		repairIds: new Set(
			incomplete.map((c) => String(c.id || "").toLowerCase()).filter(Boolean),
		),
	});

	summary.finalCount = await countPrompts(agent.collection);
	console.log(
		`[ai-styles] done — discovered ${summary.discovered}, saved ${summary.saved} → ${agent.collection} (${summary.finalCount}/${agent.targetCount})`,
	);
	return summary;
}

export { listPrompts, countPrompts, AI_STYLES_AGENT };
export { runAiStylesEnrichAgent, loadEnrichState } from "./enrich.js";
