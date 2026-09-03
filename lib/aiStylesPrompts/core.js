/**
 * AI styles prompts — Firestore, DESIGN.md builder, LLM enrich.
 */

import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { storeHashed } from "../hashedStore.js";
import { firestore } from "../../config/firebase.js";
import { scrapeUrl } from "../scrapefast.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import { AI_STYLES_AGENT, stylePageUrl } from "./configs.js";

export const DEFAULT_MODEL =
	process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";

const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const STYLE_ID_RE =
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function parseStyleId(raw) {
	const m = String(raw || "").match(STYLE_ID_RE);
	return m ? m[0].toLowerCase() : null;
}

export function firstText(...vals) {
	for (const v of vals) {
		const s = String(v ?? "").trim();
		if (!s) continue;
		if (STYLE_ID_RE.test(s) && s.length <= 40) continue;
		if (/^untitled$/i.test(s)) continue;
		return s;
	}
	return "";
}

export function pickWebsiteUrl(...vals) {
	for (const v of vals) {
		const s = String(v || "").trim();
		if (!/^https?:\/\//i.test(s)) continue;
		if (/styles\.refero\.design\/style\//i.test(s)) continue;
		if (/refero\.design\/api\//i.test(s)) continue;
		return s.replace(/\/$/, "");
	}
	return "";
}

export function extractAgentPromptGuide(ds = {}) {
	const sections = Array.isArray(ds.customSections) ? ds.customSections : [];
	const hit = sections.find((s) =>
		/agent prompt|prompt guide|copy\.md|design\.md/i.test(
			String(s?.title || ""),
		),
	);
	return String(hit?.content || "").trim();
}

/** Prefer a real DESIGN.md over stubs / empty LLM strings. */
export function pickPrompt(...vals) {
	const strings = vals.map((v) => String(v ?? "").trim()).filter(Boolean);
	for (const s of strings) {
		if (s.length >= 80 && !/^#\s*untitled\b/i.test(s)) return s;
	}
	strings.sort((a, b) => b.length - a.length);
	return strings[0] || "";
}

/** True if a stored doc is missing the fields the client needs. */
export function isIncompletePrompt(doc = {}) {
	const name = firstText(doc.name, doc.siteName);
	const url = pickWebsiteUrl(doc.url, doc.siteUrl);
	const prompt = pickPrompt(doc.prompt, doc.designMd, doc.promptGuide);
	return !name || !url || prompt.length < 80;
}

export async function fetchText(url, { timeoutMs = 25_000 } = {}) {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(timeoutMs),
		redirect: "follow",
		headers: {
			"User-Agent": BROWSER_UA,
			Accept: "application/json, text/html, application/xhtml+xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return res.text();
}

export async function fetchJson(url, opts = {}) {
	const text = await fetchText(url, opts);
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Invalid JSON from ${url}`);
	}
}

export async function scrapePage(url, baseUrl, extra = {}) {
	const target = String(url || "").trim();
	if (!target) return { url: target, error: "empty_url" };
	try {
		const row = await scrapeUrl(target, {
			baseUrl,
			timeoutMs: 75_000,
			timeout: 50_000,
			includeImages: true,
			includeLinks: true,
			waitForSelector: extra.waitForSelector || 'a[href*="/style/"]',
			takeScreenshot: extra.takeScreenshot === true,
		});
		return {
			url: target,
			title: row.title || row.data?.title || "",
			markdown: row.markdown || row.data?.markdown || "",
			html: row.html || row.data?.html || row.data?.content?.html || "",
			links: row.links || row.data?.links || [],
			images: row.images || row.data?.images || [],
			screenshot: row.screenshot || row.data?.screenshot || null,
			via: "puppeteer",
		};
	} catch (err) {
		try {
			const html = await fetchText(target);
			return {
				url: target,
				title: html.match(/<title[^>]*>([^<]+)/i)?.[1] || "",
				markdown: "",
				html,
				links: [],
				images: [],
				via: "http",
			};
		} catch (e2) {
			return { url: target, error: err?.message || String(err) };
		}
	}
}

export function extractStyleIdsFromHtml(html, pageUrl = "") {
	const out = [];
	const seen = new Set();
	const blob = String(html || "");
	const re = /\/style\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
	let m;
	while ((m = re.exec(blob))) {
		const id = m[1].toLowerCase();
		if (seen.has(id)) continue;
		seen.add(id);
		out.push({
			id,
			sourceUrl: stylePageUrl(id),
			listUrl: pageUrl || null,
		});
	}
	return out;
}

export function extractMedia(html = "", extra = {}) {
	const images = new Set();
	const videos = new Set();
	const blob = `${html}\n${JSON.stringify(extra)}`;
	for (const u of blob.match(/https:\/\/images\.refero\.design\/[^"\\\s]+/g) || []) {
		if (/\.(mp4|webm|mov)(\?|$)/i.test(u) || /\/video\//i.test(u)) videos.add(u);
		else images.add(u);
	}
	return {
		images: [...images].slice(0, 24),
		videos: [...videos].slice(0, 12),
	};
}

export function extractCopiedDesignMd(markdown = "", html = "") {
	const tryFence = (blob) => {
		const fence = String(blob || "").match(
			/```(?:markdown|md)?\s*\n(# [^\n]+(?:—|–|-)\s*Style Reference[\s\S]*?)```/i,
		);
		return fence ? fence[1].trim() : "";
	};
	const fromMd = tryFence(markdown);
	if (fromMd && !fromMd.includes("@type") && !fromMd.includes("itemListElement")) {
		return fromMd.slice(0, 20_000);
	}
	const fromHtml = tryFence(html);
	if (
		fromHtml &&
		!fromHtml.includes("@type") &&
		!fromHtml.includes("itemListElement")
	) {
		return fromHtml.slice(0, 20_000);
	}
	const heading = String(markdown || "").match(
		/^(# [^\n]+(?:—|–|-)\s*Style Reference[\s\S]{200,18000})/m,
	);
	if (heading && !heading[1].includes("@type")) {
		return heading[1].trim().slice(0, 20_000);
	}
	return "";
}

function mdTable(headers, rows) {
	const head = `| ${headers.join(" | ")} |`;
	const sep = `| ${headers.map(() => "---").join(" | ")} |`;
	const body = rows.map((r) => `| ${r.map((c) => String(c ?? "").replace(/\|/g, "\\|")).join(" | ")} |`);
	return [head, sep, ...body].join("\n");
}

/**
 * Rebuild the Copy.md DESIGN.md prompt from Refero's designSystem payload.
 */
export function buildDesignMd(style, ds = {}) {
	const name = firstText(style.name, style.siteName) || "Untitled";
	const siteUrl = pickWebsiteUrl(style.url, style.siteUrl);
	const north = ds.northStar || style.northStar || "";
	const theme = ds.theme || style.colorScheme || "";
	const parts = [
		`# ${name} — Style Reference`,
		north ? `> ${north}` : "",
		"",
		siteUrl ? `**Site:** ${siteUrl}` : "",
		theme ? `**Theme:** ${theme}` : "",
		ds.industry || style.industry ? `**Industry:** ${ds.industry || style.industry}` : "",
		"",
		ds.description || "",
		"",
	];

	const colors = Array.isArray(ds.colors) ? ds.colors : style.colors || [];
	if (colors.length) {
		parts.push("## Tokens — Colors", "");
		parts.push(
			mdTable(
				["Name", "Value", "Role"],
				colors.map((c) => [
					c.name || "",
					c.hex || c.value || "",
					c.role || c.group || "",
				]),
			),
			"",
		);
	}

	const typography = Array.isArray(ds.typography) ? ds.typography : [];
	if (typography.length) {
		parts.push("## Tokens — Typography", "");
		for (const t of typography) {
			parts.push(`### ${t.family || "Typeface"}`);
			if (t.role) parts.push(t.role);
			if (t.substitute) parts.push(`- **Substitute:** ${t.substitute}`);
			if (t.weight) parts.push(`- **Weights:** ${t.weight}`);
			if (t.sizes) parts.push(`- **Sizes:** ${t.sizes}`);
			if (t.lineHeight) parts.push(`- **Line height:** ${t.lineHeight}`);
			if (t.letterSpacing) parts.push(`- **Letter spacing:** ${t.letterSpacing}`);
			parts.push("");
		}
	}

	const scale = Array.isArray(ds.typeScale) ? ds.typeScale : [];
	if (scale.length) {
		parts.push("### Type Scale", "");
		parts.push(
			mdTable(
				["Role", "Size", "Line Height", "Letter Spacing"],
				scale.map((s) => [
					s.role || "",
					s.size != null ? `${s.size}px` : "",
					s.lineHeight ?? "",
					s.letterSpacing ?? "",
				]),
			),
			"",
		);
	}

	const spacing = ds.spacing || {};
	if (spacing && Object.keys(spacing).length) {
		parts.push("## Tokens — Spacing & Shapes", "");
		if (spacing.pageMaxWidth) parts.push(`- **Page max-width:** ${spacing.pageMaxWidth}`);
		if (spacing.sectionGap) parts.push(`- **Section gap:** ${spacing.sectionGap}`);
		if (spacing.cardPadding) parts.push(`- **Card padding:** ${spacing.cardPadding}`);
		if (spacing.elementGap) parts.push(`- **Element gap:** ${spacing.elementGap}`);
		const radius = spacing.radius || {};
		if (Object.keys(radius).length) {
			parts.push("", "### Border Radius", "");
			parts.push(
				mdTable(
					["Element", "Value"],
					Object.entries(radius).map(([k, v]) => [k, v]),
				),
			);
		}
		parts.push("");
	}

	const components = Array.isArray(ds.components) ? ds.components : [];
	if (components.length) {
		parts.push("## Components", "");
		for (const c of components.slice(0, 16)) {
			parts.push(`### ${c.name || "Component"}`);
			if (c.role) parts.push(`**Role:** ${c.role}`);
			if (c.description) parts.push(c.description);
			parts.push("");
		}
	}

	const dos = Array.isArray(ds.dos) ? ds.dos : [];
	const donts = Array.isArray(ds.donts) ? ds.donts : [];
	if (dos.length || donts.length) {
		parts.push("## Guidelines", "");
		if (dos.length) {
			parts.push("### Do", "");
			for (const d of dos) parts.push(`* ${d}`);
			parts.push("");
		}
		if (donts.length) {
			parts.push("### Don't", "");
			for (const d of donts) parts.push(`* ${d}`);
			parts.push("");
		}
	}

	const custom = Array.isArray(ds.customSections) ? ds.customSections : [];
	for (const sec of custom) {
		if (!sec?.title && !sec?.content) continue;
		parts.push(`## ${sec.title || "Notes"}`, "", sec.content || "", "");
	}

	return parts.filter((p) => p != null).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function promptDocId(style) {
	return parseStyleId(style.id || style.sourceUrl) || String(style.id || "").slice(0, 36);
}

export async function countPrompts(collection = AI_STYLES_AGENT.collection) {
	const snap = await firestore.collection(collection).count().get();
	return snap.data().count || 0;
}

export async function promptExists(collection, style) {
	const id = promptDocId(style);
	if (!id) return false;
	const snap = await firestore.collection(collection).doc(id).get();
	if (!snap.exists) return false;
	return !isIncompletePrompt(snap.data());
}

export async function deletePrompt(collection, id) {
	const docId = String(id || "").trim();
	if (!docId) return false;
	await firestore.collection(collection).doc(docId).delete();
	return true;
}

/**
 * Page through the collection by document id (stable cursor for enrich).
 * @param {string} [collection]
 * @param {{ afterId?: string, limit?: number }} [opts]
 */
export async function listPromptPage(
	collection = AI_STYLES_AGENT.collection,
	{ afterId = "", limit = 4 } = {},
) {
	let q = firestore
		.collection(collection)
		.orderBy(FieldPath.documentId())
		.limit(Math.max(1, Math.min(20, Number(limit) || 4)));
	if (afterId) q = q.startAfter(afterId);
	const snap = await q.get();
	return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function savePrompt(collection, doc) {
	const id = promptDocId(doc);
	const result = await storeHashed(collection, doc.sourceUrl || doc.url || id, doc, {
		id,
		mode: "merge",
	});
	return result.id;
}

export async function loadCursor(stateCollection, agentId) {
	const snap = await firestore.collection(stateCollection).doc(agentId).get();
	if (!snap.exists) return { listCursor: "" };
	return { listCursor: String(snap.data()?.listCursor || "") };
}

export async function saveCursor(stateCollection, agentId, data) {
	await firestore
		.collection(stateCollection)
		.doc(agentId)
		.set(
			{
				agentId,
				...data,
				updatedAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
}

export async function enrichStyleWithLlm(style, opts = {}) {
	const { content } = await openRouterChat({
		model: opts.model || DEFAULT_MODEL,
		jsonMode: true,
		temperature: 0.2,
		maxTokens: 3500,
		messages: [
			{
				role: "system",
				content: `You complete a Refero style record for AI coding agents.

Client fields that MUST be filled (never empty if input has signal):
- name: brand/site name (human, not a UUID)
- url: official website https URL (not styles.refero.design)
- prompt: FULL DESIGN.md markdown to paste (tokens, type, components, dos/donts, Agent Prompt Guide). If input.designMd is already long, return it cleaned — do not shrink it to a one-liner.
- agentPrompt: 2-6 sentences telling an agent to follow that DESIGN.md
- tags, category, oneLiner, vibe, bestFor, relevanceScore

If name/url/prompt are already present, copy them through (fix only UUIDs or Refero /style/ links).
Do not invent hex colors or font names missing from input.

Return ONLY JSON:
{
  "name": "",
  "url": "",
  "prompt": "",
  "tags": ["editorial","saas"],
  "category": "E-commerce|SaaS|Portfolio|Fintech|Media|Developer Tools|Other",
  "oneLiner": "",
  "vibe": "",
  "bestFor": ["landing pages"],
  "agentPrompt": "",
  "relevanceScore": 4
}`,
			},
			{
				role: "user",
				content: JSON.stringify({
					id: style.id,
					name: style.name || style.siteName,
					url: style.url || style.siteUrl,
					sourceUrl: style.sourceUrl,
					northStar: style.northStar,
					industry: style.industry,
					colorScheme: style.colorScheme,
					description: String(style.description || "").slice(0, 1500),
					colors: (style.colors || []).slice(0, 16),
					fonts: style.fonts || [],
					promptGuide: String(style.promptGuide || "").slice(0, 4000),
					designMd: String(style.designMd || "").slice(0, 8000),
				}),
			},
		],
	});
	try {
		return parseJsonFromLLM(content);
	} catch {
		return {
			name: style.name || style.siteName || "",
			url: style.url || style.siteUrl || "",
			prompt: style.prompt || style.designMd || "",
			tags: style.industry ? [style.industry] : [],
			category: style.industry || "Other",
			oneLiner: style.northStar || "",
			vibe: style.northStar || "",
			bestFor: [],
			agentPrompt: `Use this DESIGN.md for ${style.siteName || style.name || "the site"} as the visual system. Match colors, type, spacing, and components exactly.`,
			relevanceScore: 3,
		};
	}
}

export function mergeLlmIntoStyle(style, llm = {}) {
	const name = firstText(style.name, style.siteName, llm.name);
	const url = pickWebsiteUrl(style.url, style.siteUrl, llm.url);
	const prompt = pickPrompt(
		style.prompt,
		style.designMd,
		llm.prompt,
		style.promptGuide,
	);
	const agentPrompt = firstText(
		llm.agentPrompt,
		style.agentPrompt,
		style.promptGuide
			? `Follow the DESIGN.md and Agent Prompt Guide for ${name || "this site"}.`
			: "",
		name
			? `Use this DESIGN.md as the visual system for ${name}. Match colors, type, spacing, and components exactly.`
			: "",
	);
	return {
		...style,
		name: name || style.siteName || "",
		siteName: name || style.siteName || "",
		url: url || "",
		siteUrl: url || style.siteUrl || null,
		prompt: prompt || "",
		designMd: prompt || style.designMd || "",
		promptGuide: style.promptGuide || "",
		agentPrompt: agentPrompt || "",
		tags:
			Array.isArray(llm.tags) && llm.tags.length
				? llm.tags
				: style.industry
					? [style.industry]
					: style.tags || [],
		category: firstText(llm.category, style.industry, style.category, "Other"),
		oneLiner: firstText(llm.oneLiner, style.northStar, style.oneLiner),
		vibe: firstText(llm.vibe, style.northStar, style.vibe),
		bestFor: Array.isArray(llm.bestFor) ? llm.bestFor : style.bestFor || [],
		relevanceScore: Number(llm.relevanceScore) || 3,
	};
}

export async function listIncompletePrompts(
	collection = AI_STYLES_AGENT.collection,
	limit = 8,
) {
	const snap = await firestore.collection(collection).limit(120).get();
	return snap.docs
		.map((d) => ({ id: d.id, ...d.data() }))
		.filter((row) => isIncompletePrompt(row))
		.slice(0, limit);
}

export async function listPrompts(
	collection = AI_STYLES_AGENT.collection,
	{ tag, category, limit = 50 } = {},
) {
	const snap = await firestore.collection(collection).limit(Math.max(limit * 2, 80)).get();
	let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	if (tag) {
		const t = String(tag).toLowerCase();
		rows = rows.filter((r) =>
			(r.tags || []).some((x) => String(x).toLowerCase().includes(t)),
		);
	}
	if (category) {
		const c = String(category).toLowerCase();
		rows = rows.filter((r) => String(r.category || "").toLowerCase().includes(c));
	}
	rows.sort(
		(a, b) =>
			String(b.createdAtIso || b.updatedAt || "").localeCompare(
				String(a.createdAtIso || a.updatedAt || ""),
			),
	);
	return rows.slice(0, limit);
}
