/**
 * Resolve brand/site context — cached on site doc or scraped from homepage.
 */

import { getSite, upsertSite } from "./firestore.js";
import { scrapePage } from "./scraper.js";
import { AIRDROPBOUNTY_BRAND, isAirdropBountySite } from "../config/airdropbounty.js";
import { log, normalizeDomain } from "../utils.js";

const BRAND_CONTEXT_TTL_MS = Number(
	process.env.CONTENT_INTEL_BRAND_CONTEXT_TTL_MS || 7 * 24 * 60 * 60 * 1000,
);

export async function resolveBrandContext(siteId, opts = {}) {
	const site = await getSite(siteId);
	if (!site) throw new Error(`Site not found: ${siteId}`);

	const cached = site.brandContext;
	const fresh =
		cached?.scrapedAt &&
		Date.now() - new Date(cached.scrapedAt).getTime() < BRAND_CONTEXT_TTL_MS;

	if (fresh && !opts.refresh) {
		return mergeBrandProfile(site, cached);
	}

	let scraped = { ...(cached || {}) };
	if (site.domain) {
		try {
			log("Scraping homepage for brand context", site.domain);
			const page = await scrapePage(normalizeDomain(site.domain), {
				baseUrl: opts.baseUrl,
				maxText: 3500,
			});
			scraped = {
				homepageTitle: page.title || "",
				homepageDescription: page.description || "",
				homepageExcerpt: page.text || "",
				homepageHeadings: (page.headings || []).slice(0, 12).map((h) => h.text),
				scrapedAt: new Date().toISOString(),
				scrapedUrl: page.url || site.domain,
			};
			await upsertSite(siteId, {
				brandContext: scraped,
				brandContextUpdatedAt: scraped.scrapedAt,
			});
		} catch (err) {
			log("Brand context scrape failed", err?.message || err);
			if (!cached) scraped.scrapedAt = new Date().toISOString();
		}
	}

	return mergeBrandProfile(site, scraped);
}

function mergeBrandProfile(site, scraped = {}) {
	const profile = isAirdropBountySite(site.id, site) ? AIRDROPBOUNTY_BRAND : {};
	return {
		...profile,
		siteName: site.name,
		siteDomain: site.domain,
		siteDescription: site.description || "",
		siteAudience: site.audience || "",
		contentGoals: site.contentGoals || [],
		homepage: scraped,
	};
}
