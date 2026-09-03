/**
 * Firestore collections for SEO/GEO research pipeline.
 *
 * Composite indexes (create in Firebase console or firestore.indexes.json):
 *   blogIdeas:     (runId ASC, priorityScore DESC)
 *   keywordData:   (runId ASC, cluster ASC)
 *   questionData:  (runId ASC, cluster ASC)
 */

import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";

export const COLLECTIONS = {
	siteProfiles: "siteProfiles",
	researchRuns: "researchRuns",
	keywordData: "keywordData",
	questionData: "questionData",
	competitorData: "competitorData",
	aiVisibilityResults: "aiVisibilityResults",
	blogIdeas: "blogIdeas",
};

export function stripUndefined(value) {
	if (Array.isArray(value)) return value.map(stripUndefined);
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			if (v === undefined) continue;
			out[k] = stripUndefined(v);
		}
		return out;
	}
	return value;
}

export function col(name) {
	return firestore.collection(COLLECTIONS[name] || name);
}

export async function createDoc(collectionName, data) {
	const ref = col(collectionName).doc();
	const payload = stripUndefined({
		...data,
		createdAt: data.createdAt || FieldValue.serverTimestamp(),
	});
	await ref.set(payload);
	return ref.id;
}

export async function addMany(collectionName, rows) {
	if (!rows.length) return [];
	const batch = firestore.batch();
	const ids = [];
	for (const row of rows) {
		const ref = col(collectionName).doc();
		ids.push(ref.id);
		batch.set(
			ref,
			stripUndefined({
				...row,
				createdAt: row.createdAt || FieldValue.serverTimestamp(),
			}),
		);
	}
	await batch.commit();
	return ids;
}

export async function getRun(runId) {
	const snap = await col("researchRuns").doc(runId).get();
	if (!snap.exists) return null;
	return { id: snap.id, ...snap.data() };
}

export async function updateRun(runId, patch) {
	await col("researchRuns")
		.doc(runId)
		.set(stripUndefined(patch), { merge: true });
}

export async function getSiteProfile(siteProfileId) {
	const snap = await col("siteProfiles").doc(siteProfileId).get();
	if (!snap.exists) return null;
	return { id: snap.id, ...snap.data() };
}

export async function persistSiteProfilePatch(siteProfileId, patch) {
	await col("siteProfiles").doc(siteProfileId).set(stripUndefined(patch), {
		merge: true,
	});
}

export async function queryByRun(collectionName, runId, { where = [], orderBy } = {}) {
	let q = col(collectionName).where("runId", "==", runId);
	for (const [field, op, value] of where) {
		q = q.where(field, op, value);
	}
	try {
		if (orderBy) {
			q = q.orderBy(orderBy.field, orderBy.direction || "asc");
		}
		const snap = await q.get();
		return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
	} catch (err) {
		// Missing composite index — fetch by runId only, filter/sort in memory
		if (err?.code !== 9 && !String(err?.message || "").includes("index")) {
			throw err;
		}
		const snap = await col(collectionName).where("runId", "==", runId).get();
		let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
		for (const [field, op, value] of where) {
			rows = rows.filter((row) => {
				if (op === "==") return row[field] === value;
				if (op === "!=") return row[field] !== value;
				return true;
			});
		}
		if (orderBy) {
			const dir = orderBy.direction === "desc" ? -1 : 1;
			rows.sort((a, b) => {
				const av = a[orderBy.field];
				const bv = b[orderBy.field];
				if (av === bv) return 0;
				if (av == null) return 1;
				if (bv == null) return -1;
				return av < bv ? -dir : dir;
			});
		}
		return rows;
	}
}

function sortByPriorityDesc(rows) {
	return [...rows].sort(
		(a, b) => (b.priorityScore || 0) - (a.priorityScore || 0),
	);
}

/** Single-field query (runId) + in-memory sort — no composite index required. */
export async function queryBlogIdeasByRun(runId, { limit = 50 } = {}) {
	const snap = await col("blogIdeas").where("runId", "==", runId).get();
	return sortByPriorityDesc(
		snap.docs.map((d) => ({ id: d.id, ...d.data() })),
	).slice(0, limit);
}

export async function queryBlogIdeasBySite(siteProfileId, { status = "new", limit = 100 } = {}) {
	const runsSnap = await col("researchRuns")
		.where("siteProfileId", "==", siteProfileId)
		.get();
	const runIds = runsSnap.docs.map((d) => d.id);
	if (!runIds.length) return [];

	const all = [];
	for (const runId of runIds) {
		const snap = await col("blogIdeas").where("runId", "==", runId).get();
		let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
		if (status) rows = rows.filter((r) => r.status === status);
		all.push(...rows);
	}
	return sortByPriorityDesc(all).slice(0, limit);
}
