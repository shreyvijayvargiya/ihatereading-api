/**
 * Filesystem task store (no Redis / DB). One directory per task:
 *   <DATA_DIR>/tasks/<id>/task.json
 *   <DATA_DIR>/tasks/<id>/storage-state.json   (cookies, written on every pause)
 *   <DATA_DIR>/tasks/<id>/shots/*.png
 * Writes are serialized per task and atomic (tmp file + rename).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import {
	MAX_PAUSE_MS,
	STATES,
	canTransition,
	isWaiting,
	statusFor,
} from "./states.js";

export const DATA_DIR = path.resolve(
	process.env.DIRECTORY_AGENT_DIR ||
		path.join(process.cwd(), "data", "directory-agent"),
);
const TASKS_DIR = path.join(DATA_DIR, "tasks");
const MAX_LOGS = 400;

/** Emits "task" (public snapshot) after every persisted change. */
export const taskEvents = new EventEmitter();
taskEvents.setMaxListeners(0);

const ID_RE = /^task_[a-f0-9]{16}$/;
export const isValidTaskId = (id) => ID_RE.test(String(id));

export function taskDir(id) {
	if (!isValidTaskId(id)) throw new Error("Invalid task id");
	return path.join(TASKS_DIR, id);
}
export const taskFile = (id) => path.join(taskDir(id), "task.json");
export const shotsDir = (id) => path.join(taskDir(id), "shots");
export const storageStateFile = (id) =>
	path.join(taskDir(id), "storage-state.json");

const chains = new Map();

async function writeJsonAtomic(file, value) {
	const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(value, null, 2));
	await fs.rename(tmp, file);
}

export async function getTask(id) {
	if (!isValidTaskId(id)) return null;
	try {
		return JSON.parse(await fs.readFile(taskFile(id), "utf8"));
	} catch (e) {
		if (e.code === "ENOENT") return null;
		throw e;
	}
}

export async function listTasks() {
	let names = [];
	try {
		names = await fs.readdir(TASKS_DIR);
	} catch (e) {
		if (e.code === "ENOENT") return [];
		throw e;
	}
	const tasks = [];
	for (const name of names) {
		if (!isValidTaskId(name)) continue;
		try {
			const t = await getTask(name);
			if (t) tasks.push(t);
		} catch {
			/* skip unreadable task */
		}
	}
	return tasks.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function createTask(input) {
	const id = `task_${randomBytes(8).toString("hex")}`;
	const now = new Date().toISOString();
	const task = {
		id,
		status: statusFor(STATES.QUEUED),
		state: STATES.QUEUED,
		currentStep: "find_submission_page",
		approvalRequired: false,
		humanMessage: "",
		resumeUrl: `/api/tasks/${id}/resume`,
		card: null,
		liveSessionOpen: false,
		session: null,
		pausedAt: null,
		pauseExpiresAt: null,
		nextCheckAt: null,
		input,
		data: { cleared: {}, badge: null, confirmation: null },
		screenshots: [],
		logs: [],
		error: null,
		createdAt: now,
		updatedAt: now,
	};
	await fs.mkdir(shotsDir(id), { recursive: true });
	await writeJsonAtomic(taskFile(id), task);
	taskEvents.emit("task", task);
	return task;
}

/**
 * Serialized read-modify-write. `mutate(task)` edits in place (sync).
 * Returns the persisted task.
 */
export function updateTask(id, mutate) {
	const prev = chains.get(id) || Promise.resolve();
	const next = prev.then(async () => {
		const task = await getTask(id);
		if (!task) throw new Error(`Task ${id} not found`);
		await mutate(task);
		task.updatedAt = new Date().toISOString();
		await writeJsonAtomic(taskFile(id), task);
		taskEvents.emit("task", task);
		return task;
	});
	chains.set(
		id,
		next.catch(() => {}),
	);
	return next;
}

function pushLog(task, level, message, extra) {
	task.logs.push({
		ts: new Date().toISOString(),
		level,
		step: task.currentStep,
		message: String(message).slice(0, 600),
		...(extra ? { extra } : {}),
	});
	if (task.logs.length > MAX_LOGS) task.logs.splice(0, task.logs.length - MAX_LOGS);
}

export function appendLog(id, level, message, extra) {
	return updateTask(id, (t) => pushLog(t, level, message, extra)).catch(() => {});
}

/** Shallow-merge helper for the free-form `data` bag. */
export const patchData = (id, patch) =>
	updateTask(id, (t) => {
		t.data = { ...t.data, ...patch };
	});

/**
 * Validated state transition.
 * patch: { currentStep, card, humanMessage, session, nextCheckAt, error, data, liveSessionOpen, message }
 */
export function setState(id, state, patch = {}) {
	return updateTask(id, (task) => {
		const from = task.state;
		if (!canTransition(from, state)) {
			throw new Error(`Illegal transition ${from} -> ${state}`);
		}
		const now = Date.now();
		task.state = state;
		task.status = statusFor(state);
		if (patch.currentStep) task.currentStep = patch.currentStep;
		if ("session" in patch) task.session = patch.session;
		if ("nextCheckAt" in patch) task.nextCheckAt = patch.nextCheckAt;
		if ("error" in patch) task.error = patch.error;
		if (patch.data) task.data = { ...task.data, ...patch.data };

		if (isWaiting(state)) {
			task.approvalRequired = state !== STATES.WAITING_FOR_CONFIRMATION;
			task.pausedAt = new Date(now).toISOString();
			task.pauseExpiresAt =
				state === STATES.WAITING_FOR_CONFIRMATION
					? null
					: new Date(now + MAX_PAUSE_MS).toISOString();
			task.card = patch.card ?? null;
			task.humanMessage = patch.humanMessage ?? "";
			task.liveSessionOpen = patch.liveSessionOpen ?? false;
		} else {
			task.approvalRequired = false;
			task.pausedAt = null;
			task.pauseExpiresAt = null;
			task.card = null;
			task.liveSessionOpen = false;
			task.humanMessage = patch.humanMessage ?? "";
			if (state !== STATES.WAITING_FOR_CONFIRMATION) {
				if (state !== STATES.QUEUED && state !== STATES.RUNNING) task.nextCheckAt = null;
			}
		}
		if (from !== state) pushLog(task, "state", `${from} -> ${state}`);
		if (patch.message) pushLog(task, patch.level || "info", patch.message);
	});
}

export async function addScreenshot(id, label, buffer) {
	const file = `${Date.now()}-${label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40)}.png`;
	await fs.mkdir(shotsDir(id), { recursive: true });
	await fs.writeFile(path.join(shotsDir(id), file), buffer);
	await updateTask(id, (t) => {
		t.screenshots.push({
			file,
			label,
			step: t.currentStep,
			ts: new Date().toISOString(),
		});
		if (t.screenshots.length > 60) t.screenshots.shift();
	});
	return file;
}

export function screenshotPath(id, file) {
	if (!/^[\w.-]+\.png$/.test(file)) return null;
	return path.join(shotsDir(id), file);
}

/** Task view for API / SSE (drops internals nobody needs over the wire). */
export function publicTask(task) {
	const { logs, screenshots, ...rest } = task;
	return {
		...rest,
		logs: logs.slice(-200),
		screenshots: screenshots.map((s) => ({
			...s,
			url: `/api/tasks/${task.id}/screenshots/${s.file}`,
		})),
	};
}

export function summarizeTask(task) {
	return {
		id: task.id,
		status: task.status,
		state: task.state,
		currentStep: task.currentStep,
		approvalRequired: task.approvalRequired,
		humanMessage: task.humanMessage,
		directoryUrl: task.input?.directoryUrl,
		productName: task.input?.product?.name,
		pausedAt: task.pausedAt,
		pauseExpiresAt: task.pauseExpiresAt,
		nextCheckAt: task.nextCheckAt,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
	};
}
