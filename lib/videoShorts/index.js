/**
 * /video-shorts — AI agent that turns one product (SaaS URL, blog, GitHub repo, llms.txt) into
 * several different short videos (< 60 s), with or without audio.
 *
 *   preflight → gather context (parallel) → analyse frames (vision) → product brief
 *   → plan N concepts → N storyboards (parallel) → N renders (parallel, limited) → UploadThing
 *
 * Rendering reuses renderStoryboardVideo() from lib/urlToVideo. Browser work is injected (see deps
 * in index.js: scrape, captureSections, capture, renderHtml).
 */
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { openRouterChat, DEFAULT_CHAT_MODEL } from "../openrouter.js";
import { normalizeOpenRouterTtsVoice } from "../openRouterTts.js";
import {
	PRICE_TABLE,
	TTS_USD_PER_MIN,
	analyzeFrames,
	displayUrl,
	groupCost,
	parseJson,
	renderStoryboardVideo,
	round,
	sanitizeStoryboard,
	verifyOpenRouterKey,
} from "../urlToVideo/index.js";
import { ensureFfmpeg } from "../urlToVideo/media.js";
import { gatherProductContext } from "./context.js";
import {
	BRIEF_ANALYST_SYSTEM,
	CONCEPT_PLANNER_SYSTEM,
	FORMATS,
	SHORT_DIRECTOR_SYSTEM,
	buildBriefUserText,
	buildConceptUserText,
	buildShortDirectorUserText,
} from "./prompts.js";

const OUTPUT_ROOT = process.env.VIDEO_SHORTS_OUTPUT_DIR?.trim() || path.join(os.tmpdir(), "video-shorts");
const SCRIPT_MODEL = process.env.VIDEO_SHORTS_SCRIPT_MODEL?.trim() || process.env.URL_VIDEO_SCRIPT_MODEL?.trim() || DEFAULT_CHAT_MODEL;
const VISION_MODEL = process.env.URL_VIDEO_VISION_MODEL?.trim() || "google/gemini-2.5-flash";
const TTS_MODEL = process.env.URL_VIDEO_TTS_MODEL?.trim() || "openai/gpt-audio-mini";
const MAX_SHORT_SEC = 59;

const jobs = new Map();

/* ------------------------------------------------------------------ input */

const bool = (v, d) => (v === undefined || v === null ? d : v === true || v === "true" || v === 1);
const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : d));

function normUrl(raw) {
	const s = String(raw || "").trim();
	if (!s) return null;
	try {
		return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).toString();
	} catch {
		return null;
	}
}

export function parseShortsInput(body = {}) {
	const url = normUrl(body.url);
	if (!url) return { error: "`url` (SaaS website, blog or GitHub repo) is required" };
	// `audio: false` is a shortcut for a fully silent video; otherwise audio.* switches each layer.
	const audio = body.audio === false ? { narration: false, music: "none", sfx: false } : body.audio && typeof body.audio === "object" ? body.audio : {};
	const narration = bool(audio.narration ?? body.narration, true);
	const formats = (Array.isArray(body.formats) ? body.formats : []).filter((f) => FORMATS[f]);
	return {
		input: {
			url,
			github_url: normUrl(body.github_url),
			blog_url: normUrl(body.blog_url),
			extra_urls: (Array.isArray(body.extra_urls) ? body.extra_urls : []).map(normUrl).filter(Boolean).slice(0, 3),
			branch: body.branch ? String(body.branch) : null,
			variations: Math.round(clamp(body.variations, 1, 6, 3)),
			formats,
			target_duration_sec: Math.round(clamp(body.duration_sec ?? body.duration, 10, MAX_SHORT_SEC, 30)),
			max_total_sec: MAX_SHORT_SEC,
			aspect: ["9:16", "1:1", "16:9"].includes(body.aspect) ? body.aspect : "9:16",
			tone: String(body.tone || "punchy, confident, modern").slice(0, 80),
			language: String(body.language || "en").slice(0, 20),
			audience: body.audience ? String(body.audience).slice(0, 120) : null,
			narration,
			voice: normalizeOpenRouterTtsVoice(audio.voice || body.voice || "nova") || "nova",
			music: String(audio.music ?? body.music ?? "auto"),
			music_volume: clamp(audio.music_volume ?? body.music_volume, 0, 0.6, narration ? 0.18 : 0.5),
			sfx: bool(audio.sfx ?? body.sfx, true),
			captions: bool(body.captions, narration),
			script_model: String(body.script_model || SCRIPT_MODEL),
			vision_model: String(body.vision_model || VISION_MODEL),
			tts_model: String(body.tts_model || TTS_MODEL),
			analyze_screenshots: body.analyze_screenshots !== false,
			max_screenshots: Math.round(clamp(body.max_screenshots, 2, 12, 8)),
			max_images: Math.round(clamp(body.max_images, 0, 10, 6)),
			max_blog_posts: Math.round(clamp(body.max_blog_posts, 0, 6, 3)),
			render_concurrency: Math.round(clamp(body.render_concurrency, 1, 4, 2)),
			upload: body.upload !== false,
			theme: null,
		},
	};
}

/* --------------------------------------------------------------- estimate */

function price(model) {
	return PRICE_TABLE[model] || PRICE_TABLE["anthropic/claude-sonnet-4"];
}

export function estimateShortsCost(input) {
	const [vIn, vOut] = price(input.vision_model);
	const [sIn, sOut] = price(input.script_model);
	const frames = input.max_screenshots + input.max_images;
	const vision = input.analyze_screenshots ? ((frames * 1300 + 900) * vIn + 2500 * vOut) / 1e6 : 0;
	const brief = (14_000 * sIn + 1_800 * sOut) / 1e6;
	const concepts = (5_000 * sIn + 1_500 * sOut) / 1e6;
	const scripts = input.variations * ((6_000 * sIn + 1_600 * sOut) / 1e6);
	const tts = input.narration ? input.variations * (input.target_duration_sec / 60) * (TTS_USD_PER_MIN[input.tts_model] ?? 0.08) * 1.1 : 0;
	const total = vision + brief + concepts + scripts + tts;
	return {
		currency: "USD",
		estimated: true,
		breakdown: {
			vision_analysis: round(vision),
			product_brief: round(brief),
			concept_planning: round(concepts),
			storyboards: round(scripts),
			narration_tts: round(tts),
			screenshots_images_render_music: 0,
		},
		total_usd: round(total),
		per_video_usd: round(total / input.variations),
	};
}

/* ------------------------------------------------------------------- jobs */

const jobDir = (id) => path.join(OUTPUT_ROOT, id);

function publicJob(job) {
	const { logs = [], ...rest } = job;
	return { ...rest, logs: logs.slice(-60) };
}

async function save(job) {
	job.updated_at = new Date().toISOString();
	await fsp.mkdir(jobDir(job.id), { recursive: true });
	await fsp.writeFile(path.join(jobDir(job.id), "manifest.json"), JSON.stringify(job, null, 2)).catch(() => {});
}

const safeId = (id) => String(id || "").replace(/[^a-zA-Z0-9-]/g, "");

export async function getShortsJob(id) {
	const sid = safeId(id);
	if (!sid) return null;
	if (jobs.has(sid)) return publicJob(jobs.get(sid));
	try {
		return publicJob(JSON.parse(await fsp.readFile(path.join(jobDir(sid), "manifest.json"), "utf8")));
	} catch {
		return null;
	}
}

export async function listShortsJobs(limit = 20) {
	const dirs = await fsp.readdir(OUTPUT_ROOT).catch(() => []);
	const rows = [];
	for (const d of dirs) {
		const j = jobs.get(d) || (await fsp.readFile(path.join(OUTPUT_ROOT, d, "manifest.json"), "utf8").then(JSON.parse).catch(() => null));
		if (!j) continue;
		rows.push({
			id: j.id,
			url: j.input?.url,
			status: j.status,
			step: j.step,
			progress: j.progress,
			product: j.brief?.product_name || null,
			variants: (j.variants || []).map((v) => ({ id: v.id, status: v.status, title: v.concept?.title, format: v.concept?.format, video_url: v.result?.video_url || null, video_path: v.result?.video_path || null })),
			total_usd: j.cost?.total_usd ?? null,
			created_at: j.created_at,
		});
	}
	return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
}

/** Resolve a file inside a job folder (for the dashboard's local previews). Returns null if outside. */
export function resolveShortsFile(id, rel) {
	const base = path.resolve(jobDir(safeId(id)));
	const abs = path.resolve(base, String(rel || ""));
	if (!abs.startsWith(base + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
	return abs;
}

export async function createShortsJob(input, deps, { wait = false } = {}) {
	await ensureFfmpeg();
	await verifyOpenRouterKey();
	const id = uuidv4();
	const job = {
		id,
		status: "pending",
		step: "queued",
		progress: 0,
		input,
		estimate: estimateShortsCost(input),
		sources: [],
		frames: [],
		brief: null,
		variants: [],
		cost: null,
		error: null,
		logs: [],
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};
	jobs.set(id, job);
	await save(job);
	const p = runShorts(job, deps).catch(async (err) => {
		console.error(`[video-shorts] ${id} failed:`, err);
		job.status = "failed";
		job.error = err?.message || String(err);
		await save(job);
	});
	if (wait) await p;
	return publicJob(job);
}

/* --------------------------------------------------------------- pipeline */

async function chatJson({ model, system, user, costs, stage, variant, maxTokens = 5000, temperature = 0.6 }) {
	let lastErr;
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const res = await openRouterChat({
				model,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				temperature,
				maxTokens,
				jsonMode: true,
				timeoutMs: 180_000,
			});
			costs.push({ stage, variant: variant || null, model: res.model, usd: res.usage.cost, tokens: res.usage.total_tokens, estimated: false });
			return parseJson(res.content);
		} catch (e) {
			lastErr = e;
		}
	}
	throw lastErr;
}

async function runShorts(job, deps) {
	const input = job.input;
	const workDir = jobDir(job.id);
	const costs = [];
	const log = (msg) => {
		job.logs.push(`${new Date().toISOString()} ${msg}`);
		console.log(`[video-shorts ${job.id.slice(0, 8)}] ${msg}`);
	};
	const step = async (name, progress) => {
		Object.assign(job, { step: name, progress, status: "running" });
		log(`step: ${name}`);
		await save(job);
	};
	const rel = (abs) => (abs ? path.relative(workDir, abs) : null);

	// 1. Context -------------------------------------------------------------
	await step("gather_context", 5);
	const gathered = await gatherProductContext({ input, deps, workDir, log });
	job.sources = gathered.sources;
	await fsp.writeFile(path.join(workDir, "context.json"), JSON.stringify(gathered.context, null, 2));

	// 2. Vision analysis of every screenshot + image -----------------------
	await step("analyze_frames", 22);
	const notes = await analyzeFrames({ frames: gathered.frames, input, costs, log });
	const frameList = gathered.frames.map((f) => {
		const n = notes.find((x) => x.id === f.id) || {};
		return { id: f.id, kind: f.kind, summary: n.summary, headline: n.headline, quality: n.quality, use_for: n.use_for, motion: n.motion };
	});
	job.frames = gathered.frames.map((f) => ({ id: f.id, kind: f.kind, source: f.source, preview_path: rel(f.preview), ...frameList.find((x) => x.id === f.id) }));
	await save(job);

	// 3. Product brief --------------------------------------------------------
	await step("product_brief", 32);
	const brief = await chatJson({
		model: input.script_model,
		system: BRIEF_ANALYST_SYSTEM,
		user: buildBriefUserText(gathered.context),
		costs,
		stage: "product_brief",
		temperature: 0.3,
	});
	job.brief = brief;
	await save(job);

	// 4. Concepts -------------------------------------------------------------
	await step("plan_concepts", 40);
	const usable = frameList.filter((f) => f.use_for !== "skip");
	const planned = await chatJson({
		model: input.script_model,
		system: CONCEPT_PLANNER_SYSTEM,
		user: buildConceptUserText({
			brief,
			frames: usable,
			constraints: {
				variations: input.variations,
				preferred_formats: input.formats.length ? input.formats : "any",
				target_duration_sec: input.target_duration_sec,
				aspect: input.aspect,
				tone: input.tone,
				audience: input.audience,
				narration: input.narration,
			},
		}),
		costs,
		stage: "concept_planning",
		temperature: 0.9,
	});
	const concepts = normalizeConcepts(planned?.concepts, input, brief, usable);
	job.variants = concepts.map((c) => ({ id: c.id, concept: c, status: "pending", step: "queued", progress: 0, error: null, result: null }));
	await save(job);

	// 5. Storyboards — all concepts in parallel -------------------------------
	await step("storyboards", 48);
	const codeFiles = gathered.codeFiles.map(({ path: p, line_count, preview }) => ({ path: p, line_count, preview }));
	await Promise.all(
		job.variants.map(async (v) => {
			v.status = "scripting";
			try {
				const board = await chatJson({
					model: input.script_model,
					system: SHORT_DIRECTOR_SYSTEM,
					user: buildShortDirectorUserText({
						concept: v.concept,
						brief,
						frames: usable,
						codeFiles,
						constraints: {
							target_duration_sec: input.target_duration_sec,
							max_duration_sec: MAX_SHORT_SEC - 2,
							aspect: input.aspect,
							narration: input.narration,
							language: input.language,
							tone: input.tone,
						},
					}),
					costs,
					stage: "storyboard",
					variant: v.id,
					temperature: 0.8,
				});
				const sb = sanitizeStoryboard(board, {
					frames: usable,
					codeFiles,
					input: { max_scenes: 16 },
					source: { ...gathered.source, url: brief?.cta?.url || gathered.source.url },
				});
				if (!input.narration) for (const sc of sb.scenes) sc.narration = "";
				fitPlannedDuration(sb, input.target_duration_sec);
				sb.theme = board?.theme || v.concept.theme || {};
				sb.music = { ...(sb.music || {}), mood: sb.music?.mood || v.concept.music_mood };
				v.storyboard = sb;
				v.caption = String(board?.caption || "").slice(0, 300);
				v.status = "queued";
			} catch (e) {
				v.status = "failed";
				v.error = `storyboard: ${e.message}`;
			}
		}),
	);
	await save(job);

	// 6. Renders — limited parallelism (CPU-bound FFmpeg + one browser page each) ---
	await step("render", 55);
	const toRender = job.variants.filter((v) => v.storyboard);
	let done = 0;
	const queue = [...toRender];
	await Promise.all(
		Array.from({ length: Math.min(input.render_concurrency, queue.length) }, async () => {
			while (queue.length) {
				const v = queue.shift();
				const vDir = path.join(workDir, "variants", v.id);
				v.status = "rendering";
				try {
					const vCosts = [];
					const out = await renderStoryboardVideo({
						storyboard: v.storyboard,
						frames: gathered.frames,
						notes,
						repoDir: gathered.repoDir,
						input: { ...input, theme: null },
						workDir: vDir,
						deps,
						costs: vCosts,
						log: (m) => log(`[${v.id}] ${m}`),
						step: async (name, pr) => {
							v.step = name;
							v.progress = pr;
							await save(job);
						},
						uploadId: `${job.id.slice(0, 8)}-${v.id}`,
						uploadScreenshots: false,
					});
					for (const c of vCosts) costs.push({ ...c, variant: v.id });
					v.result = {
						video_url: out.urls.video || null,
						video_path: rel(out.finalVideo),
						duration_sec: round(out.finalDuration, 2),
						resolution: `${out.size.width}x${out.size.height}`,
						has_audio: input.narration || input.music.toLowerCase() !== "none" || input.sfx,
						title: v.storyboard.title,
						logline: v.storyboard.logline,
						caption: v.caption,
						music: out.musicInfo ? { source: out.musicInfo.source, title: out.musicInfo.title, attribution: out.musicInfo.attribution } : null,
						thumbnail_path: rel(v.storyboard.scenes[0]?.frame_file),
						thumbnail_url: out.urls[`frame_${v.storyboard.scenes[0]?.id}`] || null,
						scenes: v.storyboard.scenes.map(({ narration_file, frame_file, clip_file, ...s }) => ({ ...s, frame_path: rel(frame_file) })),
					};
					v.status = "success";
					v.step = "done";
					v.progress = 100;
				} catch (e) {
					v.status = "failed";
					v.error = e.message;
					log(`[${v.id}] render failed: ${e.message}`);
				}
				done++;
				job.progress = 55 + Math.round((done / toRender.length) * 44);
				await save(job);
			}
		}),
	);

	const total = costs.reduce((a, c) => a + (c.usd || 0), 0);
	const byVariant = {};
	for (const c of costs) if (c.variant) byVariant[c.variant] = round((byVariant[c.variant] || 0) + (c.usd || 0), 6);
	job.cost = { currency: "USD", total_usd: round(total), by_stage: groupCost(costs), by_variant: byVariant, items: costs.map((c) => ({ ...c, usd: round(c.usd || 0, 6) })) };
	const ok = job.variants.filter((v) => v.status === "success").length;
	job.status = ok ? (ok === job.variants.length ? "success" : "partial") : "failed";
	if (!ok) job.error = job.variants.map((v) => `${v.id}: ${v.error}`).join("; ") || "No variants rendered";
	job.step = "done";
	job.progress = 100;
	log(`done: ${ok}/${job.variants.length} videos, cost $${total.toFixed(4)}`);
	await save(job);
	if (gathered.repoDir) await fsp.rm(gathered.repoDir, { recursive: true, force: true }).catch(() => {});
}

/** Ensure N distinct, valid concepts even if the planner under-delivers. */
function normalizeConcepts(raw, input, brief, frames) {
	const allowed = Object.keys(FORMATS).filter((f) => {
		if (f === "dev_showcase") return brief?.has_github;
		if (f === "blog_insight") return brief?.has_blog || brief?.blog_insights?.length;
		if (f === "social_proof") return brief?.proof?.length;
		return true;
	});
	const preferred = input.formats.length ? input.formats.filter((f) => allowed.includes(f)) : [];
	const used = new Set();
	const frameIds = new Set(frames.map((f) => f.id));
	const out = [];
	for (const c of Array.isArray(raw) ? raw : []) {
		if (out.length >= input.variations) break;
		const format = FORMATS[c?.format] && !used.has(c.format) ? c.format : null;
		if (!format) continue;
		used.add(format);
		out.push({
			id: `v${out.length + 1}`,
			format,
			title: String(c.title || format).slice(0, 60),
			angle: String(c.angle || "").slice(0, 200),
			hook: String(c.hook || brief?.hooks?.[out.length] || "").slice(0, 80),
			audience: String(c.audience || input.audience || "").slice(0, 120),
			pace: c.pace === "medium" ? "medium" : "fast",
			music_mood: c.music_mood || "energetic",
			frame_ids: (Array.isArray(c.frame_ids) ? c.frame_ids : []).filter((id) => frameIds.has(id)).slice(0, 5),
			theme: c.theme || null,
		});
	}
	const fill = [...preferred, ...allowed].filter((f, i, a) => a.indexOf(f) === i && !used.has(f));
	while (out.length < input.variations && fill.length) {
		const format = fill.shift();
		used.add(format);
		out.push({ id: `v${out.length + 1}`, format, title: format.replace(/_/g, " "), angle: brief?.one_liner || "", hook: brief?.hooks?.[out.length] || "", audience: input.audience || "", pace: "fast", music_mood: "energetic", frame_ids: [], theme: null });
	}
	return out;
}

/** Scale planned scene durations so a silent cut lands on the requested length. */
function fitPlannedDuration(sb, target) {
	const sum = sb.scenes.reduce((a, s) => a + s.duration_sec, 0);
	const goal = Math.min(MAX_SHORT_SEC - 1, target);
	if (!sum || Math.abs(sum - goal) / goal < 0.1) return;
	const k = goal / sum;
	for (const s of sb.scenes) s.duration_sec = round(Math.min(8, Math.max(1.8, s.duration_sec * k)), 2);
}

export { FORMATS, displayUrl };
