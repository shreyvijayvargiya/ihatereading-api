/**
 * Search existing iHateReading articles in Firestore `publish` + site search.
 */

import { firestore } from "../../config/firebase.js";
import { googleSearch } from "./http.js";
import { topKeywordsForSearch } from "./keywordResearch.js";
import {
	articleUrlFromPublish,
	dedupeBy,
	normalize,
} from "./utils.js";

const MAX_INTERNAL = 40;
const FIRESTORE_SCAN_LIMIT = 400;

function scoreArticle(textBlob, topic, keywordList) {
	const blob = normalize(textBlob);
	const t = normalize(topic);
	let score = 0;
	if (t && blob.includes(t)) score += 40;
	for (const k of keywordList) {
		const nk = normalize(k);
		if (nk.length < 3) continue;
		if (blob.includes(nk)) score += 12;
		else {
			const words = nk.split(" ").filter((w) => w.length > 3);
			const hits = words.filter((w) => blob.includes(w)).length;
			if (hits && hits === words.length) score += 6;
		}
	}
	return score;
}

async function searchFirestorePublish(topic, keywords) {
	const keywordList = [
		topic,
		...topKeywordsForSearch(keywords, 12).map((k) => k.keyword),
	].filter(Boolean);

	let snap;
	try {
		snap = await firestore.collection("publish").limit(FIRESTORE_SCAN_LIMIT).get();
	} catch (err) {
		throw new Error(`Firestore publish query failed: ${err?.message || err}`);
	}

	const scored = [];
	for (const doc of snap.docs) {
		const d = doc.data() || {};
		const title = d.title || "";
		const description =
			d.description || d.excerpt || d.summary || d.metaDescription || "";
		const tags = Array.isArray(d.tags) ? d.tags.join(" ") : "";
		const category = d.category || "";
		const blob = `${title} ${description} ${tags} ${category}`;
		const relevanceScore = scoreArticle(blob, topic, keywordList);
		if (relevanceScore < 12) continue;
		const publishedAt =
			d.publishDate ||
			d.publishedAt ||
			d.createdAt?.toDate?.()?.toISOString?.() ||
			(typeof d.createdAt === "string" ? d.createdAt : null);
		scored.push({
			title: title || doc.id,
			url: articleUrlFromPublish(doc),
			...(description ? { description } : {}),
			...(publishedAt ? { publishedAt } : {}),
			relevanceScore,
			source: "firestore",
		});
	}

	scored.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
	return scored;
}

async function searchSiteSerp(topic, keywords, baseUrl) {
	const queries = [
		`site:ihatereading.in ${topic}`,
		...topKeywordsForSearch(keywords, 3).map(
			(k) => `site:ihatereading.in ${k.keyword}`,
		),
	].slice(0, 4);

	const settled = await Promise.allSettled(
		queries.map((q) => googleSearch(q, { baseUrl, num: 8 })),
	);
	const out = [];
	for (const r of settled) {
		if (r.status !== "fulfilled") continue;
		for (const row of r.value || []) {
			const url = row.url || row.link;
			if (!url || !/ihatereading\.in/i.test(url)) continue;
			out.push({
				title: row.title || url,
				url,
				...(row.snippet || row.description
					? { description: row.snippet || row.description }
					: {}),
				relevanceScore: 20,
				source: "google_site",
			});
		}
	}
	return out;
}

/**
 * @param {string} topic
 * @param {object[]} keywords
 * @param {{ baseUrl?: string }} [opts]
 */
export async function searchInternalArticles(topic, keywords = [], opts = {}) {
	const warnings = [];
	const parts = await Promise.allSettled([
		searchFirestorePublish(topic, keywords),
		searchSiteSerp(topic, keywords, opts.baseUrl),
	]);

	const articles = [];
	for (const p of parts) {
		if (p.status === "fulfilled") {
			articles.push(...p.value);
		} else {
			warnings.push(
				`Internal article research partial failure: ${p.reason?.message || p.reason}`,
			);
		}
	}

	if (!articles.length && warnings.length) {
		warnings.push("Internal article research returned no results");
	}

	const deduped = dedupeBy(articles, (a) => a.url || a.title)
		.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
		.slice(0, MAX_INTERNAL)
		.map(({ source, ...rest }) => rest);

	return { internalArticles: deduped, warnings };
}
