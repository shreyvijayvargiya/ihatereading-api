/**
 * DataForSEO API client — keyword + SERP data only.
 * Env: DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD
 */

const BASE = "https://api.dataforseo.com/v3";

function credentials() {
	const login = process.env.DATAFORSEO_LOGIN?.trim();
	const password = process.env.DATAFORSEO_PASSWORD?.trim();
	if (!login || !password) {
		throw new Error("DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are required");
	}
	const token = Buffer.from(`${login}:${password}`).toString("base64");
	return { login, password, authorization: `Basic ${token}` };
}

async function dfsPost(path, payload, { timeoutMs = 120_000 } = {}) {
	const { authorization } = credentials();
	const res = await fetch(`${BASE}${path}`, {
		method: "POST",
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			Authorization: authorization,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(Array.isArray(payload) ? payload : [payload]),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(
			data.status_message || data.message || `DataForSEO HTTP ${res.status}`,
		);
	}
	if (data.status_code && data.status_code !== 20000) {
		throw new Error(data.status_message || `DataForSEO status ${data.status_code}`);
	}
	return data;
}

function firstTaskResult(data) {
	const task = data.tasks?.[0];
	if (!task) return null;
	if (task.status_code && task.status_code !== 20000) {
		throw new Error(task.status_message || `Task failed ${task.status_code}`);
	}
	return task.result?.[0] ?? null;
}

/**
 * Seed + volume keywords for a domain / niche phrase.
 */
export async function fetchKeywordSuggestions(seed, { locationCode = 2356, languageCode = "en" } = {}) {
	const data = await dfsPost("/dataforseo_labs/google/keyword_suggestions/live", {
		keyword: seed,
		location_code: locationCode,
		language_code: languageCode,
		include_seed_keyword: true,
		limit: 40,
	});
	const result = firstTaskResult(data);
	const items = result?.items || [];
	return items.map((item) => ({
		keyword: item.keyword || item.keyword_data?.keyword || seed,
		volume: item.keyword_info?.search_volume ?? item.search_volume ?? null,
		difficulty:
			item.keyword_properties?.keyword_difficulty ??
			item.keyword_difficulty ??
			null,
		intent: inferIntent(item.keyword || seed),
		cluster: clusterFromKeyword(item.keyword || seed),
		source: "dataforseo",
	}));
}

/**
 * Google organic SERP — competitors + ranking URLs.
 */
export async function fetchGoogleSerp(keyword, { locationCode = 2356, languageCode = "en", depth = 10 } = {}) {
	const data = await dfsPost("/serp/google/organic/live/advanced", {
		keyword,
		location_code: locationCode,
		language_code: languageCode,
		depth,
	});
	const result = firstTaskResult(data);
	const items = result?.items || [];
	return items
		.filter((it) => it.type === "organic" && it.url)
		.map((it) => ({
			competitorDomain: domainFromUrl(it.url),
			rankingKeyword: keyword,
			theirUrl: it.url,
			url: it.url,
			link: it.url,
			title: it.title || null,
			description: it.description || null,
			snippet: it.description || null,
			position: it.rank_absolute ?? it.rank_group ?? null,
			source: "dataforseo",
		}));
}

/** True when DataForSEO credentials are configured */
export function hasDataForSeoCredentials() {
	return Boolean(
		process.env.DATAFORSEO_LOGIN?.trim() &&
			process.env.DATAFORSEO_PASSWORD?.trim(),
	);
}

/** Map country ISO → DataForSEO location_code (common set) */
export function dataForSeoLocationCode(countryCode = "in") {
	const map = {
		in: 2356,
		us: 2840,
		uk: 2826,
		gb: 2826,
		ae: 2784,
		sg: 2702,
		au: 2036,
		ca: 2124,
		de: 2276,
		nl: 2528,
	};
	return map[String(countryCode || "in").toLowerCase()] || 2356;
}

function domainFromUrl(url) {
	try {
		return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
	} catch {
		return "";
	}
}

function inferIntent(keyword) {
	const k = String(keyword).toLowerCase();
	if (/^(how|why|what|when|where|can|does|is|are)\b/.test(k)) return "informational";
	if (/\b(vs|versus|compare|alternative|best|top)\b/.test(k)) return "commercial";
	if (/\b(buy|price|cost|demo|trial|signup|subscribe)\b/.test(k)) return "transactional";
	return "informational";
}

function clusterFromKeyword(keyword) {
	const k = String(keyword).toLowerCase().trim();
	const words = k.split(/\s+/).slice(0, 2);
	return words.join(" ") || "general";
}

export { inferIntent, clusterFromKeyword, domainFromUrl };
