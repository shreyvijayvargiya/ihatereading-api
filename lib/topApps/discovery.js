/**
 * Mobile app discovery — category pages + iTunes RSS + Google SERP.
 * Store listing details come from HTTP (Play) / iTunes lookup (Apple), then
 * Google search for founder / creator / socials. Puppeteer is optional.
 */

import { firecrawlSearch, googleCustomSearch, searchDuckDuckGo } from "../contentResearch/http.js";
import { TOP_MOBILE_APPS_AGENT } from "./configs.js";
import {
	appDocId,
	appFromItunesResult,
	collectStoreImages,
	createSeenMap,
	extractAppleIdsFromText,
	extractEmails,
	extractFoundersFromText,
	extractPlayIdsFromText,
	extractSocials,
	fetchJson,
	fetchText,
	guessNameFromTitle,
	itunesLookup,
	mergeFounders,
	normalizeName,
	normalizeUrl,
	parseAppStoreId,
	parsePlayDetailsHtml,
	parsePlayStoreId,
	pickIconAndScreenshots,
	resolveStoreUrl,
	scrapePage,
	seenKey,
} from "./core.js";

async function mapLimit(items, concurrency, fn) {
	const out = new Array(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	}
	const n = Math.max(1, Math.min(concurrency, items.length));
	await Promise.all(Array.from({ length: n }, worker));
	return out;
}

function hrefOf(link) {
	if (!link) return "";
	if (typeof link === "string") return link;
	return link.href || link.url || link.link || "";
}

function textOf(link) {
	if (!link || typeof link === "string") return "";
	return String(link.text || link.title || link.alt || "").trim();
}

function listingFromUrl(rawUrl, meta = {}, nameHint = "") {
	const url = resolveStoreUrl(rawUrl, meta.pageUrl || "");
	if (!url) return null;
	const playId = parsePlayStoreId(url);
	const appleId = parseAppStoreId(url);
	if (!playId && !appleId) return null;

	let name = guessNameFromTitle(nameHint);
	if (!name || name.length < 2) {
		if (appleId) {
			const slug = url.match(/\/app\/([^/]+)\/id/i);
			if (slug) name = normalizeName(slug[1].replace(/-/g, " "));
		}
		if (playId && (!name || name.length < 2)) {
			name = playId.split(".").pop() || playId;
		}
	}
	if (!name) name = playId || `app-${appleId}`;

	return {
		name,
		category: meta.category || null,
		platform: playId ? "android" : "ios",
		store: meta.store || (playId ? "google_play" : "apple_app_store"),
		playStoreId: playId,
		appStoreId: appleId,
		playStoreUrl: playId
			? `https://play.google.com/store/apps/details?id=${encodeURIComponent(playId)}`
			: null,
		appStoreUrl: appleId ? url.split("?")[0] : null,
		sourceUrl: url,
		reviewsUrl: url,
		mobileOnly: true,
	};
}

function extractListingsFromPage(page, source) {
	const listings = [];
	const blob = `${page.markdown || ""}\n${page.html || ""}`;
	const meta = { ...source, pageUrl: page.url };

	for (const link of page.links || []) {
		const app = listingFromUrl(hrefOf(link), meta, textOf(link));
		if (app) listings.push(app);
	}

	for (const playId of extractPlayIdsFromText(blob)) {
		const app = listingFromUrl(
			`https://play.google.com/store/apps/details?id=${playId}`,
			meta,
		);
		if (app) listings.push(app);
	}
	for (const appleId of extractAppleIdsFromText(blob)) {
		const app = listingFromUrl(
			`https://apps.apple.com/app/id${appleId}`,
			meta,
		);
		if (app) listings.push(app);
	}

	const appleRe = /https?:\/\/apps\.apple\.com\/[^\s)"'<>]+\/id\d+/gi;
	for (const m of blob.match(appleRe) || []) {
		const app = listingFromUrl(m, meta);
		if (app) listings.push(app);
	}

	return listings;
}

function pushApp(seen, list, raw) {
	if (!raw?.playStoreId && !raw?.appStoreId) return;
	let name = normalizeName(raw.name);
	if (!name) {
		name = raw.playStoreId?.split(".").pop() || (raw.appStoreId ? `app-${raw.appStoreId}` : "");
	}
	if (!name) return;
	const app = { ...raw, name, mobileOnly: true };
	const key = seenKey(app);
	if (seen.has(key)) return;
	seen.set(key, true);
	list.push(app);
}

function listingsFromItunesFeed(data, source) {
	let entries = data?.feed?.entry;
	if (!entries) return [];
	if (!Array.isArray(entries)) entries = [entries];
	const out = [];
	for (const entry of entries) {
		const name = entry?.["im:name"]?.label || entry?.title?.label;
		const id =
			entry?.id?.attributes?.["im:id"] ||
			String(entry?.id?.label || "").match(/\/id(\d+)/)?.[1];
		if (!id) continue;
		const artist = entry?.["im:artist"]?.label || null;
		const artistUrl = entry?.["im:artist"]?.attributes?.href || null;
		const images = (entry?.["im:image"] || []).map((i) => i.label).filter(Boolean);
		const summary = entry?.summary?.label || "";
		const category =
			entry?.category?.attributes?.label || source.category || null;
		out.push({
			name: normalizeName(name) || `app-${id}`,
			category,
			platform: "ios",
			store: "apple_app_store",
			appStoreId: String(id),
			playStoreId: null,
			appStoreUrl: `https://apps.apple.com/app/id${id}`,
			playStoreUrl: null,
			developer: artist,
			developerUrl: artistUrl,
			website: artistUrl,
			oneLiner: String(summary).replace(/\s+/g, " ").slice(0, 280),
			iconUrl: images[images.length - 1] || images[0] || null,
			images,
			screenshots: [],
			sourceUrl: `https://apps.apple.com/app/id${id}`,
			reviewsUrl: `https://apps.apple.com/app/id${id}`,
			mobileOnly: true,
		});
	}
	return out;
}

async function discoverItunesRss(source, seen, out, cap) {
	const urls = source.itunesRssUrls || [];
	for (const rssUrl of urls) {
		if (out.length >= cap) break;
		try {
			console.log(`[top-mobile-apps:itunes] ${rssUrl}`);
			const data = await fetchJson(rssUrl);
			const found = listingsFromItunesFeed(data, source);
			console.log(`[top-mobile-apps:itunes] → ${found.length} apps`);
			for (const app of found) {
				pushApp(seen, out, app);
				if (out.length >= cap) break;
			}
		} catch (err) {
			console.warn(`[top-mobile-apps:itunes] ${rssUrl} → ${err?.message || err}`);
		}
	}
}

async function discoverHttpPages(source, seen, out, cap, baseUrl) {
	const urls = source.scrapeUrls || [];
	for (const listingUrl of urls) {
		if (out.length >= cap) break;
		console.log(`[top-mobile-apps:discover] ${source.id} fetch ${listingUrl}`);
		const page = await scrapePage(listingUrl, baseUrl);
		if (!page || page.error) {
			console.warn(
				`[top-mobile-apps:scrape] ${listingUrl} → ${page?.error || "empty"}`,
			);
			continue;
		}
		const found = extractListingsFromPage(page, source);
		console.log(
			`[top-mobile-apps:scrape] ${listingUrl} → ${found.length} listing urls (${page.via || "scrape"})`,
		);
		for (const app of found) {
			pushApp(seen, out, app);
			if (out.length >= cap) break;
		}
	}
}

async function webSearch(query) {
	const fc = await firecrawlSearch(query, { num: 8, country: "us" });
	if (fc.results?.length) return fc.results;
	const cse = await googleCustomSearch(query, { num: 8, country: "us" });
	if (cse.results?.length) return cse.results;
	try {
		return await searchDuckDuckGo(query, 8);
	} catch {
		return [];
	}
}

async function discoverGoogle(source, seen, out, cap) {
	const queries = source.googleQueries || [];
	for (const q of queries) {
		if (out.length >= cap) break;
		try {
			console.log(`[top-mobile-apps:google] ${q}`);
			const rows = await webSearch(q);
			let n = 0;
			for (const row of rows) {
				const app = listingFromUrl(row.url || row.link, source, row.title);
				if (!app) continue;
				if (row.snippet) app.snippet = String(row.snippet).slice(0, 280);
				pushApp(seen, out, app);
				n += 1;
				if (out.length >= cap) break;
			}
			console.log(`[top-mobile-apps:google] → ${n} listing urls (${rows.length} hits)`);
		} catch (err) {
			console.warn(`[top-mobile-apps:google] ${q} → ${err?.message || err}`);
		}
	}
}

/**
 * Scrape one store category/chart page (HTTP first), iTunes RSS, Google site: queries.
 */
export async function runDiscoverySource(source, opts = {}) {
	const seen = opts.seen || createSeenMap();
	const baseUrl = opts.baseUrl;
	const cap = TOP_MOBILE_APPS_AGENT.listingsPerSource || 40;
	const out = [];
	const queries = [
		...(source.scrapeUrls || []),
		...(source.itunesRssUrls || []),
		...(source.googleQueries || []),
	];

	if (source.platform === "ios" || source.store === "apple_app_store") {
		await discoverItunesRss(source, seen, out, cap);
	}
	if (out.length < cap) {
		await discoverHttpPages(source, seen, out, cap, baseUrl);
	}
	if (out.length < cap) {
		await discoverGoogle(source, seen, out, cap);
	}

	console.log(
		`[top-mobile-apps:discover] ${source.id} → ${out.length} mobile apps`,
	);
	return { apps: out, queries, listingUrls: source.scrapeUrls || [] };
}

export function parseStoreMetadata(page) {
	const text = `${page?.title || ""}\n${page?.markdown || ""}`;
	const meta = {};

	const rating =
		text.match(/([1-5]\.[0-9])\s*(?:out of|★|stars?)/i) ||
		text.match(/Rated\s+([1-5]\.[0-9])/i);
	if (rating) meta.rating = Number(rating[1]);

	const reviews =
		text.match(/([\d,.]+[KkMm]?)\s*(?:Ratings?|Reviews?)/i) ||
		text.match(/([\d,]+)\s+ratings/i);
	if (reviews) meta.reviewCount = reviews[1].replace(/,/g, "");

	const downloads =
		text.match(/([\d,.]+[KkMm+]*)\s*(?:Downloads?|downloads|Installs?)/i) ||
		text.match(/([\d,]+\+?)\s*(?:downloads|installs)/i);
	if (downloads) meta.downloads = downloads[1];

	const price = text.match(/\b(Free|\$\d+(?:\.\d+)?|₹[\d,.]+)\b/);
	if (price) meta.priceLabel = price[1];

	const developer =
		text.match(/(?:Seller|Developer|Offered By)\s*[:\n]\s*([^\n|]+)/i) ||
		text.match(/Developer\s*\n\s*([^\n]+)/i);
	if (developer) meta.developer = developer[1].trim().slice(0, 120);

	const website = text.match(
		/(?:Developer Website|Visit website|Website)\s*[:\n]?\s*(https?:\/\/[^\s)<>]+)/i,
	);
	if (website) meta.developerUrl = website[1].replace(/\/$/, "");

	return meta;
}

/**
 * Visit each app listing: iTunes lookup / Play HTTP page for screenshots + metadata.
 */
async function enrichOneMobileApp(app, baseUrl) {
		let enriched = { ...app, socials: { ...(app.socials || {}) } };
		const storeMetadata = { ...(enriched.storeMetadata || {}) };
		const emails = new Set(enriched.emails || []);
		let allImgs = collectStoreImages({ images: enriched.images || [] });

		if (app.appStoreId) {
			try {
				console.log(`[top-mobile-apps:enrich] itunes lookup ${app.appStoreId}`);
				const row = await itunesLookup(app.appStoreId);
				const fromItunes = appFromItunesResult(row, app);
				if (fromItunes) {
					enriched = {
						...enriched,
						...Object.fromEntries(
							Object.entries(fromItunes).filter(([, v]) => v != null && v !== ""),
						),
						socials: enriched.socials,
					};
					allImgs = [
						...allImgs,
						...(fromItunes.images || []),
						...(fromItunes.screenshots || []),
						fromItunes.iconUrl,
					].filter(Boolean);
					if (fromItunes.developer) storeMetadata.developer = fromItunes.developer;
					if (fromItunes.developerUrl) storeMetadata.developerUrl = fromItunes.developerUrl;
					if (fromItunes.rating != null) storeMetadata.rating = fromItunes.rating;
					if (fromItunes.reviewCount != null) storeMetadata.reviewCount = fromItunes.reviewCount;
				}
			} catch (err) {
				console.warn(
					`[top-mobile-apps:enrich] itunes ${app.appStoreId}: ${err?.message || err}`,
				);
			}
		}

		const targets = [app.playStoreUrl].filter(Boolean);
		if (!enriched.screenshots?.length && app.appStoreUrl) {
			targets.push(app.appStoreUrl);
		}
		for (const url of targets.slice(0, 2)) {
			console.log(`[top-mobile-apps:enrich] listing ${url}`);
			const page = await scrapePage(url, baseUrl, { takeScreenshot: true });
			if (!page || page.error) {
				console.warn(
					`[top-mobile-apps:enrich] fail ${url}: ${page?.error || "empty"}`,
				);
				continue;
			}
			if (page.screenshot) enriched.pageScreenshotUrl = page.screenshot;
			const text = `${page.title}\n${page.markdown}\n${page.html || ""}`;
			for (const e of extractEmails(text)) emails.add(e);
			Object.assign(enriched.socials, extractSocials(text));
			allImgs = [
				...allImgs,
				...collectStoreImages({
					markdown: page.markdown,
					html: page.html,
					images: page.images,
				}),
			];
			if (page.ogImage) allImgs.push(page.ogImage);
			Object.assign(storeMetadata, parseStoreMetadata(page));
			if (/play\.google\.com/i.test(url) && page.html) {
				const parsed = parsePlayDetailsHtml(page.html, enriched);
				if (parsed.name) enriched.name = parsed.name;
				if (parsed.oneLiner) enriched.oneLiner = parsed.oneLiner;
				if (parsed.developer) enriched.developer = parsed.developer;
				if (parsed.website) {
					enriched.website = parsed.website;
					enriched.developerUrl = parsed.developerUrl || parsed.website;
				}
				if (parsed.rating != null) enriched.rating = parsed.rating;
				if (parsed.downloads) enriched.downloads = parsed.downloads;
				if (parsed.iconUrl) enriched.iconUrl = parsed.iconUrl;
				if (parsed.screenshots?.length) enriched.screenshots = parsed.screenshots;
				allImgs.push(...(parsed.images || []));
			}
			if (!enriched.oneLiner && page.markdown) {
				enriched.oneLiner = String(page.markdown).replace(/\s+/g, " ").slice(0, 280);
			}
			if (page.title && (!enriched.name || enriched.name.length < 3)) {
				enriched.name = guessNameFromTitle(page.title) || enriched.name;
			}
			enriched.enrichmentPreview = String(page.markdown || "").slice(0, 2000);
		}

		const picked = pickIconAndScreenshots(
			[...new Set(allImgs.filter(Boolean))],
		);
		enriched.iconUrl = enriched.iconUrl || picked.iconUrl;
		enriched.screenshots =
			enriched.screenshots?.length > 0 ? enriched.screenshots : picked.screenshots;
		enriched.images =
			enriched.images?.length > 0
				? enriched.images
				: picked.images;

		if (storeMetadata.developerUrl && !enriched.website) {
			enriched.website = storeMetadata.developerUrl;
			enriched.developerUrl = storeMetadata.developerUrl;
		}
		if (storeMetadata.developer && !enriched.developer) {
			enriched.developer = storeMetadata.developer;
		}

		enriched.emails = [...emails];
		enriched.email = enriched.emails[0] || null;
		enriched.storeMetadata = storeMetadata;
		if (storeMetadata.rating != null && enriched.rating == null) {
			enriched.rating = storeMetadata.rating;
		}
		if (storeMetadata.reviewCount && !enriched.reviewCount) {
			enriched.reviewCount = storeMetadata.reviewCount;
		}
		if (storeMetadata.downloads && !enriched.downloads) {
			enriched.downloads = storeMetadata.downloads;
		}
		if (storeMetadata.priceLabel) enriched.priceLabel = storeMetadata.priceLabel;
		enriched.reviewsUrl = enriched.appStoreUrl || enriched.playStoreUrl;
		enriched.platform =
			enriched.appStoreUrl && enriched.playStoreUrl
				? "both"
				: enriched.playStoreUrl
					? "android"
					: "ios";
		enriched.id = appDocId(enriched);
		return enriched;
}

export async function enrichMobileApps(apps, opts = {}) {
	const limit = opts.limit ?? 8;
	const baseUrl = opts.baseUrl;
	const batch = apps.slice(0, limit);
	const out = await mapLimit(batch, 4, (app) => enrichOneMobileApp(app, baseUrl));
	return [...out, ...apps.slice(limit)];
}

/**
 * Google search + developer-site fetch for founder / creator / socials.
 * Failures never drop the app.
 */
async function enrichOneFounder(app, baseUrl) {
	const next = {
		...app,
		socials: { ...(app.socials || {}) },
		founders: [...(app.founders || [])],
		creators: [...(app.creators || [])],
	};
	if (!next.name) return next;

	const q = [
		`"${next.name}"`,
		next.developer ? `"${next.developer}"` : "",
		"(founder OR creator OR CEO)",
		"(twitter OR linkedin OR github)",
	]
		.filter(Boolean)
		.join(" ");

	const snippets = [];
	try {
		console.log(`[top-mobile-apps:founders] google ${q.slice(0, 90)}`);
		const results = await webSearch(q);
		for (const row of results) {
			snippets.push({
				url: row.url || row.link || "",
				title: row.title || "",
				text: String(row.snippet || "").slice(0, 500),
			});
		}
	} catch (err) {
		console.warn(`[top-mobile-apps:founders] google fail: ${err?.message || err}`);
	}

	const blob = snippets.map((s) => `${s.title}\n${s.text}\n${s.url}`).join("\n");
	Object.assign(next.socials, extractSocials(blob));
	next.founders = mergeFounders(next.founders, extractFoundersFromText(blob));
	const emails = new Set(next.emails || []);
	for (const e of extractEmails(blob)) emails.add(e);

	if (next.website) {
		try {
			const site = normalizeUrl(next.website);
			if (site && !/play\.google\.com|apps\.apple\.com/i.test(site)) {
				console.log(`[top-mobile-apps:founders] site ${site}`);
				const html = await fetchText(site, { timeoutMs: 8_000 });
				Object.assign(next.socials, extractSocials(html));
				next.founders = mergeFounders(next.founders, extractFoundersFromText(html));
				for (const e of extractEmails(html)) emails.add(e);
			}
		} catch (err) {
			console.warn(`[top-mobile-apps:founders] site fail: ${err?.message || err}`);
		}
	}

	next.emails = [...emails];
	next.email = next.email || next.emails[0] || null;
	next.companyTwitter = next.socials.twitter || next.companyTwitter || null;
	next.companyLinkedIn = next.socials.linkedin || next.companyLinkedIn || null;
	next.companyGithub = next.socials.github || next.githubUrl || null;
	return next;
}

export async function enrichFoundersAndSocials(apps, opts = {}) {
	const baseUrl = opts.baseUrl;
	const limit = opts.limit ?? apps.length;
	const batch = apps.slice(0, limit);
	const out = await mapLimit(batch, 3, (app) => enrichOneFounder(app, baseUrl));
	return [...out, ...apps.slice(limit)];
}

export const enrichApps = enrichMobileApps;
