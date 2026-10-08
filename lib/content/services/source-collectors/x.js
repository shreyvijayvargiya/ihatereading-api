import { runGoogleQueries } from "./utils.js";

function ensureXQuery(q) {
	const s = String(q || "").trim();
	if (!s) return "";
	if (/site:\s*(x\.com|twitter\.com)/i.test(s)) return s;
	return `site:x.com ${s}`;
}

/**
 * @param {{ xQueries?: string[] }} plan
 */
export async function collectXSignals(plan, opts = {}) {
	const queries = (plan.xQueries || []).map(ensureXQuery).filter(Boolean);
	if (!queries.length) return { channel: "x", signals: [], errors: [], count: 0 };

	const { signals, errors } = await runGoogleQueries(queries, {
		baseUrl: opts.baseUrl,
		num: opts.numPerQuery || 6,
		channel: "x",
	});

	const filtered = signals.filter((s) => /(?:^|\/\/)(?:www\.)?(x\.com|twitter\.com)/i.test(s.url));
	return {
		channel: "x",
		signals: filtered,
		errors,
		count: filtered.length,
	};
}
