#!/usr/bin/env node
/**
 * One-shot: copy every doc from Firestore `a16z-companies` into `yc-companies`.
 * Dedupes by sha256(a16z:{a16zId}) — same id the a16z agent uses — plus a16zId / website.
 *
 *   npm run a16z:companies:merge
 */

import "dotenv/config";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../config/firebase.js";
import {
	A16Z_COLLECTION,
	A16Z_LEGACY_COLLECTION,
} from "../lib/a16zCompanies/configs.js";
import { companyDocId, normalizeUrl } from "../lib/a16zCompanies/core.js";

const SOURCE = A16Z_LEGACY_COLLECTION;
const DEST = A16Z_COLLECTION;
const BATCH_LIMIT = 400;

function websiteKey(row) {
	return normalizeUrl(row?.website || "") || "";
}

async function main() {
	console.log(`[a16z-merge] ${SOURCE} → ${DEST} (hash dedupe)`);

	const [sourceSnap, destSnap] = await Promise.all([
		firestore.collection(SOURCE).get(),
		firestore.collection(DEST).get(),
	]);

	const seenIds = new Set();
	const seenA16zIds = new Set();
	const seenWebsites = new Set();
	for (const doc of destSnap.docs) {
		const d = doc.data() || {};
		seenIds.add(doc.id);
		if (d.a16zId) seenA16zIds.add(String(d.a16zId));
		const web = websiteKey(d);
		if (web && d.sourceType === "a16z") seenWebsites.add(web);
	}

	console.log(
		`[a16z-merge] source=${sourceSnap.size} dest=${destSnap.size} existing a16z ids=${seenA16zIds.size}`,
	);

	if (sourceSnap.empty) {
		console.log(`[a16z-merge] nothing in ${SOURCE} — already on ${DEST} or never scraped the old collection`);
		return;
	}

	let copied = 0;
	let skipped = 0;
	let batch = firestore.batch();
	let ops = 0;

	async function flush() {
		if (!ops) return;
		await batch.commit();
		batch = firestore.batch();
		ops = 0;
	}

	for (const doc of sourceSnap.docs) {
		const raw = doc.data() || {};
		const company = { ...raw, a16zId: raw.a16zId || raw.id, sourceType: "a16z" };
		const id = companyDocId(company);
		const a16zId = String(company.a16zId || "").trim();
		const web = websiteKey(company);

		if (seenIds.has(id) || (a16zId && seenA16zIds.has(a16zId)) || (web && seenWebsites.has(web))) {
			skipped += 1;
			continue;
		}

		const { createdAt: _c, id: _id, ...rest } = company;
		const plain = JSON.parse(
			JSON.stringify({
				...rest,
				id,
				sourceType: "a16z",
				mergedFrom: SOURCE,
				mergedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}),
		);
		plain.createdAt = FieldValue.serverTimestamp();

		batch.set(firestore.collection(DEST).doc(id), plain, { merge: true });
		ops += 1;
		copied += 1;
		seenIds.add(id);
		if (a16zId) seenA16zIds.add(a16zId);
		if (web) seenWebsites.add(web);

		if (ops >= BATCH_LIMIT) await flush();
	}

	await flush();

	const summary = {
		source: SOURCE,
		dest: DEST,
		sourceCount: sourceSnap.size,
		copied,
		skipped,
		destAfter: destSnap.size + copied,
	};
	console.log(JSON.stringify(summary, null, 2));
	console.log(
		`[a16z-merge] done — copied ${copied}, skipped ${skipped} duplicates → ${DEST}`,
	);
}

main().catch((err) => {
	console.error("[a16z-merge] fatal:", err?.message || err);
	process.exit(1);
});
