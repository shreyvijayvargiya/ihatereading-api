/**
 * X / Twitter adapter (API v2 POST /2/tweets).
 *
 * Payload: { text: "single post" } or { thread: ["first", "second", ...] }
 *
 * Auth (first match wins):
 *   TWITTER_USER_ACCESS_TOKEN                      OAuth 2.0 user token (Bearer)
 *   TWITTER_API_KEY / TWITTER_API_SECRET /
 *   TWITTER_ACCESS_TOKEN / TWITTER_ACCESS_SECRET   OAuth 1.0a user context
 */

import crypto from "node:crypto";
import { httpError, requireEnv } from "./util.js";

const TWEETS_URL = "https://api.twitter.com/2/tweets";
const MAX_LEN = 280;

const enc = (s) =>
	encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** OAuth 1.0a header. JSON bodies are not part of the signature base. */
export function oauth1Header(method, url, creds, { nonce, timestamp } = {}) {
	const p = {
		oauth_consumer_key: creds.apiKey,
		oauth_nonce: nonce || crypto.randomBytes(16).toString("hex"),
		oauth_signature_method: "HMAC-SHA1",
		oauth_timestamp: String(timestamp || Math.floor(Date.now() / 1000)),
		oauth_token: creds.token,
		oauth_version: "1.0",
	};
	const paramString = Object.keys(p)
		.sort()
		.map((k) => `${enc(k)}=${enc(p[k])}`)
		.join("&");
	const base = [method.toUpperCase(), enc(url), enc(paramString)].join("&");
	const key = `${enc(creds.apiSecret)}&${enc(creds.tokenSecret)}`;
	p.oauth_signature = crypto.createHmac("sha1", key).update(base).digest("base64");
	return (
		"OAuth " +
		Object.keys(p)
			.sort()
			.map((k) => `${enc(k)}="${enc(p[k])}"`)
			.join(", ")
	);
}

function authHeader() {
	const bearer = process.env.TWITTER_USER_ACCESS_TOKEN?.trim();
	if (bearer) return `Bearer ${bearer}`;
	return oauth1Header("POST", TWEETS_URL, {
		apiKey: requireEnv("TWITTER_API_KEY"),
		apiSecret: requireEnv("TWITTER_API_SECRET"),
		token: requireEnv("TWITTER_ACCESS_TOKEN"),
		tokenSecret: requireEnv("TWITTER_ACCESS_SECRET"),
	});
}

function toPosts(payload) {
	const posts = Array.isArray(payload.thread) ? payload.thread : [payload.text];
	return posts.map((t) => String(t ?? "").trim());
}

export function validate(payload) {
	const posts = toPosts(payload || {});
	if (!posts.length || posts.some((t) => !t)) throw new Error("twitter: text or thread[] is required");
	const tooLong = posts.findIndex((t) => t.length > MAX_LEN);
	if (tooLong >= 0) throw new Error(`twitter: post ${tooLong + 1} exceeds ${MAX_LEN} characters`);
}

/**
 * Posts sequentially, replying to the previous post. `resume.ids` lets a retry
 * continue a thread that failed part-way instead of reposting from the start.
 */
export async function publish(payload, { resume } = {}) {
	const posts = toPosts(payload);
	const ids = [...(resume?.ids || [])];
	for (let i = ids.length; i < posts.length; i++) {
		const body = { text: posts[i] };
		if (i > 0) body.reply = { in_reply_to_tweet_id: ids[i - 1] };
		const res = await fetch(TWEETS_URL, {
			method: "POST",
			headers: { Authorization: authHeader(), "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const err = await httpError(res, "twitter");
			err.partial = { ids };
			throw err;
		}
		const json = await res.json();
		ids.push(json.data.id);
	}
	return { ids, url: `https://x.com/i/web/status/${ids[0]}` };
}
