/**
 * Spawn / stop scrape CLIs from the dashboard.
 * Looping is done here (re-run after interval) so Stop always works.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firestore } from "../config/firebase.js";
import { getDashboardTable } from "./dashboardCatalog.js";
import { getAgentRun, AGENT_RUNS } from "./dashboardRuns.js";
import {
	isRedditMonitorSchedulerRunning,
	startRedditMonitorScheduler,
	stopRedditMonitorScheduler,
} from "./redditMonitor/scheduler.js";
import { runRedditMonitor } from "./jobs/redditMonitor.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_LOGS = 600;

/** @type {Map<string, AgentState>} */
const states = new Map();

function emptyStats() {
	return { stored: 0, fetched: 0, scraped: 0, failed: 0, ticks: 0 };
}

function getState(id) {
	if (!states.has(id)) {
		states.set(id, {
			id,
			running: false,
			loop: false,
			pid: null,
			startedAt: null,
			stoppedAt: null,
			exitCode: null,
			argv: [],
			params: {},
			intervalMs: 30_000,
			logs: [],
			stats: emptyStats(),
			child: null,
			timer: null,
			stopping: false,
		});
	}
	return states.get(id);
}

function pushLog(state, stream, text) {
	const line = String(text || "").replace(/\s+$/, "");
	if (!line) return;
	for (const part of line.split("\n")) {
		const msg = part.slice(0, 4000);
		state.logs.push({
			t: new Date().toISOString(),
			stream,
			line: msg,
		});
		ingestStats(state, msg);
	}
	if (state.logs.length > MAX_LOGS) {
		state.logs.splice(0, state.logs.length - MAX_LOGS);
	}
}

function ingestStats(state, line) {
	const saving = line.match(/saving (\d+) new/i);
	if (saving) state.stats.fetched += Number(saving[1]);
	const stored = line.match(/stored (\d+)/i);
	if (stored) state.stats.scraped += Number(stored[1]);
	if (/\bfailed\b|\berror\b/i.test(line) && !/0 errors/i.test(line)) {
		state.stats.failed += 1;
	}
	if (state.id === "clubs" && (/\/333 done\b/i.test(line) || /finished \d+\/333 clubs/i.test(line))) {
		state.loop = false;
	}
	const trimmed = line.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		try {
			const j = JSON.parse(trimmed);
			const scraped =
				Number(j.newPosts || j.saved || j.newLeads || j.newArticles || j.newInvestors || 0) ||
				0;
			if (scraped) state.stats.scraped += scraped;
			if (Array.isArray(j.errors) && j.errors.length) {
				state.stats.failed += j.errors.length;
			}
			if (j.agentId === "england-clubs" && j.done) {
				state.loop = false;
				pushLog(
					state,
					"sys",
					`reached ${j.stored || j.listed || 0}/${j.target || 333} clubs — loop off`,
				);
			}
		} catch {
			/* ignore */
		}
	}
}

async function refreshStored(id) {
	const table = getDashboardTable(id);
	const state = getState(id);
	if (!table?.collection) return;
	try {
		const snap = await firestore.collection(table.collection).count().get();
		state.stats.stored = snap.data().count || 0;
	} catch {
		/* ignore */
	}
}

function sanitizeValue(raw) {
	const s = String(raw ?? "").trim();
	if (!s) return "";
	if (/[\n\r;|&$`]/.test(s) || s.includes("..")) {
		throw new Error("Invalid parameter value");
	}
	return s.slice(0, 500);
}

function buildArgv(id, params = {}) {
	const spec = getAgentRun(id);
	if (!spec) throw new Error(`No runner for ${id}`);
	if (spec.kind === "scheduler") return { kind: "scheduler", argv: [] };

	let script = spec.script;
	let args = [...(spec.args || [])];
	if (params.enrichJob && spec.fields?.some((f) => f.key === "enrichJob" && f.script)) {
		const f = spec.fields.find((x) => x.key === "enrichJob");
		script = f.script;
		args = [...(f.args || ["once"])];
	}

	for (const field of spec.fields || []) {
		if (field.key === "enrichJob") continue;
		const val = params[field.key];
		if (field.type === "checkbox") {
			if (val === true || val === "true" || val === "1" || val === "on") {
				if (field.flag) args.push(field.flag);
			}
			continue;
		}
		if (val == null || val === "") continue;
		if (field.required === false && !val) continue;
		const clean = sanitizeValue(val);
		if (!clean) continue;
		if (field.flag) args.push(field.flag, clean);
		else args.push(clean);
	}

	for (const field of spec.fields || []) {
		if (field.required && !sanitizeValue(params[field.key] || "")) {
			throw new Error(`${field.label || field.key} is required`);
		}
	}

	return {
		kind: "cli",
		argv: [path.join(ROOT, script), ...args],
		display: ["node", script, ...args],
	};
}

function snapshot(id) {
	const s = getState(id);
	const spec = getAgentRun(id);
	return {
		id,
		running: s.running || (id === "saascrm" && isRedditMonitorSchedulerRunning()),
		loop: s.loop,
		pid: s.pid,
		startedAt: s.startedAt,
		stoppedAt: s.stoppedAt,
		exitCode: s.exitCode,
		argv: s.argv,
		params: s.params,
		intervalMs: s.intervalMs,
		stats: { ...s.stats },
		logs: s.logs,
		fields: spec?.fields || [],
		kind: spec?.kind || "cli",
		help: spec?.help || null,
	};
}

export function getRunSnapshot(id, { logs = true } = {}) {
	const snap = snapshot(id);
	if (!logs) snap.logs = snap.logs.slice(-8);
	return snap;
}

export function listRunSnapshots() {
	const ids = new Set([...Object.keys(AGENT_RUNS), ...states.keys()]);
	return [...ids].map((id) => getRunSnapshot(id, { logs: false }));
}

function killChild(state) {
	if (!state.child || state.child.killed) return;
	try {
		state.child.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	setTimeout(() => {
		try {
			if (state.child && !state.child.killed) state.child.kill("SIGKILL");
		} catch {
			/* ignore */
		}
	}, 2500);
}

function spawnCli(id, argv) {
	const state = getState(id);
	return new Promise((resolve) => {
		const child = spawn(process.execPath, argv, {
			cwd: ROOT,
			env: {
				...process.env,
				SCRAPE_API_BASE_URL:
					process.env.SCRAPE_API_BASE_URL ||
					`http://127.0.0.1:${process.env.PORT || 3002}`,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		state.child = child;
		state.pid = child.pid;
		pushLog(state, "sys", `$ node ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);

		child.stdout.on("data", (buf) => pushLog(state, "out", buf.toString("utf8")));
		child.stderr.on("data", (buf) => pushLog(state, "err", buf.toString("utf8")));
		child.on("error", (err) => {
			pushLog(state, "err", err.message || String(err));
			state.stats.failed += 1;
		});
		child.on("close", (code, signal) => {
			state.pid = null;
			state.child = null;
			state.exitCode = code;
			state.stats.ticks += 1;
			pushLog(
				state,
				"sys",
				`exit code=${code}${signal ? ` signal=${signal}` : ""}`,
			);
			refreshStored(id).finally(() => resolve(code));
		});
	});
}

async function tick(id) {
	const state = getState(id);
	if (state.stopping) return;
	await refreshStored(id);
	if (id === "saascrm") {
		pushLog(state, "sys", "running reddit monitor tick");
		try {
			const summary = await runRedditMonitor();
			pushLog(state, "out", JSON.stringify(summary));
			state.stats.ticks += 1;
			if (summary?.newPosts) state.stats.scraped += Number(summary.newPosts) || 0;
			if (summary?.errors?.length) state.stats.failed += summary.errors.length;
		} catch (err) {
			pushLog(state, "err", err?.message || String(err));
			state.stats.failed += 1;
		}
		await refreshStored(id);
		return;
	}
	const built = buildArgv(id, state.params);
	state.argv = built.display;
	await spawnCli(id, built.argv);
}

function scheduleNext(id) {
	const state = getState(id);
	if (!state.loop || state.stopping) {
		state.running = false;
		state.stoppedAt = new Date().toISOString();
		return;
	}
	pushLog(state, "sys", `next tick in ${state.intervalMs}ms`);
	state.timer = setTimeout(() => {
		tick(id)
			.catch((err) => pushLog(state, "err", err?.message || String(err)))
			.finally(() => scheduleNext(id));
	}, state.intervalMs);
}

export async function startAgent(id, body = {}) {
	const spec = getAgentRun(id);
	if (!spec) throw new Error(`Unknown agent: ${id}`);
	const state = getState(id);
	if (getRunSnapshot(id, { logs: false }).running) {
		throw new Error("Already running — stop it first");
	}

	const { loop, intervalMs, params, ...rest } = body || {};
	state.params =
		params && typeof params === "object" && !Array.isArray(params)
			? params
			: rest;
	delete state.params.loop;
	delete state.params.intervalMs;
	if (spec.kind !== "scheduler") buildArgv(id, state.params);

	state.loop = loop === true || loop === "true" || loop === 1;
	state.intervalMs = Math.max(
		5_000,
		Math.min(30 * 60 * 1000, Number(intervalMs) || 30_000),
	);
	state.stopping = false;
	state.running = true;
	state.startedAt = new Date().toISOString();
	state.stoppedAt = null;
	state.exitCode = null;
	state.stats = { ...emptyStats(), stored: state.stats.stored };
	state.logs = [];
	pushLog(
		state,
		"sys",
		`start loop=${state.loop} intervalMs=${state.intervalMs}`,
	);

	if (id === "saascrm" && state.loop) {
		startRedditMonitorScheduler();
		pushLog(state, "sys", "scheduler on (in-process)");
		await refreshStored(id);
		return getRunSnapshot(id, { logs: false });
	}

	if (id === "saascrm" && !state.loop) {
		await tick(id);
		state.running = false;
		state.stoppedAt = new Date().toISOString();
		return getRunSnapshot(id, { logs: false });
	}

	tick(id)
		.catch((err) => {
			pushLog(state, "err", err?.message || String(err));
			state.stats.failed += 1;
		})
		.finally(() => {
			if (state.loop && !state.stopping) scheduleNext(id);
			else {
				state.running = false;
				state.stoppedAt = new Date().toISOString();
			}
		});

	return getRunSnapshot(id, { logs: false });
}

export function stopAgent(id) {
	const state = getState(id);
	state.stopping = true;
	state.loop = false;
	if (state.timer) {
		clearTimeout(state.timer);
		state.timer = null;
	}
	if (id === "saascrm") stopRedditMonitorScheduler();
	killChild(state);
	state.running = false;
	state.stoppedAt = new Date().toISOString();
	pushLog(state, "sys", "stopped");
	return getRunSnapshot(id, { logs: false });
}

export function stopAllAgents() {
	const ids = new Set([...states.keys(), "saascrm"]);
	for (const id of ids) stopAgent(id);
	return { success: true };
}

export { getAgentRun };
