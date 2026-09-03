/**
 * iHateReading content marketing Reddit monitor.
 * RSS coding subs → score → match against Firestore `publish` articles for promo fit.
 */

import { firestore } from "../../config/firebase.js";
import { getAgent } from "./configs.js";
import { runRssAgent } from "./core.js";
import { normalize } from "../contentResearch/utils.js";

const PUBLISH_SCAN = 300;

function slugify(title) {
	return String(title || "")
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-")
		.slice(0, 100);
}

function articleUrl(doc) {
	const d = doc.data() || {};
	const slug = d.slug || d.path || (d.title ? slugify(d.title) : doc.id);
	return `https://ihatereading.in/t/${encodeURIComponent(String(slug).replace(/\s+/g, "-"))}`;
}

async function loadPublishCatalog() {
	const snap = await firestore.collection("publish").limit(PUBLISH_SCAN).get();
	return snap.docs.map((doc) => {
		const d = doc.data() || {};
		const title = d.title || doc.id;
		const tags = Array.isArray(d.tags) ? d.tags.join(" ") : "";
		const description = d.description || d.excerpt || d.summary || "";
		return {
			id: doc.id,
			title,
			url: articleUrl(doc),
			blob: normalize(`${title} ${tags} ${description}`),
		};
	});
}

function matchArticles(post, catalog, limit = 3) {
	const blob = normalize(`${post.title || ""} ${post.body || ""}`);
	const words = blob.split(" ").filter((w) => w.length > 3);
	const scored = [];
	for (const art of catalog) {
		let score = 0;
		if (!art.blob) continue;
		const titleWords = normalize(art.title)
			.split(" ")
			.filter((w) => w.length > 3);
		for (const w of titleWords) {
			if (blob.includes(w)) score += 3;
		}
		for (const w of words.slice(0, 40)) {
			if (art.blob.includes(w)) score += 1;
		}
		if (score >= 6) {
			scored.push({
				title: art.title,
				url: art.url,
				matchScore: score,
			});
		}
	}
	scored.sort((a, b) => b.matchScore - a.matchScore);
	return scored.slice(0, limit).map(({ title, url }) => ({ title, url }));
}

export async function runIhatereadingAgent(opts = {}) {
	const agent = getAgent("ihatereading");
	if (!agent) throw new Error("ihatereading agent config missing");

	let catalog = [];
	try {
		catalog = await loadPublishCatalog();
		console.log(
			`[reddit-agent:ihatereading] loaded ${catalog.length} publish articles for matching`,
		);
	} catch (err) {
		console.warn(
			`[reddit-agent:ihatereading] publish load failed: ${err?.message || err}`,
		);
	}

	return runRssAgent(agent, {
		llm: opts.llm,
		enrich: opts.enrich,
		enrichPost: async (post, match) => {
			const matchedArticles = matchArticles(post, catalog);
			return {
				matchedArticles,
				marketingAngle: match?.marketingAngle || null,
			};
		},
	});
}
