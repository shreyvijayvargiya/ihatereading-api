/**
 * Scheduling + posting API.
 *
 * Auth: send SCHEDULER_API_KEY as `x-api-key` or `Authorization: Bearer`.
 * The API refuses to run if the key is unset (it can post to your accounts).
 *
 *   POST   /scheduler/publish      { platform, payload }            post now
 *   POST   /scheduler/posts        { platform, payload, runAt }     schedule
 *   GET    /scheduler/posts        ?status=&platform=&limit=
 *   GET    /scheduler/posts/:id
 *   DELETE /scheduler/posts/:id                                      cancel
 *   POST   /scheduler/tick                                           run due posts
 *                                                    (call from cron on serverless)
 * platform "twitter": payload { text } | { thread: [..] }
 * platform "github":  payload { path, content, repo?, branch?, message?, frontmatter? }
 */

import crypto from "node:crypto";
import { Hono } from "hono";
import { platforms } from "./scheduler/platforms/index.js";
import { firestoreStore } from "./scheduler/store.js";
import { createScheduler, startTicker } from "./scheduler/scheduler.js";

export const scheduler = createScheduler({ store: firestoreStore, platforms });
export const schedulerRouter = new Hono();

function keyMatches(given, expected) {
	const a = Buffer.from(String(given || ""));
	const b = Buffer.from(expected);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

schedulerRouter.use("*", async (c, next) => {
	const expected = process.env.SCHEDULER_API_KEY?.trim();
	if (!expected) return c.json({ success: false, error: "SCHEDULER_API_KEY is not set" }, 503);
	const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
	if (!keyMatches(c.req.header("x-api-key") || bearer, expected))
		return c.json({ success: false, error: "Unauthorized" }, 401);
	await next();
});

const body = (c) => c.req.json().catch(() => ({}));

schedulerRouter.post("/publish", async (c) => {
	try {
		const { platform, payload } = await body(c);
		const post = await scheduler.publishNow({ platform, payload });
		return c.json({ success: post.status === "published", post }, post.status === "published" ? 200 : 502);
	} catch (err) {
		return c.json({ success: false, error: err.message }, 400);
	}
});

schedulerRouter.post("/posts", async (c) => {
	try {
		const { platform, payload, runAt } = await body(c);
		if (runAt === undefined) return c.json({ success: false, error: "runAt is required (use /publish to post now)" }, 400);
		return c.json({ success: true, post: await scheduler.schedule({ platform, payload, runAt }) }, 201);
	} catch (err) {
		return c.json({ success: false, error: err.message }, 400);
	}
});

schedulerRouter.get("/posts", async (c) => {
	const posts = await firestoreStore.list({
		status: c.req.query("status"),
		platform: c.req.query("platform"),
		limit: c.req.query("limit"),
	});
	return c.json({ success: true, posts });
});

schedulerRouter.get("/posts/:id", async (c) => {
	const post = await firestoreStore.get(c.req.param("id"));
	return post ? c.json({ success: true, post }) : c.json({ success: false, error: "Not found" }, 404);
});

schedulerRouter.delete("/posts/:id", async (c) => {
	const post = await firestoreStore.cancel(c.req.param("id"));
	if (!post) return c.json({ success: false, error: "Not found" }, 404);
	return c.json({ success: post.cancelled, post }, post.cancelled ? 200 : 409);
});

schedulerRouter.post("/tick", async (c) => {
	const done = await scheduler.runDue({ limit: Number(c.req.query("limit")) || 10 });
	return c.json({ success: true, processed: done.length, posts: done });
});

// Long-running servers: poll for due posts. On Vercel, call POST /scheduler/tick from a cron.
if (process.env.SCHEDULER_ENABLED === "1" && !process.env.VERCEL) {
	startTicker(scheduler, { intervalMs: Number(process.env.SCHEDULER_INTERVAL_MS) || 30_000 });
}
