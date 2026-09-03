/**
 * Firestore tables for the Claude toprated agent.
 * A "table" is a collection; each row is a document.
 */

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";

export const TABLES_REGISTRY = "claudeTopratedTables";
export const MAX_ADD_ROWS = 50;
export const MAX_LIST = 100;
export const MAX_REMOVE = 20;

const RESERVED = new Set([
	"claudeTopratedTables",
	"companySeeds",
	"publish",
]);

export function sanitizeCollection(name) {
	const s = String(name || "")
		.trim()
		.replace(/[^a-zA-Z0-9_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	if (s.length < 2 || s.length > 80) {
		throw new Error("collection must be 2–80 chars of letters, numbers, _ or -");
	}
	if (s.startsWith("__") || RESERVED.has(s)) {
		throw new Error(`collection name "${s}" is reserved`);
	}
	return s;
}

export function sanitizeDocId(id) {
	const s = String(id || "")
		.trim()
		.replace(/\//g, "_")
		.slice(0, 700);
	if (!s) throw new Error("docId is required");
	return s;
}

function rowDocId(row) {
	const given = row?.id || row?.docId;
	if (given) return sanitizeDocId(given);
	return createHash("sha256")
		.update(JSON.stringify(row || {}))
		.digest("hex")
		.slice(0, 24);
}

function stripMeta(row) {
	if (!row || typeof row !== "object" || Array.isArray(row)) return {};
	const { id: _id, docId: _docId, ...rest } = row;
	return rest;
}

async function touchRegistry(collection, extra = {}) {
	await firestore
		.collection(TABLES_REGISTRY)
		.doc(collection)
		.set(
			{
				collection,
				updatedAt: FieldValue.serverTimestamp(),
				...extra,
			},
			{ merge: true },
		);
}

export async function tableAddRows(collectionName, rows) {
	const collection = sanitizeCollection(collectionName);
	if (rows && !Array.isArray(rows) && typeof rows === "object") {
		rows = [rows];
	}
	if (!Array.isArray(rows) || !rows.length) {
		throw new Error("rows must be a non-empty array");
	}
	if (rows.length > MAX_ADD_ROWS) {
		throw new Error(`at most ${MAX_ADD_ROWS} rows per add`);
	}
	const saved = [];
	const batch = firestore.batch();
	for (const raw of rows) {
		const data = stripMeta(raw);
		const docId = rowDocId(raw);
		const ref = firestore.collection(collection).doc(docId);
		batch.set(
			ref,
			{
				...data,
				_collection: collection,
				updatedAt: FieldValue.serverTimestamp(),
				createdAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
		saved.push({ docId, collection });
	}
	await batch.commit();
	await touchRegistry(collection, {
		createdAt: FieldValue.serverTimestamp(),
		lastAction: "add",
		lastCount: saved.length,
	});
	return { collection, added: saved.length, rows: saved };
}

export async function tableEditRow(collectionName, docId, data) {
	const collection = sanitizeCollection(collectionName);
	const id = sanitizeDocId(docId);
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("data must be an object");
	}
	const payload = stripMeta(data);
	const ref = firestore.collection(collection).doc(id);
	const snap = await ref.get();
	if (!snap.exists) throw new Error(`doc ${id} not found in ${collection}`);
	await ref.set(
		{
			...payload,
			updatedAt: FieldValue.serverTimestamp(),
		},
		{ merge: true },
	);
	await touchRegistry(collection, { lastAction: "edit" });
	const next = await ref.get();
	return { collection, docId: id, row: { docId: id, ...next.data() } };
}

export async function tableRemoveRows(collectionName, docIds) {
	const collection = sanitizeCollection(collectionName);
	const ids = (Array.isArray(docIds) ? docIds : [docIds])
		.map((id) => sanitizeDocId(id))
		.filter(Boolean);
	if (!ids.length) throw new Error("docIds required");
	if (ids.length > MAX_REMOVE) {
		throw new Error(`at most ${MAX_REMOVE} docs per remove`);
	}
	const batch = firestore.batch();
	for (const id of ids) {
		batch.delete(firestore.collection(collection).doc(id));
	}
	await batch.commit();
	await touchRegistry(collection, { lastAction: "remove", lastCount: ids.length });
	return { collection, removed: ids.length, docIds: ids };
}

export async function tableGetRow(collectionName, docId) {
	const collection = sanitizeCollection(collectionName);
	const id = sanitizeDocId(docId);
	const snap = await firestore.collection(collection).doc(id).get();
	if (!snap.exists) return { collection, docId: id, row: null };
	return { collection, docId: id, row: { docId: id, ...snap.data() } };
}

export async function tableListRows(collectionName, limit = 40) {
	const collection = sanitizeCollection(collectionName);
	const n = Math.min(MAX_LIST, Math.max(1, Number(limit) || 40));
	const snap = await firestore.collection(collection).limit(n).get();
	const rows = snap.docs.map((d) => ({ docId: d.id, ...d.data() }));
	return { collection, count: rows.length, rows };
}

export async function listTables(limit = 50) {
	const snap = await firestore
		.collection(TABLES_REGISTRY)
		.limit(Math.min(200, Math.max(1, Number(limit) || 50)))
		.get();
	return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
