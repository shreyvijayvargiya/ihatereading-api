/**
 * iHateReading internet news — hash dedupe, Firestore.
 * No LLM: category/tags come from the platform + keyword.
 */

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { INTERNET_NEWS_AGENT } from "./configs.js";

export function normalizeUrl(raw) {
	const s = String(raw || "").trim();
	if (!s) return "";
	try {
		const u = new URL(s.startsWith("http") ? s : `https://${s}`);
		u.hash = "";
		if (u.hostname === "news.google.com") return u.href;
		u.searchParams.delete("utm_source");
		u.searchParams.delete("utm_medium");
		u.searchParams.delete("utm_campaign");
		return u.href.replace(/\/$/, "");
	} catch {
		return s;
	}
}

export function articleDocId(article) {
	const key = normalizeUrl(article.url || article.link) || String(article.title || "");
	return createHash("sha256")
		.update(key.toLowerCase())
		.digest("hex")
		.slice(0, 32);
}

export async function articleExists(collection, article) {
	const id = articleDocId(article);
	if (!id) return false;
	const snap = await firestore.collection(collection).doc(id).get();
	return snap.exists;
}

export async function saveArticle(collection, doc) {
	const id = articleDocId(doc);
	const plain = JSON.parse(
		JSON.stringify({
			...doc,
			id,
			url: normalizeUrl(doc.url),
		}),
	);
	const ref = firestore.collection(collection).doc(id);
	const existing = await ref.get();
	plain.updatedAt = new Date().toISOString();
	if (!existing.exists) {
		plain.createdAt = FieldValue.serverTimestamp();
		plain.createdAtIso = new Date().toISOString();
	}
	await ref.set(plain, { merge: true });
	return id;
}

export async function loadNewsCursor(stateCollection, agentId) {
	const snap = await firestore.collection(stateCollection).doc(agentId).get();
	const d = snap.data() || {};
	return {
		platformIndex: Number(d.platformIndex) || 0,
		keywordIndex: Number(d.keywordIndex) || 0,
	};
}

export async function saveNewsCursor(stateCollection, agentId, patch) {
	await firestore
		.collection(stateCollection)
		.doc(agentId)
		.set(
			{
				agentId,
				platformIndex: patch.platformIndex ?? 0,
				keywordIndex: patch.keywordIndex ?? 0,
				updatedAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
}

export async function countArticles(collection = INTERNET_NEWS_AGENT.collection) {
	const snap = await firestore.collection(collection).count().get();
	return snap.data().count || 0;
}

export async function listArticles(
	collection = INTERNET_NEWS_AGENT.collection,
	{ platform, tag, category, limit = 40 } = {},
) {
	const snap = await firestore
		.collection(collection)
		.limit(Math.max(limit * 3, 80))
		.get();
	let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	if (platform) {
		const p = String(platform).toLowerCase();
		rows = rows.filter((r) => String(r.platform || "").toLowerCase() === p);
	}
	if (category) {
		const c = String(category).toLowerCase();
		rows = rows.filter((r) => String(r.category || "").toLowerCase() === c);
	}
	if (tag) {
		const t = String(tag).toLowerCase();
		rows = rows.filter((r) =>
			(r.tags || []).some((x) => String(x).toLowerCase().includes(t)),
		);
	}
	rows.sort((a, b) =>
		String(b.fetchedAt || b.createdAtIso || "").localeCompare(
			String(a.fetchedAt || a.createdAtIso || ""),
		),
	);
	return rows.slice(0, limit);
}
