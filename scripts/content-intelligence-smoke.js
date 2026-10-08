#!/usr/bin/env node
/**
 * Smoke tests for Content Intelligence (no live OpenRouter unless OPENROUTER_API_KEY set).
 * Run: node scripts/content-intelligence-smoke.js
 */

import { HOOK_IDS, isValidHook } from "../lib/content/config/hooks.js";
import { validateLinks } from "../lib/content/services/link-validator.js";
import { validateArticle } from "../lib/content/services/article-validator.js";
import { isDuplicateTopic } from "../lib/content/services/firestore.js";
import { makeSiteId, titleSimilarity } from "../lib/content/utils.js";

let passed = 0;
let failed = 0;

function assert(name, cond) {
	if (cond) {
		passed += 1;
		console.log(`✓ ${name}`);
	} else {
		failed += 1;
		console.error(`✗ ${name}`);
	}
}

assert("five hooks defined", HOOK_IDS.length === 5);
assert("faq is valid hook", isValidHook("faq"));
assert("site id from domain", makeSiteId("Test", "https://airdropbounty.events") === "airdropbounty-events");
assert(
	"title similarity detects overlap",
	titleSimilarity("DeFi Explained Guide", "DeFi Explained Complete Guide") >= 0.5,
);
assert(
	"duplicate topic rejected (exact title)",
	isDuplicateTopic({ title: "What is DeFi?" }, [{ title: "What is DeFi?" }], []),
);
assert(
	"duplicate topic rejected (similar title)",
	isDuplicateTopic(
		{ title: "DeFi Explained Complete Beginner Guide" },
		[{ title: "DeFi Explained: Complete Beginner Guide" }],
		[],
	),
);

const internalCandidates = [{ title: "Home", url: "https://example.com/" }];
const externalCandidates = [{ title: "Source", url: "https://docs.example.com/page" }];
const linkResult = validateLinks(
	{
		internalLinks: [
			{ title: "Home", url: "https://example.com/", anchorText: "home" },
			{ title: "Fake", url: "https://example.com/invented", anchorText: "nope" },
		],
		externalLinks: [
			{ title: "Source", url: "https://docs.example.com/page", anchorText: "docs" },
			{ title: "Bad", url: "https://evil.com/x", anchorText: "bad" },
		],
	},
	internalCandidates,
	externalCandidates,
);
assert("invented internal link removed", linkResult.internalLinks.length === 1);
assert("invented external link removed", linkResult.externalLinks.length === 1);

const validation = validateArticle(
	{
		title: "Test Article",
		description: "A test description for SEO.",
		slug: "test-article",
		hook: "faq",
		content: [
			"Opening paragraph explains the reader problem in plain language with enough detail to exceed minimum length requirements for publishing.",
			"Second paragraph adds a concrete example, a practical takeaway, and one sentence on why this matters for the target audience right now.",
			"Third paragraph covers an important caveat, related questions the audience might ask next, and a short closing recommendation without filler.",
		].join("\n\n"),
	},
	{ issues: [] },
);
assert("article validates", validation.valid);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
