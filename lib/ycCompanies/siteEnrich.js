/**
 * Site enrich for yc-companies: scrape each company website (no Chrome).
 * Landing + llm.txt + sitemap + RSS + blog/pricing/about (4–5 pages).
 * Same-domain URLs stored as hash → { url, kind, path }.
 */

import { load } from "cheerio";
import {
	LOCAL_API_BASE,
	SITE_ENRICH_BATCH_SIZE,
	YC_AGENT,
} from "./configs.js";
import {
	countCompanies,
	countSiteEnrichedCompanies,
	isRealMapsUrl,
	loadSiteEnrichCursor,
	nextUnenrichedSiteBatch,
	normalizeUrl,
	pageUrlHash,
	saveSiteEnrichCursor,
	updateCompanyDoc,
} from "./core.js";
import { googleSearch } from "../contentResearch/http.js";

const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SKIP_PATH =
	/\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf|mp4|webm|pdf|zip)(\?|$)/i;

const MAX_PAGES = 80;
const FETCH_PAGES = 5;

function compact(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj || {})) {
		if (v == null || v === "") continue;
		if (Array.isArray(v)) {
			if (v.length) out[k] = v;
			continue;
		}
		if (typeof v === "object" && !(v instanceof Date)) {
			const inner = compact(v);
			if (Object.keys(inner).length) out[k] = inner;
			continue;
		}
		out[k] = v;
	}
	return out;
}

export function originOf(url) {
	try {
		const u = new URL(normalizeUrl(url) || url);
		return `${u.protocol}//${u.hostname.replace(/^www\./, "")}`;
	} catch {
		return "";
	}
}

export function hostOf(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return "";
	}
}

export function canonicalPageUrl(raw, base) {
	try {
		const u = new URL(String(raw || "").trim(), base);
		if (u.protocol !== "http:" && u.protocol !== "https:") return "";
		u.hash = "";
		u.hostname = u.hostname.replace(/^www\./, "").toLowerCase();
		if (SKIP_PATH.test(u.pathname)) return "";
		u.pathname = u.pathname.replace(/\/+$/, "") || "/";
		return `${u.protocol}//${u.hostname}${u.pathname}${u.search}`;
	} catch {
		return "";
	}
}

export function classifyPath(pathname) {
	const p = String(pathname || "/").toLowerCase().replace(/\/+$/, "") || "/";
	if (p === "/") return "landing";
	if (/llms?\.txt$/i.test(p)) return "llmTxt";
	if (/sitemap/i.test(p)) return "sitemap";
	if (/(^|\/)(rss|atom|feed)(\.|\/|$)/i.test(p) || /\.(rss|atom|xml)$/i.test(p))
		return "rss";
	if (/blog|news|articles|changelog|journal|updates/i.test(p)) return "blog";
	if (/pricing|plans|price/i.test(p)) return "pricing";
	if (/docs|documentation|developer|api|guide/i.test(p)) return "docs";
	if (/about|company|team|mission|story/i.test(p)) return "about";
	if (/careers|jobs|hiring|join-us/i.test(p)) return "careers";
	if (/privacy|terms|legal|cookies/i.test(p)) return "legal";
	if (/contact|support/i.test(p)) return "contact";
	return "other";
}

async function fetchText(url, timeoutMs = 14_000) {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(timeoutMs),
		redirect: "follow",
		headers: {
			"User-Agent": BROWSER_UA,
			Accept: "text/html,application/xhtml+xml,application/xml,text/plain,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const ctype = String(res.headers.get("content-type") || "");
	const finalUrl = res.url || url;
	const text = await res.text();
	return { text, finalUrl, ctype };
}

function absUrl(href, base) {
	if (!href || href === "#") return "";
	try {
		return new URL(href, base).href;
	} catch {
		return "";
	}
}

function extractLinks(html, pageUrl, originHost) {
	const $ = load(String(html || ""));
	const out = [];
	$("a[href]").each((_, el) => {
		const href = $(el).attr("href");
		const url = canonicalPageUrl(href, pageUrl);
		if (!url || hostOf(url) !== originHost) return;
		out.push({
			url,
			text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 80),
		});
	});
	return out;
}

function extractBrand(html, pageUrl) {
	const $ = load(String(html || ""));
	const attr = (sel, a) => String($(sel).first().attr(a) || "").trim();
	const ogImage = absUrl(
		attr('meta[property="og:image"]', "content") ||
			attr('meta[name="twitter:image"]', "content"),
		pageUrl,
	);
	const icon =
		absUrl(attr('link[rel="apple-touch-icon"]', "href"), pageUrl) ||
		absUrl(attr('link[rel="icon"]', "href"), pageUrl) ||
		absUrl(attr('link[rel="shortcut icon"]', "href"), pageUrl);
	let logo = "";
	$("img").each((_, el) => {
		if (logo) return;
		const src = $(el).attr("src") || $(el).attr("data-src") || "";
		const blob = `${$(el).attr("alt") || ""} ${$(el).attr("class") || ""} ${src}`;
		if (/logo/i.test(blob) && src && !/^data:/.test(src)) logo = absUrl(src, pageUrl);
	});
	const rss =
		absUrl(
			$('link[rel="alternate"][type="application/rss+xml"]').attr("href") ||
				$('link[rel="alternate"][type="application/atom+xml"]').attr("href") ||
				"",
			pageUrl,
		) || "";
	return {
		name: attr('meta[property="og:site_name"]', "content"),
		title: $("title").first().text().replace(/\s+/g, " ").trim().slice(0, 200),
		description: (
			attr('meta[name="description"]', "content") ||
			attr('meta[property="og:description"]', "content")
		).slice(0, 400),
		themeColor: attr('meta[name="theme-color"]', "content"),
		logoUrl: logo || ogImage || icon || "",
		faviconUrl: icon,
		ogImage,
		rssUrl: rss,
	};
}

function locsFromXml(xml, originHost, origin) {
	const out = [];
	const re = /<loc>\s*([^<]+)\s*<\/loc>/gi;
	let m;
	while ((m = re.exec(String(xml || ""))) && out.length < MAX_PAGES) {
		const url = canonicalPageUrl(m[1].trim(), origin);
		if (url && hostOf(url) === originHost) out.push(url);
	}
	return out;
}

function sitemapsFromRobots(text) {
	return String(text || "")
		.split(/\r?\n/)
		.map((line) => line.match(/^\s*sitemap:\s*(\S+)/i)?.[1])
		.filter(Boolean);
}

function addPage(map, url, kind, extra = {}) {
	if (!url || Object.keys(map).length >= MAX_PAGES) return;
	const hash = pageUrlHash(url);
	if (map[hash]) {
		if (kind && map[hash].kind === "other") map[hash].kind = kind;
		return;
	}
	let path = "/";
	try {
		path = new URL(url).pathname || "/";
	} catch {
		/* ignore */
	}
	map[hash] = compact({
		url,
		kind: kind || classifyPath(path),
		path,
		...extra,
	});
}

function firstOfKind(map, kind) {
	return Object.values(map).find((p) => p.kind === kind)?.url || "";
}

function guessUrls(origin, kind) {
	const paths = {
		blog: ["/blog", "/news", "/articles", "/changelog"],
		pricing: ["/pricing", "/plans", "/price"],
		about: ["/about", "/company", "/about-us"],
		docs: ["/docs", "/documentation", "/developers"],
		careers: ["/careers", "/jobs"],
		contact: ["/contact", "/contact-us", "/about/contact"],
		llmTxt: ["/llm.txt", "/llms.txt"],
		sitemap: ["/sitemap.xml", "/sitemap_index.xml"],
		rss: ["/rss.xml", "/feed", "/atom.xml", "/blog/rss.xml"],
	};
	return (paths[kind] || []).map((p) => `${origin}${p}`);
}

let geoLock = Promise.resolve();
function withGeoLock(fn) {
	const run = geoLock.then(fn, fn);
	geoLock = run.then(
		() => {},
		() => {},
	);
	return run;
}

let mapsLock = Promise.resolve();
function withMapsLock(fn) {
	const run = mapsLock.then(fn, fn);
	mapsLock = run.then(
		() => {},
		() => {},
	);
	return run;
}

function uniqueStrings(arr) {
	const seen = new Set();
	const out = [];
	for (const x of arr || []) {
		const s = String(x || "").replace(/\s+/g, " ").trim();
		if (!s || seen.has(s.toLowerCase())) continue;
		seen.add(s.toLowerCase());
		out.push(s);
	}
	return out;
}

function isRemoteOnly(text) {
	const bits = String(text || "")
		.split(/[;|/]/)
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (!bits.length) return false;
	return bits.every((b) => /^(remote|anywhere|distributed|global only|fully remote)$/.test(b));
}

function looksLikeStreet(text) {
	return /\d{1,5}\s+\S+/.test(String(text || "")) &&
		/\b(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|suite|ste|floor|fl)\b/i.test(
			String(text || ""),
		);
}

function formatPostal(addr) {
	if (!addr || typeof addr !== "object") return "";
	const parts = [
		addr.streetAddress,
		addr.addressLocality,
		addr.addressRegion,
		addr.postalCode,
		addr.addressCountry,
	]
		.flatMap((v) => (Array.isArray(v) ? v : [v]))
		.map((v) => String(v || "").trim())
		.filter(Boolean);
	return uniqueStrings(parts).join(", ");
}

function walkJsonLd(node, acc) {
	if (!node) return;
	if (Array.isArray(node)) {
		for (const x of node) walkJsonLd(x, acc);
		return;
	}
	if (typeof node !== "object") return;
	const type = String(node["@type"] || node.type || "");
	if (/PostalAddress/i.test(type)) {
		const line = formatPostal(node);
		if (line) acc.addresses.push(line);
	}
	if (node.address) walkJsonLd(node.address, acc);
	if (/GeoCoordinates|Place|Organization|LocalBusiness/i.test(type)) {
		const lat = Number(node.latitude ?? node.geo?.latitude);
		const lng = Number(node.longitude ?? node.geo?.longitude);
		if (Number.isFinite(lat) && Number.isFinite(lng)) acc.coords.push({ lat, lng });
	}
	if (node.geo) walkJsonLd(node.geo, acc);
	if (node.location) walkJsonLd(node.location, acc);
	for (const v of Object.values(node)) {
		if (v && typeof v === "object") walkJsonLd(v, acc);
	}
}

function extractJsonLdLocation(html) {
	const acc = { addresses: [], coords: [] };
	const re =
		/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
	let m;
	while ((m = re.exec(String(html || "")))) {
		try {
			walkJsonLd(JSON.parse(m[1]), acc);
		} catch {
			/* ignore */
		}
	}
	return acc;
}

function extractMapsHref(html) {
	const m = String(html || "").match(
		/https?:\/\/(?:www\.)?google\.[^/"']+\/maps\/[^\s"'<>]+/i,
	);
	return m ? m[0].replace(/&amp;/g, "&") : "";
}

function ycHintFromCompany(company) {
	const parts = [];
	for (const v of [
		company.address,
		company.all_locations,
		company.locations,
		...(Array.isArray(company.regions) ? company.regions : []),
	]) {
		if (Array.isArray(v)) parts.push(...v);
		else if (v) parts.push(v);
	}
	return uniqueStrings(parts).join("; ");
}

function extractYcPageLocation(html) {
	const text = String(html || "");
	const jsonBits = [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(
		(x) => x[1],
	);
	for (const bit of jsonBits) {
		const loc =
			bit.match(/"all_locations"\s*:\s*"([^"]+)"/) ||
			bit.match(/"location"\s*:\s*"([^"]+)"/);
		if (loc?.[1]) return loc[1];
	}
	const vis = text.match(
		/>\s*([A-Z][A-Za-z .'-]+,\s*[A-Z]{2}(?:,\s*[A-Z][A-Za-z .'-]+)?)\s*</,
	);
	return vis?.[1] || "";
}

function mapsSearchUrl(query, coords) {
	if (Number.isFinite(coords?.lat) && Number.isFinite(coords?.lng)) {
		return `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`;
	}
	if (looksLikeStreet(query)) {
		return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
	}
	return "";
}

function extractStreetFromText(text) {
	const s = String(text || "").replace(/\s+/g, " ");
	const street = s.match(
		/\b\d{1,5}\s+[A-Z][\w.'-]+(?:\s+[A-Z0-9][\w.'-]*){0,6}\s*,\s*[A-Z][A-Za-z .'-]+(?:,\s*(?:[A-Z]{2}|[A-Za-z .']+))?(?:\s+\d{5}(?:-\d{4})?)?/,
	);
	if (street) return street[0].trim();
	const city = s.match(
		/\b(?:headquarters|hq|based in|located in|office in)\s+(?:in\s+)?([A-Z][A-Za-z .'-]+,\s*(?:[A-Z]{2}|[A-Za-z .']{3,}))\b/i,
	);
	return city ? city[1].trim() : "";
}

function mapsQueriesForCompany(company, originHost, address) {
	const name = String(company.name || "").trim();
	const host = originHost || hostOf(company.website);
	const out = [];
	if (looksLikeStreet(address)) {
		out.push(`${name} ${address}`);
		out.push(address);
	} else if (address) {
		out.push(`${name} headquarters ${address}`);
	}
	if (host) {
		out.push(`"${name}" headquarters ${host}`);
		out.push(`${name} ${host} office`);
	}
	out.push(`"${name}" company headquarters`);
	return uniqueStrings(out).slice(0, 3);
}

async function searchHqAddress(company, originHost, baseUrl) {
	const name = String(company.name || "").trim();
	const host = originHost || hostOf(company.website);
	if (!name) return "";
	const queries = uniqueStrings([
		`"${name}" ${host || ""} headquarters address`.trim(),
		`"${name}" company office headquarters ${host || ""}`.trim(),
	]).slice(0, 2);
	for (const q of queries) {
		try {
			const rows = await googleSearch(q, {
				baseUrl,
				num: 6,
				country: "us",
				skipPuppeteer: true,
			});
			const blob = (rows || [])
				.map((r) => `${r.title || ""} ${r.snippet || ""}`)
				.join("\n");
			const hit = extractStreetFromText(blob);
			if (hit) {
				console.log(`[site-enrich:maps] google HQ "${q}" → ${hit}`);
				return hit;
			}
		} catch (err) {
			console.warn(`[site-enrich:maps] google HQ failed:`, err?.message || err);
		}
	}
	return "";
}

function placeCoords(place) {
	const c =
		place?.coordinates ||
		(place?.lat && place?.lng ? { lat: Number(place.lat), lng: Number(place.lng) } : null);
	if (!c) return null;
	const lat = Number(c.lat);
	const lng = Number(c.lng);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	return { lat, lng };
}

function acceptMapsPlace(place, company, originHost) {
	if (!place) return false;
	const coords = placeCoords(place);
	const addr = String(place.address || "");
	if (!coords && !looksLikeStreet(addr) && !addr) return false;
	const score = scoreMapsPlace(place, company, originHost);
	const name = String(company.name || "").trim();
	const host = hostOf(place.website || "");
	const hostMatch =
		originHost && host && (host === originHost || host.endsWith(`.${originHost}`));
	if (hostMatch) return score >= 8;
	if (name.length <= 5) return score >= 12;
	return score >= 8;
}

function placesFromMapsPayload(data) {
	if (data?.success === false && data?.data?.results) return data.data.results;
	const d = data?.data ?? data ?? {};
	if (Array.isArray(d.results)) {
		if (d.results[0]?.name || d.results[0]?.address || d.results[0]?.url) return d.results;
		return d.results.flatMap((row) => row.results || row.places || []);
	}
	if (Array.isArray(d.places)) return d.places;
	if (Array.isArray(d)) return d;
	return [];
}

function scoreMapsPlace(place, company, originHost) {
	const name = String(company.name || "").toLowerCase();
	const blob = `${place.name || ""} ${place.address || ""}`.toLowerCase();
	let s = 0;
	if (name && blob.includes(name)) s += 8;
	const first = name.split(/\s+/)[0];
	if (first && first.length > 3 && blob.includes(first)) s += 3;
	const host = hostOf(place.website || "");
	if (originHost && host && (host === originHost || host.endsWith(`.${originHost}`))) s += 10;
	if (place.coordinates || place.address) s += 2;
	if (/headquarters|office|hq\b/i.test(place.name || "")) s += 2;
	return s;
}

async function nominatimGeocode(query) {
	const q = String(query || "").trim();
	if (!q) return null;
	return withGeoLock(async () => {
		const res = await fetch(
			`https://nominatim.openstreetmap.org/search?${new URLSearchParams({
				q,
				format: "jsonv2",
				limit: "1",
			})}`,
			{
				signal: AbortSignal.timeout(12_000),
				headers: {
					"User-Agent": "ihatereading-api/1.0 (yc-companies-site-enrich)",
					Accept: "application/json",
				},
			},
		);
		if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
		const rows = await res.json();
		const hit = Array.isArray(rows) ? rows[0] : null;
		if (!hit?.lat || !hit?.lon) return null;
		return {
			address: hit.display_name || q,
			coordinates: { lat: Number(hit.lat), lng: Number(hit.lon) },
			source: "nominatim",
		};
	});
}

async function scrapeMapsPlaces(query, baseUrl) {
	const q = String(query || "").trim();
	if (!q) return [];
	return withMapsLock(async () => {
		try {
			const { scrapeMapsQuery } = await import("../mapsScrape.js");
			const places = await Promise.race([
				scrapeMapsQuery(q),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("maps timeout")), 40_000),
				),
			]);
			if (Array.isArray(places) && places.length) return places;
		} catch (err) {
			console.warn("[yc-site-enrich] maps in-process:", err?.message || err);
		}
		const root = String(baseUrl || LOCAL_API_BASE).replace(/\/$/, "");
		const res = await fetch(`${root}/scrape-google-maps`, {
			method: "POST",
			signal: AbortSignal.timeout(45_000),
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ singleQuery: q }),
		});
		const data = await res.json().catch(() => ({}));
		if (res.status === 404) return [];
		if (!res.ok && data.success === false) {
			throw new Error(data.error || `Maps scrape HTTP ${res.status}`);
		}
		return placesFromMapsPayload(data);
	});
}

async function resolveCompanyLocation(company, htmlBlobs, opts = {}) {
	const originHost = opts.originHost || "";
	const baseUrl = opts.baseUrl;
	const jsonld = { addresses: [], coords: [] };
	for (const html of htmlBlobs) {
		const part = extractJsonLdLocation(html);
		jsonld.addresses.push(...part.addresses);
		jsonld.coords.push(...part.coords);
	}
	const mapsHref = htmlBlobs.map(extractMapsHref).find((u) => isRealMapsUrl(u)) || "";
	const pageStreet =
		htmlBlobs
			.map((h) => {
				try {
					return extractStreetFromText(load(h).text());
				} catch {
					return extractStreetFromText(h);
				}
			})
			.find(Boolean) || "";
	const ycHint = ycHintFromCompany(company);
	let ycPageLoc = "";
	if (/ycombinator\.com\/companies\//i.test(String(company.ycUrl || ""))) {
		try {
			const yc = await fetchText(company.ycUrl, 12_000);
			ycPageLoc = extractYcPageLocation(yc.text);
			if (yc.text) htmlBlobs.push(yc.text);
		} catch {
			/* yc.com is often JS-only */
		}
	}

	const addressCandidates = uniqueStrings([
		...jsonld.addresses,
		pageStreet,
		ycPageLoc,
		ycHint,
	]);
	let locationLine =
		addressCandidates.find((a) => looksLikeStreet(a)) ||
		addressCandidates[0] ||
		"";
	const remote = isRemoteOnly(locationLine || ycHint);

	let coords = jsonld.coords[0] || null;
	let address = locationLine;
	let mapsUrl = mapsHref;
	let source = jsonld.coords[0] ? "jsonld" : locationLine ? "website-or-yc" : "";
	let mapsError = "";

	if (remote && !looksLikeStreet(locationLine)) {
		return compact({
			address: ycHint || locationLine || "Remote",
			location: ycHint || locationLine || "Remote",
			locationStatus: "remote",
			locationSource: "yc",
			mapsUrl: "",
		});
	}

	if (!looksLikeStreet(address)) {
		const googled = await searchHqAddress(company, originHost, baseUrl);
		if (googled) {
			address = googled;
			locationLine = googled;
			source = source || "google-search";
		}
	}

	if (!coords && address) {
		try {
			const geo = await nominatimGeocode(address);
			if (geo?.coordinates) {
				coords = geo.coordinates;
				if (!looksLikeStreet(address) && geo.address) address = geo.address;
				source = "nominatim";
			}
		} catch (err) {
			mapsError = err?.message || String(err);
		}
	}

	if (!coords || !isRealMapsUrl(mapsUrl)) {
		const queries = mapsQueriesForCompany(company, originHost, address || locationLine);
		for (const mapsQuery of queries) {
			try {
				console.log(`[site-enrich:maps] scrape "${mapsQuery}"`);
				const places = await scrapeMapsPlaces(mapsQuery, baseUrl);
				const ranked = [...(places || [])].sort(
					(a, b) =>
						scoreMapsPlace(b, company, originHost) -
						scoreMapsPlace(a, company, originHost),
				);
				const place = ranked.find((p) => acceptMapsPlace(p, company, originHost));
				if (!place) continue;
				const pCoords = placeCoords(place);
				if (pCoords) coords = pCoords;
				if (place.address) address = place.address;
				const placeUrl = place.url || place.mapsUrl || "";
				if (isRealMapsUrl(placeUrl)) mapsUrl = placeUrl;
				source = "google-maps";
				break;
			} catch (err) {
				mapsError = err?.message || String(err);
			}
		}
	}

	if (!mapsUrl) mapsUrl = mapsSearchUrl(address, coords);
	if (!isRealMapsUrl(mapsUrl) && !coords) mapsUrl = "";
	const hasGeo = Boolean(coords?.lat);

	return compact({
		address: address || ycHint || "",
		location: ycHint || ycPageLoc || address || "",
		latitude: coords?.lat ?? null,
		longitude: coords?.lng ?? null,
		coordinates: coords,
		mapsUrl,
		maps: coords
			? {
					name: company.name,
					address,
					url: mapsUrl,
					coordinates: coords,
					source,
				}
			: null,
		locationSource: source,
		locationStatus: hasGeo ? "done" : address ? "partial" : "none",
		locationError: mapsError,
	});
}

/**
 * Scrape one YC company website. Does not invent pages — only stores URLs that resolve
 * or appear in landing/sitemap/rss (same host).
 */
export async function enrichCompanySite(company, opts = {}) {
	const website = normalizeUrl(company.website);
	if (!website) {
		const loc = await resolveCompanyLocation(company, [], {
			baseUrl: opts.baseUrl,
		});
		return compact({
			...loc,
			siteEnrichStatus:
				loc.latitude || isRealMapsUrl(loc.mapsUrl) || loc.locationStatus === "remote"
					? "done"
					: "skipped",
			siteEnrichError: "no_website",
			siteEnrichedAt: new Date().toISOString(),
		});
	}

	const origin = originOf(website);
	const originHost = hostOf(origin);
	if (!originHost) {
		return compact({
			siteEnrichStatus: "skipped",
			siteEnrichError: "bad_website",
			siteEnrichedAt: new Date().toISOString(),
		});
	}

	const pages = {};
	let brand = {};
	let llmTxt = { found: false, url: "", text: "" };
	let landingHtml = "";
	let landingUrl = `${origin}/`;
	let scrapeError = "";
	const htmlBlobs = [];

	try {
		const landing = await fetchText(website, 16_000);
		landingHtml = landing.text;
		landingUrl = canonicalPageUrl(landing.finalUrl, origin) || `${origin}/`;
		brand = extractBrand(landingHtml, landing.finalUrl);
		htmlBlobs.push(landingHtml);
		addPage(pages, landingUrl, "landing", { title: brand.title || "" });
		for (const row of extractLinks(landingHtml, landing.finalUrl, originHost)) {
			addPage(pages, row.url, classifyPath(new URL(row.url).pathname), {
				anchor: row.text,
			});
		}
		if (brand.rssUrl && hostOf(brand.rssUrl) === originHost) {
			addPage(pages, canonicalPageUrl(brand.rssUrl, origin), "rss");
		}
	} catch (err) {
		scrapeError = err?.message || String(err);
		addPage(pages, `${origin}/`, "landing");
	}

	const wellKnown = [
		...guessUrls(origin, "llmTxt"),
		...guessUrls(origin, "sitemap"),
		...guessUrls(origin, "rss"),
		`${origin}/robots.txt`,
	];
	const wellResults = await Promise.allSettled(
		wellKnown.map(async (url) => {
			const row = await fetchText(url, 10_000);
			return { url, ...row };
		}),
	);

	for (const row of wellResults) {
		if (row.status !== "fulfilled") continue;
		const { url, text, finalUrl, ctype } = row.value;
		const canon = canonicalPageUrl(finalUrl || url, origin);
		if (!canon || hostOf(canon) !== originHost) continue;
		const kind = /robots\.txt$/i.test(canon)
			? "other"
			: classifyPath(new URL(canon).pathname);

		if (kind === "llmTxt" || /llms?\.txt$/i.test(canon)) {
			llmTxt = {
				found: true,
				url: canon,
				text: String(text || "").slice(0, 12_000),
			};
			addPage(pages, canon, "llmTxt");
			continue;
		}
		if (/robots\.txt$/i.test(canon)) {
			for (const sm of sitemapsFromRobots(text)) {
				const smUrl = canonicalPageUrl(sm, origin);
				if (smUrl && hostOf(smUrl) === originHost) addPage(pages, smUrl, "sitemap");
			}
			continue;
		}
		if (kind === "sitemap" || (/xml/i.test(ctype) && /sitemap/i.test(canon))) {
			addPage(pages, canon, "sitemap");
			for (const loc of locsFromXml(text, originHost, origin)) addPage(pages, loc);
			continue;
		}
		if (kind === "rss" || /rss|atom|xml/i.test(ctype)) {
			addPage(pages, canon, "rss");
			for (const loc of locsFromXml(text, originHost, origin)) addPage(pages, loc);
			for (const m of String(text).matchAll(/<link>([^<]+)<\/link>/gi)) {
				const u = canonicalPageUrl(m[1].trim(), origin);
				if (u && hostOf(u) === originHost) addPage(pages, u);
			}
		}
	}

	const wantedKinds = ["contact", "about", "blog", "pricing", "docs"];
	const toFetch = [];
	const seenFetch = new Set([landingUrl]);
	for (const kind of wantedKinds) {
		const existing = firstOfKind(pages, kind);
		const candidate = existing || guessUrls(origin, kind)[0];
		if (!candidate || seenFetch.has(candidate)) continue;
		seenFetch.add(candidate);
		toFetch.push({ url: candidate, kind });
		if (toFetch.length >= FETCH_PAGES - 1) break;
	}
	if (toFetch.length < FETCH_PAGES - 1) {
		for (const p of Object.values(pages)) {
			if (toFetch.length >= FETCH_PAGES - 1) break;
			if (seenFetch.has(p.url) || p.kind === "landing") continue;
			if (p.kind === "legal" || p.kind === "rss" || p.kind === "sitemap") continue;
			seenFetch.add(p.url);
			toFetch.push({ url: p.url, kind: p.kind });
		}
	}

	const extra = await Promise.allSettled(
		toFetch.map(async ({ url, kind }) => {
			const row = await fetchText(url, 14_000);
			return { url, kind, ...row };
		}),
	);
	for (const row of extra) {
		if (row.status !== "fulfilled") continue;
		const { text, finalUrl, kind } = row.value;
		const canon = canonicalPageUrl(finalUrl, origin);
		if (!canon || hostOf(canon) !== originHost) continue;
		const $ = load(text);
		htmlBlobs.push(text);
		addPage(pages, canon, kind || classifyPath(new URL(canon).pathname), {
			title: $("title").first().text().replace(/\s+/g, " ").trim().slice(0, 160),
		});
		for (const link of extractLinks(text, finalUrl, originHost)) {
			addPage(pages, link.url, classifyPath(new URL(link.url).pathname), {
				anchor: link.text,
			});
		}
	}

	const sitePageUrls = Object.values(pages).map((p) => p.url);
	const hasAnything = sitePageUrls.length > 0 || Boolean(brand.logoUrl) || llmTxt.found;
	const logoUrl = brand.logoUrl || company.logoUrl || "";
	const loc = await resolveCompanyLocation(company, htmlBlobs, {
		originHost,
		baseUrl: opts.baseUrl,
	});

	return compact({
		siteHost: originHost,
		landingUrl,
		blogUrl: firstOfKind(pages, "blog"),
		pricingUrl: firstOfKind(pages, "pricing"),
		docsUrl: firstOfKind(pages, "docs"),
		aboutUrl: firstOfKind(pages, "about"),
		careersUrl: firstOfKind(pages, "careers"),
		contactUrl: firstOfKind(pages, "contact"),
		sitemapUrl: firstOfKind(pages, "sitemap"),
		rssUrl: firstOfKind(pages, "rss"),
		llmTxt,
		brand: compact({
			name: brand.name,
			title: brand.title,
			description: brand.description,
			themeColor: brand.themeColor,
			logoUrl,
			faviconUrl: brand.faviconUrl,
			ogImage: brand.ogImage,
		}),
		logoUrl: company.logoUrl ? undefined : logoUrl,
		sitePages: pages,
		sitePageUrls: sitePageUrls.slice(0, MAX_PAGES),
		sitePageCount: sitePageUrls.length,
		...loc,
		siteEnrichError: scrapeError || loc.locationError || "",
		siteEnrichedAt: new Date().toISOString(),
		siteEnrichStatus: hasAnything || loc.latitude || isRealMapsUrl(loc.mapsUrl) ? "done" : "empty",
	});
}

export async function enrichAndSaveCompanySite(company, opts = {}) {
	const patch = await enrichCompanySite(company, opts);
	await updateCompanyDoc(company.id, patch);
	return {
		id: company.id,
		name: company.name,
		website: company.website || "",
		landingUrl: patch.landingUrl || "",
		blogUrl: patch.blogUrl || "",
		pricingUrl: patch.pricingUrl || "",
		sitemapUrl: patch.sitemapUrl || "",
		rssUrl: patch.rssUrl || "",
		llmTxt: Boolean(patch.llmTxt?.found),
		logoUrl: patch.logoUrl || patch.brand?.logoUrl || "",
		address: patch.address || "",
		latitude: patch.latitude ?? null,
		longitude: patch.longitude ?? null,
		mapsUrl: patch.mapsUrl || "",
		locationStatus: patch.locationStatus || "",
		sitePageCount: patch.sitePageCount || 0,
		siteEnrichStatus: patch.siteEnrichStatus,
		siteEnrichError: patch.siteEnrichError || "",
	};
}

export async function runYcCompaniesSiteEnrichAgent(opts = {}) {
	const batchSize = SITE_ENRICH_BATCH_SIZE;
	let cursor = opts.reset
		? { afterId: "", enriched: 0, done: false }
		: await loadSiteEnrichCursor();

	if (opts.reset) {
		cursor = { afterId: "", enriched: 0, done: false };
		await saveSiteEnrichCursor(cursor);
	}

	const stored = await countCompanies().catch(() => 0);
	const already = await countSiteEnrichedCompanies().catch(() => cursor.enriched || 0);

	const summary = {
		agentId: "yc-companies-site-enrich",
		collection: YC_AGENT.collection,
		batchSize,
		stored,
		enrichedBefore: already,
		fetched: 0,
		updated: 0,
		failed: 0,
		done: false,
		companies: [],
		errors: [],
	};

	if (cursor.done && already >= stored && stored > 0 && !opts.reset) {
		summary.done = true;
		summary.enriched = already;
		summary.note = `All ${already}/${stored} companies already site-enriched. Pass --reset to run again.`;
		return summary;
	}

	const batch = await nextUnenrichedSiteBatch({
		afterId: cursor.afterId,
		limit: batchSize,
	});
	summary.fetched = batch.companies.length;
	summary.afterIdFrom = cursor.afterId;
	summary.afterIdTo = batch.afterId;
	summary.scanned = batch.scanned;

	if (!batch.companies.length) {
		const done = batch.exhausted || stored === 0;
		await saveSiteEnrichCursor({
			afterId: done ? "" : batch.afterId,
			enriched: already,
			done,
		});
		summary.done = done;
		summary.enriched = already;
		summary.note = done
			? `Site enrichment complete — ${already}/${stored} companies.`
			: "No pending companies in this window — cursor advanced.";
		return summary;
	}

	console.log(
		`[yc-site-enrich] ${batch.companies.length} companies: ${batch.companies.map((c) => c.name).join(", ")}`,
	);

	const settled = await Promise.allSettled(
		batch.companies.map((company) =>
			enrichAndSaveCompanySite(company, { baseUrl: opts.baseUrl }),
		),
	);

	for (let i = 0; i < settled.length; i++) {
		const company = batch.companies[i];
		const row = settled[i];
		if (row.status === "fulfilled") {
			summary.updated += 1;
			summary.companies.push(row.value);
			console.log(
				`[yc-site-enrich] ${company.name} pages=${row.value.sitePageCount} addr=${row.value.address || "-"} lat=${row.value.latitude ?? "-"} maps=${row.value.mapsUrl ? "yes" : "no"} ${row.value.siteEnrichError ? `err=${row.value.siteEnrichError}` : "ok"}`,
			);
		} else {
			summary.failed += 1;
			const message = row.reason?.message || String(row.reason);
			summary.errors.push({ id: company.id, name: company.name, error: message });
			await updateCompanyDoc(company.id, {
				siteEnrichStatus: "error",
				siteEnrichError: message,
				siteEnrichedAt: new Date().toISOString(),
			}).catch(() => {});
			summary.companies.push({
				id: company.id,
				name: company.name,
				siteEnrichStatus: "error",
				error: message,
			});
		}
	}

	const filled = summary.companies.filter(
		(c) => c.siteEnrichStatus === "done" || c.siteEnrichStatus === "skipped",
	).length;
	const enrichedNow = already + filled;
	const done = Boolean(batch.exhausted && batch.companies.length < batchSize);
	await saveSiteEnrichCursor({
		afterId: done ? "" : batch.afterId,
		enriched: enrichedNow,
		done,
	});

	summary.enriched = enrichedNow;
	summary.done = done;
	summary.target = stored;
	console.log(
		`[yc-site-enrich] updated ${summary.updated} failed ${summary.failed} — ${enrichedNow}/${stored}${done ? " done" : ""}`,
	);
	return summary;
}
