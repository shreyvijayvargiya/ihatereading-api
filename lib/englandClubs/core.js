/**
 * England clubs — Firestore listing + enrich cursor (no LLM).
 */

import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { storeHashed } from "../hashedStore.js";
import {
	CLUBS_COLLECTION,
	CLUBS_STATE_COLLECTION,
	COUNTRY_ID,
	COUNTRY_NAME,
	ENGLAND_CLUBS_AGENT,
	ENRICH_STATE_DOC,
} from "./configs.js";

export function clubIdentity(club) {
	return [`eng`, club.clubId || club.wikiUrl || club.name];
}

export async function saveClub(club, { mode = "once" } = {}) {
	const identity = clubIdentity(club);
	return storeHashed(
		CLUBS_COLLECTION,
		identity,
		{
			...club,
			country: COUNTRY_NAME,
			countryId: COUNTRY_ID,
			fetchedAt: club.fetchedAt || new Date().toISOString(),
		},
		{ mode },
	);
}

export async function loadCursor() {
	const snap = await firestore
		.collection(CLUBS_STATE_COLLECTION)
		.doc(ENGLAND_CLUBS_AGENT.id)
		.get();
	const d = snap.data() || {};
	return {
		offset: Number(d.offset) || 0,
		done: Boolean(d.done),
		listed: Number(d.listed) || 0,
		pass: Number(d.pass) || 0,
		savedThisPass: Number(d.savedThisPass) || 0,
	};
}

export async function saveCursor(patch) {
	await firestore
		.collection(CLUBS_STATE_COLLECTION)
		.doc(ENGLAND_CLUBS_AGENT.id)
		.set(
			{
				agentId: ENGLAND_CLUBS_AGENT.id,
				offset: patch.offset ?? 0,
				done: Boolean(patch.done),
				listed: Number(patch.listed) || 0,
				pass: Number(patch.pass) || 0,
				savedThisPass: Number(patch.savedThisPass) || 0,
				updatedAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
}

export async function countClubs() {
	const snap = await firestore.collection(CLUBS_COLLECTION).count().get();
	return snap.data().count || 0;
}

export async function listClubs({ limit = 50 } = {}) {
	const snap = await firestore
		.collection(CLUBS_COLLECTION)
		.orderBy("fetchedAt", "desc")
		.limit(Math.min(200, Number(limit) || 50))
		.get()
		.catch(async () =>
			firestore.collection(CLUBS_COLLECTION).limit(Math.min(200, Number(limit) || 50)).get(),
		);
	return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export function isClubEnriched(data) {
	if (data?.enrichStatus === "error") return false;
	const hasAnything = Boolean(
		data?.email ||
			data?.contactEmail ||
			data?.contact?.email ||
			data?.phone ||
			data?.website ||
			data?.latitude,
	);
	return data?.enrichStatus === "done" && hasAnything;
}

export async function countEnrichedClubs() {
	try {
		const snap = await firestore
			.collection(CLUBS_COLLECTION)
			.where("enrichStatus", "==", "done")
			.count()
			.get();
		return snap.data().count || 0;
	} catch {
		const d = await loadEnrichCursor();
		return d.enriched || 0;
	}
}

export async function loadEnrichCursor() {
	const snap = await firestore
		.collection(CLUBS_STATE_COLLECTION)
		.doc(ENRICH_STATE_DOC)
		.get();
	const d = snap.data() || {};
	return {
		afterId: String(d.afterId || ""),
		enriched: Number(d.enriched) || 0,
		done: Boolean(d.done),
	};
}

export async function saveEnrichCursor(patch) {
	await firestore
		.collection(CLUBS_STATE_COLLECTION)
		.doc(ENRICH_STATE_DOC)
		.set(
			{
				agentId: ENRICH_STATE_DOC,
				afterId: String(patch.afterId || ""),
				enriched: Number(patch.enriched) || 0,
				done: Boolean(patch.done),
				updatedAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
}

export async function updateClubDoc(id, patch) {
	if (!id) throw new Error("club id is required");
	await firestore
		.collection(CLUBS_COLLECTION)
		.doc(id)
		.set(
			{
				...patch,
				updatedAt: new Date().toISOString(),
			},
			{ merge: true },
		);
}

/**
 * Walk clubs by document id, skip already-enriched, return up to `limit` pending docs.
 */
export async function nextUnenrichedBatch({ afterId = "", limit = 4 } = {}) {
	const picked = [];
	let cursor = afterId || null;
	let scanned = 0;
	let exhausted = false;

	while (picked.length < limit && !exhausted) {
		let q = firestore
			.collection(CLUBS_COLLECTION)
			.orderBy(FieldPath.documentId())
			.limit(30);
		if (cursor) q = q.startAfter(cursor);
		const snap = await q.get();
		if (snap.empty) {
			exhausted = true;
			break;
		}
		for (const doc of snap.docs) {
			cursor = doc.id;
			scanned += 1;
			const data = doc.data() || {};
			if (isClubEnriched(data)) continue;
			picked.push({ id: doc.id, ...data });
			if (picked.length >= limit) break;
		}
		if (snap.size < 30) exhausted = true;
	}

	return {
		clubs: picked,
		afterId: cursor || "",
		scanned,
		exhausted,
	};
}
