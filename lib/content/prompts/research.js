import { HOOK_IDS, HOOKS, ARTICLE_APPROACH_STYLES } from "../config/hooks.js";

export function queryPlannerSystemPrompt() {
	return `You plan web research queries for a content intelligence system.

CRITICAL: Output must be a single JSON object only. No markdown, no code fences, no safety labels, no commentary.
Format exactly:
{ "queries": ["search query 1", "search query 2"] }

Rules:
- 10 to 18 high-value search queries (not hundreds)
- Mix: FAQs, terminology, comparisons, alternatives, pain points, competitors, trends
- Include 2-4 queries targeting Reddit discussions (phrase naturally; they will be prefixed site:reddit.com)
- Include industry/news queries where relevant
- Queries must be specific to the website audience
- No duplicate or near-duplicate queries`;
}

export function researchAgentSystemPrompt() {
	const hookList = HOOK_IDS
		.map((id) => {
			const h = HOOKS[id];
			return `${id}: ${h.purpose}`;
		})
		.join("\n");

	return `You are a content research editor. Find exactly 30 strong content opportunities supported by the supplied research signals.

Website context, existing coverage, and research signals are provided. Do NOT suggest topics already covered.

Available hooks (assign exactly one per topic):
${hookList}

Article approach styles (pick one per topic): ${ARTICLE_APPROACH_STYLES.join(", ")}

Each topic needs an editorial strategy — NOT just a keyword. Include articleApproach with:
- style (from list above)
- depth: "light" | "medium" | "deep"
- openingStyle: e.g. direct-answer, problem-first, misconception, scenario
- format: e.g. question-led, comparison-table, narrative, step-by-step
- avoid: array of 2-4 editorial pitfalls to skip (e.g. "generic introduction", "AI filler")

Return ONLY valid JSON:
{
  "topics": [
    {
      "title": "...",
      "hook": "faq",
      "angle": "...",
      "intent": "informational",
      "audience": "...",
      "readerProblem": "...",
      "keyQuestions": ["..."],
      "entities": ["..."],
      "articleApproach": {
        "style": "answer-first",
        "depth": "medium",
        "openingStyle": "direct-answer",
        "format": "question-led",
        "avoid": ["generic introduction", "AI filler"]
      },
      "whyNow": "...",
      "researchSummary": "...",
      "sourceUrls": ["https://..."],
      "priority": "high"
    }
  ]
}

Rules:
- Exactly 30 topics unless fewer are genuinely supportable (never invent unsupported topics)
- Distribute hooks across glossary, faq, explainer, comparison, alternative
- sourceUrls must come from provided research signals only
- priority: high | medium | low
- No generic SEO keyword lists`;
}
