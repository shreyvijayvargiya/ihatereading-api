/**
 * BrowserPool — reuses a fixed set of Puppeteer browser instances
 * instead of launching/closing a browser on every request.
 *
 * Strategy:
 *  - Maintain a pool of N browser instances (default: 3)
 *  - Each browser can serve ONE page at a time (acquire/release pattern)
 *  - Requests that arrive while all browsers are busy are queued and resolved
 *    as soon as a browser becomes available
 *  - If a browser crashes it is automatically replaced
 */

const POOL_SIZE = parseInt(process.env.BROWSER_POOL_SIZE) || 3;
const BROWSER_IDLE_TIMEOUT_MS =
	parseInt(process.env.BROWSER_IDLE_TIMEOUT_MS) || 5 * 60 * 1000; // 5 min

const CHROME_LAUNCH_ARGS = [
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-dev-shm-usage",
	"--disable-gpu",
	"--disable-web-security",
	"--disable-extensions",
	"--no-zygote",
	"--single-process",
];

/**
 * @typedef {Object} PoolEntry
 * @property {import('puppeteer-core').Browser} browser
 * @property {boolean} busy
 * @property {number} lastUsed
 * @property {number} index
 */

class BrowserPool {
	constructor({ poolSize = POOL_SIZE } = {}) {
		/** @type {PoolEntry[]} */
		this._pool = [];
		this._poolSize = poolSize;
		/** @type {Array<{resolve: Function, reject: Function}>} */
		this._waitQueue = [];
		this._initialised = false;
		this._initialising = false;
		this._idleTimer = null;
		this._puppeteer = null;
		this._chromium = null;
	}

	// ─── Lazy initialisation ───────────────────────────────────────────────────

	async _loadDeps() {
		if (!this._puppeteer) {
			this._puppeteer = (await import("puppeteer-core")).default;
		}
		if (!this._chromium) {
			this._chromium = (await import("@sparticuz/chromium")).default;
		}
	}

	async _launchBrowser() {
		await this._loadDeps();

		let browser;
		try {
			const executablePath = await this._chromium.executablePath();
			browser = await this._puppeteer.launch({
				headless: true,
				args: [...this._chromium.args, "--disable-web-security"],
				executablePath,
				ignoreDefaultArgs: ["--disable-extensions"],
			});
		} catch {
			// Fallback to system Chrome (local dev)
			browser = await this._puppeteer.launch({
				headless: true,
				executablePath:
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				args: CHROME_LAUNCH_ARGS,
			});
		}
		return browser;
	}

	async initialise() {
		if (this._initialised || this._initialising) return;
		this._initialising = true;
		console.log(`🚀 BrowserPool: launching ${this._poolSize} browser(s)…`);
		const launches = Array.from({ length: this._poolSize }, (_, i) =>
			this._launchBrowser().then((browser) => {
				const entry = { browser, busy: false, lastUsed: Date.now(), index: i };
				this._pool.push(entry);
				this._attachCrashHandler(entry);
				console.log(`  ✅ Browser #${i} ready`);
				return entry;
			}),
		);
		await Promise.all(launches);
		this._initialised = true;
		this._initialising = false;
		console.log(
			`🎉 BrowserPool initialised with ${this._pool.length} browser(s)`,
		);
	}

	// ─── Crash handling ────────────────────────────────────────────────────────

	_attachCrashHandler(entry) {
		entry.browser.on("disconnected", async () => {
			console.warn(`⚠️  Browser #${entry.index} disconnected — replacing…`);
			entry.busy = false;
			try {
				const replacement = await this._launchBrowser();
				entry.browser = replacement;
				entry.lastUsed = Date.now();
				this._attachCrashHandler(entry);
				console.log(`✅ Browser #${entry.index} replaced`);
			} catch (err) {
				console.error(`❌ Could not replace browser #${entry.index}:`, err);
			}
			// Drain queue in case something was waiting on this slot
			this._drainQueue();
		});
	}

	// ─── Acquire / release ─────────────────────────────────────────────────────

	/**
	 * Acquire a free browser entry. Queues the request if the pool is full.
	 * @returns {Promise<PoolEntry>}
	 */
	_acquire() {
		const free = this._pool.find((e) => !e.busy);
		if (free) {
			free.busy = true;
			free.lastUsed = Date.now();
			return Promise.resolve(free);
		}
		// All browsers are busy — park the caller until one is released
		return new Promise((resolve, reject) => {
			this._waitQueue.push({ resolve, reject });
		});
	}

	/**
	 * Return a browser entry back to the pool and wake up next waiter.
	 * @param {PoolEntry} entry
	 */
	_release(entry) {
		entry.busy = false;
		entry.lastUsed = Date.now();
		this._drainQueue();
	}

	_drainQueue() {
		if (this._waitQueue.length === 0) return;
		const free = this._pool.find((e) => !e.busy);
		if (!free) return;
		const { resolve } = this._waitQueue.shift();
		free.busy = true;
		free.lastUsed = Date.now();
		resolve(free);
	}

	// ─── Public API ────────────────────────────────────────────────────────────

	/**
	 * Open a new page on a pooled browser and run `task(page)`.
	 * The browser is automatically returned to the pool when done.
	 *
	 * @param {(page: import('puppeteer-core').Page) => Promise<T>} task
	 * @returns {Promise<T>}
	 * @template T
	 */
	async withPage(task) {
		if (!this._initialised) {
			await this.initialise();
		}

		const entry = await this._acquire();
		let page;
		try {
			page = await entry.browser.newPage();
			const result = await task(page);
			return result;
		} finally {
			// Always close the page and release the browser slot
			if (page) {
				try {
					await page.close();
				} catch {}
			}
			this._release(entry);
		}
	}

	/**
	 * Gracefully shut down all browsers in the pool.
	 */
	async destroy() {
		console.log("🛑 BrowserPool: shutting down…");
		await Promise.allSettled(this._pool.map((e) => e.browser.close()));
		this._pool = [];
		this._initialised = false;
		console.log("💤 BrowserPool: all browsers closed");
	}

	/** Pool diagnostics */
	get stats() {
		return {
			size: this._pool.length,
			busy: this._pool.filter((e) => e.busy).length,
			free: this._pool.filter((e) => !e.busy).length,
			queued: this._waitQueue.length,
		};
	}
}

// ─── Singleton ────────────────────────────────────────────────────────────────
const browserPool = new BrowserPool();

// Lazy: browsers launch on first withPage() (scrape / screenshot routes), not at process start.

// Clean shutdown hooks
process.on("SIGTERM", () => browserPool.destroy());
process.on("SIGINT", () => browserPool.destroy());

export default browserPool;
