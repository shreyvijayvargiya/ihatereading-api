/**
 * YouTube channel transcripts.
 *
 * GET  /youtube-channel-scripts/channels
 * GET  /youtube-channel-scripts?collection=
 * GET  /youtube-channel-scripts/:videoId?collection=
 * POST /youtube-channel-scripts/run
 */

import { Hono } from "hono";
import {
	YT_CHANNELS,
	clampBatch,
	getYoutubeScript,
	listYoutubeScripts,
	resolveYoutubeChannel,
	runYoutubeChannelScriptsBatch,
} from "./youtubeChannelScripts/core.js";

export const youtubeChannelScriptsRouter = new Hono();

youtubeChannelScriptsRouter.get("/youtube-channel-scripts/channels", (c) => {
	return c.json({ success: true, channels: YT_CHANNELS });
});

youtubeChannelScriptsRouter.get("/youtube-channel-scripts", async (c) => {
	try {
		const listed = await listYoutubeScripts({
			limit: c.req.query("limit"),
			collection: c.req.query("collection"),
		});
		return c.json({
			success: true,
			...listed,
			channels: YT_CHANNELS,
			cli: "npm run yt:scripts:greg",
			run: "POST /youtube-channel-scripts/run",
		});
	} catch (err) {
		console.error("[youtube-channel-scripts] list failed:", err);
		return c.json(
			{ success: false, error: err?.message || "Failed to list scripts" },
			500,
		);
	}
});

youtubeChannelScriptsRouter.get("/youtube-channel-scripts/:videoId", async (c) => {
	try {
		const video = await getYoutubeScript(c.req.param("videoId"), c.req.query("collection"));
		if (!video) return c.json({ success: false, error: "Video not found" }, 404);
		const resolved = resolveYoutubeChannel({ collection: c.req.query("collection") });
		return c.json({ success: true, collection: resolved.collection, video });
	} catch (err) {
		console.error("[youtube-channel-scripts] get failed:", err);
		return c.json(
			{ success: false, error: err?.message || "Failed to load script" },
			500,
		);
	}
});

youtubeChannelScriptsRouter.post("/youtube-channel-scripts/run", async (c) => {
	let body = {};
	try {
		body = await c.req.json();
	} catch {
		body = {};
	}
	const channelUrl = body.channelUrl || body.url || c.req.query("channelUrl") || "";
	const collection = body.collection || c.req.query("collection") || "";
	if (!channelUrl && !collection) {
		return c.json({ success: false, error: "channelUrl or collection is required" }, 400);
	}
	try {
		const summary = await runYoutubeChannelScriptsBatch({
			channelUrl,
			collection,
			batchSize: clampBatch(body.batchSize ?? body.batch ?? c.req.query("batch")),
			minSeconds: body.minSeconds ?? c.req.query("minSeconds"),
		});
		return c.json({ success: true, ...summary, timestamp: new Date().toISOString() });
	} catch (err) {
		console.error("[youtube-channel-scripts] run failed:", err);
		return c.json(
			{ success: false, error: err?.message || "Failed to scrape channel" },
			500,
		);
	}
});
