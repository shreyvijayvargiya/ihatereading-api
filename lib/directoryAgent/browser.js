/**
 * Playwright session manager + browser tools.
 *
 * One task = one browser (+ context + page). Sessions stay alive while the task is
 * paused; storage state (cookies) is written to disk on every pause so a task can
 * also resume after a server restart.
 *
 * Tools: browser.open / click / type / upload / wait / screenshot / extract / pause / resume
 */

import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { allowPrivate, assertPublicHttpUrl, isPrivateHostLiteral } from "./urlSafety.js";

export const VIEWPORT = { width: 1280, height: 800 };

/** taskId -> session */
const sessions = new Map();
const closedHooks = new Set();

export const sessionCount = () => sessions.size;
export const getSession = (taskId) => sessions.get(taskId) || null;
export const onSessionClosed = (fn) => closedHooks.add(fn);

export const sessionRef = (s) =>
	s ? { browserId: s.browserId, pageId: s.pageId, taskId: s.taskId } : null;

export async function openSession(taskId, { storageStatePath } = {}) {
	const existing = sessions.get(taskId);
	if (existing) return existing;

	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
	const browser = await chromium
		.launch({
		headless: process.env.DIRECTORY_AGENT_HEADLESS !== "false",
		executablePath: process.env.DIRECTORY_AGENT_CHROMIUM_PATH || undefined,
		args: [
			"--disable-dev-shm-usage",
			"--disable-blink-features=AutomationControlled",
			...(isRoot || process.env.DIRECTORY_AGENT_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
		],
	})
		.catch((e) => {
			if (/Executable doesn't exist/i.test(e.message)) {
				throw new Error(
					"Chromium is not installed. Run `npx playwright install chromium` (or set DIRECTORY_AGENT_CHROMIUM_PATH to a Chrome binary), then create a new task.",
				);
			}
			throw e;
		});

	let storageState;
	if (storageStatePath) {
		try {
			storageState = JSON.parse(await fs.readFile(storageStatePath, "utf8"));
		} catch {
			/* no saved state */
		}
	}

	const context = await browser.newContext({
		viewport: VIEWPORT,
		locale: "en-US",
		acceptDownloads: false,
		...(storageState ? { storageState } : {}),
	});
	context.setDefaultTimeout(15_000);
	context.setDefaultNavigationTimeout(45_000);

	if (!allowPrivate()) {
		await context.route("**/*", (route) => {
			try {
				const { hostname, protocol } = new URL(route.request().url());
				if (/^https?:$/.test(protocol) && isPrivateHostLiteral(hostname)) {
					return route.abort("blockedbyclient");
				}
			} catch {
				/* fall through */
			}
			return route.continue();
		});
	}

	const page = await context.newPage();
	const s = {
		taskId,
		browserId: `br_${randomUUID().slice(0, 8)}`,
		pageId: `pg_${randomUUID().slice(0, 8)}`,
		browser,
		context,
		page,
		popups: [],
		restored: Boolean(storageState),
		createdAt: Date.now(),
	};

	const watch = (p) => p.on("dialog", (d) => d.dismiss().catch(() => {}));
	watch(page);
	context.on("page", (p) => {
		if (p === s.page) return;
		watch(p);
		s.popups.push(p);
		p.on("close", () => {
			s.popups = s.popups.filter((x) => x !== p);
		});
	});
	browser.on("disconnected", () => {
		if (sessions.get(taskId) === s) {
			sessions.delete(taskId);
			for (const fn of closedHooks) fn(taskId);
		}
	});

	sessions.set(taskId, s);
	return s;
}

export async function saveStorageState(taskId, file) {
	const s = sessions.get(taskId);
	if (!s) return false;
	try {
		await s.context.storageState({ path: file });
		return true;
	} catch {
		return false;
	}
}

export async function closeSession(taskId, { stateFile } = {}) {
	const s = sessions.get(taskId);
	if (!s) return;
	if (stateFile) await saveStorageState(taskId, stateFile);
	sessions.delete(taskId);
	await s.browser.close().catch(() => {});
	for (const fn of closedHooks) fn(taskId);
}

export async function closeAllSessions() {
	await Promise.all([...sessions.keys()].map((id) => closeSession(id)));
}

/* ------------------------------ live view ------------------------------ */

/** Popups (OAuth windows) take over the live view until they close. */
const livePage = (s) => [...s.popups].reverse().find((p) => !p.isClosed()) || s.page;

export async function liveFrame(taskId) {
	const s = sessions.get(taskId);
	if (!s) return null;
	const p = livePage(s);
	return {
		buffer: await p.screenshot({ type: "jpeg", quality: 55, timeout: 8000 }),
		url: p.url(),
		popup: p !== s.page,
	};
}

const KEY_RE = /^[A-Za-z0-9+_ -]{1,30}$/;
const num = (v, max) => Math.min(Math.max(Number(v) || 0, 0), max);

export async function liveInput(taskId, ev) {
	const s = sessions.get(taskId);
	if (!s) throw new Error("No live browser session");
	const p = livePage(s);
	switch (ev?.type) {
		case "click":
			await p.mouse.click(num(ev.x, VIEWPORT.width), num(ev.y, VIEWPORT.height), {
				clickCount: ev.double ? 2 : 1,
			});
			break;
		case "type":
			if (typeof ev.text === "string" && ev.text.length <= 500) {
				await p.keyboard.type(ev.text);
			}
			break;
		case "key":
			if (!KEY_RE.test(String(ev.key))) throw new Error("Invalid key");
			await p.keyboard.press(ev.key);
			break;
		case "scroll":
			await p.mouse.wheel(Number(ev.dx) || 0, Math.max(-2000, Math.min(2000, Number(ev.dy) || 0)));
			break;
		case "goto": {
			const url = await assertPublicHttpUrl(ev.url, "URL");
			await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
			break;
		}
		case "back":
			await p.goBack({ timeout: 10_000 }).catch(() => {});
			break;
		default:
			throw new Error("Unknown input event");
	}
	return { ok: true, url: p.url() };
}

/* ------------------------------- tools -------------------------------- */

/**
 * @param {string} taskId
 * @param {{ log: (level: string, msg: string) => void, saveShot: (label: string, buf: Buffer) => Promise<string>, stateFile: string }} hooks
 */
export function createBrowserTools(taskId, hooks) {
	const sess = () => {
		const s = sessions.get(taskId);
		if (!s) throw new Error("Browser session is not available");
		return s;
	};
	const page = () => sess().page;

	const settle = async (p) => {
		await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
		await p.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
	};

	/** string => selector | {selector} | {text} | {role,name} */
	const locate = (p, target) => {
		if (typeof target === "string") return p.locator(target).first();
		if (target?.selector) return p.locator(target.selector).first();
		if (target?.role) return p.getByRole(target.role, { name: target.name }).first();
		if (target?.text) return p.getByText(target.text, { exact: Boolean(target.exact) }).first();
		throw new Error("Invalid target");
	};

	return {
		async open(url) {
			const safe = await assertPublicHttpUrl(url, "URL");
			const p = page();
			const res = await p.goto(safe, { waitUntil: "domcontentloaded" });
			await settle(p);
			hooks.log("info", `browser.open ${safe} -> ${res?.status() ?? "?"}`);
			return { url: p.url(), title: await p.title().catch(() => ""), status: res?.status() ?? null };
		},

		async click(target, { settleAfter = true } = {}) {
			const p = page();
			const loc = locate(p, target);
			await loc.scrollIntoViewIfNeeded().catch(() => {});
			await loc.click();
			if (settleAfter) await settle(p);
			hooks.log("info", `browser.click ${typeof target === "string" ? target : JSON.stringify(target)}`);
			return { url: p.url() };
		},

		async type(target, text, { clear = true } = {}) {
			const p = page();
			const loc = locate(p, target);
			try {
				if (clear) await loc.fill(String(text));
				else await loc.pressSequentially(String(text), { delay: 10 });
			} catch {
				await loc.click();
				await p.keyboard.type(String(text));
			}
		},

		async select(target, option) {
			const loc = locate(page(), target);
			await loc.selectOption(option);
		},

		async upload(target, filePath) {
			await fs.access(filePath);
			await locate(page(), target).setInputFiles(filePath);
			hooks.log("info", `browser.upload ${filePath.split("/").pop()}`);
		},

		async wait({ ms, selector, state = "visible", urlIncludes } = {}) {
			const p = page();
			if (selector) await p.waitForSelector(selector, { state, timeout: 15_000 });
			else if (urlIncludes) await p.waitForURL((u) => u.href.includes(urlIncludes), { timeout: 15_000 });
			else await p.waitForTimeout(Math.min(Math.max(Number(ms) || 500, 0), 30_000));
		},

		async screenshot(label = "shot") {
			const buffer = await page().screenshot({ type: "png", timeout: 15_000 });
			return hooks.saveShot(label, buffer);
		},

		/** what: text | links | title | url | selector */
		async extract(what = "text", { selector, maxChars = 6000 } = {}) {
			const p = page();
			switch (what) {
				case "url":
					return p.url();
				case "title":
					return p.title();
				case "selector":
					return (await locate(p, selector).innerText()).slice(0, maxChars);
				case "links":
					return p.evaluate(() =>
						[...document.querySelectorAll("a[href]")]
							.filter((a) => a.getBoundingClientRect().width > 0)
							.slice(0, 300)
							.map((a) => ({ text: (a.innerText || "").trim().slice(0, 100), href: a.href })),
					);
				default:
					return (await p.evaluate(() => document.body?.innerText || "")).slice(0, maxChars);
			}
		},

		/** Keep the browser alive, persist cookies, hand back the ids needed to resume. */
		async pause(reason = "") {
			await saveStorageState(taskId, hooks.stateFile);
			hooks.log("info", `browser.pause ${reason}`.trim());
			return sessionRef(sess());
		},

		resume() {
			hooks.log("info", "browser.resume");
			return sessionRef(sess());
		},
	};
}
