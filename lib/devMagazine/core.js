/**
 * Firestore + LLM classify for magazine creators.
 */

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { openRouterChat } from "../openrouter.js";
import { parseJsonFromLLM } from "../geoPipeline/parseLlmJson.js";
import { MAGAZINE_AGENT, MAGAZINE_CATEGORIES } from "./configs.js";

export const DEFAULT_MODEL =
	process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";

export function channelDocId(row) {
	const platform = String(row.platform || "web").toLowerCase();
	const handle = String(
		row.handle || row.channelId || row.profileUrl || row.name || "",
	)
		.toLowerCase()
		.trim();
	return createHash("sha256")
		.update(`${platform}:${handle}`)
		.digest("hex")
		.slice(0, 32);
}

export function videoDocId(videoId) {
	return createHash("sha256")
		.update(String(videoId || ""))
		.digest("hex")
		.slice(0, 32);
}

export async function channelExists(row) {
	const id = channelDocId(row);
	const snap = await firestore
		.collection(MAGAZINE_AGENT.channelsCollection)
		.doc(id)
		.get();
	return snap.exists;
}

function uniq(arr) {
	return [...new Set((arr || []).map((x) => String(x).trim()).filter(Boolean))];
}

export async function saveChannel(row) {
	const id = channelDocId(row);
	const ref = firestore.collection(MAGAZINE_AGENT.channelsCollection).doc(id);
	const existing = await ref.get();
	const prev = existing.data() || {};
	const topics = uniq([...(prev.topics || []), ...(row.topics || []), row.topic]);
	const categories = uniq([
		...(prev.categories || []),
		row.categoryId,
		...(row.categories || []),
	]);
	const { createdAt: _c, ...rest } = row;
	const plain = JSON.parse(
		JSON.stringify({
			...prev,
			...rest,
			id,
			topics,
			categories,
			updatedAt: new Date().toISOString(),
		}),
	);
	if (!existing.exists) plain.createdAt = FieldValue.serverTimestamp();
	await ref.set(plain, { merge: true });
	return id;
}

export async function saveVideo(row) {
	const id = videoDocId(row.videoId);
	const ref = firestore.collection(MAGAZINE_AGENT.videosCollection).doc(id);
	const existing = await ref.get();
	const plain = JSON.parse(
		JSON.stringify({
			...row,
			id,
			updatedAt: new Date().toISOString(),
		}),
	);
	if (!existing.exists) plain.createdAt = FieldValue.serverTimestamp();
	await ref.set(plain, { merge: true });
	return id;
}

export async function loadQueryCursor(docId) {
	const snap = await firestore
		.collection(MAGAZINE_AGENT.stateCollection)
		.doc(docId)
		.get();
	if (!snap.exists) return 0;
	return Number(snap.data()?.lastQueryIndex) || 0;
}

export async function saveQueryCursor(docId, index) {
	await firestore
		.collection(MAGAZINE_AGENT.stateCollection)
		.doc(docId)
		.set(
			{
				agentId: MAGAZINE_AGENT.id,
				lastQueryIndex: index,
				updatedAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
}

export async function countChannels() {
	const snap = await firestore
		.collection(MAGAZINE_AGENT.channelsCollection)
		.count()
		.get();
	return snap.data().count || 0;
}

export async function listChannels({
	category,
	topic,
	platform,
	limit = 80,
} = {}) {
	const snap = await firestore
		.collection(MAGAZINE_AGENT.channelsCollection)
		.limit(Math.min(400, Math.max(1, Number(limit) || 80) * 3))
		.get();
	let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	if (category) {
		const c = String(category).toLowerCase();
		rows = rows.filter(
			(r) =>
				String(r.categoryId || "").toLowerCase() === c ||
				(r.categories || []).some((x) => String(x).toLowerCase() === c),
		);
	}
	if (topic) {
		const t = String(topic).toLowerCase();
		rows = rows.filter((r) =>
			(r.topics || []).some((x) => String(x).toLowerCase() === t),
		);
	}
	if (platform) {
		const p = String(platform).toLowerCase();
		rows = rows.filter((r) => String(r.platform || "").toLowerCase() === p);
	}
	rows.sort(
		(a, b) =>
			new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime(),
	);
	return rows.slice(0, limit);
}

export async function listVideos({ category, topic, channelId, limit = 80 } = {}) {
	const snap = await firestore
		.collection(MAGAZINE_AGENT.videosCollection)
		.limit(Math.min(400, Math.max(1, Number(limit) || 80) * 3))
		.get();
	let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	if (category) {
		const c = String(category).toLowerCase();
		rows = rows.filter((r) => String(r.categoryId || "").toLowerCase() === c);
	}
	if (topic) {
		const t = String(topic).toLowerCase();
		rows = rows.filter((r) => String(r.topic || "").toLowerCase() === t);
	}
	if (channelId) {
		rows = rows.filter((r) => r.channelDocId === channelId || r.ytChannelId === channelId);
	}
	rows.sort((a, b) => {
		const ta = new Date(a.publishedAt || a.updatedAt || 0).getTime();
		const tb = new Date(b.publishedAt || b.updatedAt || 0).getTime();
		return tb - ta;
	});
	return rows.slice(0, limit);
}

/**
 * Keep programming educators / tutorial channels (brands OK). Tag category + topics.
 */
export async function classifyMagazineCreators(rows) {
	if (!rows.length) return [];
	const allowed = MAGAZINE_CATEGORIES.map((c) => ({
		id: c.id,
		topics: c.topics,
	}));
	const fallback = rows.map((r) => ({
		id: r.id,
		keep: true,
		name: r.name,
		categoryId: r.categoryId,
		topics: r.topic ? [r.topic] : [],
		relevanceScore: 3,
		reason: "llm_skipped",
		oneLiner: "",
	}));
	try {
		const { content } = await openRouterChat({
			model: DEFAULT_MODEL,
			jsonMode: true,
			temperature: 0.15,
			maxTokens: 1600,
			messages: [
				{
					role: "system",
					content: `You classify YouTube/X accounts for a programming magazine.

KEEP: developers, educators, tutorial channels, tech explainers, conference talks, tooling channels (Fireship-style brands are OK).
REJECT: music, cooking, vlogs, crypto pumps, unrelated lifestyle, spam.

Allowed covers: ${JSON.stringify(allowed)}

Return ONLY JSON:
{ "results": [{ "id": "", "keep": true, "name": "", "categoryId": "frontend", "topics": ["react"], "relevanceScore": 0, "reason": "", "oneLiner": "" }] }
Include every id. Score 1-5. topics must be from the matching category.`,
				},
				{
					role: "user",
					content: JSON.stringify(
						rows.map((r) => ({
							id: r.id,
							name: r.name,
							handle: r.handle,
							platform: r.platform,
							bio: String(r.bio || "").slice(0, 600),
							categoryId: r.categoryId,
							topic: r.topic,
							followersCount: r.followersCount,
						})),
					),
				},
			],
		});
		const raw = parseJsonFromLLM(content);
		const parsed = Array.isArray(raw)
			? raw
			: Array.isArray(raw.results)
				? raw.results
				: [];
		return parsed.length ? parsed : fallback;
	} catch (err) {
		console.warn(
			"[dev-magazine] LLM classify skipped, storing Google hits:",
			err?.message || err,
		);
		return fallback;
	}
}
