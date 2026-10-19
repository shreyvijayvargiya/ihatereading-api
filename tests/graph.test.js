import test from "node:test";
import assert from "node:assert/strict";
import { runGraph, parallel } from "../lib/graph/runGraph.js";
import { runContentResearchGraph } from "../lib/contentResearch/runContentResearchGraph.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- engine ----------------------------------------------------------------

test("runGraph follows edges and merges patches into state", async () => {
	const { state, trace } = await runGraph({
		nodes: { a: async () => ({ x: 1 }), b: async (s) => ({ y: s.x + 1 }) },
		edges: { a: "b", b: null },
		start: "a",
	});
	assert.deepEqual(state, { x: 1, y: 2 });
	assert.deepEqual(trace.map((t) => t.node), ["a", "b"]);
});

test("function edges branch on state", async () => {
	const run = (n) =>
		runGraph({
			nodes: { check: async () => ({ n }), big: async () => ({ path: "big" }), small: async () => ({ path: "small" }) },
			edges: { check: (s) => (s.n > 5 ? "big" : "small"), big: null, small: null },
			start: "check",
		});
	assert.equal((await run(10)).state.path, "big");
	assert.equal((await run(1)).state.path, "small");
});

test("parallel nodes run concurrently and reducers combine their patches", async () => {
	const events = [];
	const slow = (name) => async () => {
		events.push(`start ${name}`);
		await sleep(30);
		events.push(`end ${name}`);
		return { log: [name] };
	};
	const { state } = await runGraph({
		nodes: { a: slow("a"), b: slow("b"), done: async () => ({}) },
		edges: { a: parallel(["b"], "done"), done: null },
		start: "a",
		reducers: { log: (old = [], add) => [...old, ...add] },
	});
	assert.deepEqual(state.log, ["a", "b"]);

	events.length = 0;
	await runGraph({
		nodes: { s: async () => ({}), p: slow("p"), q: slow("q"), r: slow("r") },
		edges: { s: parallel(["p", "q", "r"], null) },
		start: "s",
		reducers: { log: (old = [], add) => [...old, ...add] },
	});
	// every branch started before any finished = truly concurrent
	assert.deepEqual(events.slice(0, 3).sort(), ["start p", "start q", "start r"]);
});

test("maxSteps stops an infinite loop", async () => {
	await assert.rejects(
		runGraph({ nodes: { a: async () => ({}) }, edges: { a: "a" }, start: "a", maxSteps: 5 }),
		/exceeded 5 steps/,
	);
});

test("unknown node is a clear error", async () => {
	await assert.rejects(runGraph({ nodes: { a: async () => ({}) }, edges: { a: "nope" }, start: "a" }), /unknown node "nope"/);
});

// ---- content research graph ------------------------------------------------

function fakeDeps(over = {}) {
	const saved = [];
	return {
		saved,
		loadSiteContext: async () => ({ siteContext: { origin: "https://x.test", themes: ["t"] }, warnings: ["site-warn"] }),
		researchKeywords: async () => ({ keywords: [{ keyword: "next.js", source: "suggest" }], warnings: [] }),
		researchReddit: async () => ({ reddit: [{ title: "Q", url: "https://r/1" }], warnings: [] }),
		searchInternalArticles: async () => ({ internalArticles: [{ title: "A", url: "https://x/a" }], warnings: [] }),
		researchExternalReferences: async () => ({ externalReferences: [{ url: "https://e/1", domain: "e" }], warnings: [] }),
		generateContentIdeas: async () => ({ contentIdeas: [{ title: "Idea" }], usage: { total_tokens: 5 }, model: "m" }),
		saveRun: async (d) => saved.push(["run", d.id]),
		saveCalendarIdeas: async (id) => saved.push(["cal", id]),
		...over,
	};
}

test.beforeEach(() => { process.env.OPENROUTER_API_KEY = "k"; });

test("happy path returns the same shape as runContentResearch and saves", async () => {
	const deps = fakeDeps();
	const r = await runContentResearchGraph({ topic: " Next.js " }, { deps });
	assert.equal(r.success, true);
	assert.equal(r.topic, "Next.js");
	assert.ok(r.runId);
	assert.deepEqual(Object.keys(r.research).sort(), ["external_references", "internal_articles", "keywords", "reddit", "site_context"]);
	assert.equal(r.content_ideas.length, 1);
	assert.deepEqual(r.usage, { total_tokens: 5 });
	assert.equal(r.meta.keyword_count, 1);
	assert.deepEqual(r.warnings, ["site-warn"]);
	assert.deepEqual(deps.saved.map((x) => x[0]), ["run", "cal"]);
	assert.deepEqual(r.meta.trace.map((t) => t.node).slice(0, 2), ["loadSite", "keywords"]);
	assert.equal(r.meta.trace.at(-1).node, "finish");
});

test("one failing provider becomes a warning, run continues", async () => {
	const r = await runContentResearchGraph(
		{ topic: "x" },
		{ deps: fakeDeps({ researchReddit: async () => { throw new Error("reddit down"); } }) },
	);
	assert.equal(r.success, true);
	assert.ok(r.warnings.includes("Reddit research failed: reddit down"));
	assert.equal(r.meta.reddit_result_count, 0);
});

test("nothing found stops before the LLM with RESEARCH_EMPTY", async () => {
	let llmCalled = false;
	const none = (k) => async () => ({ [k]: [], warnings: [] });
	const r = await runContentResearchGraph(
		{ topic: "x" },
		{
			deps: fakeDeps({
				researchKeywords: none("keywords"),
				researchReddit: none("reddit"),
				searchInternalArticles: none("internalArticles"),
				researchExternalReferences: none("externalReferences"),
				generateContentIdeas: async () => { llmCalled = true; return {}; },
			}),
		},
	);
	assert.equal(r.success, false);
	assert.equal(r.error.code, "RESEARCH_EMPTY");
	assert.equal(r.research, undefined);
	assert.equal(llmCalled, false);
});

test("missing OpenRouter key returns MISSING_OPENROUTER_KEY with research attached", async () => {
	delete process.env.OPENROUTER_API_KEY;
	const r = await runContentResearchGraph({ topic: "x" }, { deps: fakeDeps() });
	assert.equal(r.error.code, "MISSING_OPENROUTER_KEY");
	assert.equal(r.research.keywords.length, 1);
});

test("LLM failure returns LLM_FAILED and does not save", async () => {
	const deps = fakeDeps({ generateContentIdeas: async () => { throw new Error("rate limited"); } });
	const r = await runContentResearchGraph({ topic: "x" }, { deps });
	assert.equal(r.error.code, "LLM_FAILED");
	assert.equal(r.error.message, "rate limited");
	assert.equal(deps.saved.length, 0);
});

test("save failure is only a warning; ideas are still returned", async () => {
	const r = await runContentResearchGraph(
		{ topic: "x" },
		{ deps: fakeDeps({ saveRun: async () => { throw new Error("firestore down"); } }) },
	);
	assert.equal(r.success, true);
	assert.equal(r.content_ideas.length, 1);
	assert.ok(r.warnings.includes("Firestore save failed: firestore down"));
});
