/**
 * Vite middleware: Firestore table reads for the dashboard without npm run start.
 * Uses the repo firebase-admin credentials (config/service-account-file.js).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { FieldPath } from "firebase-admin/firestore";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
loadEnv({ path: path.join(repoRoot, ".env") });

function sendJson(res, status, body) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(body));
}

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

const idleRun = (id) => ({
	id,
	running: false,
	loop: false,
	pid: null,
	startedAt: null,
	stoppedAt: null,
	exitCode: null,
	argv: [],
	params: {},
	intervalMs: 0,
	stats: { stored: 0, fetched: 0, scraped: 0, failed: 0, ticks: 0 },
	logs: [],
	fields: [],
	kind: "idle",
	help: null,
});

async function latestFetchedAt(firestore, collection) {
	for (const field of ["fetchedAt", "updatedAt", "publishedAt", "createdAtIso", "enrichedAt"]) {
		try {
			const snap = await firestore.collection(collection).orderBy(field, "desc").limit(1).get();
			if (snap.empty) continue;
			const v = snap.docs[0].data()?.[field];
			if (!v) continue;
			if (typeof v.toDate === "function") return v.toDate().toISOString();
			if (typeof v === "object" && typeof v._seconds === "number") {
				return new Date(v._seconds * 1000).toISOString();
			}
			if (typeof v === "object") continue;
			return String(v);
		} catch {
			/* missing index */
		}
	}
	return null;
}

async function listLatestDocs(firestore, collection, limit) {
	for (const field of ["siteEnrichedAt", "fetchedAt", "updatedAt", "publishedAt", "enrichedAt", "createdAtIso"]) {
		try {
			const snap = await firestore.collection(collection).orderBy(field, "desc").limit(limit).get();
			if (!snap.empty) return snap.docs.map(serializeDoc);
		} catch {
			/* missing index */
		}
	}
	const snap = await firestore.collection(collection).limit(Math.min(250, limit * 5)).get();
	const docs = snap.docs.map(serializeDoc);
	docs.sort((a, b) => {
		const ta = new Date(a.siteEnrichedAt || a.fetchedAt || a.updatedAt || a.enrichedAt || a.publishedAt || 0).getTime();
		const tb = new Date(b.siteEnrichedAt || b.fetchedAt || b.updatedAt || b.enrichedAt || b.publishedAt || 0).getTime();
		return tb - ta;
	});
	return docs.slice(0, limit);
}

export function dashboardFirestorePlugin() {
	return {
		name: "dashboard-firestore",
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				const raw = req.url || "";
				if (!raw.startsWith("/api/dashboard")) return next();
				if (req.method !== "GET") return next();

				try {
					const { firestore } = await import("../../config/firebase.js");
					const {
						DASHBOARD_TABLES,
						FIREBASE_PROJECT,
						FIRESTORE_DATABASE,
						getDashboardTable,
					} = await import("../../lib/dashboardCatalog.js");
					const { getAgentRun } = await import("../../lib/dashboardRuns.js");

					const url = new URL(raw, "http://localhost");
					const pathname = url.pathname.replace(/\/$/, "") || "/";

					if (pathname === "/api/dashboard" || pathname === "/api/dashboard/status") {
						const tables = await Promise.all(
							DASHBOARD_TABLES.map(async (table) => {
								let count = 0;
								let error = null;
								try {
									const snap = await firestore.collection(table.collection).count().get();
									count = snap.data().count || 0;
								} catch (err) {
									error = err?.message || String(err);
								}
								const latestAt = count ? await latestFetchedAt(firestore, table.collection) : null;
								return {
									...table,
									count,
									latestAt,
									error,
									fields: getAgentRun(table.id)?.fields || [],
									run: idleRun(table.id),
								};
							}),
						);
						return sendJson(res, 200, {
							success: true,
							project: FIREBASE_PROJECT,
							database: FIRESTORE_DATABASE,
							source: "vite-firebase",
							tables,
						});
					}

					const tableMatch = pathname.match(/^\/api\/dashboard\/tables\/([^/]+)$/);
					if (tableMatch) {
						const table = getDashboardTable(decodeURIComponent(tableMatch[1]));
						if (!table) {
							return sendJson(res, 404, {
								success: false,
								error: { code: "UNKNOWN_TABLE", message: tableMatch[1] },
							});
						}
						const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25));
						const cursor = String(url.searchParams.get("cursor") || "").trim();
						const latest =
							url.searchParams.get("latest") === "1" || url.searchParams.get("sort") === "latest";
						let docs;
						let next = null;
						if (latest) {
							docs = await listLatestDocs(firestore, table.collection, limit);
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
						let count = docs.length;
						try {
							const cs = await firestore.collection(table.collection).count().get();
							count = cs.data().count || 0;
						} catch {
							/* ignore */
						}
						return sendJson(res, 200, {
							success: true,
							project: FIREBASE_PROJECT,
							database: FIRESTORE_DATABASE,
							source: "vite-firebase",
							table,
							count,
							docs,
							nextCursor: next,
						});
					}

					return next();
				} catch (err) {
					return sendJson(res, 500, {
						success: false,
						error: { message: err?.message || String(err) },
					});
				}
			});
		},
	};
}
