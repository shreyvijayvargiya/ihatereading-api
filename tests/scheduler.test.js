import test from "node:test";
import assert from "node:assert/strict";
import { createScheduler } from "../lib/scheduler/scheduler.js";
import * as twitter from "../lib/scheduler/platforms/twitter.js";
import * as github from "../lib/scheduler/platforms/github.js";

function memoryStore() {
	const docs = new Map();
	let n = 0;
	return {
		docs,
		async create(d) { const id = `p${++n}`; docs.set(id, { id, ...d }); return docs.get(id); },
		async get(id) { return docs.get(id) || null; },
		async update(id, patch) { Object.assign(docs.get(id), patch); },
		async claimDue({ now, limit, leaseMs }) {
			const out = [];
			for (const d of docs.values()) {
				const ok = (d.status === "scheduled" && d.runAt <= now) || (d.status === "processing" && d.leaseUntil <= now);
				if (ok && out.length < limit) { Object.assign(d, { status: "processing", leaseUntil: now + leaseMs }); out.push({ ...d }); }
			}
			return out;
		},
	};
}

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test("scheduled post only runs once due, and only once", async () => {
	let t = 1000;
	const calls = [];
	const store = memoryStore();
	const s = createScheduler({ store, now: () => t, platforms: { fake: { validate() {}, async publish(p) { calls.push(p); return { ok: true }; } } } });
	await s.schedule({ platform: "fake", payload: { a: 1 }, runAt: 5000 });
	assert.equal((await s.runDue()).length, 0);
	t = 5000;
	assert.equal((await s.runDue()).length, 1);
	assert.equal((await s.runDue()).length, 0);
	assert.equal(calls.length, 1);
	assert.equal(store.docs.get("p1").status, "published");
});

test("transient failure retries with backoff, permanent failure does not", async () => {
	let t = 0;
	const store = memoryStore();
	let mode = "transient";
	const s = createScheduler({ store, now: () => t, platforms: { fake: { validate() {}, async publish() { const e = new Error("boom"); e.permanent = mode === "permanent"; throw e; } } } });
	await s.schedule({ platform: "fake", payload: {}, runAt: 0 });
	await s.runDue();
	assert.equal(store.docs.get("p1").status, "scheduled");
	assert.equal(store.docs.get("p1").runAt, 60_000);
	mode = "permanent";
	t = 60_000;
	await s.runDue();
	assert.equal(store.docs.get("p1").status, "failed");
});

test("crashed worker's expired lease is reclaimed", async () => {
	let t = 0;
	const store = memoryStore();
	const s = createScheduler({ store, now: () => t, leaseMs: 1000, platforms: { fake: { validate() {}, async publish() { return {}; } } } });
	const d = await s.schedule({ platform: "fake", payload: {}, runAt: 0 });
	await store.claimDue({ now: 0, limit: 5, leaseMs: 1000 }); // claimed, never finished
	assert.equal((await s.runDue()).length, 0);
	t = 1001;
	assert.equal((await s.runDue()).length, 1);
	assert.equal(store.docs.get(d.id).status, "published");
});

test("validation rejects bad input before storing", async () => {
	const s = createScheduler({ store: memoryStore(), platforms: { twitter, github } });
	await assert.rejects(s.schedule({ platform: "twitter", payload: { text: "x".repeat(281) } }), /280/);
	await assert.rejects(s.schedule({ platform: "github", payload: { repo: "a/b", path: "../x.md", content: "hi" } }), /relative/);
	await assert.rejects(s.schedule({ platform: "youtube", payload: {} }), /Unsupported/);
	await assert.rejects(s.schedule({ platform: "twitter", payload: { text: "hi" }, runAt: "not a date" }), /runAt/);
});

test("twitter thread chains replies and resumes after partial failure", async () => {
	process.env.TWITTER_USER_ACCESS_TOKEN = "tok";
	const sent = [];
	let failAt = 1;
	globalThis.fetch = async (url, init) => {
		const body = JSON.parse(init.body);
		if (sent.length === failAt) { failAt = -1; return new Response("rate", { status: 429 }); }
		sent.push(body);
		return new Response(JSON.stringify({ data: { id: `id${sent.length}` } }), { status: 201 });
	};
	const payload = { thread: ["one", "two", "three"] };
	let err;
	try { await twitter.publish(payload); } catch (e) { err = e; }
	assert.equal(err.permanent, false);
	assert.deepEqual(err.partial.ids, ["id1"]);
	const res = await twitter.publish(payload, { resume: err.partial });
	assert.deepEqual(res.ids, ["id1", "id2", "id3"]);
	assert.equal(sent[1].reply.in_reply_to_tweet_id, "id1");
	assert.equal(sent[2].reply.in_reply_to_tweet_id, "id2");
	delete process.env.TWITTER_USER_ACCESS_TOKEN;
});

test("oauth1 header is well-formed and deterministic", () => {
	const creds = { apiKey: "k", apiSecret: "s", token: "t", tokenSecret: "ts" };
	const a = twitter.oauth1Header("POST", "https://api.twitter.com/2/tweets", creds, { nonce: "n", timestamp: 1 });
	const b = twitter.oauth1Header("POST", "https://api.twitter.com/2/tweets", creds, { nonce: "n", timestamp: 1 });
	assert.equal(a, b);
	assert.match(a, /^OAuth oauth_consumer_key="k", oauth_nonce="n", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1"/);
});

test("github creates then updates a markdown file with frontmatter", async () => {
	process.env.GITHUB_TOKEN = "gh";
	const reqs = [];
	let exists = false;
	globalThis.fetch = async (url, init = {}) => {
		reqs.push({ url, method: init.method || "GET", body: init.body && JSON.parse(init.body) });
		if (!init.method) return exists ? new Response(JSON.stringify({ sha: "abc" })) : new Response("nf", { status: 404 });
		exists = true;
		return new Response(JSON.stringify({ content: { html_url: "https://github.com/o/r/blob/main/p.md" }, commit: { sha: "c1" } }));
	};
	const payload = { repo: "o/r", branch: "main", path: "content/p.md", content: "# Hi", frontmatter: { title: "A: b" } };
	const first = await github.publish(payload);
	assert.equal(first.updated, false);
	assert.equal(reqs[1].body.sha, undefined);
	assert.equal(Buffer.from(reqs[1].body.content, "base64").toString(), '---\ntitle: "A: b"\n---\n\n# Hi');
	const second = await github.publish(payload);
	assert.equal(second.updated, true);
	assert.equal(reqs[3].body.sha, "abc");
	delete process.env.GITHUB_TOKEN;
});
