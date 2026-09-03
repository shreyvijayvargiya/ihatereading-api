/**
 * Google Maps scraping via Puppeteer — used by /scrape-google-maps and maps agents.
 */

import chromium from "@sparticuz/chromium";

const BROWSER_ARGS = [
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-dev-shm-usage",
	"--disable-accelerated-2d-canvas",
	"--no-first-run",
	"--no-zygote",
	"--single-process",
	"--disable-gpu",
];

const LOCAL_CHROME_PATHS = [
	process.env.CHROME_PATH,
	process.env.PUPPETEER_EXECUTABLE_PATH,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
].filter(Boolean);

export async function launchMapsBrowser() {
	const puppeteer = (await import("puppeteer-core")).default;
	const { existsSync } = await import("node:fs");

	// @sparticuz/chromium — Vercel / Linux serverless
	try {
		const executablePath = await chromium.executablePath();
		return await puppeteer.launch({
			headless: true,
			executablePath,
			args: [...chromium.args, ...BROWSER_ARGS],
			ignoreDefaultArgs: ["--disable-extensions"],
		});
	} catch {
		/* try local Chrome below */
	}

	for (const executablePath of LOCAL_CHROME_PATHS) {
		if (!existsSync(executablePath)) continue;
		try {
			return await puppeteer.launch({
				headless: true,
				executablePath,
				args: ["--no-sandbox", "--disable-dev-shm-usage"],
			});
		} catch {
			continue;
		}
	}

	throw new Error(
		"Could not launch Chrome for Maps scraping — install Chrome or set CHROME_PATH",
	);
}

/**
 * Scrapes a single Google Maps query using an existing puppeteer browser instance.
 * @returns {Promise<object[]>}
 */
export async function runMapsQuery(browser, query) {
	const page = await browser.newPage();
	try {
		await page.setUserAgent(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		);
		await page.setRequestInterception(true);
		page.on("request", (req) => {
			if (["image", "font", "stylesheet", "media"].includes(req.resourceType()))
				req.abort();
			else req.continue();
		});

		await page.goto(
			`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`,
			{ waitUntil: "networkidle0", timeout: 30000 },
		);
		await new Promise((r) => setTimeout(r, 5000));

		await page.evaluate(async () => {
			const feed = document.querySelector('div[role="feed"]');
			if (!feed) return;
			for (let i = 0; i < 5; i++) {
				feed.scrollBy(0, 1000);
				await new Promise((r) => setTimeout(r, 1000));
			}
		});

		const feedEntries = await page.evaluate(() => {
			const feed = document.querySelector('div[role="feed"]');
			if (!feed) return [];
			return Array.from(feed.querySelectorAll('a[href*="/maps/place/"]'))
				.slice(0, 10)
				.map((card) => {
					const url = card.href || "";
					const latMatch = url.match(/[!,]3d(-?[\d.]+)/);
					const lngMatch = url.match(/[!,]4d(-?[\d.]+)/);
					return {
						name: card.getAttribute("aria-label")?.trim() || "",
						url,
						coordinates:
							latMatch && lngMatch
								? { lat: parseFloat(latMatch[1]), lng: parseFloat(lngMatch[1]) }
								: null,
					};
				})
				.filter((item) => item.name.length > 0);
		});

		const places = await Promise.all(
			feedEntries.map(async (entry) => {
				const detailPage = await browser.newPage();
				try {
					await detailPage.setRequestInterception(true);
					detailPage.on("request", (req) => {
						if (
							["image", "font", "stylesheet", "media"].includes(
								req.resourceType(),
							)
						)
							req.abort();
						else req.continue();
					});
					await detailPage.goto(entry.url, {
						waitUntil: "domcontentloaded",
						timeout: 15000,
					});
					await new Promise((r) => setTimeout(r, 2000));

					const details = await detailPage.evaluate(() => {
						let rating = null;
						for (const el of document.querySelectorAll("[aria-label]")) {
							const al = el.getAttribute("aria-label");
							const m =
								al.match(/([1-5]\.[0-9])\s*stars?/i) ||
								al.match(/rated\s+([1-5]\.[0-9])/i);
							if (m) {
								rating = parseFloat(m[1]);
								break;
							}
						}
						let reviews = null;
						for (const el of document.querySelectorAll("[aria-label]")) {
							const al = el.getAttribute("aria-label");
							const m = al.match(/([\d,]+)\s*reviews?/i);
							if (m) {
								reviews = m[1].replace(/,/g, "");
								break;
							}
						}
						const addrEl =
							document.querySelector('button[data-item-id="address"]') ||
							document.querySelector('[data-tooltip="Copy address"]');
						const address =
							addrEl
								?.getAttribute("aria-label")
								?.replace(/^Address:\s*/i, "")
								?.trim() || "";
						const phoneEl =
							document.querySelector('[data-item-id^="phone"]') ||
							document.querySelector('[data-tooltip="Copy phone number"]');
						const phone =
							phoneEl
								?.getAttribute("aria-label")
								?.replace(/^Phone:\s*/i, "")
								?.trim() ||
							phoneEl?.textContent?.trim() ||
							"";
						const websiteEl = document.querySelector(
							'a[data-item-id="authority"]',
						);
						const rawWebsite = websiteEl?.href || "";
						let website = rawWebsite;
						try {
							const u = new URL(rawWebsite);
							const q = u.searchParams.get("q");
							if (q) website = q;
						} catch {
							/* keep rawWebsite */
						}
						const category =
							document
								.querySelector('button[jsaction*="category"]')
								?.textContent?.trim() || "";
						const image =
							document
								.querySelector('meta[property="og:image"]')
								?.getAttribute("content") || "";
						return {
							rating,
							reviews,
							address,
							phone,
							website,
							category,
							image,
						};
					});

					return { ...entry, ...details };
				} catch {
					return {
						...entry,
						rating: null,
						reviews: null,
						address: "",
						phone: "",
						website: "",
						category: "",
						image: "",
					};
				} finally {
					await detailPage.close().catch(() => {});
				}
			}),
		);

		return places;
	} finally {
		await page.close().catch(() => {});
	}
}

/** Scrape one query — opens and closes its own browser. */
export async function scrapeMapsQuery(query) {
	const browser = await launchMapsBrowser();
	try {
		return await runMapsQuery(browser, query);
	} finally {
		await browser.close().catch(() => {});
	}
}

/**
 * Scrape multiple queries with one shared browser.
 * @returns {Promise<{ query: string, places: object[], error?: string }[]>}
 */
export async function scrapeMapsQueries(queries) {
	const browser = await launchMapsBrowser();
	const results = [];
	try {
		for (const query of queries) {
			try {
				const places = await runMapsQuery(browser, query);
				results.push({ query, places });
			} catch (err) {
				results.push({
					query,
					places: [],
					error: err?.message || String(err),
				});
			}
		}
	} finally {
		await browser.close().catch(() => {});
	}
	return results;
}
