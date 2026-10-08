#!/usr/bin/env node
/**
 * Embed full yc-companies snapshot into yc-companies.html
 *   node scripts/embed-yc-companies-html.js
 */

import { readFileSync, writeFileSync } from "node:fs";
import { FieldPath } from "firebase-admin/firestore";
import { firestore } from "../config/firebase.js";

const TRUNCATE_KEYS = new Set([
	"launchMarkdown",
	"longDescription",
	"enrichmentPreview",
	"snippet",
]);

function serializeValue(v, key) {
	if (v == null) return null;
	if (typeof v.toDate === "function") return v.toDate().toISOString();
	if (typeof v === "object" && typeof v._seconds === "number") {
		return new Date(v._seconds * 1000).toISOString();
	}
	if (key === "sitePages" && v && typeof v === "object" && !Array.isArray(v)) {
		const keys = Object.keys(v);
		return {
			_pageCount: keys.length,
			_sample: keys.slice(0, 4).map((k) => ({
				k,
				url: v[k]?.url || v[k],
			})),
		};
	}
	if (TRUNCATE_KEYS.has(key) && typeof v === "string") {
		return v.length > 800 ? `${v.slice(0, 800)}…` : v;
	}
	if (typeof v === "object" && !Array.isArray(v)) {
		const s = JSON.stringify(v);
		if (s.length > 500) return `${s.slice(0, 500)}…`;
		return v;
	}
	return v;
}

function serializeDoc(id, data) {
	const out = { id };
	for (const [k, val] of Object.entries(data || {})) {
		if (k === "id") continue;
		out[k] = serializeValue(val, k);
	}
	return out;
}

const allKeys = new Set(["id"]);
const companies = [];
let cursor = null;

for (;;) {
	let q = firestore.collection("yc-companies").orderBy(FieldPath.documentId()).limit(400);
	if (cursor) q = q.startAfter(cursor);
	const snap = await q.get();
	if (snap.empty) break;
	for (const doc of snap.docs) {
		const row = serializeDoc(doc.id, doc.data());
		Object.keys(row).forEach((k) => allKeys.add(k));
		companies.push(row);
	}
	cursor = snap.docs[snap.docs.length - 1].id;
	if (snap.size < 400) break;
}

companies.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

const fieldKeys = [...allKeys].sort((a, b) => a.localeCompare(b));
const generated = new Date().toISOString();
const path = new URL("../yc-companies.html", import.meta.url);
let html = readFileSync(path, "utf8");

const companiesJson = JSON.stringify(companies).replace(/</g, "\\u003c");
const keysJson = JSON.stringify(fieldKeys);

if (!html.includes("window.COMPANIES = [];")) {
	throw new Error("Expected window.COMPANIES = []; placeholder in yc-companies.html");
}
html = html.replace("window.COMPANIES = [];", `window.COMPANIES = ${companiesJson};`);
html = html.replace("window.FIELD_KEYS = [];", `window.FIELD_KEYS = ${keysJson};`);
html = html.replace(
	'window.GENERATED_AT = "";',
	`window.GENERATED_AT = ${JSON.stringify(generated)};`,
);

writeFileSync(path, html);
console.log(
	JSON.stringify({
		companies: companies.length,
		fieldKeys: fieldKeys.length,
		bytes: Buffer.byteLength(html),
		generated,
	}),
);
