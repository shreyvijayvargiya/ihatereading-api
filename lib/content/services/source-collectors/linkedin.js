import { runGoogleQueries } from "./utils.js";

function ensureLinkedInQuery(q) {
	const s = String(q || "").trim();
	if (!s) return "";
	if (/site:\s*linkedin\.com/i.test(s)) return s;
	return `site:linkedin.com ${s}`;
}

/**
 * @param {{ linkedinQueries?: string[] }} plan
 */
export async function collectLinkedInSignals(plan, opts = {}) {
	const queries = (plan.linkedinQueries || []).map(ensureLinkedInQuery).filter(Boolean);
	if (!queries.length) return { channel: "linkedin", signals: [], errors: [], count: 0 };

	const { signals, errors } = await runGoogleQueries(queries, {
		baseUrl: opts.baseUrl,
		num: opts.numPerQuery || 6,
		channel: "linkedin",
	});

	const filtered = signals.filter((s) => /linkedin\.com/i.test(s.url));
	return {
		channel: "linkedin",
		signals: filtered,
		errors,
		count: filtered.length,
	};
}
