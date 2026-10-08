import { runGoogleQueries } from "./utils.js";

/**
 * @param {{ webQueries?: string[] }} plan
 */
export async function collectWebSignals(plan, opts = {}) {
	const queries = (plan.webQueries || []).filter(Boolean);
	if (!queries.length) return { channel: "web", signals: [], errors: [], count: 0 };

	const { signals, errors } = await runGoogleQueries(queries, {
		baseUrl: opts.baseUrl,
		num: opts.numPerQuery || 6,
		channel: "web",
	});

	const filtered = signals.filter(
		(s) =>
			!/reddit\.com|linkedin\.com|twitter\.com|x\.com/i.test(s.url),
	);

	return {
		channel: "web",
		signals: filtered,
		errors,
		count: filtered.length,
	};
}
