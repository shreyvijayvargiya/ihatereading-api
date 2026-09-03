/**
 * Dedicated social profile scrapers (no RapidAPI, no login-modal clicks).
 *
 * POST /scrape-instagram  { username | url }
 * POST /scrape-x          { handle | username | url }
 * POST /scrape-youtube-channel { handle | username | url | channelId }
 */

import { Hono } from "hono";
import { scrapeInstagramProfile } from "./socialScrapers/instagram.js";
import { scrapeXProfile } from "./socialScrapers/x.js";
import { scrapeYoutubeChannel } from "./socialScrapers/youtube.js";

export const socialScrapersRouter = new Hono();

function fail(c, err, code = 500) {
	return c.json(
		{
			success: false,
			error: err?.message || String(err),
		},
		code,
	);
}

socialScrapersRouter.post("/scrape-instagram", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	if (!body.username && !body.url) {
		return fail(c, new Error("username or url is required"), 400);
	}
	try {
		const data = await scrapeInstagramProfile(body);
		return c.json({ ...data, timestamp: new Date().toISOString() });
	} catch (err) {
		console.error("[scrape-instagram]", err);
		return fail(c, err);
	}
});

socialScrapersRouter.post("/scrape-x", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	if (!body.handle && !body.username && !body.url) {
		return fail(c, new Error("handle, username, or url is required"), 400);
	}
	try {
		const data = await scrapeXProfile(body);
		return c.json({ ...data, timestamp: new Date().toISOString() });
	} catch (err) {
		console.error("[scrape-x]", err);
		return fail(c, err);
	}
});

socialScrapersRouter.post("/scrape-youtube-channel", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	if (!body.handle && !body.username && !body.url && !body.channelId) {
		return fail(c, new Error("handle, username, url, or channelId is required"), 400);
	}
	try {
		const data = await scrapeYoutubeChannel(body);
		return c.json({ ...data, timestamp: new Date().toISOString() });
	} catch (err) {
		console.error("[scrape-youtube-channel]", err);
		return fail(c, err);
	}
});
