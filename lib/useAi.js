/**
 * Opt-in OpenRouter for scrape agents. Default is scrape-only.
 *
 *   CLI:  --use-ai  (aliases: --useAI, --llm)
 *         --model <openrouter-id>
 *   HTTP: { "useAI": true, "model": "..." }  or  ?useAI=1&model=...
 *   Env:  USE_AI=1   OPENROUTER_MODEL=google/gemini-2.0-flash-exp:free
 */

export const DEFAULT_AGENT_LLM_MODEL = "google/gemini-2.0-flash-exp:free";

function flagOn(v) {
	return v === true || v === 1 || v === "1" || v === "true" || v === "yes";
}

export function resolveAgentLlmModel(explicit) {
	const s = String(explicit || "").trim();
	if (s) return s;
	const env = String(process.env.OPENROUTER_MODEL || "").trim();
	if (env) return env;
	return DEFAULT_AGENT_LLM_MODEL;
}

export function cliFlagValue(args = [], names = []) {
	for (const name of names) {
		const hit = args.find((a) => a.startsWith(`${name}=`));
		if (hit) return hit.slice(name.length + 1).trim();
		const i = args.indexOf(name);
		if (i !== -1) {
			const next = args[i + 1];
			if (next && !String(next).startsWith("-")) return String(next).trim();
		}
	}
	return "";
}

export function cliLlmModel(args = []) {
	return cliFlagValue(args, ["--model", "--llm-model"]);
}

export function isUseAiOn(opts = {}) {
	if (opts.useAI === true || opts.useAi === true || opts.llm === true) return true;
	if (opts.useAI === false || opts.useAi === false || opts.llm === false) return false;
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

export function wantModelFromRequest(body = {}, query = {}) {
	return String(
		body.model || body.llmModel || query.model || query.llmModel || "",
	).trim();
}

export function cliWantsUseAi(args = []) {
	return (
		args.includes("--use-ai") ||
		args.includes("--useAI") ||
		args.includes("--llm")
	);
}

export function useAiOpts(useAI, model) {
	if (!useAI) return {};
	return {
		useAI: true,
		llm: true,
		model: resolveAgentLlmModel(model),
	};
}

/** One helper for every scrape CLI: `--use-ai` / `--llm` plus optional `--model`. */
export function cliAiOpts(args = []) {
	return useAiOpts(cliWantsUseAi(args), cliLlmModel(args));
}

/** Reddit CLIs also treat `--enrich` as LLM-on (not used by England listing `--enrich`). */
export function cliRedditAiOpts(args = []) {
	return useAiOpts(
		cliWantsUseAi(args) || args.includes("--enrich"),
		cliLlmModel(args),
	);
}

export function requestAiOpts(body = {}, query = {}) {
	return useAiOpts(
		wantUseAiFromRequest(body, query),
		wantModelFromRequest(body, query),
	);
}

export function hasOpenRouterKey() {
	return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}
