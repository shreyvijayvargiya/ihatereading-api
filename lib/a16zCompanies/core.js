/**
 * a16z companies core — same Firestore keys as yc-companies, hash dedupe.
 */

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import {
	computeConfidence,
	isSiteEnriched,
	listCompanies,
	normalizeName,
	normalizeUrl,
} from "../ycCompanies/core.js";
import { A16Z_AGENT, A16Z_COLLECTION, A16Z_STATE_COLLECTION, A16Z_STATE_DOC } from "./configs.js";
import { slugFromA16zUrl } from "./parse.js";

export { computeConfidence, isSiteEnriched, listCompanies, normalizeName, normalizeUrl };

/** Firestore document id = sha256(stable a16z key). Same company always maps to the same doc. */
export function companyDocId(company) {
	const a16zId = String(company.a16zId || "").trim();
	const slug = company.slug || slugFromA16zUrl(company.a16zUrl || company.ycUrl) || "";
	const website = normalizeUrl(company.website) || "";
	const key = a16zId
		? `a16z:${a16zId}`
		: slug
			? `a16z:slug:${slug}`
			: website
				? `a16z:web:${website}`
				: `a16z:name:${normalizeName(company.name).toLowerCase()}`;
	return createHash("sha256")
		.update(key.toLowerCase().trim())
		.digest("hex")
		.slice(0, 32);
}

export function seenKey(company) {
	if (company.a16zId) return `a16z:${company.a16zId}`;
	const slug = company.slug || slugFromA16zUrl(company.a16zUrl || company.ycUrl);
	if (slug) return `slug:${slug}`;
	if (company.website) return `web:${normalizeUrl(company.website)}`;
	return `name:${normalizeName(company.name).toLowerCase()}`;
}

export async function companyExists(company, collection = A16Z_COLLECTION) {
	const id = companyDocId(company);
	const snap = await firestore.collection(collection).doc(id).get();
	return snap.exists;
}

export async function getCompany(company, collection = A16Z_COLLECTION) {
	const id = companyDocId(company);
	const snap = await firestore.collection(collection).doc(id).get();
	if (!snap.exists) return null;
	return { id: snap.id, ...snap.data() };
}

export async function saveCompany(company, collection = A16Z_COLLECTION) {
	const id = companyDocId(company);
	const { createdAt: _ca, id: _id, ...rest } = company;
	const plain = JSON.parse(JSON.stringify({ ...rest, id }));
	const ref = firestore.collection(collection).doc(id);
	const existing = await ref.get();
	plain.updatedAt = new Date().toISOString();
	if (!existing.exists) {
		plain.createdAt = FieldValue.serverTimestamp();
	}
	await ref.set(plain, { merge: true });
	return id;
}

export async function loadListingCursor() {
	const snap = await firestore.collection(A16Z_STATE_COLLECTION).doc(A16Z_STATE_DOC).get();
	const d = snap.data() || {};
	return {
		offset: Number(d.offset) || 0,
		saved: Number(d.saved) || 0,
		enriched: Number(d.enriched) || 0,
		done: Boolean(d.done),
	};
}

export async function saveListingCursor(patch) {
	await firestore
		.collection(A16Z_STATE_COLLECTION)
		.doc(A16Z_STATE_DOC)
		.set(
			{
				agentId: A16Z_AGENT.id,
				offset: Number(patch.offset) || 0,
				saved: Number(patch.saved) || 0,
				enriched: Number(patch.enriched) || 0,
				done: Boolean(patch.done),
				updatedAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
}

export async function countCompanies(collection = A16Z_COLLECTION) {
	const snap = await firestore.collection(collection).count().get();
	return snap.data().count || 0;
}
