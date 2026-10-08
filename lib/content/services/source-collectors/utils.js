import { googleSearch } from "../../../contentResearch/http.js";
import { dedupeByUrl, normalizeUrl, urlDomain } from "../../utils.js";

export async function runGoogleQueries(queries, { baseUrl, num = 6, channel = "web" }) {
	const signals = [];
	const errors = [];
	const unique = [...new Set(queries.map((q) => String(q).trim()).filter(Boolean))];

	const settled = await Promise.allSettled(
		unique.map((query) => googleSearch(query, { baseUrl, num })),
	);

	for (let i = 0; i < settled.length; i++) {
		const query = unique[i];
		const r = settled[i];
		if (r.status !== "fulfilled") {
			errors.push({ query, channel, error: r.reason?.message || String(r.reason) });
			continue;
		}
		for (const row of r.value || []) {
			const url = normalizeUrl(row.url || row.link || "");
			if (!url) continue;
			signals.push({
				query,
				title: String(row.title || "").trim(),
				url,
				snippet: String(row.snippet || row.description || "").trim(),
				content: "",
				sourceType: channel,
				domain: urlDomain(url),
			});
		}
	}

	return { signals: dedupeByUrl(signals), errors };
}

export function mergeSignalLists(lists) {
	const map = new Map();
	for (const list of lists) {
		for (const s of list || []) {
			if (!s?.url) continue;
			const prev = map.get(s.url);
			if (!prev) {
				map.set(s.url, s);
				continue;
			}
			map.set(s.url, {
				...prev,
				title: prev.title || s.title,
				snippet: prev.snippet || s.snippet,
				content: prev.content || s.content,
				sourceType: prev.sourceType || s.sourceType,
			});
		}
	}
	return [...map.values()];
}
