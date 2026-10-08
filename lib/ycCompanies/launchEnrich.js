/**
 * YC Launch YC enrich — scrape company page → find /launches/ URL → scrape launch post.
 * Walks Firestore in reverse batch order (W26, S26, P26, …) and reverse doc id within batch.
 * No LLM — uses POST /scrape only.
 */

import {
	LAUNCH_ENRICH_BATCH_ORDER,
	LAUNCH_ENRICH_BATCH_SIZE,
	LAUNCH_ENRICH_STATE_DOC,
	YC_AGENT,
} from "./configs.js";
import {
	countCompanies,
	countLaunchEnrichedCompanies,
	extractEmails,
	isLaunchEnriched,
	loadLaunchEnrichCursor,
	normalizeName,
	normalizeUrl,
	saveLaunchEnrichCursor,
	slugFromYcUrl,
	updateCompanyDoc,
} from "./core.js";
import { firestore } from "../../config/firebase.js";
import { scrapeUrl } from "../scrapefast.js";

const YC_LAUNCH_PATH =
	/(?:https?:\/\/)?(?:www\.)?ycombinator\.com\/launches\/([^\s"'<>)\]]+)/gi;
const YC_COMPANY_BASE = "https://www.ycombinator.com/companies";

function pageBlob(row) {
	return [
		row?.markdown,
		row?.html,
		row?.data?.html,
		row?.title,
		...(Array.isArray(row?.links) ? row.links : []),
		...(Array.isArray(row?.data?.links) ? row.data.links : []),
	]
		.filter(Boolean)
		.join("\n");
}

export function companyPageUrl(company) {
	const slug = String(company.slug || slugFromYcUrl(company.ycUrl) || "").trim();
	if (slug) return `${YC_COMPANY_BASE}/${slug}`;
	const yc = normalizeUrl(company.ycUrl);
	if (yc && /ycombinator\.com\/companies\//i.test(yc)) return yc;
	return "";
}

export function extractLaunchUrls(blob, { slug } = {}) {
	const found = new Set();
	for (const m of String(blob || "").matchAll(YC_LAUNCH_PATH)) {
		const path = String(m[1] || "").replace(/\/+$/, "");
		if (!path) continue;
		found.add(normalizeUrl(`https://www.ycombinator.com/launches/${path}`));
	}
	const urls = [...found];
	if (!urls.length) return [];
	const slugNeedle = String(slug || "").toLowerCase();
	if (slugNeedle) {
		const slugHits = urls.filter((u) => u.toLowerCase().includes(slugNeedle));
		if (slugHits.length) return slugHits;
	}
	return urls.sort((a, b) => a.length - b.length);
}

export function pickLaunchUrl(urls, { slug, companyName } = {}) {
	if (!urls?.length) return null;
	const slugNeedle = String(slug || "").toLowerCase();
	if (slugNeedle) {
		const hit = urls.find((u) => u.toLowerCase().includes(slugNeedle));
		if (hit) return hit;
	}
	const nameNeedle = String(companyName || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	if (nameNeedle.length >= 3) {
		const hit = urls.find((u) => u.toLowerCase().includes(nameNeedle));
		if (hit) return hit;
	}
	return urls[0];
}

export function parseLaunchPage(row) {
	const md = String(row?.markdown || "");
	const titleMatch = md.match(/^#\s+(.+)$/m);
	const title = normalizeName(titleMatch?.[1]?.replace(/🦑|🚀/g, "").trim() || row?.title || "");
	const emails = extractEmails(md);
	const linkCandidates = [
		...md.matchAll(/\((https?:\/\/[^)\s]+)\)/gi),
		...md.matchAll(/<(https?:\/\/[^>\s]+)>/gi),
	].map((m) => normalizeUrl(m[1]));
	let website = null;
	for (const href of linkCandidates) {
		if (!href) continue;
		if (/ycombinator\.com|bookface-images|twitter\.com|x\.com|facebook|linkedin/i.test(href))
			continue;
		website = href;
		break;
	}

	const founderLine = md.match(/\*\*([A-Z][a-z]+(?:\s+[A-Z][a-z.-]+)+)\*\*/);
	const founders = [];
	if (founderLine) founders.push(normalizeName(founderLine[1]));

	const whyUs = md.match(/###\s*Why us[\s\S]{0,1200}/i);
	if (whyUs) {
		const pair = whyUs[0].match(
			/We(?:'|’)?re\s+([A-Z][a-z]+(?:\s+[A-Z][a-z.-]+)+)(?:\s+and\s+([A-Z][a-z]+(?:\s+[A-Z][a-z.-]+)+))?/,
		);
		if (pair?.[1]) founders.push(normalizeName(pair[1]));
		if (pair?.[2]) founders.push(normalizeName(pair[2]));
	}

	const ask = md.match(/###\s*Our ask[\s\S]{0,1500}/i);
	const launchAsk = ask ? ask[0].replace(/^###\s*Our ask\s*/i, "").trim().slice(0, 2000) : "";

	return {
		launchTitle: title,
		launchMarkdown: md.slice(0, 12_000),
		launchWebsite: website,
		launchFounders: [...new Set(founders.filter(Boolean))].slice(0, 6),
		launchEmails: emails,
		launchEmail: emails[0] || null,
		launchAsk,
	};
}

async function scrapePage(url, baseUrl) {
	const row = await scrapeUrl(url, {
		baseUrl,
		timeoutMs: 90_000,
		timeout: 50_000,
		includeLinks: true,
	});
	return row;
}

export async function enrichCompanyLaunch(company, opts = {}) {
	const baseUrl = opts.baseUrl;
	const slug = String(company.slug || slugFromYcUrl(company.ycUrl) || "").trim();
	const companyUrl = companyPageUrl(company);
	if (!companyUrl) {
		return {
			launchEnrichStatus: "skipped",
			launchEnrichError: "no_yc_company_url",
			launchEnrichedAt: new Date().toISOString(),
		};
	}

	let launchUrl = normalizeUrl(company.launchUrl);
	let companyError = "";

	if (!launchUrl) {
		try {
			const companyPage = await scrapePage(companyUrl, baseUrl);
			const urls = extractLaunchUrls(pageBlob(companyPage), { slug });
			launchUrl = pickLaunchUrl(urls, { slug, companyName: company.name });
			if (!launchUrl) {
				return {
					launchEnrichStatus: "not_found",
					launchEnrichError: "",
					launchCompanyUrl: companyUrl,
					launchEnrichedAt: new Date().toISOString(),
				};
			}
		} catch (err) {
			companyError = err?.message || String(err);
			return {
				launchEnrichStatus: "error",
				launchEnrichError: companyError,
				launchCompanyUrl: companyUrl,
				launchEnrichedAt: new Date().toISOString(),
			};
		}
	}

	let launchRow;
	try {
		launchRow = await scrapePage(launchUrl, baseUrl);
	} catch (err) {
		return {
			launchEnrichStatus: "error",
			launchEnrichError: err?.message || String(err),
			launchCompanyUrl: companyUrl,
			launchUrl,
			launchEnrichedAt: new Date().toISOString(),
		};
	}

	const parsed = parseLaunchPage(launchRow);
	const mergedEmails = [
		...new Set([
			...(Array.isArray(company.emails) ? company.emails : []),
			...parsed.launchEmails,
		]),
	].slice(0, 12);

	const mergedFounders = [
		...new Set([
			...(Array.isArray(company.founders) ? company.founders : []),
			...parsed.launchFounders,
		]),
	].slice(0, 8);

	return {
		launchCompanyUrl: companyUrl,
		launchUrl,
		launchTitle: parsed.launchTitle,
		launchMarkdown: parsed.launchMarkdown,
		launchWebsite: parsed.launchWebsite || company.website || null,
		launchAsk: parsed.launchAsk,
		launchFounders: parsed.launchFounders,
		launchEnrichStatus: "done",
		launchEnrichError: companyError,
		launchEnrichedAt: new Date().toISOString(),
		emails: mergedEmails,
		email: company.email || parsed.launchEmail || mergedEmails[0] || null,
		founders: mergedFounders,
		website: company.website || parsed.launchWebsite || undefined,
	};
}

export async function enrichAndSaveCompanyLaunch(company, opts = {}) {
	const patch = await enrichCompanyLaunch(company, opts);
	await updateCompanyDoc(company.id, patch);
	return {
		id: company.id,
		name: company.name,
		batch: company.batch || null,
		...patch,
	};
}

/**
 * Next companies in current batch (reverse doc id), skipping launch-enriched.
 */
export async function nextLaunchEnrichBatch({
	batchIndex = 0,
	afterId = "",
	limit = LAUNCH_ENRICH_BATCH_SIZE,
	batchOrder = LAUNCH_ENRICH_BATCH_ORDER,
} = {}) {
	const order = batchOrder.length ? batchOrder : LAUNCH_ENRICH_BATCH_ORDER;
	const idx = Math.min(Math.max(0, batchIndex), order.length - 1);
	const batch = order[idx];
	const picked = [];
	let cursor = afterId || "";

	const snap = await firestoreQueryBatch(batch);
	const allRows = snap.docs
		.map((d) => ({ id: d.id, ...d.data() }))
		.sort((a, b) => b.id.localeCompare(a.id));
	const rows = cursor ? allRows.filter((r) => r.id < cursor) : allRows;

	for (const row of rows) {
		cursor = row.id;
		if (isLaunchEnriched(row)) continue;
		picked.push(row);
		if (picked.length >= limit) break;
	}

	const lastId = rows[rows.length - 1]?.id;
	const exhausted = !allRows.length || (rows.length > 0 && cursor === lastId);

	return {
		batch,
		batchIndex: idx,
		companies: picked,
		afterId: cursor || afterId,
		exhausted,
		batchCount: allRows.length,
	};
}

async function firestoreQueryBatch(batch) {
	try {
		return await firestore.collection(YC_AGENT.collection).where("batch", "==", batch).get();
	} catch (err) {
		console.error("[yc-launch-enrich] batch query failed:", err?.message);
		return { docs: [], empty: true, size: 0 };
	}
}

export async function runYcCompaniesLaunchEnrichAgent(opts = {}) {
	const batchSize = LAUNCH_ENRICH_BATCH_SIZE;
	const order = LAUNCH_ENRICH_BATCH_ORDER;
	let cursor = opts.reset
		? { batchIndex: 0, afterId: "", cycle: 1, enriched: 0 }
		: await loadLaunchEnrichCursor();

	if (opts.reset) {
		await saveLaunchEnrichCursor(cursor);
	}

	const stored = await countCompanies().catch(() => 0);
	const already = await countLaunchEnrichedCompanies().catch(
		() => cursor.enriched || 0,
	);

	const summary = {
		agentId: LAUNCH_ENRICH_STATE_DOC,
		collection: YC_AGENT.collection,
		batchSize,
		batchOrder: order.slice(0, 8),
		stored,
		launchEnrichedBefore: already,
		cycle: cursor.cycle,
		batchIndex: cursor.batchIndex,
		currentBatch: order[cursor.batchIndex] || order[0],
		fetched: 0,
		updated: 0,
		failed: 0,
		skipped: 0,
		notFound: 0,
		cycleComplete: false,
		companies: [],
		errors: [],
	};

	let batchIndex = cursor.batchIndex;
	let afterId = cursor.afterId;
	let cycle = cursor.cycle;

	for (let guard = 0; guard < order.length + 2; guard += 1) {
		const batch = await nextLaunchEnrichBatch({
			batchIndex,
			afterId,
			limit: batchSize,
			batchOrder: order,
		});
		summary.currentBatch = batch.batch;
		summary.batchIndex = batch.batchIndex;
		summary.afterIdFrom = afterId;
		summary.afterIdTo = batch.afterId;
		summary.batchDocCount = batch.batchCount;

		if (batch.companies.length) {
			summary.fetched = batch.companies.length;
			console.log(
				`[yc-launch-enrich] batch ${batch.batch} (${batch.batchIndex + 1}/${order.length}) → ${batch.companies.map((c) => c.name).join(", ")}`,
			);

			for (const company of batch.companies) {
				try {
					const row = await enrichAndSaveCompanyLaunch(company, {
						baseUrl: opts.baseUrl,
					});
					summary.companies.push(row);
					if (row.launchEnrichStatus === "done") summary.updated += 1;
					else if (row.launchEnrichStatus === "not_found") summary.notFound += 1;
					else if (row.launchEnrichStatus === "skipped") summary.skipped += 1;
					else summary.failed += 1;
					console.log(
						`[yc-launch-enrich] ${company.name} ${row.launchEnrichStatus}${row.launchUrl ? ` ${row.launchUrl}` : ""}${row.email ? ` email=${row.email}` : ""}`,
					);
				} catch (err) {
					summary.failed += 1;
					const message = err?.message || String(err);
					summary.errors.push({ id: company.id, name: company.name, error: message });
					await updateCompanyDoc(company.id, {
						launchEnrichStatus: "error",
						launchEnrichError: message,
						launchEnrichedAt: new Date().toISOString(),
					}).catch(() => {});
				}
			}

			const enrichedNow =
				already +
				summary.companies.filter((c) =>
					["done", "not_found", "skipped"].includes(c.launchEnrichStatus),
				).length;
			await saveLaunchEnrichCursor({
				batchIndex,
				afterId: batch.afterId,
				cycle,
				enriched: enrichedNow,
				currentBatch: batch.batch,
			});
			summary.launchEnriched = enrichedNow;
			summary.cycle = cycle;
			return summary;
		}

		// Advance to next batch (reverse-year order).
		if (batch.exhausted || batch.batchCount === 0) {
			batchIndex += 1;
			afterId = "";
			if (batchIndex >= order.length) {
				batchIndex = 0;
				cycle += 1;
				summary.cycleComplete = true;
				console.log(
					`[yc-launch-enrich] cycle ${cycle - 1} complete — restarting at ${order[0]}`,
				);
				await saveLaunchEnrichCursor({
					batchIndex: 0,
					afterId: "",
					cycle,
					enriched: already,
					currentBatch: order[0],
				});
				summary.note = `Cycle complete — restarted at ${order[0]} (cycle ${cycle}).`;
				summary.cycle = cycle;
				summary.batchIndex = 0;
				summary.launchEnriched = already;
				return summary;
			}
			continue;
		}

		afterId = batch.afterId;
		await saveLaunchEnrichCursor({
			batchIndex,
			afterId,
			cycle,
			enriched: already,
			currentBatch: batch.batch,
		});
		summary.note = "Cursor advanced within batch — no pending companies in window.";
		summary.launchEnriched = already;
		return summary;
	}

	summary.note = "No companies to enrich in this tick.";
	summary.launchEnriched = already;
	return summary;
}
