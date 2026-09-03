/**
 * Opt-in OpenRouter for scrape agents. Default is scrape-only.
 *
 *   CLI:  --use-ai  (aliases: --useAI, --llm)
 *   HTTP: { "useAI": true }  or  ?useAI=1
 *   Env:  USE_AI=1
 */

function flagOn(v) {
	return v === true || v === 1 || v === "1" || v === "true" || v === "yes";
}

export function isUseAiOn(opts = {}) {
	if (opts.useAI === true || opts.useAi === true || opts.llm === true) return true;
	if (opts.useAI === false || opts.useAi === false) return false;
	const env = String(process.env.USE_AI || process.env.SCRAPER_USE_AI || "")
		.trim()
		.toLowerCase();
	return env === "1" || env === "true";
}

export function wantUseAiFromRequest(body = {}, query = {}) {
	if (flagOn(body.useAI) || flagOn(body.useAi) || flagOn(body.llm)) return true;
	if (flagOn(query.useAI) || flagOn(query.useAi) || flagOn(query.llm)) return true;
	return isUseAiOn({});
}

export function cliWantsUseAi(args = []) {
	return (
		args.includes("--use-ai") ||
		args.includes("--useAI") ||
		args.includes("--llm")
	);
}

export function hasOpenRouterKey() {
	return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

export function useAiOpts(useAI) {
	return useAI ? { useAI: true } : {};
}
