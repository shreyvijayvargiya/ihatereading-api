/**
 * Prepare Puppeteer pages for reliable screenshots (SPAs, lazy content, bot checks).
 */

/** Stable desktop Chrome UA — random UAs break Sec-CH-UA headers and SPA hydration. */
export const SCREENSHOT_CHROME_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function generateScreenshotHeaders() {
	return {
		userAgent: SCREENSHOT_CHROME_UA,
		// Only safe headers here — Sec-Fetch-* / Sec-CH-UA on setExtraHTTPHeaders
		// are applied to ALL subresources and break SPA hydration (empty #__next).
		extraHTTPHeaders: {
			"Accept-Language": "en-US,en;q=0.9",
		},
	};
}

/** Reduce headless fingerprinting — mirrors scrape path in index.js */
export async function applyStealthToPage(page) {
	await page.evaluateOnNewDocument(() => {
		Object.defineProperty(navigator, "webdriver", {
			get: () => undefined,
		});
		Object.defineProperty(navigator, "plugins", {
			get: () => [1, 2, 3, 4, 5],
		});
		Object.defineProperty(navigator, "languages", {
			get: () => ["en-US", "en"],
		});
		const orig = window.navigator.permissions?.query;
		if (orig) {
			window.navigator.permissions.query = (p) =>
				p.name === "notifications"
					? Promise.resolve({ state: Notification.permission })
					: orig(p);
		}
	});
}

/** Measure visible page content (text, media, painted nodes). */
export async function measurePageContent(page) {
	return page.evaluate(() => {
		const pickText = () => {
			const roots = [
				document.getElementById("__next"),
				document.getElementById("root"),
				document.querySelector("main"),
				document.querySelector('[role="main"]'),
				document.body,
			].filter(Boolean);
			let best = "";
			for (const el of roots) {
				const t = (el.innerText || "").replace(/\s+/g, " ").trim();
				if (t.length > best.length) best = t;
			}
			return best.length;
		};

		const textLen = pickText();
		const hasMedia =
			document.images.length > 0 ||
			!!document.querySelector("video, canvas, svg");

		const walker = document.createTreeWalker(
			document.getElementById("__next") || document.body,
			NodeFilter.SHOW_ELEMENT,
		);
		let visibleNodes = 0;
		let node = walker.nextNode();
		while (node) {
			const el = /** @type {HTMLElement} */ (node);
			const style = window.getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			if (
				style.visibility !== "hidden" &&
				style.display !== "none" &&
				parseFloat(style.opacity || "1") > 0.05 &&
				rect.width > 24 &&
				rect.height > 12
			) {
				visibleNodes++;
			}
			node = walker.nextNode();
		}

		return { textLen, visibleNodes, hasMedia };
	});
}

/**
 * Wait for Next.js / React / SPA shells to hydrate (#__next, #root, etc.).
 */
export async function waitForSpaHydration(page, { timeout = 45_000 } = {}) {
	const sel =
		"#__next, #root, main, [role='main'], #app, body > div:first-child";

	try {
		await page.waitForSelector(sel, {
			timeout: Math.min(timeout, 12_000),
		});
	} catch {}

	try {
		await page.waitForFunction(
			() => {
				const next = document.getElementById("__next");
				const root = document.getElementById("root");
				const main =
					document.querySelector("main") ||
					document.querySelector('[role="main"]');
				const candidates = [next, root, main].filter(Boolean);

				for (const el of candidates) {
					const text = (el.innerText || "").replace(/\s+/g, " ").trim();
					const rect = el.getBoundingClientRect();
					const hasStructure = el.querySelector(
						"h1, h2, h3, nav, a, img, button, p, section, article",
					);
					if (
						(text.length >= 25 && rect.height > 80) ||
						(hasStructure && rect.height > 120)
					) {
						return true;
					}
				}

				const bodyText = (document.body?.innerText || "")
					.replace(/\s+/g, " ")
					.trim();
				return bodyText.length >= 50;
			},
			{ timeout, polling: 300 },
		);
	} catch {
		/* fall through — caller may reload */
	}

	if (typeof page.waitForNetworkIdle === "function") {
		await page
			.waitForNetworkIdle({ idleTime: 800, timeout: 15_000 })
			.catch(() => {});
	}

	try {
		await page.evaluate(() => document.fonts?.ready);
	} catch {}
}

/**
 * Wait until the page has rendered meaningful content (not an empty SPA shell).
 */
export async function waitForVisiblePageContent(
	page,
	{ timeout = 15_000, minTextLength = 40, pollMs = 250 } = {},
) {
	const deadline = Date.now() + timeout;
	let last = { textLen: 0, visibleNodes: 0, hasMedia: false };

	while (Date.now() < deadline) {
		last = await measurePageContent(page);
		const ready =
			last.textLen >= minTextLength ||
			last.hasMedia ||
			last.visibleNodes >= 8;
		if (ready) return last;
		await new Promise((r) => setTimeout(r, pollMs));
	}

	return last;
}

/** Reload and wait again when the shell never hydrated. */
export async function recoverBlankSpaPage(page, { timeout = 45_000 } = {}) {
	try {
		await page.reload({ waitUntil: "networkidle2", timeout });
	} catch {
		await page.reload({ waitUntil: "load", timeout }).catch(() => {});
	}
	await waitForSpaHydration(page, { timeout });
	return measurePageContent(page);
}

/** Nudge lazy-loaded sections and wait for paint. */
export async function settlePageBeforeScreenshot(page) {
	try {
		await page.evaluate(async () => {
			const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
			const maxY = Math.max(
				document.body?.scrollHeight ?? 0,
				document.documentElement?.scrollHeight ?? 0,
			);
			window.scrollTo(0, Math.min(maxY, 900));
			await sleep(400);
			window.scrollTo(0, 0);
			await new Promise((r) =>
				requestAnimationFrame(() => requestAnimationFrame(r)),
			);
		});
	} catch {}

	await new Promise((r) => setTimeout(r, 500));
}

/** Parse __NEXT_DATA__ JSON when the live DOM is still empty (markdown fallback). */
export async function extractNextDataMarkdown(page) {
	return page.evaluate(() => {
		const el = document.getElementById("__NEXT_DATA__");
		if (!el?.textContent) return "";
		try {
			const data = JSON.parse(el.textContent);
			const seo = data?.props?.pageProps?.seoData;
			if (!seo) return "";
			const lines = [];
			if (seo.title) lines.push(`# ${seo.title}`);
			if (seo.description) lines.push("", seo.description);
			if (seo.keywords) lines.push("", `Keywords: ${seo.keywords}`);
			return lines.join("\n").trim();
		} catch {
			return "";
		}
	});
}

/** Ensure GPU/compositor has painted before screenshot. */
export async function waitForPaint(page) {
	try {
		await page.evaluate(
			() =>
				new Promise((r) =>
					requestAnimationFrame(() => requestAnimationFrame(r)),
				),
		);
	} catch {}
}
