/** Hardcoded subreddits for saascrm.site CRM monitor */
export const SUBREDDITS = [
	"SaaS",
	"CRM",
	"nextjs",
	"webdev",
	"Entrepreneur",
	"smallbusiness",
];

export const PRODUCT_CONTEXT = `
Product: saascrm.site — customizable CRM built on Next.js + shadcn/ui, sold as a template/boilerplate developers and small businesses can deploy and customize themselves.
Solves: needing a CRM without building one from scratch or paying for a bloated SaaS with monthly fees.
Look for: people asking about CRM alternatives, complaining about existing CRM tools (cost, bloat, customization), asking how to build a CRM, freelancers/agencies needing a white-label client CRM.
`.trim();

export const RELEVANCE_MIN = 4;

export const SONAR_MODEL =
	process.env.REDDIT_CLAUDE_SONNET ||
	process.env.OPENROUTER_MODEL ||
	"anthropic/claude-sonnet-4";

export const REDDIT_POSTS_COLL = "redditPosts";
export const REDDIT_DRAFTS_COLL = "redditDrafts";
