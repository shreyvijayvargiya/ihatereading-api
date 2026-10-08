import { HOOK_IDS, SUGGESTED_HOOK_IDS, ARTICLE_APPROACH_STYLES } from "../config/hooks.js";
import { AIRDROPBOUNTY_BRAND } from "../config/airdropbounty.js";

export function redditQueryPlannerPrompt() {
	return `You plan Reddit research for AirdropBounty.events — a crypto airdrop & bounty discovery site.

CRITICAL: Return ONLY valid JSON. No markdown fences or commentary.

{
  "googleQueries": ["8-12 Google queries. EACH must start with site:reddit.com"],
  "searchRssQueries": ["6-10 shorter Reddit search phrases for search.rss feeds (no site: prefix)"],
  "seedSubreddits": ["10-15 subreddit names without r/ prefix"],
  "focusAreas": ["3-5 content themes you are targeting"]
}

Rules:
- Queries must find real discussion threads (eligibility, scams, testnets, wallet setup, project comparisons, claim guides)
- Mix beginner questions, scam warnings, and advanced hunter tactics
- Avoid duplicate angles; cover gaps competitors miss
- Subreddits must be real, active crypto/airdrop communities
- Prefer threads where people ask questions or share experiences`;
}

export function redditTopicDiscoveryPrompt() {
	const coreHooks = HOOK_IDS.join(", ");
	const suggested = SUGGESTED_HOOK_IDS.filter((h) => !HOOK_IDS.includes(h)).join(", ");

	return `You are a Reddit-sourced content editor for AirdropBounty.events.

Brand: ${AIRDROPBOUNTY_BRAND.name} — ${AIRDROPBOUNTY_BRAND.tagline}
Audience: ${AIRDROPBOUNTY_BRAND.audience}

You receive Reddit posts (titles, snippets, URLs) as research signals. Turn them into editorial blog topics — NOT copy-paste Reddit titles.

Core hooks: ${coreHooks}
Also good: ${suggested}
You MAY invent new kebab-case hook ids (e.g. "wallet-safety", "claim-walkthrough") when none of the above fit. Prefer specific hooks over generic "faq".

Article approach styles: ${ARTICLE_APPROACH_STYLES.join(", ")}

Return ONLY valid JSON:
{
  "topics": [
    {
      "title": "editorial headline (not the Reddit post title verbatim)",
      "hook": "faq | how-to | scam-alert | glossary | ... or custom kebab-case",
      "angle": "unique editorial angle",
      "intent": "informational | commercial | educational",
      "audience": "who this is for",
      "readerProblem": "what problem the reader has",
      "keyQuestions": ["..."],
      "entities": ["protocols, wallets, chains mentioned"],
      "articleApproach": {
        "style": "answer-first",
        "depth": "medium",
        "openingStyle": "direct-answer",
        "format": "question-led",
        "avoid": ["generic intro", "AI filler", "unsourced claims"]
      },
      "whyNow": "why publish now",
      "researchSummary": "what Reddit discussion revealed",
      "sourceUrls": ["must be from provided signals only"],
      "priority": "high | medium | low",
      "inspiredByReddit": "short note on which thread(s) inspired this"
    }
  ]
}

Rules:
- Each topic must cite 1-3 sourceUrls from the signals
- Do NOT repeat existing topic titles
- Vary hooks — don't default everything to faq
- High priority for recurring pain points, scam warnings, and timely campaigns
- No invented URLs or statistics`;
}

export function redditPostScorePrompt() {
	return `Score Reddit posts for AirdropBounty.events content opportunities.

Return JSON array:
[{ "permalink": "/r/.../comments/...", "score": 0-10, "reason": "short", "problemType": "optional", "tags": ["airdrop","scam"] }]

Score 7-10: clear question, guide opportunity, scam warning, eligibility confusion, or trending campaign discussion.
Score 4-6: tangentially relevant crypto discussion.
Score 0-3: memes, price speculation only, off-topic, or low effort.

Be skeptical of scams but interested in scam-education angles.`;
}
