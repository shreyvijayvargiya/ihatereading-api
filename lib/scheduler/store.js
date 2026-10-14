/**
 * Firestore store for scheduled posts. Times are epoch milliseconds.
 * Doc: { platform, payload, runAt, status, attempts, leaseUntil?, result?,
 *        partial?, error?, createdAt, updatedAt }
 * status: scheduled | processing | published | failed | cancelled
 *
 * Needs composite indexes (status+runAt, status+leaseUntil): see firestore.indexes.json.
 */

import { firestore } from "../../config/firebase.js";

const COLL = "scheduled_posts";
const col = () => firestore.collection(COLL);
const toDoc = (snap) => (snap.exists ? { id: snap.id, ...snap.data() } : null);

export const firestoreStore = {
	async create(data) {
		const ref = col().doc();
		const doc = { ...data, createdAt: Date.now(), updatedAt: Date.now() };
		await ref.set(doc);
		return { id: ref.id, ...doc };
	},

	async get(id) {
		return toDoc(await col().doc(id).get());
	},

	async list({ status, platform, limit = 50 } = {}) {
		let q = col();
		if (status) q = q.where("status", "==", status);
		if (platform) q = q.where("platform", "==", platform);
		const snap = await q.limit(Math.min(Number(limit) || 50, 200)).get();
		return snap.docs.map(toDoc).sort((a, b) => a.runAt - b.runAt);
	},

	/** Cancel only if not yet published or running. */
	async cancel(id) {
		return firestore.runTransaction(async (tx) => {
			const ref = col().doc(id);
			const snap = await tx.get(ref);
			if (!snap.exists) return null;
			const doc = snap.data();
			if (!["scheduled", "failed"].includes(doc.status)) return { id, ...doc, cancelled: false };
			tx.update(ref, { status: "cancelled", updatedAt: Date.now() });
			return { id, ...doc, status: "cancelled", cancelled: true };
		});
	},

	/**
	 * Atomically claim due posts (scheduled, or processing with an expired
	 * lease from a crashed worker) so two ticks never publish the same post.
	 */
	async claimDue({ now, limit, leaseMs }) {
		const [due, stale] = await Promise.all([
			col().where("status", "==", "scheduled").where("runAt", "<=", now).orderBy("runAt").limit(limit).get(),
			col().where("status", "==", "processing").where("leaseUntil", "<=", now).limit(limit).get(),
		]);
		const claimed = [];
		for (const snap of [...due.docs, ...stale.docs].slice(0, limit)) {
			const doc = await firestore.runTransaction(async (tx) => {
				const ref = col().doc(snap.id);
				const cur = await tx.get(ref);
				const d = cur.data();
				const claimable =
					(d.status === "scheduled" && d.runAt <= now) || (d.status === "processing" && d.leaseUntil <= now);
				if (!claimable) return null;
				const patch = { status: "processing", leaseUntil: now + leaseMs, updatedAt: now };
				tx.update(ref, patch);
				return { id: cur.id, ...d, ...patch };
			});
			if (doc) claimed.push(doc);
		}
		return claimed;
	},

	async update(id, patch) {
		await col().doc(id).update({ ...patch, updatedAt: Date.now() });
	},
};
