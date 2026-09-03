/**
 * Shared Firestore store for scrape/monitor agents.
 * Identity → sha256[:32] doc id. Pass opts.id to keep existing ids stable.
 */

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../config/firebase.js";

export function hashIdentity(identity) {
	const key = Array.isArray(identity)
		? identity
				.map((p) => String(p || "").trim().toLowerCase())
				.filter(Boolean)
				.join("|")
		: String(identity || "").trim().toLowerCase();
	if (!key) throw new Error("hashedStore: identity is required");
	return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function resolveId(identity, opts = {}) {
	if (opts.id) return String(opts.id);
	return hashIdentity(identity);
}

function toPlain(data) {
	const { createdAt: _c, ...rest } = data && typeof data === "object" ? data : {};
	return JSON.parse(JSON.stringify({ ...rest }));
}

export async function hashedExists(collection, identity, opts = {}) {
	if (!collection) throw new Error("hashedStore: collection is required");
	const id = resolveId(identity, opts);
	const snap = await firestore.collection(collection).doc(id).get();
	return { id, exists: snap.exists };
}

export async function storeHashed(collection, identity, data, opts = {}) {
	if (!collection) throw new Error("hashedStore: collection is required");
	const mode = opts.mode === "merge" ? "merge" : "once";
	const { id, exists } = await hashedExists(collection, identity, opts);

	if (exists && mode === "once") {
		return { id, collection, skipped: true, created: false };
	}

	const plain = toPlain({ ...data, id, contentHash: id });
	plain.updatedAt = new Date().toISOString();
	if (!exists) {
		plain.createdAt = FieldValue.serverTimestamp();
		plain.createdAtIso = new Date().toISOString();
	}

	await firestore.collection(collection).doc(id).set(plain, { merge: true });
	return { id, collection, skipped: false, created: !exists };
}
