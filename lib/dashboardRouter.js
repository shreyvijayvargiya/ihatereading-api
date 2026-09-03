/**
 * Scrape dashboard API — status, tables, start/stop agents, live logs.
 *
 * GET  /dashboard
 * GET  /dashboard/status
 * GET  /dashboard/tables/:id
 * GET  /dashboard/runs
 * GET  /dashboard/agents/:id
 * POST /dashboard/agents/:id/start
 * POST /dashboard/agents/:id/stop
 * POST /dashboard/stop-all
 */

import { Hono } from "hono";
import { FieldPath } from "firebase-admin/firestore";
import { firestore } from "../config/firebase.js";
import {
	DASHBOARD_TABLES,
	FIREBASE_PROJECT,
	FIRESTORE_DATABASE,
	getDashboardTable,
} from "./dashboardCatalog.js";
import { getAgentRun } from "./dashboardRuns.js";
import {
	getRunSnapshot,
	listRunSnapshots,
	startAgent,
	stopAgent,
	stopAllAgents,
} from "./dashboardRunner.js";

export const dashboardRouter = new Hono();

function serializeValue(v) {
	if (v == null) return v;
	if (typeof v.toDate === "function") return v.toDate().toISOString();
	if (typeof v === "object" && typeof v._seconds === "number") {
		return new Date(v._seconds * 1000).toISOString();
	}
	if (Array.isArray(v)) return v.map(serializeValue);
	if (typeof v === "object") {
		const out = {};
		for (const [k, val] of Object.entries(v)) out[k] = serializeValue(val);
		return out;
	}
	return v;
}

function serializeDoc(snap) {
	return { id: snap.id, ...serializeValue(snap.data() || {}) };
}

async function latestFetchedAt(collection) {
	for (const field of ["fetchedAt", "updatedAt", "publishedAt", "createdAtIso"]) {
		try {
			const snap = await firestore
				.collection(collection)
				.orderBy(field, "desc")
				.limit(1)
				.get();
			if (snap.empty) continue;
			const d = snap.docs[0].data() || {};
			const v = d[field];
			if (!v) continue;
			if (typeof v.toDate === "function") return v.toDate().toISOString();
			if (typeof v === "object" && typeof v._seconds === "number") {
				return new Date(v._seconds * 1000).toISOString();
			}
			if (typeof v === "object") continue;
			return String(v);
		} catch {
			/* missing index or field */
		}
	}
	return null;
}

dashboardRouter.get("/dashboard", (c) => {
	return c.json({
		success: true,
		project: FIREBASE_PROJECT,
		database: FIRESTORE_DATABASE,
		tables: DASHBOARD_TABLES,
	});
});

dashboardRouter.get("/dashboard/status", async (c) => {
	const rows = await Promise.all(
		DASHBOARD_TABLES.map(async (table) => {
			let count = 0;
			let error = null;
			try {
				const snap = await firestore.collection(table.collection).count().get();
				count = snap.data().count || 0;
			} catch (err) {
				error = err?.message || String(err);
			}
			const latestAt = count ? await latestFetchedAt(table.collection) : null;
			const run = getRunSnapshot(table.id, { logs: false });
			return {
				...table,
				count,
				latestAt,
				error,
				fields: getAgentRun(table.id)?.fields || [],
				run,
			};
		}),
	);
	return c.json({
		success: true,
		project: FIREBASE_PROJECT,
		database: FIRESTORE_DATABASE,
		tables: rows,
	});
});

async function listLatestDocs(collection, limit) {
	for (const field of ["fetchedAt", "updatedAt", "publishedAt", "createdAtIso"]) {
		try {
			const snap = await firestore
				.collection(collection)
				.orderBy(field, "desc")
				.limit(limit)
				.get();
			if (!snap.empty) return snap.docs.map(serializeDoc);
		} catch {
			/* missing index */
		}
	}
	const snap = await firestore.collection(collection).limit(Math.min(250, limit * 5)).get();
	const docs = snap.docs.map(serializeDoc);
	docs.sort((a, b) => {
		const ta = new Date(a.fetchedAt || a.updatedAt || a.publishedAt || 0).getTime();
		const tb = new Date(b.fetchedAt || b.updatedAt || b.publishedAt || 0).getTime();
		return tb - ta;
	});
	return docs.slice(0, limit);
}

dashboardRouter.get("/dashboard/tables/:id", async (c) => {
	const table = getDashboardTable(c.req.param("id"));
	if (!table) {
		return c.json(
			{ success: false, error: { code: "UNKNOWN_TABLE", message: c.req.param("id") } },
			404,
		);
	}
	const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 25));
	const cursor = String(c.req.query("cursor") || "").trim();
	const latest =
		c.req.query("latest") === "1" || c.req.query("sort") === "latest";

	let docs;
	let next = null;
	if (latest) {
		docs = await listLatestDocs(table.collection, limit);
	} else {
		let q = firestore
			.collection(table.collection)
			.orderBy(FieldPath.documentId())
			.limit(limit + 1);
		if (cursor) q = q.startAfter(cursor);
		const snap = await q.get();
		docs = snap.docs.slice(0, limit).map(serializeDoc);
		next = snap.docs.length > limit ? snap.docs[limit - 1].id : null;
	}

	let count = 0;
	try {
		const cs = await firestore.collection(table.collection).count().get();
		count = cs.data().count || 0;
	} catch {
		count = docs.length;
	}

	return c.json({
		success: true,
		project: FIREBASE_PROJECT,
		database: FIRESTORE_DATABASE,
		table,
		count,
		docs,
		nextCursor: next,
	});
});

dashboardRouter.get("/dashboard/runs", (c) => {
	return c.json({ success: true, runs: listRunSnapshots() });
});

dashboardRouter.get("/dashboard/agents/:id", (c) => {
	const table = getDashboardTable(c.req.param("id"));
	if (!table) {
		return c.json(
			{ success: false, error: { code: "UNKNOWN_TABLE", message: c.req.param("id") } },
			404,
		);
	}
	return c.json({
		success: true,
		table,
		fields: getAgentRun(table.id)?.fields || [],
		run: getRunSnapshot(table.id, { logs: true }),
	});
});

dashboardRouter.post("/dashboard/agents/:id/start", async (c) => {
	const id = c.req.param("id");
	if (!getDashboardTable(id)) {
		return c.json(
			{ success: false, error: { code: "UNKNOWN_TABLE", message: id } },
			404,
		);
	}
	try {
		const body = await c.req.json().catch(() => ({}));
		const run = await startAgent(id, body || {});
		return c.json({ success: true, run });
	} catch (err) {
		return c.json(
			{ success: false, error: { code: "START_FAILED", message: err?.message || String(err) } },
			400,
		);
	}
});

dashboardRouter.post("/dashboard/agents/:id/stop", (c) => {
	const id = c.req.param("id");
	if (!getDashboardTable(id)) {
		return c.json(
			{ success: false, error: { code: "UNKNOWN_TABLE", message: id } },
			404,
		);
	}
	return c.json({ success: true, run: stopAgent(id) });
});

dashboardRouter.post("/dashboard/stop-all", (c) => {
	stopAllAgents();
	return c.json({ success: true });
});
