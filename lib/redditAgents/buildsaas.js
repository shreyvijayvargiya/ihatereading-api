/**
 * BuildSaaS (buildsaas.dev) — Reddit monitor for boilerplate / starter-kit buyers.
 * Google site:reddit.com + seed RSS. CLI / POST only — not on npm run dev.
 */

import { runGooglePlusRssAgent } from "./saasProblems.js";

export async function runBuildsaasAgent(opts = {}) {
	return runGooglePlusRssAgent("buildsaas", opts);
}
