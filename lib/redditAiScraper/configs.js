/**
 * Generic Reddit scraper — one agent, any topic via prompt.
 * Default: Google + RSS scrape-only. OpenRouter plan/score is opt-in (`--llm`).
 */

export const REDDIT_AI_SCRAPER = {
	id: "reddit-ai-scraper",
	name: "Reddit AI scraper",
	collection: "redditAiScraperPosts",
	topicsCollection: "redditAiScraperTopics",
	relevanceMin: 4,
	maxSubs: Number(process.env.REDDIT_AI_SCRAPER_MAX_SUBS || "20"),
	subsPerRun: Number(process.env.REDDIT_AI_SCRAPER_SUBS_PER_RUN || "10"),
	queriesPerRun: Number(process.env.REDDIT_AI_SCRAPER_QUERIES_PER_RUN || "5"),
};

export function sanitizeTopicId(raw) {
	const s = String(raw || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
	return s.length >= 2 ? s : "topic";
}

export function buildScorePrompt(plan) {
	const goal = plan?.goal || plan?.topicName || "the user's research goal";
	const keep = plan?.keepCriteria || "posts that match the research goal";
	const reject = plan?.rejectCriteria || "off-topic, memes, homework with no real need";
	return `You score Reddit posts for this research goal:
${goal}

KEEP: ${keep}
REJECT: ${reject}

Score 1-5:
5 = exact match with clear need / problem / hiring / looking-for
4 = strong related pain
3 = weak adjacent
1-2 = not a fit

Also set:
- "problemType": short label
- "intent": hire | buy_tool | diy | complain | research | other
- "tags": string[] (max 6)
- "solutionFit": one line how this post helps the goal
- "summary": one sentence of the post
- "reason": short

Return ONLY JSON:
{ "results": [{ "permalink": "/r/...", "score": 0, "reason": "", "problemType": "", "intent": "", "tags": [], "solutionFit": "", "summary": "" }] }
Include every post. Use exact permalinks.`;
}
