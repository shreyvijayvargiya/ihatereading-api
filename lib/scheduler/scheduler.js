/**
 * Small scheduling + posting engine. Store and platforms are injected so the
 * core is testable without Firestore or network.
 */

const BACKOFF_BASE_MS = 60_000;

export function parseRunAt(value, now) {
	if (value === undefined || value === null || value === "") return now;
	const ms = typeof value === "number" ? value : Date.parse(value);
	if (!Number.isFinite(ms)) throw new Error("runAt must be an ISO date or epoch milliseconds");
	return ms;
}

export function createScheduler({ store, platforms, now = Date.now, maxAttempts = 3, leaseMs = 5 * 60_000 }) {
	function adapter(name) {
		const a = platforms[String(name || "").toLowerCase()];
		if (!a) throw new Error(`Unsupported platform "${name}". Available: ${Object.keys(platforms).join(", ")}`);
		return a;
	}

	async function schedule({ platform, payload, runAt }) {
		const a = adapter(platform);
		a.validate(payload);
		const t = now();
		return store.create({
			platform: String(platform).toLowerCase(),
			payload,
			runAt: parseRunAt(runAt, t),
			status: "scheduled",
			attempts: 0,
		});
	}

	async function runOne(doc) {
		try {
			const result = await adapter(doc.platform).publish(doc.payload, { resume: doc.partial });
			const patch = { status: "published", result, publishedAt: now(), error: null, partial: null, leaseUntil: null };
			await store.update(doc.id, patch);
			return { ...doc, ...patch };
		} catch (err) {
			const attempts = (doc.attempts || 0) + 1;
			const final = err.permanent || attempts >= maxAttempts;
			const patch = {
				attempts,
				error: String(err.message || err).slice(0, 500),
				partial: err.partial || doc.partial || null,
				leaseUntil: null,
				...(final
					? { status: "failed" }
					: { status: "scheduled", runAt: now() + BACKOFF_BASE_MS * 2 ** (attempts - 1) }),
			};
			await store.update(doc.id, patch);
			return { ...doc, ...patch };
		}
	}

	/** Create and publish immediately (still goes through the claim path). */
	async function publishNow(input) {
		const created = await schedule({ ...input, runAt: now() });
		const [claimed] = (await store.claimDue({ now: now(), limit: 50, leaseMs })).filter((d) => d.id === created.id);
		return claimed ? runOne(claimed) : store.get(created.id);
	}

	async function runDue({ limit = 10 } = {}) {
		const docs = await store.claimDue({ now: now(), limit, leaseMs });
		const out = [];
		for (const doc of docs) out.push(await runOne(doc));
		return out;
	}

	return { schedule, publishNow, runDue, runOne };
}

/** In-process ticker for long-running servers (not for serverless). */
export function startTicker(scheduler, { intervalMs = 30_000, log = console } = {}) {
	let busy = false;
	const timer = setInterval(async () => {
		if (busy) return;
		busy = true;
		try {
			const done = await scheduler.runDue();
			if (done.length) log.log(`[scheduler] processed ${done.length} post(s)`);
		} catch (err) {
			log.error("[scheduler] tick failed:", err.message);
		} finally {
			busy = false;
		}
	}, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
