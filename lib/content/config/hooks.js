/**
 * Five editorial content hooks for the Content Intelligence system.
 */

export const HOOK_IDS = [
	"glossary",
	"faq",
	"explainer",
	"comparison",
	"alternative",
];

export const HOOKS = {
	glossary: {
		id: "glossary",
		name: "Glossary",
		purpose:
			"Explain an important term that the target audience encounters.",
		triggers: [
			"unfamiliar terminology",
			"recurring term",
			"industry phrase",
			"protocol/product/concept that deserves explanation",
		],
		structure: [
			"Direct definition",
			"Why the term exists",
			"How it works",
			"Real-world example",
			"Related concepts",
			"Common misunderstanding",
			"Practical takeaway",
		],
		avoid: [
			"generic 500-word definitions",
			"repeating the same definition throughout the article",
			"unnecessary introduction",
		],
	},
	faq: {
		id: "faq",
		name: "FAQ",
		purpose: "Answer a question people are actively asking.",
		triggers: [
			"Reddit question",
			"search query",
			"question-shaped Google result",
			"recurring user problem",
			'"how do I..."',
			'"is X..."',
			'"why does X..."',
			'"can I..."',
		],
		structure: [
			"Direct answer first",
			"Explanation",
			"Example",
			"Important caveat",
			"Related questions",
			"Practical takeaway",
		],
		avoid: [
			"generic article converted into a question",
			"burying the answer below filler",
		],
	},
	explainer: {
		id: "explainer",
		name: "Explainer",
		purpose:
			"Explain a recurring subject that deserves a larger pillar article.",
		triggers: [
			"subject appears across multiple sources",
			"significant current discussion",
			"important concept for the site's audience",
			"topic can become a pillar article",
		],
		structure: [
			"Problem/context",
			"What it is",
			"How it works",
			"Why it matters",
			"Examples",
			"Practical use",
			"Common mistakes",
			"Further reading",
		],
		avoid: ["shallow listicles", "surface-level summaries"],
	},
	comparison: {
		id: "comparison",
		name: "Comparison",
		purpose:
			"Help users understand meaningful differences between two or more options.",
		triggers: [
			"X vs Y",
			"X or Y",
			"product comparisons",
			"platform comparisons",
			"competing approaches",
			"users asking which option fits their situation",
		],
		structure: [
			"Why people compare them",
			"Option A",
			"Option B",
			"Important differences",
			"Use cases",
			"Trade-offs",
			"Practical scenarios",
			"FAQ / decision guidance",
		],
		avoid: [
			"arbitrary winner",
			"biased verdict without evidence",
			"invented competitor claims",
		],
	},
	alternative: {
		id: "alternative",
		name: "Alternative",
		purpose:
			"Help users exploring alternatives to a product, platform, service or approach.",
		triggers: [
			'"alternative to X"',
			"competitor mentions",
			"complaints about an existing product",
			"users looking for another solution",
		],
		structure: [
			"What the original product does",
			"Why users look for alternatives",
			"What to consider",
			"Alternative options",
			"Differences",
			"Use cases",
			"Trade-offs",
			"FAQ",
		],
		avoid: ["invented competitor claims", "unsupported negative claims"],
	},
};

export const ARTICLE_APPROACH_STYLES = [
	"answer-first",
	"practical",
	"beginner-friendly",
	"misconception-led",
	"comparison-led",
	"troubleshooting",
	"example-led",
	"data-led",
	"step-by-step",
	"expert-explanation",
];

export const TOPIC_STATUSES = [
	"pending",
	"approved",
	"rejected",
	"generating",
	"generated",
	"needs_edit",
];

export const SUGGESTED_HOOK_IDS = [
	...HOOK_IDS,
	"how-to",
	"scam-alert",
	"news",
	"checklist",
	"case-study",
	"roundup",
	"tool-review",
	"eligibility",
	"warning",
];

export function isValidHook(hook) {
	const raw = String(hook || "").trim();
	if (!raw) return false;
	const n = normalizeHook(raw);
	if (HOOK_IDS.includes(n)) return true;
	const slug = raw
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/^-+|-+$/g, "");
	return n === slug && slug.length >= 2;
}

/** Built-in hook or custom kebab-case editorial hook slug. */
export function normalizeHook(hook) {
	const h = String(hook || "faq")
		.toLowerCase()
		.trim()
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/^-+|-+$/g, "");
	if (HOOK_IDS.includes(h)) return h;
	if (h.length >= 2 && h.length <= 40 && /^[a-z][a-z0-9-]*$/.test(h)) return h;
	return "faq";
}

export function hookPromptBlock(hookId) {
	const hook = HOOKS[hookId];
	if (!hook) return "";
	return `Hook: ${hook.name}
Purpose: ${hook.purpose}
Suggested structure: ${hook.structure.join(" → ")}
Avoid: ${hook.avoid.join("; ")}`;
}
