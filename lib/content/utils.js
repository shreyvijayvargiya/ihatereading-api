/**
 * Shared helpers for Content Intelligence.
 */

export function log(step, detail = "") {
	const msg = detail ? `[CONTENT] ${step} — ${detail}` : `[CONTENT] ${step}`;
	console.log(msg);
}

export function normalizeDomain(domain) {
	let d = String(domain || "").trim();
	if (!d) return "";
	if (!/^https?:\/\//i.test(d)) d = `https://${d}`;
	try {
		const u = new URL(d);
		return u.origin;
	} catch {
		return d.replace(/\/$/, "");
	}
}

export function domainHost(domain) {
	try {
		return new URL(normalizeDomain(domain)).hostname.replace(/^www\./, "");
	} catch {
		return String(domain || "")
			.replace(/^https?:\/\//, "")
			.replace(/^www\./, "")
			.split("/")[0]
			.toLowerCase();
	}
}

/** Safe Firestore site id from domain/name. */
export function makeSiteId(name, domain) {
	const host = domainHost(domain);
	const fromHost = host.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
	if (fromHost) return fromHost.slice(0, 80);
	const fromName = String(name || "site")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	return fromName.slice(0, 80) || "site";
}

export function slugify(text) {
	return String(text || "")
		.toLowerCase()
		.trim()
		.replace(/['"]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 120);
}

export function normalizeUrl(url) {
	const s = String(url || "").trim();
	if (!s) return "";
	try {
		const u = new URL(s);
		u.hash = "";
		let out = u.toString();
		if (out.endsWith("/") && u.pathname !== "/") out = out.slice(0, -1);
		return out;
	} catch {
		return s;
	}
}

export function urlDomain(url) {
	try {
		return new URL(normalizeUrl(url)).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

export function dedupeByUrl(rows) {
	const seen = new Set();
	const out = [];
	for (const row of rows) {
		const url = normalizeUrl(row.url || row.link);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		out.push({ ...row, url });
	}
	return out;
}

export function truncate(text, max = 2000) {
	const s = String(text || "");
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…`;
}

export function titleSimilarity(a, b) {
	const x = String(a || "")
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.trim();
	const y = String(b || "")
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.trim();
	if (!x || !y) return 0;
	if (x === y) return 1;
	if (x.includes(y) || y.includes(x)) return 0.85;
	const wordsA = new Set(x.split(/\s+/).filter((w) => w.length > 2));
	const wordsB = new Set(y.split(/\s+/).filter((w) => w.length > 2));
	if (!wordsA.size || !wordsB.size) return 0;
	let overlap = 0;
	for (const w of wordsA) if (wordsB.has(w)) overlap++;
	return overlap / Math.max(wordsA.size, wordsB.size);
}

export function isJunkUrl(url) {
	const u = normalizeUrl(url).toLowerCase();
	if (!u) return true;
	const junk = [
		"/login",
		"/signup",
		"/cart",
		"/privacy",
		"/terms",
		"/cookie",
		"facebook.com/sharer",
		"twitter.com/intent",
		"linkedin.com/share",
		"youtube.com/watch?v=",
	];
	return junk.some((j) => u.includes(j));
}

export async function mapPool(items, concurrency, fn) {
	const results = [];
	let i = 0;
	async function worker() {
		while (i < items.length) {
			const idx = i++;
			try {
				results[idx] = await fn(items[idx], idx);
			} catch (err) {
				results[idx] = { error: err?.message || String(err) };
			}
		}
	}
	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		() => worker(),
	);
	await Promise.all(workers);
	return results;
}
