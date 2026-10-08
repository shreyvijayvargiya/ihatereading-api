import { HOOK_IDS, SUGGESTED_HOOK_IDS, ARTICLE_APPROACH_STYLES } from "../config/hooks.js";
import { AGENT37_BRAND } from "../config/agent37.js";

export function agent37QueryPlannerPrompt() {
	return `You plan multi-channel research for Agent37.com — AI agents, orchestration, and developer tooling.

CRITICAL: Return ONLY valid JSON. No markdown fences.

{
  "redditQueries": ["6-10 queries, each MUST start with site:reddit.com"],
  "linkedinQueries": ["5-8 queries with site:linkedin.com (posts, pulse, or /in)"],
  "xQueries": ["5-8 queries with site:x.com OR site:twitter.com"],
  "webQueries": ["6-10 general web queries WITHOUT site: prefix — blogs, docs, news"],
  "redditSearchRss": ["4-6 short Reddit search phrases for search.rss (no site: prefix)"],
  "seedSubreddits": ["8-12 subreddit names without r/"],
  "focusAreas": ["3-5 content themes"]
}

Rules:
- Cover: agent frameworks, MCP, tool calling, multi-agent systems, deployment, observability, costs
- Reddit/X: pain points, questions, hot takes, launch threads
- LinkedIn: founder/engineer posts about AI agents in production
- Web: tutorials, comparisons, release notes, competitor blogs
- No duplicate angles`;
}

export function agent37TopicDiscoveryPrompt() {
	const core = HOOK_IDS.join(", ");
	const extra = SUGGESTED_HOOK_IDS.filter((h) => !HOOK_IDS.includes(h)).join(", ");

	return `You are a content editor for Agent37.com.

Brand: ${AGENT37_BRAND.name} — ${AGENT37_BRAND.tagline}
Audience: ${AGENT37_BRAND.audience}

Turn research signals (Reddit, LinkedIn, X, web) into editorial blog topics — not copy-paste titles.

Core hooks: ${core}
Also good: ${extra}, tutorial, architecture, troubleshooting, launch-notes
Invent kebab-case hook ids when needed (e.g. "mcp-guide", "agent-pattern").

Article styles: ${ARTICLE_APPROACH_STYLES.join(", ")}

Return ONLY JSON:
{
  "topics": [{
    "title": "...",
    "hook": "faq | how-to | explainer | ...",
    "angle": "...",
    "intent": "informational",
    "audience": "...",
    "readerProblem": "...",
    "keyQuestions": ["..."],
    "entities": ["frameworks, tools, protocols"],
    "articleApproach": {
      "style": "practical",
      "depth": "medium",
      "openingStyle": "problem-first",
      "format": "step-by-step",
      "avoid": ["hype", "unsourced claims"]
    },
    "whyNow": "...",
    "researchSummary": "...",
    "sourceUrls": ["from signals only"],
    "priority": "high | medium | low",
    "signalChannels": ["reddit", "linkedin", "x", "web"]
  }]
}

Rules:
- sourceUrls must exist in provided signals
- Vary hooks; don't default everything to faq
- Prefer topics with cross-channel validation when possible
- No invented URLs`;
}
