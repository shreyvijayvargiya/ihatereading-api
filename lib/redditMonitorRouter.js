import { createHash } from "node:crypto";
import { Hono } from "hono";
import { Client, Receiver } from "@upstash/qstash";
import { firestore } from "../config/firebase.js";
import { executeComposioTool } from "./composioClient.js";
import {
	listRelevantRedditPosts,
	runRedditMonitor,
} from "./jobs/redditMonitor.js";
import { openRouterChat } from "./openrouter.js";
import { parseJsonFromLLM } from "./geoPipeline/parseLlmJson.js";
import {
	PRODUCT_CONTEXT,
	REDDIT_DRAFTS_COLL,
	REDDIT_POSTS_COLL,
	RELEVANCE_MIN,
	SONAR_MODEL,
} from "./redditMonitor/constants.js";

export const redditMonitorRouter = new Hono();

function docIdFromString(value) {
	return createHash("sha256")
		.update(String(value || ""))
		.digest("hex")
		.slice(0, 32);
}

function draftDocRef(draftId) {
	return firestore.collection(REDDIT_DRAFTS_COLL).doc(draftId);
}

function postDocRefByPermalink(permalink) {
	return firestore.collection(REDDIT_POSTS_COLL).doc(docIdFromString(permalink));
}

function nowIso() {
	return new Date().toISOString();
}

function normalizeSubreddit(subreddit) {
	return String(subreddit || "")
		.trim()
		.replace(/^r\//i, "")
		.toLowerCase();
}

function extractThingIdFromPermalink(permalink) {
	const raw = String(permalink || "");
	const m = raw.match(/\/comments\/([a-z0-9]+)\//i);
	return m ? `t3_${m[1]}` : null;
}

function getQstashClient() {
	const token = process.env.QSTASH_TOKEN?.trim();
	if (!token) throw new Error("QSTASH_TOKEN is required for scheduling posts");
	return new Client({ token });
}

function getRedditConnectedAccountId() {
	return (
		process.env.COMPOSIO_REDDIT_CONNECTED_ACCOUNT_ID?.trim() ||
		process.env.COMPOSIO_LINKEDIN_CONNECTED_ACCOUNT_ID?.trim() ||
		undefined
	);
}

function getRedditToolkitVersion() {
	return process.env.COMPOSIO_REDDIT_TOOLKIT_VERSION?.trim() || undefined;
}

function getPostEndpointUrl() {
	const explicit = process.env.REDDIT_POST_URL?.trim();
	if (explicit) return explicit;
	const base =
		process.env.API_BASE_URL?.trim() ||
		process.env.REDDIT_MONITOR_URL?.trim() ||
		(process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
	if (!base) {
		throw new Error(
			"Set REDDIT_POST_URL or API_BASE_URL/VERCEL_URL for scheduled Reddit posting",
		);
	}
	return base.replace(/\/reddit\/run\/?$/, "").replace(/\/$/, "") + "/reddit/post";
}

function parseDraftReplyResponse(text) {
	const raw = parseJsonFromLLM(text);
	if (Array.isArray(raw)) return raw;
	if (Array.isArray(raw.results)) return raw.results;
	if (Array.isArray(raw.drafts)) return raw.drafts;
	return [];
}

async function buildDraftReplies(posts) {
	if (!posts.length) return [];
	const { content, model, usage } = await openRouterChat({
		model: SONAR_MODEL,
		jsonMode: true,
		temperature: 0.4,
		maxTokens: 2600,
		messages: [
			{
				role: "system",
				content: `You write Reddit replies for a founder/community member representing a product, but the tone must be genuinely helpful, non-spammy, and subreddit-safe.

${PRODUCT_CONTEXT}

Goal:
- For each post, write the best helpful reply if the post is a good fit.
- Mention the product only when it genuinely helps and do it softly.
- Prefer advice-first, sales-last.
- Avoid sounding like an ad, fake testimonial, or bot.
- If a post is not a good fit for a direct reply, still return a short explanation and set shouldReply=false.

Return ONLY JSON:
{
  "drafts": [
    {
      "permalink": "/r/...",
      "shouldReply": true,
      "score": 1,
      "reason": "why this is/isn't worth replying to",
      "reply": "final reddit comment text"
    }
  ]
}
Rules:
- Include every input post exactly once.
- score is 1-5 for reply-worthiness.
- Keep reply under 900 characters.
- Do not use markdown headings or code fences.`,
			},
			{
				role: "user",
				content: JSON.stringify(
					posts.map((post) => ({
						permalink: post.permalink,
						subreddit: post.subreddit,
						title: post.title,
						body: String(post.body || "").slice(0, 2000),
						relevanceScore: post.relevanceScore || 0,
						relevanceReason: post.relevanceReason || "",
					})),
				),
			},
		],
	});
	return { drafts: parseDraftReplyResponse(content), model, usage, raw: content };
}

async function loadDraft(draftId) {
	const snap = await draftDocRef(draftId).get();
	if (!snap.exists) {
		throw Object.assign(new Error("Draft not found"), { status: 404 });
	}
	return { id: snap.id, ...snap.data() };
}

function getQstashReceiver() {
	const current = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
	const next = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
	if (!current || !next) return null;
	return new Receiver({
		currentSigningKey: current,
		nextSigningKey: next,
	});
}

async function authorizeCron(c) {
	const signature =
		c.req.header("upstash-signature") || c.req.header("Upstash-Signature");
	const receiver = getQstashReceiver();

	if (signature && receiver) {
		try {
			const body = await c.req.text();
			c.set("redditRunRawBody", body);
			const verifyUrl =
				process.env.REDDIT_MONITOR_URL?.trim() ||
				process.env.QSTASH_VERIFY_URL?.trim() ||
				c.req.url;
			const ok = await receiver.verify({
				signature,
				body: body || "",
				url: verifyUrl,
				clockTolerance: 60,
			});
			if (ok) return true;
		} catch (err) {
			console.warn(
				"[reddit/run] QStash signature verify failed:",
				err?.message || err,
			);
		}
	}

	const secret = process.env.CRON_SECRET?.trim();
	const auth =
		c.req.header("Authorization") || c.req.header("authorization") || "";
	const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
	if (secret && bearer === secret) return true;

	// Local without secrets: allow; production: deny
	if (!secret && !receiver && process.env.VERCEL !== "1") return true;
	return false;
}

async function handleRedditRun(c) {
	const allowed = await authorizeCron(c);
	if (!allowed) {
		return c.json(
			{
				success: false,
				error: "Unauthorized",
				code: "CRON_UNAUTHORIZED",
				details:
					"Call via Upstash QStash (Upstash-Signature) or Authorization: Bearer <CRON_SECRET>.",
			},
			401,
		);
	}

	try {
		const summary = await runRedditMonitor();
		return c.json({ success: true, ...summary });
	} catch (err) {
		console.error("[reddit/run]", err);
		return c.json(
			{ success: false, error: err?.message || "Monitor run failed" },
			500,
		);
	}
}

async function handleRedditPost(c, payload = null) {
	const body = payload || (await c.req.json().catch(() => ({})));
	const draftId = body.draftId ? String(body.draftId).trim() : "";
	const explicitThingId = body.thingId ? String(body.thingId).trim() : "";
	const explicitText = body.text ? String(body.text).trim() : "";

	if (!draftId && (!explicitThingId || !explicitText)) {
		return c.json(
			{
				success: false,
				error: "Provide draftId or both thingId and text",
			},
			400,
		);
	}

	try {
		let draft = null;
		let thingId = explicitThingId;
		let text = explicitText;

		if (draftId) {
			draft = await loadDraft(draftId);
			thingId = draft.thingId || extractThingIdFromPermalink(draft.permalink);
			text = draft.draftText || text;
		}

		if (!thingId) {
			return c.json(
				{
					success: false,
					error:
						"Unable to derive Reddit thing_id from permalink. Provide thingId explicitly.",
				},
				400,
			);
		}
		if (!text) {
			return c.json({ success: false, error: "Reply text is empty" }, 400);
		}

		const result = await executeComposioTool(
			"REDDIT_POST_REDDIT_COMMENT",
			{ text, thing_id: thingId },
			{
				connectedAccountId: getRedditConnectedAccountId(),
				version: getRedditToolkitVersion(),
			},
		);

		if (!result.successful) {
			if (draftId) {
				await draftDocRef(draftId).set(
					{
						status: "failed",
						error: result.error || "Reddit post failed",
						updatedAt: nowIso(),
					},
					{ merge: true },
				);
			}
			return c.json(
				{
					success: false,
					error: result.error || "Reddit post failed",
					code: result.code,
					raw: result.raw,
				},
				500,
			);
		}

		if (draftId) {
			await draftDocRef(draftId).set(
				{
					status: "posted",
					postedAt: nowIso(),
					updatedAt: nowIso(),
					postResult: result.data,
					error: null,
				},
				{ merge: true },
			);
		}

		return c.json({
			success: true,
			draftId: draftId || undefined,
			thingId,
			result: result.data,
		});
	} catch (err) {
		return c.json(
			{ success: false, error: err?.message || "Failed to post to Reddit" },
			err?.status || 500,
		);
	}
}

redditMonitorRouter.get("/reddit/relevant", async (c) => {
	try {
		const min = Number(c.req.query("minScore")) || RELEVANCE_MIN;
		const limit = Math.min(Number(c.req.query("limit")) || 100, 200);
		const posts = await listRelevantRedditPosts(min, limit);
		return c.json({
			success: true,
			count: posts.length,
			minScore: min,
			posts,
		});
	} catch (err) {
		console.error("[reddit/relevant]", err);
		return c.json(
			{ success: false, error: err?.message || "Failed to list relevant posts" },
			500,
		);
	}
});

redditMonitorRouter.post("/reddit/draft-replies", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const minScore = Math.max(Number(body.minScore) || RELEVANCE_MIN, 1);
		const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 50);
		const force = body.force === true;
		const posts = await listRelevantRedditPosts(minScore, limit);

		if (!posts.length) {
			return c.json({
				success: true,
				count: 0,
				drafts: [],
				message: "No relevant Reddit posts found",
			});
		}

		const { drafts: aiDrafts, model, usage, raw } = await buildDraftReplies(posts);
		const draftByPermalink = new Map(
			aiDrafts.map((d) => [String(d.permalink || ""), d]),
		);
		const saved = [];

		for (const post of posts) {
			const ai = draftByPermalink.get(String(post.permalink || ""));
			const draftId = docIdFromString(post.permalink);
			const ref = draftDocRef(draftId);
			const existing = await ref.get();
			if (existing.exists && !force) {
				saved.push({ id: draftId, ...existing.data(), reused: true });
				continue;
			}

			const thingId = extractThingIdFromPermalink(post.permalink);
			const doc = {
				postId: post.id || docIdFromString(post.permalink),
				permalink: post.permalink,
				subreddit: normalizeSubreddit(post.subreddit),
				thingId,
				title: post.title || "",
				author: post.author || "",
				sourceBody: String(post.body || "").slice(0, 3000),
				relevanceScore: post.relevanceScore || 0,
				relevanceReason: post.relevanceReason || "",
				replyWorthinessScore: Number(ai?.score) || 0,
				replyReason: String(ai?.reason || "").slice(0, 500),
				draftText: String(ai?.reply || "").slice(0, 3000),
				shouldReply: ai?.shouldReply === true,
				status: "draft",
				createdAt: nowIso(),
				updatedAt: nowIso(),
				draftModel: model,
			};
			await ref.set(doc, { merge: true });
			saved.push({ id: draftId, ...doc, reused: false });
		}

		return c.json({
			success: true,
			count: saved.length,
			drafts: saved,
			usage,
			model,
			debug:
				body.debug === true
					? { rawPreview: String(raw || "").slice(0, 1000) }
					: undefined,
		});
	} catch (err) {
		console.error("[reddit/draft-replies]", err);
		return c.json(
			{
				success: false,
				error: err?.message || "Failed to draft Reddit replies",
			},
			500,
		);
	}
});

redditMonitorRouter.post("/reddit/post", async (c) => {
	const qstashSig =
		c.req.header("upstash-signature") || c.req.header("Upstash-Signature");
	if (qstashSig) {
		const allowed = await authorizeCron(c);
		if (!allowed) {
			return c.json(
				{ success: false, error: "Unauthorized", code: "CRON_UNAUTHORIZED" },
				401,
			);
		}
	}
	return handleRedditPost(c);
});

redditMonitorRouter.post("/reddit/schedule-post", async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}));
		const draftIds = Array.isArray(body.draftIds)
			? body.draftIds.map((x) => String(x).trim()).filter(Boolean)
			: [];
		const intervalMinutes = Math.max(Number(body.intervalMinutes) || 10, 1);
		const firstDelayMinutes = Math.max(Number(body.firstDelayMinutes) || 0, 0);
		if (!draftIds.length) {
			return c.json(
				{ success: false, error: "draftIds must be a non-empty array" },
				400,
			);
		}

		const qstash = getQstashClient();
		const url = getPostEndpointUrl();
		const scheduled = [];

		for (let i = 0; i < draftIds.length; i++) {
			const draft = await loadDraft(draftIds[i]);
			const thingId = draft.thingId || extractThingIdFromPermalink(draft.permalink);
			if (!thingId) {
				throw new Error(
					`Draft ${draft.id} is missing thingId and permalink-derived thing_id`,
				);
			}
			if (!draft.draftText) {
				throw new Error(`Draft ${draft.id} has empty draftText`);
			}

			const notBefore =
				Math.floor(Date.now() / 1000) +
				(firstDelayMinutes + i * intervalMinutes) * 60;
			const publishRes = await qstash.publishJSON({
				url,
				body: { draftId: draft.id, thingId, text: draft.draftText },
				notBefore,
				headers: process.env.CRON_SECRET
					? {
							Authorization: `Bearer ${process.env.CRON_SECRET}`,
							"Content-Type": "application/json",
					  }
					: { "Content-Type": "application/json" },
			});

			await draftDocRef(draft.id).set(
				{
					status: "scheduled",
					scheduledAt: new Date(notBefore * 1000).toISOString(),
					qstashMessageId:
						publishRes?.messageId || publishRes?.message_id || null,
					updatedAt: nowIso(),
				},
				{ merge: true },
			);

			scheduled.push({
				draftId: draft.id,
				thingId,
				scheduledAt: new Date(notBefore * 1000).toISOString(),
				qstashMessageId:
					publishRes?.messageId || publishRes?.message_id || null,
			});
		}

		return c.json({
			success: true,
			count: scheduled.length,
			intervalMinutes,
			firstDelayMinutes,
			scheduled,
		});
	} catch (err) {
		console.error("[reddit/schedule-post]", err);
		return c.json(
			{
				success: false,
				error: err?.message || "Failed to schedule Reddit posts",
			},
			500,
		);
	}
});

redditMonitorRouter.get("/reddit/run", handleRedditRun);
redditMonitorRouter.post("/reddit/run", handleRedditRun);
