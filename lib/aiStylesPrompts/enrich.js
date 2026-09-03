/**
 * Enrich pass over existing ai-styles-prompts docs.
 * Each tick: 4 Firestore objects → LLM plans Google/scrape → merge / delete / add.
 * CLI loops every 10s until the last document.
 */

import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { googleSearch } from "../contentResearch/http.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import { isUseAiOn } from "../useAi.js";
import {
	AI_STYLES_AGENT,
	AI_STYLES_ENRICH,
	stylePageUrl,
} from "./configs.js";
import {
	DEFAULT_MODEL,
	deletePrompt,
	firstText,
	listPromptPage,
	parseStyleId,
	pickPrompt,
	pickWebsiteUrl,
	savePrompt,
	scrapePage,
} from "./core.js";
import { enrichStyleCard } from "./discovery.js";

const SKIP_SLIM = new Set([
	"pageMarkdown",
	"pageScreenshotUrl",
	"createdAt",
	"raw",
	"fullResult",
	"similar",
	"customSections",
	"typeScale",
	"spacing",
	"components",
	"dos",
	"donts",
	"layout",
	"imagery",
]);

function llmJson(content, fallback) {
	try {
		const raw = parseJsonFromLLM(content);
		return raw && typeof raw === "object" ? raw : fallback;
	} catch {
		return fallback;
	}
}

function isTimestampish(v) {
	return (
		v &&
		typeof v === "object" &&
		(typeof v.toDate === "function" || v._seconds != null)
	);
}

function slimStyleDoc(doc = {}) {
	const out = {};
	for (const [k, v] of Object.entries(doc)) {
		if (SKIP_SLIM.has(k) || isTimestampish(v)) continue;
		out[k] = v;
	}
	if (out.prompt) out.prompt = String(out.prompt).slice(0, 2200);
	if (out.designMd) out.designMd = String(out.designMd).slice(0, 2200);
	if (out.promptGuide) out.promptGuide = String(out.promptGuide).slice(0, 800);
	if (Array.isArray(out.images)) out.images = out.images.slice(0, 6);
	if (Array.isArray(out.videos)) out.videos = out.videos.slice(0, 4);
	if (Array.isArray(out.colors)) out.colors = out.colors.slice(0, 12);
	if (Array.isArray(out.fonts)) out.fonts = out.fonts.slice(0, 8);
	return out;
}

function emptyVal(v) {
	if (v == null) return true;
	if (typeof v === "string") return !v.trim();
	if (Array.isArray(v)) return v.length === 0;
	if (typeof v === "object") return Object.keys(v).length === 0;
	return false;
}

const WANTED_KEYS = [
	"name",
	"url",
	"prompt",
	"agentPrompt",
	"tags",
	"category",
	"oneLiner",
	"vibe",
	"bestFor",
	"colors",
	"fonts",
	"previewImage",
	"industry",
	"northStar",
];

function missingKeys(doc = {}) {
	return WANTED_KEYS.filter((k) => {
		if (k === "name") return !firstText(doc.name, doc.siteName);
		if (k === "url") return !pickWebsiteUrl(doc.url, doc.siteUrl);
		if (k === "prompt")
			return pickPrompt(doc.prompt, doc.designMd, doc.promptGuide).length < 80;
		return emptyVal(doc[k]);
	});
}

function uniqStrings(arr) {
	const seen = new Set();
	const out = [];
	for (const x of arr || []) {
		const s = String(x || "").trim();
		if (!s) continue;
		const k = s.toLowerCase();
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(s);
	}
	return out;
}

function uniqColors(arr) {
	const seen = new Set();
	const out = [];
	for (const c of arr || []) {
		if (!c || typeof c !== "object") continue;
		const hex = String(c.hex || c.value || "").trim().toLowerCase();
		const key = hex || String(c.name || "").toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(c);
	}
	return out;
}

function cleanUrlList(urls, max) {
	const out = [];
	const seen = new Set();
	for (const raw of urls || []) {
		const u = String(raw || "").trim();
		if (!/^https?:\/\//i.test(u)) continue;
		if (/styles\.refero\.design\/style\//i.test(u)) continue;
		const key = u.replace(/\/$/, "").toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(u);
		if (out.length >= max) break;
	}
	return out;
}

export async function loadEnrichState() {
	const snap = await firestore
		.collection(AI_STYLES_AGENT.stateCollection)
		.doc(AI_STYLES_ENRICH.stateDocId)
		.get();
	const d = snap.data() || {};
	return {
		afterId: String(d.afterId || ""),
		done: Boolean(d.done),
		processed: Number(d.processed) || 0,
		updated: Number(d.updated) || 0,
		removed: Number(d.removed) || 0,
		added: Number(d.added) || 0,
	};
}

export async function saveEnrichState(data) {
	await firestore
		.collection(AI_STYLES_AGENT.stateCollection)
		.doc(AI_STYLES_ENRICH.stateDocId)
		.set(
			{
				agentId: AI_STYLES_ENRICH.id,
				...data,
				updatedAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
}

export async function resetEnrichState() {
	await saveEnrichState({
		afterId: "",
		done: false,
		processed: 0,
		updated: 0,
		removed: 0,
		added: 0,
	});
}

async function planLookups(doc, useAI = false) {
	const missing = missingKeys(doc);
	const fallback = {
		googleQueries: [
			firstText(doc.name, doc.siteName)
				? `${firstText(doc.name, doc.siteName)} official website`
				: "",
			firstText(doc.name, doc.siteName)
				? `${firstText(doc.name, doc.siteName)} design system brand colors fonts`
				: "",
		].filter(Boolean),
		scrapeUrls: pickWebsiteUrl(doc.url, doc.siteUrl)
			? [pickWebsiteUrl(doc.url, doc.siteUrl)]
			: [],
		shouldDelete: false,
		deleteReason: "",
		missingKeys: missing,
	};

	if (!useAI || !process.env.OPENROUTER_API_KEY?.trim()) return fallback;

	try {
		const { content } = await openRouterChat({
			model: DEFAULT_MODEL,
			jsonMode: true,
			temperature: 0.1,
			maxTokens: 900,
			messages: [
				{
					role: "system",
					content: `You plan web lookups to complete one Refero DESIGN.md style record.

Decide Google queries and pages to scrape so missing keys get real values (official site, colors, fonts, category, one-liner). Never invent hex colors or font names.

Delete the doc only if it is empty junk, a UUID with no usable prompt, or an obvious duplicate of another brand (set shouldDelete).

Return ONLY JSON:
{
  "googleQueries": ["1-2 search queries"],
  "scrapeUrls": ["https official site or brand page, not styles.refero.design/style/..."],
  "shouldDelete": false,
  "deleteReason": "",
  "missingKeys": ["url","fonts"]
}`,
				},
				{
					role: "user",
					content: JSON.stringify({
						id: doc.id,
						missing,
						record: slimStyleDoc(doc),
					}),
				},
			],
		});
		const plan = llmJson(content, fallback);
		return {
			googleQueries: (plan.googleQueries || fallback.googleQueries)
				.map((q) => String(q || "").trim())
				.filter(Boolean)
				.slice(0, AI_STYLES_ENRICH.googlePerDoc),
			scrapeUrls: cleanUrlList(
				plan.scrapeUrls || fallback.scrapeUrls,
				AI_STYLES_ENRICH.scrapePerDoc,
			),
			shouldDelete: plan.shouldDelete === true,
			deleteReason: String(plan.deleteReason || ""),
			missingKeys: Array.isArray(plan.missingKeys) ? plan.missingKeys : missing,
		};
	} catch (err) {
		console.warn(`[ai-styles:enrich] plan ${doc.id}: ${err?.message || err}`);
		return fallback;
	}
}

async function fetchEvidence(plan, baseUrl) {
	const searches = [];
	const settled = await Promise.allSettled(
		(plan.googleQueries || []).map((q) =>
			googleSearch(q, { baseUrl, num: 5 }),
		),
	);
	for (let i = 0; i < settled.length; i++) {
		const r = settled[i];
		const query = plan.googleQueries[i];
		if (r.status !== "fulfilled") {
			searches.push({
				query,
				error: r.reason?.message || String(r.reason),
				results: [],
			});
			continue;
		}
		searches.push({
			query,
			results: (r.value || []).slice(0, 5).map((row) => ({
				title: row.title || "",
				url: row.url || row.link || "",
				snippet: String(row.snippet || "").slice(0, 280),
			})),
		});
	}

	let scrapeUrls = [...(plan.scrapeUrls || [])];
	if (!scrapeUrls.length) {
		for (const s of searches) {
			for (const row of s.results || []) {
				const u = pickWebsiteUrl(row.url);
				if (u) scrapeUrls.push(u);
			}
		}
		scrapeUrls = cleanUrlList(scrapeUrls, AI_STYLES_ENRICH.scrapePerDoc);
	}

	const pages = [];
	for (const url of scrapeUrls.slice(0, AI_STYLES_ENRICH.scrapePerDoc)) {
		const page = await scrapePage(url, baseUrl, { waitForSelector: "body" });
		pages.push({
			url,
			title: page.title || "",
			error: page.error || null,
			markdown: String(page.markdown || "").slice(0, 5000),
			html: page.error ? "" : String(page.html || "").slice(0, 2500),
			images: (page.images || []).slice(0, 8),
		});
	}

	return { searches, pages };
}

function scrapeOnlyMerge(doc, evidence) {
	const patch = {};
	const page = (evidence.pages || []).find((p) => p.url && !p.error);
	if (page?.url && !pickWebsiteUrl(doc.url, doc.siteUrl)) patch.url = page.url;
	if (page?.title && !firstText(doc.siteName, doc.name)) patch.siteName = page.title;
	return {
		action: Object.keys(patch).length ? "update" : "skip",
		reason: "scrape_only",
		patch,
	};
}

async function mergeWithEvidence(doc, evidence, useAI = false) {
	const fallback = scrapeOnlyMerge(doc, evidence);
	if (!useAI || !process.env.OPENROUTER_API_KEY?.trim()) return fallback;

	try {
		const { content } = await openRouterChat({
			model: DEFAULT_MODEL,
			jsonMode: true,
			temperature: 0.15,
			maxTokens: 2500,
			messages: [
				{
					role: "system",
					content: `You update one Firestore style-prompt document from Google + scraped pages.

Rules:
- Fill missing keys. Update stale/wrong values from newly fetched evidence (official URL beats styles.refero.design).
- Deduplicate tags, images, fonts, colors (unique hex). Drop junk keys in unsetKeys.
- action "delete" if the record is empty junk or a duplicate of another brand with no unique DESIGN.md.
- action "update" with a patch of ONLY keys to set. Keep a long DESIGN.md prompt — do not shrink it to a one-liner.
- Do not invent hex colors or font names that are not in evidence or the existing record.
- add[] may list extra Refero style UUIDs found in evidence (id must be a UUID). Skip if unsure.

Return ONLY JSON:
{
  "action": "update" | "delete" | "skip",
  "reason": "",
  "duplicateOf": null,
  "patch": {
    "name": "",
    "url": "",
    "prompt": "",
    "agentPrompt": "",
    "tags": [],
    "category": "",
    "oneLiner": "",
    "vibe": "",
    "bestFor": [],
    "fonts": [],
    "industry": "",
    "previewImage": ""
  },
  "unsetKeys": [],
  "add": [{ "id": "uuid", "name": "", "url": "" }]
}`,
				},
				{
					role: "user",
					content: JSON.stringify({
						record: slimStyleDoc(doc),
						missing: missingKeys(doc),
						google: evidence.searches,
						scraped: evidence.pages.map((p) => ({
							url: p.url,
							title: p.title,
							error: p.error,
							markdown: p.markdown,
							images: p.images,
						})),
					}),
				},
			],
		});
		return llmJson(content, fallback);
	} catch (err) {
		console.warn(`[ai-styles:enrich] merge ${doc.id}: ${err?.message || err}`);
		return { action: "skip", reason: err?.message || String(err), patch: {} };
	}
}

function applyPatch(doc, patch = {}, unsetKeys = []) {
	const next = { ...doc };
	for (const k of unsetKeys || []) {
		if (!k || k === "id") continue;
		delete next[k];
	}
	for (const [k, v] of Object.entries(patch || {})) {
		if (k === "id" || v == null || v === "") continue;
		if (k === "url" || k === "siteUrl") {
			const url = pickWebsiteUrl(v, next.url, next.siteUrl);
			if (url) {
				next.url = url;
				next.siteUrl = url;
			}
			continue;
		}
		if (k === "name" || k === "siteName") {
			const name = firstText(v, next.name, next.siteName);
			if (name) {
				next.name = name;
				next.siteName = name;
			}
			continue;
		}
		if (k === "prompt" || k === "designMd") {
			const prompt = pickPrompt(v, next.prompt, next.designMd);
			if (prompt) {
				next.prompt = prompt;
				next.designMd = prompt;
			}
			continue;
		}
		if (k === "tags" || k === "bestFor" || k === "fonts" || k === "images" || k === "videos") {
			next[k] = uniqStrings([...(next[k] || []), ...(Array.isArray(v) ? v : [v])]);
			continue;
		}
		if (k === "colors") {
			next.colors = uniqColors([
				...(next.colors || []),
				...(Array.isArray(v) ? v : []),
			]);
			continue;
		}
		next[k] = v;
	}
	next.tags = uniqStrings(next.tags);
	next.fonts = uniqStrings(next.fonts);
	next.images = uniqStrings(next.images);
	next.videos = uniqStrings(next.videos);
	next.bestFor = uniqStrings(next.bestFor);
	if (Array.isArray(next.colors)) next.colors = uniqColors(next.colors);
	next.enrichedAt = new Date().toISOString();
	next.enrichAgentId = AI_STYLES_ENRICH.id;
	return next;
}

async function loadUrlIndex(collection) {
	const snap = await firestore.collection(collection).select("url", "siteUrl").get();
	const byUrl = new Map();
	for (const d of snap.docs) {
		const url = pickWebsiteUrl(d.data()?.url, d.data()?.siteUrl);
		if (!url) continue;
		const key = url.replace(/\/$/, "").toLowerCase();
		const ids = byUrl.get(key) || [];
		ids.push(d.id);
		byUrl.set(key, ids);
	}
	return byUrl;
}

async function addRelatedStyles(addList, collection, baseUrl, summary) {
	for (const row of (addList || []).slice(0, 2)) {
		const id = parseStyleId(row?.id || row?.sourceUrl);
		if (!id) continue;
		try {
			const ref = firestore.collection(collection).doc(id);
			if ((await ref.get()).exists) {
				summary.skippedAdd += 1;
				continue;
			}
			console.log(`[ai-styles:enrich] add related ${id}`);
			const hydrated = await enrichStyleCard(
				{ id, name: row.name, url: row.url, sourceUrl: stylePageUrl(id) },
				{ baseUrl, scrape: true },
			);
			await savePrompt(collection, {
				...hydrated,
				fetchedAt: new Date().toISOString(),
				createdAtIso: new Date().toISOString(),
				agentId: AI_STYLES_AGENT.id,
				addedByEnrich: true,
			});
			summary.added += 1;
			summary.addedIds.push(id);
		} catch (err) {
			summary.errors.push({
				style: id,
				stage: "add",
				error: err?.message || String(err),
			});
		}
	}
}

/**
 * One enrich tick: up to `batch` Firestore docs, then advance cursor.
 * @param {{ baseUrl?: string, batch?: number, reset?: boolean, useAI?: boolean }} [opts]
 */
export async function runAiStylesEnrichAgent(opts = {}) {
	const collection = AI_STYLES_AGENT.collection;
	const batch = opts.batch ?? AI_STYLES_ENRICH.batchSize ?? 4;
	const baseUrl = opts.baseUrl;
	const useAI = isUseAiOn(opts);

	if (opts.reset) await resetEnrichState();

	let state = await loadEnrichState();
	if (state.done && !opts.reset) {
		console.log(
			`[ai-styles:enrich] already finished all docs (processed=${state.processed}). Pass reset:true to restart.`,
		);
		return {
			agentId: AI_STYLES_ENRICH.id,
			collection,
			atEnd: true,
			batch: 0,
			processed: 0,
			updated: 0,
			removed: 0,
			added: 0,
			skipped: 0,
			docs: [],
			errors: [],
			cursor: state,
		};
	}

	const rows = await listPromptPage(collection, {
		afterId: state.afterId,
		limit: batch,
	});

	const summary = {
		agentId: AI_STYLES_ENRICH.id,
		collection,
		atEnd: rows.length === 0,
		batch: rows.length,
		processed: 0,
		updated: 0,
		removed: 0,
		added: 0,
		skipped: 0,
		skippedAdd: 0,
		addedIds: [],
		docs: [],
		errors: [],
		cursor: { from: state.afterId || null, to: null },
	};

	if (!rows.length) {
		await saveEnrichState({
			afterId: state.afterId || "",
			done: true,
			processed: state.processed,
			updated: state.updated,
			removed: state.removed,
			added: state.added,
		});
		summary.cursor.to = state.afterId || null;
		console.log("[ai-styles:enrich] last Firestore object reached — done");
		return summary;
	}

	const urlIndex = await loadUrlIndex(collection);

	for (const doc of rows) {
		const id = doc.id;
		try {
			const plan = await planLookups(doc, useAI);
			if (plan.shouldDelete) {
				await deletePrompt(collection, id);
				summary.removed += 1;
				summary.processed += 1;
				summary.docs.push({
					id,
					action: "delete",
					reason: plan.deleteReason || "planner_delete",
				});
				console.log(`[ai-styles:enrich] deleted ${id}: ${plan.deleteReason}`);
				continue;
			}

			const evidence = await fetchEvidence(plan, baseUrl);
			const decision = await mergeWithEvidence(doc, evidence, useAI);
			const action = String(decision.action || "skip").toLowerCase();

			if (action === "delete") {
				await deletePrompt(collection, id);
				summary.removed += 1;
				summary.processed += 1;
				summary.docs.push({
					id,
					action: "delete",
					reason: decision.reason || "merge_delete",
					duplicateOf: decision.duplicateOf || null,
				});
				console.log(`[ai-styles:enrich] deleted ${id}: ${decision.reason}`);
				continue;
			}

			if (action === "update") {
				const next = applyPatch(doc, decision.patch, decision.unsetKeys);
				const url = pickWebsiteUrl(next.url, next.siteUrl);
				const urlKey = url ? url.replace(/\/$/, "").toLowerCase() : "";
				const others = urlKey
					? (urlIndex.get(urlKey) || []).filter((x) => x !== id)
					: [];
				if (others.length) {
					await deletePrompt(collection, id);
					summary.removed += 1;
					summary.processed += 1;
					summary.docs.push({
						id,
						action: "delete",
						reason: "duplicate_url",
						duplicateOf: others[0],
					});
					console.log(
						`[ai-styles:enrich] deleted ${id} duplicate of ${others[0]} (${url})`,
					);
					continue;
				}

				delete next.error;
				delete next.createdAt;
				const stored = {};
				for (const [k, v] of Object.entries(next)) {
					if (isTimestampish(v)) continue;
					stored[k] = v;
				}
				await savePrompt(collection, stored);
				if (urlKey) {
					const ids = urlIndex.get(urlKey) || [];
					if (!ids.includes(id)) ids.push(id);
					urlIndex.set(urlKey, ids);
				}
				summary.updated += 1;
				summary.processed += 1;
				summary.docs.push({
					id,
					action: "update",
					reason: decision.reason || "",
					name: next.name,
					url: next.url,
					missingAfter: missingKeys(next),
				});
				await addRelatedStyles(decision.add, collection, baseUrl, summary);
				console.log(`[ai-styles:enrich] updated ${id} ${next.name || ""}`);
				continue;
			}

			summary.skipped += 1;
			summary.processed += 1;
			summary.docs.push({
				id,
				action: "skip",
				reason: decision.reason || "no_changes",
			});
		} catch (err) {
			summary.errors.push({
				style: id,
				error: err?.message || String(err),
			});
			summary.processed += 1;
			summary.docs.push({
				id,
				action: "error",
				reason: err?.message || String(err),
			});
		}
	}

	const lastId = rows[rows.length - 1]?.id || state.afterId;
	const more = await listPromptPage(collection, { afterId: lastId, limit: 1 });
	const done = more.length === 0;
	summary.atEnd = done;
	summary.cursor.to = lastId;

	await saveEnrichState({
		afterId: lastId,
		done,
		processed: state.processed + summary.processed,
		updated: state.updated + summary.updated,
		removed: state.removed + summary.removed,
		added: state.added + summary.added,
	});

	console.log(
		`[ai-styles:enrich] tick — ${summary.processed} docs, ${summary.updated} updated, ${summary.removed} removed, ${summary.added} added${done ? " — END" : ""}`,
	);
	return summary;
}
