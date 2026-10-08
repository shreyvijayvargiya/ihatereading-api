/**
 * Human-in-the-loop directory submission agent — HTTP API + dashboard.
 *
 *   POST /api/tasks                    create a task (starts immediately)
 *   GET  /api/tasks                    list tasks
 *   GET  /api/tasks/events             SSE stream of task summaries
 *   GET  /api/tasks/:id                full task (state, card, logs, screenshots)
 *   POST /api/tasks/:id/approve        approve the pending card
 *   POST /api/tasks/:id/decline        decline the pending card
 *   POST /api/tasks/:id/resume         "Continue" after the human logged in / solved a captcha
 *   POST /api/tasks/:id/cancel
 *   POST /api/tasks/:id/check-status   follow-up poll of the directory (?wait=1 to block)
 *   GET  /api/tasks/:id/screenshots/:file
 *   GET  /api/tasks/:id/live/frame     JPEG of the live browser
 *   POST /api/tasks/:id/live/input     click / type / key / scroll / goto / back
 *   GET  /directory-agent              dashboard
 *
 * Auth: set DIRECTORY_AGENT_TOKEN (required when NODE_ENV=production).
 * Needs a long-running Node server (browsers + SSE); not suitable for serverless.
 */

import fs from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
	AgentError,
	approveTask,
	cancelTask,
	checkStatus,
	createAndStart,
	declineTask,
	getFullTask,
	recoverTasks,
	resumeTask,
	startScheduler,
} from "./directoryAgent/agent.js";
import { liveFrame, liveInput } from "./directoryAgent/browser.js";
import { LIVE_CONTROL_STATES, STATES } from "./directoryAgent/states.js";
import {
	getTask,
	isValidTaskId,
	listTasks,
	publicTask,
	screenshotPath,
	summarizeTask,
	taskEvents,
} from "./directoryAgent/store.js";

export const directoryAgentRouter = new Hono();

const DASHBOARD_HTML = new URL("./directoryAgent/dashboard.html", import.meta.url);

const productSchema = z.object({
	name: z.string().trim().min(1).max(120),
	website: z.string().url(),
	description: z.string().trim().min(1).max(5000),
	tagline: z.string().max(200).optional(),
	email: z.string().email().optional(),
	tags: z.union([z.array(z.string().max(40)).max(20), z.string().max(300)]).optional(),
	category: z.string().max(80).optional(),
	pricing: z.string().max(80).optional(),
	twitter: z.string().max(100).optional(),
	contactName: z.string().max(100).optional(),
	logoUrl: z.string().url().optional(),
});

const createSchema = z.object({
	directoryUrl: z.string().url(),
	submissionUrl: z.string().url().optional(),
	githubRepo: z.string().max(200).optional(),
	product: productSchema,
});

const liveInputSchema = z.object({
	type: z.enum(["click", "type", "key", "scroll", "goto", "back"]),
	x: z.number().optional(),
	y: z.number().optional(),
	double: z.boolean().optional(),
	text: z.string().max(500).optional(),
	key: z.string().max(30).optional(),
	dx: z.number().optional(),
	dy: z.number().optional(),
	url: z.string().max(2000).optional(),
});

/* -------------------------------- helpers ------------------------------- */

function tokenOk(provided, expected) {
	const a = Buffer.from(String(provided || ""));
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

async function auth(c, next) {
	const expected = process.env.DIRECTORY_AGENT_TOKEN?.trim();
	if (!expected) {
		if (process.env.NODE_ENV === "production") {
			return c.json({ error: "DIRECTORY_AGENT_TOKEN must be configured in production" }, 503);
		}
		return next();
	}
	const hdr = c.req.header("authorization") || "";
	const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
	// query token is accepted for GET only (EventSource / <img> cannot send headers)
	const provided = bearer || (c.req.method === "GET" ? c.req.query("token") : "") || "";
	if (!tokenOk(provided, expected)) return c.json({ error: "Unauthorized" }, 401);
	return next();
}

const wrap = (fn) => async (c) => {
	try {
		return await fn(c);
	} catch (e) {
		if (e instanceof z.ZodError) {
			return c.json({ error: "Invalid request", issues: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
		}
		if (e instanceof AgentError) return c.json({ error: e.message }, e.status);
		if (/URL|private|resolve|host/i.test(e.message || "")) return c.json({ error: e.message }, 400);
		console.error("[directory-agent]", e);
		return c.json({ error: "Internal error" }, 500);
	}
};

const readBody = async (c) => {
	try {
		const b = await c.req.json();
		return b && typeof b === "object" ? b : {};
	} catch {
		return {};
	}
};

const taskResponse = (task) => ({ success: true, task: publicTask(task) });

function ensureId(c) {
	const id = c.req.param("id");
	if (!isValidTaskId(id)) throw new AgentError(404, "Task not found");
	return id;
}

/* ------------------------------ lifecycle ------------------------------- */

let booted = false;
function boot() {
	if (booted || process.env.VERCEL) return;
	booted = true;
	recoverTasks().catch((e) => console.error("[directory-agent] recover failed", e.message));
	startScheduler();
}
boot();

/* --------------------------------- routes ------------------------------- */

directoryAgentRouter.use("/api/tasks", auth);
directoryAgentRouter.use("/api/tasks/*", auth);

directoryAgentRouter.get("/directory-agent", (c) => {
	try {
		return c.html(fs.readFileSync(DASHBOARD_HTML, "utf8"));
	} catch {
		return c.text("Dashboard unavailable", 500);
	}
});

directoryAgentRouter.post(
	"/api/tasks",
	wrap(async (c) => {
		const input = createSchema.parse(await readBody(c));
		if (input.githubRepo) input.product.githubRepo = input.githubRepo;
		const task = await createAndStart(input);
		return c.json(taskResponse(task), 201);
	}),
);

directoryAgentRouter.get(
	"/api/tasks",
	wrap(async (c) => {
		const state = c.req.query("state");
		let tasks = await listTasks();
		if (state) tasks = tasks.filter((t) => t.state === state.toUpperCase());
		return c.json({ success: true, count: tasks.length, tasks: tasks.map(summarizeTask) });
	}),
);

directoryAgentRouter.get("/api/tasks/events", (c) =>
	streamSSE(c, async (stream) => {
		const onTask = (t) => {
			stream.writeSSE({ event: "task", data: JSON.stringify(summarizeTask(t)) }).catch(() => {});
		};
		taskEvents.on("task", onTask);
		stream.onAbort(() => taskEvents.off("task", onTask));
		while (!stream.aborted) {
			await stream.writeSSE({ event: "ping", data: String(Date.now()) });
			await stream.sleep(15_000);
		}
	}),
);

directoryAgentRouter.get(
	"/api/tasks/:id",
	wrap(async (c) => c.json(taskResponse(await getFullTask(ensureId(c))))),
);

directoryAgentRouter.post(
	"/api/tasks/:id/approve",
	wrap(async (c) => c.json(taskResponse(await approveTask(ensureId(c), await readBody(c))))),
);
directoryAgentRouter.post(
	"/api/tasks/:id/decline",
	wrap(async (c) => c.json(taskResponse(await declineTask(ensureId(c))))),
);
directoryAgentRouter.post(
	"/api/tasks/:id/resume",
	wrap(async (c) => c.json(taskResponse(await resumeTask(ensureId(c), await readBody(c))))),
);
directoryAgentRouter.post(
	"/api/tasks/:id/cancel",
	wrap(async (c) => c.json(taskResponse(await cancelTask(ensureId(c))))),
);
directoryAgentRouter.post(
	"/api/tasks/:id/check-status",
	wrap(async (c) =>
		c.json(taskResponse(await checkStatus(ensureId(c), { wait: c.req.query("wait") === "1" }))),
	),
);

directoryAgentRouter.get(
	"/api/tasks/:id/screenshots/:file",
	wrap(async (c) => {
		const id = ensureId(c);
		const file = screenshotPath(id, c.req.param("file"));
		if (!file || !fs.existsSync(file)) throw new AgentError(404, "Screenshot not found");
		return new Response(fs.readFileSync(file), {
			headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" },
		});
	}),
);

directoryAgentRouter.get(
	"/api/tasks/:id/live/frame",
	wrap(async (c) => {
		const id = ensureId(c);
		const frame = await liveFrame(id);
		if (!frame) throw new AgentError(404, "No live browser session for this task");
		return new Response(frame.buffer, {
			headers: {
				"Content-Type": "image/jpeg",
				"Cache-Control": "no-store",
				"X-Page-Url": encodeURIComponent(frame.url),
				"X-Popup": frame.popup ? "1" : "0",
			},
		});
	}),
);

directoryAgentRouter.post(
	"/api/tasks/:id/live/input",
	wrap(async (c) => {
		const id = ensureId(c);
		const task = await getTask(id);
		if (!task) throw new AgentError(404, "Task not found");
		const humanState =
			LIVE_CONTROL_STATES.has(task.state) &&
			(task.liveSessionOpen ||
				task.state === STATES.WAITING_FOR_BADGE ||
				task.state === STATES.WAITING_FOR_APPROVAL);
		if (!humanState) throw new AgentError(409, "Live control is only available while waiting for a human");
		const ev = liveInputSchema.parse(await readBody(c));
		try {
			return c.json({ success: true, ...(await liveInput(id, ev)) });
		} catch (e) {
			throw new AgentError(/URL|private|resolve|host/i.test(e.message) ? 400 : 409, e.message.split("\n")[0]);
		}
	}),
);
