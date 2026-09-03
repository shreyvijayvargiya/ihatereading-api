/**
 * Discover Refero style cards, hydrate each /style/{id} via API + /scrape.
 */

import {
	AI_STYLES_AGENT,
	REFERO_API_STYLES,
	REFERO_LIST_URL,
	styleApiUrl,
	stylePageUrl,
} from "./configs.js";
import {
	buildDesignMd,
	extractAgentPromptGuide,
	extractCopiedDesignMd,
	extractMedia,
	extractStyleIdsFromHtml,
	fetchJson,
	fetchText,
	firstText,
	parseStyleId,
	pickPrompt,
	pickWebsiteUrl,
	scrapePage,
} from "./core.js";

function hrefOf(link) {
	if (!link) return "";
	if (typeof link === "string") return link;
	return link.href || link.url || link.link || "";
}

/**
 * Paginate Refero JSON API: GET /api/styles?sort=newest&limit=&cursor=
 */
export async function discoverFromApi(opts = {}) {
	const limit = opts.limit ?? AI_STYLES_AGENT.listPageSize ?? 20;
	const cursor = opts.cursor || "";
	const params = new URLSearchParams({
		sort: "newest",
		limit: String(Math.min(50, Math.max(1, limit))),
	});
	if (cursor) params.set("cursor", cursor);
	const url = `${REFERO_API_STYLES}?${params}`;
	console.log(`[ai-styles:list] ${url}`);
	const data = await fetchJson(url);
	const styles = Array.isArray(data.styles) ? data.styles : [];
	const cards = styles
		.map((s) => ({
			id: parseStyleId(s.id),
			name: s.siteName || null,
			url: s.url || null,
			siteName: s.siteName || null,
			siteUrl: s.url || null,
			northStar: s.northStar || null,
			colorScheme: s.colorScheme || null,
			thumbnailUrl: s.thumbnailUrl || null,
			screenshotUrl: s.screenshotUrl || null,
			iconUrl: s.iconUrl || null,
			previewVideoUrl: s.previewVideoUrl || null,
			previewVideoPosterUrl: s.previewVideoPosterUrl || null,
			colors: s.colors || [],
			fonts: s.fonts || [],
			sourceUrl: s.id ? stylePageUrl(s.id) : null,
			createdAtSource: s.createdAt || null,
		}))
		.filter((s) => s.id);
	console.log(`[ai-styles:list] → ${cards.length} cards nextCursor=${data.nextCursor || ""}`);
	return {
		cards,
		nextCursor: data.nextCursor || "",
		queries: [url],
	};
}

/**
 * Fallback: HTTP / Puppeteer the catalog (infinite-scroll cards → /style/{id}).
 */
export async function discoverFromCatalogPage(opts = {}) {
	const baseUrl = opts.baseUrl;
	const pageUrl = opts.listUrl || REFERO_LIST_URL;
	console.log(`[ai-styles:list] scrape ${pageUrl}`);
	const page = await scrapePage(pageUrl, baseUrl, {
		waitForSelector: 'a[href*="/style/"]',
		takeScreenshot: false,
	});
	if (page.error) {
		const html = await fetchText(pageUrl).catch(() => "");
		const cards = extractStyleIdsFromHtml(html || page.html, pageUrl);
		return { cards, nextCursor: "", queries: [pageUrl], via: page.via || "http" };
	}
	const fromHtml = extractStyleIdsFromHtml(
		`${page.html}\n${page.markdown}`,
		pageUrl,
	);
	const fromLinks = [];
	for (const link of page.links || []) {
		const id = parseStyleId(hrefOf(link));
		if (id) fromLinks.push({ id, sourceUrl: stylePageUrl(id), listUrl: pageUrl });
	}
	const seen = new Set();
	const cards = [];
	for (const c of [...fromLinks, ...fromHtml]) {
		if (!c.id || seen.has(c.id)) continue;
		seen.add(c.id);
		cards.push(c);
	}
	console.log(`[ai-styles:list] scrape → ${cards.length} cards (${page.via})`);
	return { cards, nextCursor: "", queries: [pageUrl], via: page.via };
}

export async function discoverStyleCards(opts = {}) {
	try {
		return await discoverFromApi(opts);
	} catch (err) {
		console.warn(`[ai-styles:list] API failed: ${err?.message || err}`);
		return discoverFromCatalogPage(opts);
	}
}

function collectPreview(style, ds, page) {
	const media = extractMedia(page?.html || "", {
		screenshotUrl: style.screenshotUrl,
		thumbnailUrl: style.thumbnailUrl,
		iconUrl: style.iconUrl,
		previewVideoUrl: style.previewVideoUrl,
		previewVideoDetailUrl: style.previewVideoDetailUrl,
		images: page?.images,
	});
	const images = [
		style.screenshotUrl,
		style.thumbnailUrl,
		style.iconUrl,
		style.previewVideoPosterUrl,
		style.previewVideoDetailPosterUrl,
		...media.images,
	].filter(Boolean);
	const videos = [
		style.previewVideoUrl,
		style.previewVideoDetailUrl,
		...media.videos,
	].filter(Boolean);
	return {
		previewImage: style.screenshotUrl || style.thumbnailUrl || images[0] || null,
		previewVideo: style.previewVideoUrl || videos[0] || null,
		images: [...new Set(images)].slice(0, 20),
		videos: [...new Set(videos)].slice(0, 8),
	};
}

/**
 * Hydrate one style: Refero detail API + optional /scrape of the nested page.
 */
export async function enrichStyleCard(card, opts = {}) {
	const id = parseStyleId(card.id || card.sourceUrl);
	if (!id) throw new Error("missing style id");
	const sourceUrl = stylePageUrl(id);
	let apiStyle = { ...card, id };
	let ds = {};
	let similar = [];

	try {
		console.log(`[ai-styles:detail] ${styleApiUrl(id)}`);
		const data = await fetchJson(styleApiUrl(id), { timeoutMs: 35_000 });
		const detail = data.style || {};
		const { fullResult, ...detailFields } = detail;
		const meta = fullResult?.meta || {};
		apiStyle = {
			...apiStyle,
			...detailFields,
			id,
			name: firstText(
				card.name,
				card.siteName,
				detail.siteName,
				meta.siteName,
			),
			siteName: firstText(
				card.siteName,
				card.name,
				detail.siteName,
				meta.siteName,
			),
			url: pickWebsiteUrl(
				card.url,
				card.siteUrl,
				detail.url,
				meta.url,
			),
			siteUrl: pickWebsiteUrl(
				card.siteUrl,
				card.url,
				detail.url,
				meta.url,
			),
		};
		ds = fullResult?.designSystem || {};
		similar = Array.isArray(data.similar)
			? data.similar.map((s) => ({
					id: s.id,
					siteName: s.siteName,
					sourceUrl: s.id ? stylePageUrl(s.id) : null,
					thumbnailUrl: s.thumbnailUrl || null,
				}))
			: [];
	} catch (err) {
		console.warn(`[ai-styles:detail] API ${id}: ${err?.message || err}`);
	}

	let page = null;
	if (opts.scrape !== false) {
		console.log(`[ai-styles:scrape] ${sourceUrl}`);
		page = await scrapePage(sourceUrl, opts.baseUrl, {
			waitForSelector: "h1, pre, code",
			takeScreenshot: opts.takeScreenshot === true,
		});
		if (page?.error) {
			console.warn(`[ai-styles:scrape] fail ${id}: ${page.error}`);
		}
	}

	const copied = extractCopiedDesignMd(page?.markdown || "", page?.html || "");
	const built = buildDesignMd(apiStyle, ds);
	const promptGuide = extractAgentPromptGuide(ds);
	const designMd = pickPrompt(copied, built, promptGuide);
	const preview = collectPreview(apiStyle, ds, page);
	const pageName = String(page?.title || "")
		.replace(/\s*[|\-–—].*$/, "")
		.replace(/\s+style reference.*$/i, "")
		.trim();
	const name = firstText(
		apiStyle.name,
		apiStyle.siteName,
		card.name,
		card.siteName,
		pageName,
	);
	const url = pickWebsiteUrl(
		apiStyle.url,
		apiStyle.siteUrl,
		card.url,
		card.siteUrl,
	);

	const fonts =
		apiStyle.fonts ||
		(Array.isArray(ds.typography)
			? ds.typography.map((t) => t.family).filter(Boolean)
			: []);

	return {
		id,
		sourceUrl,
		name: name || apiStyle.siteName || "",
		siteName: name || apiStyle.siteName || "",
		url: url || "",
		siteUrl: url || null,
		northStar: ds.northStar || apiStyle.northStar || null,
		description: ds.description || null,
		industry: ds.industry || apiStyle.industry || null,
		colorScheme: ds.theme || apiStyle.colorScheme || null,
		colors: ds.colors || apiStyle.colors || [],
		fonts,
		typography: ds.typography || [],
		typeScale: ds.typeScale || [],
		spacing: ds.spacing || null,
		components: ds.components || [],
		dos: ds.dos || [],
		donts: ds.donts || [],
		layout: ds.layout || null,
		imagery: ds.imagery || null,
		elevationPhilosophy: ds.elevationPhilosophy || null,
		customSections: ds.customSections || [],
		promptGuide,
		prompt: designMd || promptGuide || "",
		designMd: designMd || promptGuide || "",
		designMdSource: copied ? "page_copy" : "design_system",
		pageMarkdown: String(page?.markdown || "").slice(0, 12_000) || null,
		pageTitle: page?.title || null,
		pageScreenshotUrl: page?.screenshot || null,
		...preview,
		iconUrl: apiStyle.iconUrl || null,
		thumbnailUrl: apiStyle.thumbnailUrl || null,
		screenshotUrl: apiStyle.screenshotUrl || null,
		previewVideoUrl: apiStyle.previewVideoUrl || null,
		previewVideoPosterUrl: apiStyle.previewVideoPosterUrl || null,
		similar,
		createdAtSource: apiStyle.createdAt || card.createdAtSource || null,
		agentId: AI_STYLES_AGENT.id,
		source: "refero.design",
	};
}

export async function enrichStyleCards(cards, opts = {}) {
	const out = [];
	for (const card of cards) {
		try {
			out.push(await enrichStyleCard(card, opts));
		} catch (err) {
			console.warn(
				`[ai-styles:enrich] ${card.id}: ${err?.message || err}`,
			);
			out.push({
				...card,
				id: parseStyleId(card.id),
				sourceUrl: card.sourceUrl || stylePageUrl(card.id),
				error: err?.message || String(err),
			});
		}
	}
	return out;
}
