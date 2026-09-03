/**
 * Content Research API — single public endpoint for iHateReading content planner.
 *
 * POST /api/content-research
 * Body: { "topic": "Next.js", "count"?: 10, "region"?: "global", "language"?: "en" }
 *
 * No API key required. Uses free Google Suggest + /google-search + Reddit RSS.
 */

import { Hono } from "hono";
import { contentResearchRequestSchema } from "./contentResearch/schemas.js";
import { runContentResearch } from "./contentResearch/runContentResearch.js";
import { resolveResearchBaseUrl } from "./contentResearch/http.js";

export const contentResearchRouter = new Hono();

function clientIp(c) {
	return (
		c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown"
	);
}

const rateBuckets = new Map();
function rateLimitOk(ip, limit = 10, windowMs = 10 * 60 * 1000) {
	const now = Date.now();
	let rec = rateBuckets.get(ip);
	if (!rec || now > rec.resetTime) {
		rec = { count: 0, resetTime: now + windowMs };
		rateBuckets.set(ip, rec);
	}
	rec.count += 1;
	if (rec.count > limit) {
		return {
			ok: false,
			retryAfter: Math.ceil((rec.resetTime - now) / 1000),
		};
	}
	return { ok: true };
}

async function handleResearch(c) {
	const rl = rateLimitOk(clientIp(c), 12, 10 * 60 * 1000);
	if (!rl.ok) {
		c.header("Retry-After", String(rl.retryAfter));
		return c.json(
			{
				success: false,
				error: {
					code: "RATE_LIMITED",
					message: "Rate limit exceeded",
					retryAfter: rl.retryAfter,
				},
			},
			429,
		);
	}

	let body = {};
	try {
		body = await c.req.json();
	} catch {
		return c.json(
			{
				success: false,
				error: { code: "INVALID_JSON", message: "Invalid JSON body" },
			},
			400,
		);
	}

	const parsed = contentResearchRequestSchema.safeParse(body || {});
	if (!parsed.success) {
		const issue = parsed.error.issues?.[0];
		return c.json(
			{
				success: false,
				error: {
					code:
						issue?.path?.[0] === "topic" ? "INVALID_TOPIC" : "INVALID_REQUEST",
					message: issue?.message || "Invalid request",
				},
			},
			400,
		);
	}

	try {
		const result = await runContentResearch({
			...parsed.data,
			baseUrl: resolveResearchBaseUrl(c),
		});
		const http =
			result.success === false
				? result.error?.code === "MISSING_OPENROUTER_KEY"
					? 503
					: result.error?.code === "RESEARCH_EMPTY"
						? 502
						: 500
				: 200;
		return c.json(result, http);
	} catch (err) {
		console.error("❌ content-research error:", err);
		return c.json(
			{
				success: false,
				error: {
					code: "INTERNAL_ERROR",
					message: err?.message || "Content research failed",
				},
			},
			500,
		);
	}
}

contentResearchRouter.post("/api/content-research", handleResearch);
contentResearchRouter.post("/research", handleResearch);
