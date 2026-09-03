/**
 * Stage 1: Site audit via scrapefast + llms.txt + __NEXT_DATA__ (SPA-safe).
 */

import { scrapeUrl } from "../scrapefast.js";
import { updateRun } from "../geoPipeline/collections.js";
import {
	buildSiteContext,
	fetchLlmsTxt,
	fetchPageHtml,
} from "../geoPipeline/extractSiteContext.js";

function hostFromUrl(url) {
	try {
		return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
	} catch {
		return "";
	}
}

function inferTechStack(markdown = "", metadata = {}, html = "") {
	const m = `${markdown} ${html}`.toLowerCase();
	const stack = [];
	if (m.includes("__next_data__") || m.includes("_next/static")) stack.push("Next.js");
	if (m.includes("wp-content") || m.includes("wordpress")) stack.push("WordPress");
	if (m.includes("shopify")) stack.push("Shopify");
	if (m.includes("webflow")) stack.push("Webflow");
	if (metadata?.generator?.toLowerCase?.().includes("wordpress")) stack.push("WordPress");
	return [...new Set(stack)];
}

function extractBlogTitles(markdown = "", links = [], llmsTopics = []) {
	const titles = new Set();
	for (const line of String(markdown).split("\n")) {
		const m = line.match(/^#{1,2}\s+(.{8,120})$/);
		if (m) titles.add(m[1].trim());
	}
	for (const link of links || []) {
		const t = link?.text || link?.title;
		if (t && t.length > 8 && t.length < 140) titles.add(String(t).trim());
	}
	for (const t of llmsTopics) titles.add(t);
	return [...titles].slice(0, 80);
}

export async function runSiteAudit({ runId, siteProfile, scrapeOptions = {} }) {
	await updateRun(runId, { stage: "site_audit" });
	const url = siteProfile.url;
	const origin = new URL(url).origin;

	const spaScrapeOptions = {
		...scrapeOptions,
		timeout: scrapeOptions.timeout || 55_000,
		waitForSelector: scrapeOptions.waitForSelector || "#__next, main, h1",
	};

	let scraped = { markdown: "", data: {} };
	try {
		scraped = await scrapeUrl(url, spaScrapeOptions);
	} catch (err) {
		console.warn("[siteAudit] scrape failed, HTML fallback:", err.message);
	}

	let html = "";
	try {
		html = await fetchPageHtml(url);
	} catch (err) {
		console.warn("[siteAudit] HTML fetch failed:", err.message);
	}

	const llmsTxt = await fetchLlmsTxt(origin);
	const md = scraped.markdown || "";
	const meta = scraped.data?.metadata || scraped.data || {};

	const context = buildSiteContext({
		url,
		markdown: md,
		scrapedMeta: meta,
		html,
		llmsTxt,
		userNiche: siteProfile.niche || scrapeOptions.niche || null,
		userDescription: siteProfile.description || scrapeOptions.description || null,
	});

	const techStack = inferTechStack(md, meta, html);
	const blogTitles = extractBlogTitles(md, scraped.data?.links, context.llmsTopics);

	return {
		domain: hostFromUrl(url),
		niche: context.niche,
		techStack,
		siteSummary: context.siteSummary,
		audit: {
			title: context.title,
			description: context.description,
			metaKeywords: context.metaKeywords,
			wordCount: md.split(/\s+/).filter(Boolean).length,
			blogTitles,
			llmsTopics: context.llmsTopics,
			scrapeQuality: context.scrapeQuality,
			scrapedAt: new Date().toISOString(),
		},
	};
}
