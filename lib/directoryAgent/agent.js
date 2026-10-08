/**
 * Directory submission agent — workflow engine.
 *
 * Steps (persisted in task.currentStep, each idempotent so it can be re-run after a pause):
 *   find_submission_page -> analyze_form -> fill_form -> badge_check -> preview
 *     -> submit -> post_submit -> (COMPLETED | WAITING_FOR_CONFIRMATION)
 *   check_status   (scheduled follow-up from WAITING_FOR_CONFIRMATION)
 *
 * Handlers return an outcome instead of looping on failure:
 *   { next }  { pause }  { sleep }  { done }  { fail }
 * Whenever a human is needed the run loop exits; approve/resume/cancel start a new run.
 * Nothing retries: a failed step fails the task, a gate pauses it.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
	closeSession,
	createBrowserTools,
	getSession,
	onSessionClosed,
	openSession,
	sessionCount,
	sessionRef,
} from "./browser.js";
import { collectSignals } from "./detectors.js";
import {
	collectFields,
	fieldSig,
	fillFields,
	findSubmitCandidates,
	mapFieldsHeuristic,
	markSubmitButton,
	readBack,
} from "./form.js";
import {
	classifyListing,
	heuristicGatePlan,
	planFieldMapping,
	planNext,
	pickSubmitLink,
} from "./planner.js";
import {
	badgeCard,
	captchaCard,
	confirmationCard,
	continueCard,
	githubBadgeCard,
	loginCard,
	previewCard,
} from "./cards.js";
import {
	addBadgeToReadme,
	containsBadge,
	githubToken,
	parseRepo,
	readRepoReadme,
} from "./github.js";
import {
	addScreenshot,
	appendLog,
	createTask,
	getTask,
	listTasks,
	patchData,
	setState,
	storageStateFile,
	taskDir,
	updateTask,
} from "./store.js";
import { STATES, isTerminal, isWaiting } from "./states.js";
import { assertPublicHttpUrl } from "./urlSafety.js";

const MAX_SESSIONS = Number(process.env.DIRECTORY_AGENT_MAX_BROWSERS || 5);
const CHECK_INTERVAL_MS = Number(process.env.DIRECTORY_AGENT_CHECK_INTERVAL_MS || 6 * 60 * 60 * 1000);
const MAX_AUTO_CHECKS = 120;
const STEP_BUDGET = 30;

export class AgentError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

const host = (u) => {
	try {
		return new URL(u).hostname;
	} catch {
		return String(u || "");
	}
};

/* ------------------------- scheduling primitives ------------------------- */

const chains = new Map();
const cancelled = new Set();
const queued = [];

/** Serialize all work for one task. Returns a promise for this job. */
function schedule(id, job) {
	const prev = chains.get(id) || Promise.resolve();
	const next = prev.then(() => job()).catch((err) => failTask(id, err));
	chains.set(id, next);
	return next;
}

const startRun = (id) => schedule(id, () => runLoop(id));

onSessionClosed(() => {
	while (queued.length && sessionCount() < MAX_SESSIONS) startRun(queued.shift());
});

async function failTask(id, err) {
	if (cancelled.has(id)) return;
	const msg = String(err?.message || err).split("\n")[0].slice(0, 300);
	try {
		const task = await getTask(id);
		if (!task || isTerminal(task.state)) return;
		await endTask(id, STATES.FAILED, { error: msg, humanMessage: msg, message: `Failed: ${msg}`, level: "error" }, true);
	} catch {
		/* task vanished */
	}
}

/** Move to a terminal state and release the browser. */
async function endTask(id, state, patch, withShot = false) {
	const s = getSession(id);
	if (s && withShot) {
		try {
			await addScreenshot(id, state.toLowerCase(), await s.page.screenshot({ type: "png", timeout: 8000 }));
		} catch {
			/* browser may already be gone */
		}
	}
	await closeSession(id, { stateFile: storageStateFile(id) });
	await setState(id, state, { ...patch, session: null });
}

/* ------------------------------ sessions ------------------------------- */

function makeTools(id) {
	return createBrowserTools(id, {
		log: (level, msg) => appendLog(id, level, msg),
		saveShot: (label, buf) => addScreenshot(id, label, buf),
		stateFile: storageStateFile(id),
	});
}

/** Reuse the live session or rebuild one from saved cookies + last URL. Null when no slot is free. */
async function ensureSession(id) {
	let s = getSession(id);
	if (s) return s;
	if (sessionCount() >= MAX_SESSIONS) return null;
	const task = await getTask(id);
	s = await openSession(id, { storageStatePath: storageStateFile(id) });
	await updateTask(id, (t) => {
		t.session = sessionRef(s);
	});
	const last = task?.data?.lastUrl;
	if (last) {
		s.restored = true;
		try {
			await s.page.goto(await assertPublicHttpUrl(last), { waitUntil: "domcontentloaded", timeout: 45_000 });
			appendLog(id, "info", `Browser session restored at ${last}`);
		} catch (e) {
			appendLog(id, "warn", `Could not restore last page: ${e.message.split("\n")[0]}`);
		}
	}
	return s;
}

/* -------------------------------- gates -------------------------------- */

const clearKey = (task, kind) => `${task.currentStep}:${kind}`;

/**
 * Detect login / captcha / badge walls on the current page. Returns a pause outcome or null.
 * A gate the human already cleared for this step is not raised again (no pause loops).
 */
async function gate(ctx, { captcha = "interstitial", badge = "off" } = {}) {
	const task = await ctx.refresh();
	const sig = await collectSignals(ctx.page);
	ctx.signals = sig;
	const c = task.data.cleared || {};
	const cleared = {
		login: c[clearKey(task, "login")],
		captcha: c[clearKey(task, "captcha")],
		badge: task.data.badge?.verified || c[clearKey(task, "badge")],
	};
	const heuristic = heuristicGatePlan(sig, { captcha, badge, cleared });

	const ambiguous =
		heuristic.strength === "weak" ||
		sig.login.loginLinks.length > 0 ||
		sig.login.oauth.length > 0 ||
		sig.hasPassword ||
		sig.badge.found ||
		sig.captcha.found;
	const allowed = [
		"continue",
		...(cleared.login ? [] : ["pause_for_login"]),
		...(cleared.captcha ? [] : ["pause_for_captcha"]),
		...(badge === "off" || cleared.badge ? [] : ["pause_for_badge"]),
	];
	const plan = ambiguous
		? await planNext({ stage: task.currentStep, signals: sig, heuristic, allowed, log: ctx.log })
		: { ...heuristic, source: "heuristic" };

	if (plan.nextStep === "continue") return null;
	ctx.log("info", `planner → ${plan.nextStep} (${plan.source}, ${plan.confidence}): ${plan.reason}`);

	switch (plan.nextStep) {
		case "pause_for_login":
			return {
				pause: {
					state: STATES.WAITING_FOR_LOGIN,
					card: loginCard(sig),
					message: plan.reason || "Login required",
				},
			};
		case "pause_for_captcha":
			return {
				pause: {
					state: STATES.WAITING_FOR_CAPTCHA,
					card: captchaCard(sig),
					message: plan.reason || "CAPTCHA required",
				},
			};
		case "pause_for_badge": {
			const b = sig.badge;
			const info = {
				badgeCode: b.badgeCode,
				instructions: b.instructions,
				verificationUrl: b.verificationUrl,
				verifyButton: b.verifyButton,
				verified: false,
				detectedAt: new Date().toISOString(),
			};
			const repo = parseRepo(task.input.githubRepo);
			const canAuto = repo && githubToken() && b.badgeCode && !task.data.githubDeclined;
			return {
				pause: {
					state: STATES.WAITING_FOR_BADGE,
					card: canAuto ? githubBadgeCard(info, repo.slug) : badgeCard(info),
					message: "Badge verification required",
					data: { badge: info },
				},
			};
		}
		default:
			return null;
	}
}

/* ------------------------------- handlers ------------------------------ */

async function stepFind(ctx) {
	const { page, tools, log } = ctx;
	const task = await ctx.refresh();
	const entry = task.input.submissionUrl || task.input.directoryUrl;
	if (page.url() === "about:blank") await tools.open(entry);

	const visited = new Set([page.url()]);
	let reopened = page.url() === entry;
	for (let hop = 0; hop < 4; hop++) {
		const g = await gate(ctx, { captcha: "interstitial" });
		if (g) return g;

		const fields = await collectFields(page);
		const submitLike = /submit|add|new|list/i.test(new URL(page.url()).pathname);
		if (fields.length >= 3 || (fields.length >= 2 && submitLike)) {
			return { next: "analyze_form", data: { submissionPageUrl: page.url() } };
		}

		const cands = (await findSubmitCandidates(page)).filter((c) => !visited.has(c.href || `text:${c.text}`));
		let pick = cands.find((c) => c.score >= 3);
		if (!pick && cands.length) {
			const idx = await pickSubmitLink(cands, log);
			pick = cands.find((c) => c.idx === idx);
		}
		if (!pick) {
			const loginCleared = (task.data.cleared || {})[clearKey(task, "login")];
			if (ctx.signals.login.loginLinks.length && !loginCleared) {
				return {
					pause: {
						state: STATES.WAITING_FOR_LOGIN,
						card: loginCard(ctx.signals),
						message: "No submission form is visible; the directory probably requires login first.",
					},
				};
			}
			if (!reopened) {
				reopened = true;
				await tools.open(entry);
				continue;
			}
			return { fail: "Could not find a submission page or form on this directory" };
		}
		visited.add(pick.href || `text:${pick.text}`);
		log("info", `Following "${pick.text}"`);
		try {
			if (pick.href) await tools.open(pick.href);
			else await tools.click(`[data-da-cand="${pick.idx}"]`);
		} catch (e) {
			log("warn", `Could not follow "${pick.text}": ${e.message.split("\n")[0]}`);
		}
	}
	return { fail: "Submission page not found after following links" };
}

async function stepAnalyze(ctx) {
	const { page, log } = ctx;
	const g = await gate(ctx, { captcha: "interstitial" });
	if (g) return g;
	const task = await ctx.refresh();
	const fields = await collectFields(page);
	if (!fields.length) {
		const loginCleared = (task.data.cleared || {})[clearKey(task, "login")];
		if (ctx.signals.login.loginLinks.length && !loginCleared) {
			return {
				pause: {
					state: STATES.WAITING_FOR_LOGIN,
					card: loginCard(ctx.signals),
					message: "No form fields found; login may be required.",
				},
			};
		}
		return { fail: "No fillable form fields found on the submission page" };
	}
	const mapping = mapFieldsHeuristic(fields);
	const unmapped = fields.filter((f) => !mapping[f.idx] && f.type !== "checkbox").map((f) => f.idx);
	Object.assign(mapping, await planFieldMapping(fields, unmapped, log));

	const plan = {};
	for (const f of fields) if (mapping[f.idx]) plan[fieldSig(f)] = mapping[f.idx];
	log("info", `Analyzed form: ${fields.length} fields, ${Object.keys(plan).length} mapped`);
	return { next: "fill_form", data: { formUrl: page.url(), plan, fieldCount: fields.length } };
}

async function downloadLogo(task, log) {
	const p = task.input.product;
	if (p.logoPath || !p.logoUrl) return p.logoPath || null;
	try {
		const url = await assertPublicHttpUrl(p.logoUrl, "logoUrl");
		const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
		const type = res.headers.get("content-type") || "";
		if (!res.ok || !type.startsWith("image/")) throw new Error(`not an image (${res.status})`);
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > 5 * 1024 * 1024) throw new Error("image too large");
		const ext = (type.split("/")[1] || "png").split(/[+;]/)[0];
		const file = path.join(taskDir(task.id), `logo.${ext}`);
		await fs.writeFile(file, buf);
		return file;
	} catch (e) {
		log("warn", `Logo download skipped: ${e.message}`);
		return null;
	}
}

async function stepFill(ctx) {
	const { page, tools, log } = ctx;
	const g = await gate(ctx, { captcha: "interstitial" });
	if (g) return g;
	const task = await ctx.refresh();
	const fields = await collectFields(page);
	if (!fields.length) return { fail: "Form disappeared before it could be filled" };

	const heur = mapFieldsHeuristic(fields);
	const stored = task.data.plan || {};
	const mapping = {};
	for (const f of fields) mapping[f.idx] = stored[fieldSig(f)] || heur[f.idx];

	const logoPath = await downloadLogo(task, log);
	const product = { ...task.input.product, ...(logoPath ? { logoPath } : {}) };
	const { filled, unfilled } = await fillFields(tools, fields, mapping, product, log);
	log("info", `Filled ${filled.length} fields${unfilled.length ? `, ${unfilled.length} need attention` : ""}`);
	ctx.session.restored = false;
	return { next: "badge_check", data: { filled, unfilled, formFields: fields, lastUrl: page.url() } };
}

async function stepBadge(ctx) {
	const task = await ctx.refresh();
	if (task.data.badge?.verified) return { next: "preview" };
	const g = await gate(ctx, { captcha: "interstitial", badge: "any" });
	if (g) return g;
	return { next: "preview" };
}

async function stepPreview(ctx) {
	const { page, tools } = ctx;
	const task = await ctx.refresh();
	const p = task.input.product;
	const fields = await readBack(page, task.data.formFields || []);
	const summary = {
		name: p.name,
		website: p.website,
		description: p.description,
		tags: Array.isArray(p.tags) ? p.tags.join(", ") : p.tags || "",
		category: p.category || "",
	};
	const preview = { summary, fields, directory: host(task.input.directoryUrl), formUrl: page.url() };
	const hash = createHash("sha1").update(JSON.stringify({ summary, fields })).digest("hex");

	if (task.data.approvedPreviewHash === hash) return { next: "submit", data: { preview } };

	await tools.screenshot("preview");
	const warnings = (task.data.unfilled || []).map((u) => `${u.label || "field"}: ${u.reason}`);
	return {
		pause: {
			state: STATES.WAITING_FOR_APPROVAL,
			card: previewCard(preview, warnings),
			message: "Review the submission preview, then approve to submit.",
			resumeStep: "submit",
			data: { preview, previewHash: hash },
		},
	};
}

async function stepSubmit(ctx) {
	const { page, tools, session } = ctx;
	if (session.restored) return { next: "analyze_form", data: { submitAttempted: false } };
	const task = await ctx.refresh();
	if (task.data.submitAttempted) return { next: "post_submit" };

	const g = await gate(ctx, { captcha: "any" });
	if (g) return g;

	const label = await markSubmitButton(page);
	if (!label) return { fail: "Could not find a submit button" };
	await patchData(task.id, { submitAttempted: true, submittedFrom: page.url() });
	await tools.screenshot("before-submit");
	ctx.log("info", `Submitting via "${label}"`);
	await tools.click('[data-da-submit="1"]');
	await page.waitForTimeout(1500);
	await tools.screenshot("after-submit");
	return { next: "post_submit" };
}

const SUCCESS_RE =
	/thank you|thanks for (submitting|your)|successfully (submitted|received|added)|submission (received|successful|complete)|has been (submitted|received|added)|we(?:'|’)?ll review|under review|pending (review|approval)|awaiting (review|approval)|check your email|confirm your email|moderat/;
const REVIEW_RE = /review|pending|moderat|approval|within \d|business days?|check your email|confirm your email|verification email/;

function expectedReviewDate(text) {
	const m =
		text.match(/(\d+)\s*(?:-|to|–)\s*(\d+)\s*(?:business\s+)?(hour|day|week)s?/) ||
		text.match(/within\s+(\d+)\s*(?:business\s+)?(hour|day|week)s?/);
	let ms = 7 * 24 * 3600_000;
	if (m) {
		const n = Number(m[m.length - 2] && /^\d+$/.test(m[m.length - 2]) ? m[m.length - 2] : m[1]);
		const unit = m[m.length - 1];
		ms = n * ({ hour: 3600_000, day: 24 * 3600_000, week: 7 * 24 * 3600_000 }[unit] || 24 * 3600_000);
	}
	return new Date(Date.now() + ms).toISOString();
}

async function stepPostSubmit(ctx) {
	const { page } = ctx;
	const urlBefore = (await ctx.refresh()).data.submittedFrom;
	await page.waitForTimeout(1200);
	const g = await gate(ctx, { captcha: "any", badge: "strong" });
	if (g) return g;

	const task = await ctx.refresh();
	const sig = ctx.signals;
	const text = sig.text.toLowerCase();
	const { errors, invalid } = await page.evaluate(() => {
		const vis = (e) => {
			const r = e.getBoundingClientRect();
			return r.width > 2 && r.height > 2 && getComputedStyle(e).visibility !== "hidden";
		};
		const errs = [
			...document.querySelectorAll(
				'[role=alert],.error,.errors,.invalid-feedback,.field-error,.form-error,.text-red-500,.text-danger,[class*="error"]',
			),
		]
			.filter(vis)
			.map((e) => (e.innerText || "").trim().slice(0, 160))
			.filter(Boolean);
		return { errors: [...new Set(errs)].slice(0, 5), invalid: [...document.querySelectorAll(":invalid")].filter(vis).length };
	});
	const fieldsLeft = (await collectFields(page)).length;
	const success = SUCCESS_RE.test(text);
	const urlChanged = page.url() !== urlBefore;

	let heuristic;
	if (success && !errors.length) {
		heuristic = { nextStep: REVIEW_RE.test(text) ? "verify" : "complete", requiresHuman: false, reason: "Success text on page", confidence: 0.85, strength: "strong" };
	} else if (errors.length || invalid) {
		heuristic = { nextStep: "continue", requiresHuman: false, reason: `Form errors: ${errors.join(" | ") || `${invalid} invalid fields`}`, confidence: 0.8, strength: "strong" };
	} else if (!fieldsLeft && urlChanged) {
		heuristic = { nextStep: "verify", requiresHuman: false, reason: "Form is gone but no explicit confirmation found", confidence: 0.5, strength: "weak" };
	} else {
		heuristic = { nextStep: "continue", requiresHuman: false, reason: "No confirmation found", confidence: 0.4, strength: "weak" };
	}
	const plan = await planNext({
		stage: "post_submit",
		signals: sig,
		heuristic,
		allowed: ["continue", "verify", "complete"],
		log: ctx.log,
		extra: { formErrors: errors, formStillPresent: fieldsLeft > 0, urlChanged },
	});
	ctx.log("info", `Result: ${plan.nextStep} (${plan.source}) – ${plan.reason}`);

	if (plan.nextStep === "continue") {
		if (errors.length || invalid) return { fail: `The directory rejected the form: ${errors.join(" | ") || "invalid fields"}`.slice(0, 280) };
		const loginDone = (task.data.cleared || {})[clearKey(task, "login")];
		if (fieldsLeft && loginDone && !task.data.resubmitted) {
			ctx.log("info", "Login happened during submit; filling the form once more");
			return { next: "analyze_form", data: { submitAttempted: false, resubmitted: true } };
		}
	}

	const conf = {
		confirmationUrl: page.url(),
		directory: host(task.input.directoryUrl),
		submittedAt: new Date().toISOString(),
		expectedReviewDate: expectedReviewDate(text),
		checks: 0,
		note: plan.nextStep === "continue" || plan.reason.startsWith("Form is gone") ? "No explicit confirmation was detected; verify with check-status." : undefined,
	};
	if (plan.nextStep === "complete") {
		return { done: { message: "Submission confirmed", data: { confirmation: conf } } };
	}
	return { sleep: { conf, message: conf.note || "Submitted — waiting for directory review." } };
}

async function findListing(page, task) {
	const wantedHost = host(task.input.product.website).replace(/^www\./, "");
	const name = task.input.product.name.toLowerCase();
	const ownHost = host(page.url());
	return page.evaluate(
		({ wantedHost, name, ownHost }) => {
			for (const a of document.querySelectorAll("a[href]")) {
				if (a.closest("form")) continue;
				let h;
				try {
					h = new URL(a.href);
				} catch {
					continue;
				}
				const text = (a.innerText || "").trim().toLowerCase();
				if (h.hostname.replace(/^www\./, "") === wantedHost && h.hostname !== ownHost) return a.href;
				if (text && text === name) return a.href;
			}
			return null;
		},
		{ wantedHost, name, ownHost },
	);
}

async function stepCheckStatus(ctx) {
	const { page, tools, log } = ctx;
	const task = await ctx.refresh();
	const conf = task.data.confirmation;
	if (!conf?.confirmationUrl) return { fail: "No confirmation URL stored for this task" };

	await tools.open(conf.confirmationUrl);
	const g = await gate(ctx, { captcha: "interstitial" });
	if (g) return g;

	const text = await tools.extract("text", { maxChars: 4000 });
	const cls = await classifyListing({ text, productName: task.input.product.name, log });
	let listing = await findListing(page, task);
	if (!listing && task.input.directoryUrl !== conf.confirmationUrl) {
		await tools.open(task.input.directoryUrl);
		listing = await findListing(page, task);
	}
	await tools.screenshot("status-check");
	log("info", `Status check: ${cls.status}${listing ? `, listing found at ${listing}` : ""}`);

	if (cls.status === "rejected") return { fail: "The directory rejected this listing" };
	if (cls.status === "approved" || listing) {
		return { done: { message: "Listing is live", data: { confirmation: { ...conf, listingUrl: listing || undefined, lastCheckedAt: new Date().toISOString() } } } };
	}
	const checks = (conf.checks || 0) + 1;
	return {
		sleep: {
			conf: { ...conf, checks, lastCheckedAt: new Date().toISOString() },
			message: `Still pending (check ${checks}).`,
		},
	};
}

const HANDLERS = {
	find_submission_page: stepFind,
	analyze_form: stepAnalyze,
	fill_form: stepFill,
	badge_check: stepBadge,
	preview: stepPreview,
	submit: stepSubmit,
	post_submit: stepPostSubmit,
	check_status: stepCheckStatus,
};

/* ------------------------------- run loop ------------------------------ */

function makeCtx(id, session) {
	const ctx = {
		id,
		session,
		page: session.page,
		tools: makeTools(id),
		signals: null,
		refresh: () => getTask(id),
		log: (level, msg) => appendLog(id, level, msg),
	};
	return ctx;
}

async function applyOutcome(ctx, out) {
	const { id } = ctx;
	if (out.next) {
		await updateTask(id, (t) => {
			if (out.next !== t.currentStep) t.data.cleared = {};
			t.currentStep = out.next;
			if (out.data) t.data = { ...t.data, ...out.data };
		});
		return false;
	}
	if (out.pause) {
		const p = out.pause;
		const task = await getTask(id);
		await ctx.tools.screenshot(p.state.toLowerCase()).catch(() => {});
		const ref = await ctx.tools.pause(p.state).catch(() => null);
		await setState(id, p.state, {
			currentStep: p.resumeStep || task.currentStep,
			card: p.card,
			humanMessage: p.message,
			session: ref,
			data: { lastUrl: ctx.page.url(), ...(p.data || {}) },
			message: `Paused: ${p.message}`,
		});
		return true;
	}
	if (out.sleep) {
		const { conf, message } = out.sleep;
		const nextCheckAt = (conf.checks || 0) >= MAX_AUTO_CHECKS ? null : new Date(Date.now() + CHECK_INTERVAL_MS).toISOString();
		await ctx.tools.screenshot("waiting-confirmation").catch(() => {});
		await closeSession(id, { stateFile: storageStateFile(id) });
		await setState(id, STATES.WAITING_FOR_CONFIRMATION, {
			currentStep: "check_status",
			card: confirmationCard(conf),
			humanMessage: message,
			session: null,
			nextCheckAt,
			data: { confirmation: conf },
			message,
		});
		return true;
	}
	if (out.done) {
		await endTask(id, STATES.COMPLETED, {
			humanMessage: out.done.message,
			message: out.done.message,
			data: out.done.data,
			error: null,
		}, true);
		return true;
	}
	if (out.fail) {
		await endTask(id, STATES.FAILED, { error: out.fail, humanMessage: out.fail, message: `Failed: ${out.fail}`, level: "error" }, true);
		return true;
	}
	return true;
}

async function runLoop(id) {
	let task = await getTask(id);
	if (!task || isTerminal(task.state) || isWaiting(task.state) || cancelled.has(id)) return;

	const session = await ensureSession(id);
	if (!session) {
		if (!queued.includes(id)) queued.push(id);
		if (task.state !== STATES.QUEUED) {
			await setState(id, STATES.QUEUED, { message: "Waiting for a free browser slot" });
		}
		return;
	}
	if (task.state !== STATES.RUNNING) {
		await setState(id, STATES.RUNNING, { session: sessionRef(session) });
	}

	for (let i = 0; i < STEP_BUDGET; i++) {
		task = await getTask(id);
		if (!task || isTerminal(task.state) || isWaiting(task.state) || cancelled.has(id)) return;
		const handler = HANDLERS[task.currentStep];
		if (!handler) return failTask(id, new Error(`Unknown step ${task.currentStep}`));

		const ctx = makeCtx(id, getSession(id) || session);
		let out;
		try {
			out = await handler(ctx);
		} catch (e) {
			if (cancelled.has(id)) return;
			out = { fail: `${task.currentStep}: ${e.message.split("\n")[0]}` };
		}
		if (cancelled.has(id)) return;
		if (await applyOutcome(ctx, out)) return;
	}
	await failTask(id, new Error("Step budget exceeded"));
}

/* ---------------------------- badge verification ----------------------- */

async function verifyBadgeRemote(task) {
	const code = task.data.badge?.badgeCode;
	if (!code) return { ok: true };
	const places = [];
	const repo = parseRepo(task.input.githubRepo);
	if (repo) {
		places.push(`GitHub README (${repo.slug})`);
		try {
			if (containsBadge(await readRepoReadme(repo), code)) return { ok: true, where: places[0] };
		} catch {
			/* try website */
		}
	}
	const site = task.input.product.website;
	if (site) {
		places.push(site);
		try {
			const res = await fetch(await assertPublicHttpUrl(site, "website"), {
				signal: AbortSignal.timeout(20_000),
				headers: { "User-Agent": "Mozilla/5.0 (directory-agent badge check)" },
			});
			if (containsBadge(await res.text(), code)) return { ok: true, where: site };
		} catch {
			/* not found */
		}
	}
	return { ok: false, message: `Badge not found on ${places.join(" or ") || "any known location"} yet. Add it, wait for deploy, then approve again.` };
}

/** Click the directory's own "verify" button, then look for failure text. */
async function directoryVerify(id, log) {
	const session = getSession(id) || (await ensureSession(id));
	if (!session) return { ok: true };
	const tools = makeTools(id);
	const sig = await collectSignals(session.page);
	if (!sig.badge.verifyButton || !(await session.page.locator('[data-da-verify="1"]').count())) {
		if (sig.badge.verifyButton) log("info", `Directory has a "${sig.badge.verifyButton}" control that was left for the human`);
		return { ok: true };
	}
	await tools.click('[data-da-verify="1"]');
	await session.page.waitForTimeout(1500);
	const text = (await tools.extract("text", { maxChars: 3000 })).toLowerCase();
	await tools.screenshot("badge-verify");
	const failed = /(badge|verif|ownership)[^.\n]{0,80}(not found|could not|couldn.t|failed|unable|missing|invalid)|(not found|could not|failed|unable to verify)[^.\n]{0,80}(badge|ownership)/.test(text);
	log("info", `Directory verification ${failed ? "failed" : "passed"}`);
	return failed ? { ok: false, message: "The directory could not find the badge yet." } : { ok: true };
}

async function jobVerifyBadge(id, { force = false } = {}) {
	const task = await getTask(id);
	if (!task || isTerminal(task.state)) return;
	let ok = force;
	let message = "";
	if (!force) {
		const r = await verifyBadgeRemote(task);
		ok = r.ok;
		message = r.message || "";
		if (ok) {
			const d = await directoryVerify(id, (l, m) => appendLog(id, l, m));
			ok = d.ok;
			message = d.message || "";
		}
	}
	if (ok) {
		await patchData(id, { badge: { ...task.data.badge, verified: true, verifiedAt: new Date().toISOString() } });
		await appendLog(id, "info", force ? "Badge accepted by human" : "Badge verified");
		return runLoop(id);
	}
	const session = getSession(id);
	await setState(id, STATES.WAITING_FOR_BADGE, {
		card: badgeCard(task.data.badge, message),
		humanMessage: message,
		session: sessionRef(session),
		message: `Badge not verified: ${message}`,
		level: "warn",
	});
}

async function jobGithubBadge(id) {
	const task = await getTask(id);
	if (!task || isTerminal(task.state)) return;
	const repo = parseRepo(task.input.githubRepo);
	try {
		const r = await addBadgeToReadme({ repo, badgeCode: task.data.badge.badgeCode, workRoot: taskDir(id) });
		await appendLog(id, "info", r.changed ? `Pushed badge to ${repo.slug}/${r.file}` : "Badge already present in README");
		await new Promise((r2) => setTimeout(r2, 2500));
	} catch (e) {
		const msg = `Automatic GitHub update failed: ${e.message.slice(0, 200)}`;
		await setState(id, STATES.WAITING_FOR_BADGE, {
			card: badgeCard(task.data.badge, msg),
			humanMessage: msg,
			session: sessionRef(getSession(id)),
			data: { githubDeclined: true },
			message: msg,
			level: "warn",
		});
		return;
	}
	return jobVerifyBadge(id);
}

/* ------------------------------ public API ------------------------------ */

async function mustGet(id) {
	const t = await getTask(id);
	if (!t) throw new AgentError(404, "Task not found");
	return t;
}

export async function createAndStart(input) {
	input.directoryUrl = await assertPublicHttpUrl(input.directoryUrl, "directoryUrl");
	if (input.submissionUrl) input.submissionUrl = await assertPublicHttpUrl(input.submissionUrl, "submissionUrl");
	if (input.product.website) input.product.website = await assertPublicHttpUrl(input.product.website, "product.website");
	if (input.githubRepo && !parseRepo(input.githubRepo)) throw new AgentError(400, "githubRepo must be owner/repo");
	const task = await createTask(input);
	await appendLog(task.id, "info", `Task created for ${host(input.directoryUrl)}`);
	startRun(task.id);
	return task;
}

export async function getFullTask(id) {
	return mustGet(id);
}

export async function resumeTask(id, { force = false } = {}) {
	const task = await mustGet(id);
	switch (task.state) {
		case STATES.WAITING_FOR_LOGIN:
		case STATES.WAITING_FOR_CAPTCHA: {
			const kind = task.state === STATES.WAITING_FOR_LOGIN ? "login" : "captcha";
			const cleared = { ...(task.data.cleared || {}), [clearKey(task, kind)]: true };
			await setState(id, STATES.RUNNING, { data: { cleared }, message: "Resumed by human" });
			startRun(id);
			break;
		}
		case STATES.WAITING_FOR_BADGE:
			if (task.card?.type === "github_badge") throw new AgentError(409, "Choose whether the agent should add the badge automatically");
			await setState(id, STATES.RUNNING, { message: "Verifying badge" });
			schedule(id, () => jobVerifyBadge(id, { force }));
			break;
		default:
			throw new AgentError(409, `Cannot resume a task in state ${task.state}`);
	}
	return getTask(id);
}

export async function approveTask(id, body = {}) {
	const task = await mustGet(id);
	switch (task.state) {
		case STATES.WAITING_FOR_LOGIN:
		case STATES.WAITING_FOR_CAPTCHA: {
			if (task.liveSessionOpen) return resumeTask(id);
			if (!(await ensureSession(id))) throw new AgentError(503, "No free browser slot; try again shortly");
			return updateTask(id, (t) => {
				t.liveSessionOpen = true;
				t.card = continueCard(t);
				t.humanMessage = "Live browser is open. Complete the step, then press Continue.";
			});
		}
		case STATES.WAITING_FOR_BADGE:
			if (task.card?.type === "github_badge") {
				await setState(id, STATES.RUNNING, { message: "Adding badge to GitHub README" });
				schedule(id, () => jobGithubBadge(id));
				return getTask(id);
			}
			return resumeTask(id, { force: Boolean(body.force) });
		case STATES.WAITING_FOR_APPROVAL:
			await setState(id, STATES.RUNNING, {
				currentStep: "submit",
				data: { approvedPreviewHash: task.data.previewHash },
				message: "Submission approved by human",
			});
			startRun(id);
			return getTask(id);
		case STATES.WAITING_FOR_CONFIRMATION:
			return checkStatus(id);
		default:
			throw new AgentError(409, `Nothing to approve in state ${task.state}`);
	}
}

export async function declineTask(id) {
	const task = await mustGet(id);
	if (task.state === STATES.WAITING_FOR_BADGE && task.card?.type === "github_badge") {
		return updateTask(id, (t) => {
			t.card = badgeCard(t.data.badge);
			t.humanMessage = "Add the badge manually, then approve.";
			t.data.githubDeclined = true;
		});
	}
	return cancelTask(id, "Declined by human");
}

export async function cancelTask(id, reason = "Cancelled by human") {
	const task = await mustGet(id);
	if (isTerminal(task.state)) throw new AgentError(409, `Task already ${task.state}`);
	cancelled.add(id);
	const qi = queued.indexOf(id);
	if (qi >= 0) queued.splice(qi, 1);
	await closeSession(id, { stateFile: storageStateFile(id) });
	await setState(id, STATES.CANCELLED, { humanMessage: reason, message: reason, session: null });
	return getTask(id);
}

export async function checkStatus(id, { wait = false } = {}) {
	const task = await mustGet(id);
	if (task.state !== STATES.WAITING_FOR_CONFIRMATION) {
		throw new AgentError(409, `check-status needs WAITING_FOR_CONFIRMATION (task is ${task.state})`);
	}
	await setState(id, STATES.RUNNING, { currentStep: "check_status", message: "Checking directory status" });
	const job = startRun(id);
	if (wait) await job;
	return getTask(id);
}

/* --------------------------- recovery & scheduler ------------------------ */

export async function recoverTasks() {
	for (const t of await listTasks()) {
		try {
			if (t.state !== STATES.RUNNING && t.state !== STATES.QUEUED) continue;
			const mid = ["submit", "post_submit"].includes(t.currentStep) && t.data.submitAttempted;
			if (mid) {
				const conf = {
					confirmationUrl: t.data.submittedFrom || t.input.directoryUrl,
					directory: host(t.input.directoryUrl),
					submittedAt: new Date().toISOString(),
					expectedReviewDate: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
					checks: 0,
					note: "Server restarted during submission; verify with check-status.",
				};
				await setState(t.id, STATES.WAITING_FOR_CONFIRMATION, {
					currentStep: "check_status",
					card: confirmationCard(conf),
					humanMessage: conf.note,
					nextCheckAt: new Date().toISOString(),
					data: { confirmation: conf },
					message: conf.note,
				});
			} else {
				await appendLog(t.id, "info", "Recovered after server restart; continuing");
				startRun(t.id);
			}
		} catch {
			/* keep recovering the rest */
		}
	}
}

/** Expire 24h pauses and fire due follow-up checks. */
export async function sweep() {
	const now = Date.now();
	for (const t of await listTasks()) {
		try {
			if (isTerminal(t.state)) continue;
			if (t.state === STATES.WAITING_FOR_CONFIRMATION) {
				if (t.nextCheckAt && Date.parse(t.nextCheckAt) <= now) await checkStatus(t.id);
			} else if (isWaiting(t.state) && t.pauseExpiresAt && Date.parse(t.pauseExpiresAt) <= now) {
				await endTask(t.id, STATES.FAILED, {
					error: "Paused for more than 24 hours without a response",
					humanMessage: "Expired: no human response within 24 hours.",
					message: "Pause expired after 24h",
					level: "warn",
				});
			} else if (t.state === STATES.QUEUED && !queued.includes(t.id) && sessionCount() < MAX_SESSIONS) {
				startRun(t.id);
			}
		} catch {
			/* next task */
		}
	}
}

let timer = null;
export function startScheduler() {
	if (timer || process.env.DIRECTORY_AGENT_SCHEDULER === "0") return;
	timer = setInterval(() => sweep().catch(() => {}), Number(process.env.DIRECTORY_AGENT_SWEEP_MS || 60_000));
	timer.unref?.();
}
export function stopScheduler() {
	if (timer) clearInterval(timer);
	timer = null;
}

export { cancelled as _cancelled };
