/**
 * Robust page screenshot capture with Puppeteer + CDP fallbacks.
 * Works around Chrome CDP "Internal error" on Page.captureScreenshot.
 */

import { waitForPaint } from "./prepareScreenshotPage.js";

/**
 * @param {import('puppeteer-core').Page} page
 * @param {{ fullPage?: boolean, clip?: { x: number, y: number, width: number, height: number } }} options
 * @returns {Promise<Buffer>}
 */
export async function capturePageScreenshot(page, options = {}) {
	const { fullPage = false, clip = null } = options;

	await page.emulateMediaType("screen").catch(() => {});
	await waitForPaint(page);

	const attempts = [];

	if (fullPage) {
		attempts.push(() =>
			page.screenshot({
				type: "png",
				fullPage: true,
				captureBeyondViewport: true,
			}),
		);
	}

	if (clip) {
		attempts.push(() =>
			page.screenshot({
				type: "png",
				clip,
				captureBeyondViewport: false,
			}),
		);
	}

	attempts.push(() =>
		page.screenshot({
			type: "png",
			captureBeyondViewport: false,
		}),
	);

	attempts.push(() =>
		page.screenshot({
			type: "jpeg",
			quality: 85,
			captureBeyondViewport: false,
		}),
	);

	attempts.push(() => captureViaCdp(page, { fullPage, clip }));

	attempts.push(async () => {
		await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
		return captureViaCdp(page, { fullPage: false });
	});

	let lastErr;
	for (const run of attempts) {
		try {
			const buf = await run();
			if (buf && buf.length > 0) {
				return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
			}
		} catch (err) {
			lastErr = err;
			console.warn("[screenshot] capture attempt failed:", err?.message);
		}
	}

	throw lastErr || new Error("Screenshot capture failed");
}

/**
 * @param {import('puppeteer-core').Page} page
 * @param {{ fullPage?: boolean, clip?: { x: number, y: number, width: number, height: number } | null }} options
 */
async function captureViaCdp(page, { fullPage = false, clip = null } = {}) {
	const client = await page.createCDPSession();
	try {
		const metrics = await client.send("Page.getLayoutMetrics");
		const vp =
			metrics.cssVisualViewport ||
			metrics.visualViewport ||
			metrics.layoutViewport ||
			{};

		const params = {
			format: "png",
			fromSurface: true,
			captureBeyondViewport: Boolean(fullPage),
		};

		if (!fullPage) {
			const width = Math.max(
				1,
				Math.floor(
					clip?.width ?? vp.clientWidth ?? vp.width ?? 1280,
				),
			);
			const height = Math.max(
				1,
				Math.floor(
					clip?.height ?? vp.clientHeight ?? vp.height ?? 720,
				),
			);
			params.clip = {
				x: Math.max(0, Math.floor(clip?.x ?? 0)),
				y: Math.max(0, Math.floor(clip?.y ?? 0)),
				width,
				height,
				scale: 1,
			};
		}

		const { data } = await client.send("Page.captureScreenshot", params);
		return Buffer.from(data, "base64");
	} finally {
		await client.detach().catch(() => {});
	}
}

/** Normalize viewport config for page.setViewport */
export function normalizeScreenshotViewport(device = "desktop") {
	const map = {
		desktop: { width: 1280, height: 720 },
		tablet: { width: 1024, height: 768 },
		mobile: { width: 375, height: 667 },
	};
	const base = map[device] || map.desktop;
	return { ...base, deviceScaleFactor: 1 };
}
