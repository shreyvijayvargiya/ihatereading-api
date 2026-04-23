/**
 * Video translate / dub pipeline (OpenRouter + FFmpeg + UploadThing + Firestore):
 * 1) Video URL → download (HTTP fetch, or yt-dlp for YouTube watch/shorts/youtu.be) → base64 data URL for Gemini.
 * 2) Gemini: transcribe + translate → JSON { transcript, translation } via response_format json_object.
 * 3) TTS: optional CUSTOM_TTS_API_URL (JSON pcm16), else OpenRouter streaming (openai/gpt-audio, audio.format pcm16).
 * 4) FFmpeg: strip audio, mux new audio → final MP4.
 * 5) Upload final MP4 to UploadThing; persist job in Firestore.
 */
import { v4 as uuidv4 } from "uuid";
import { execFile } from "child_process";
import youtubedl, { create as createYoutubeDl } from "youtube-dl-exec";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../config/firebase.js";
import { UTApi, UTFile } from "uploadthing/server";
import { VIDEO_TRANSLATE_TARGET_LANGUAGES } from "./videoTranslateLanguages.js";
import {
	mergeOpenRouterUsage,
	normalizeOpenRouterUsage,
	buildUsageResponseFields,
	publicTranslateUsageFromDoc,
} from "./openRouterUsage.js";
import { resolveTranslateLlmModel } from "./translateLlmModels.js";
import { ACTIVE_OPENROUTER_MODELS } from "./activeOpenRouterModels.js";

export { VIDEO_TRANSLATE_TARGET_LANGUAGES };

const JOBS_COLL = "videoTranslateJobs";
const OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions";

/** Max time an SSE client may wait for caption readiness (Firestore snapshot + terminal event). */
export const VIDEO_TRANSLATE_CAPTION_SSE_MAX_MS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_CAPTION_SSE_MAX_MS || "", 10) ||
	30 * 60 * 1000;

const utapi = new UTApi({ token: process.env.UPLOADTHING_TOKEN });

const MAX_VIDEO_BYTES =
	Number.parseInt(process.env.VIDEO_TRANSLATE_MAX_VIDEO_BYTES || "", 10) ||
	200 * 1024 * 1024;
const OPENROUTER_VIDEO_TIMEOUT_MS =
	Number.parseInt(process.env.OPENROUTER_VIDEO_TIMEOUT_MS || "", 10) || 600_000;

/** Subprocess timeout for yt-dlp (YouTube downloads can be slow). */
const YTDLP_TIMEOUT_MS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_YTDLP_TIMEOUT_MS || "", 10) ||
	20 * 60 * 1000;
const FFPROBE_TIMEOUT_MS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_FFPROBE_TIMEOUT_MS || "", 10) ||
	30_000;
const TMP_SPACE_BASE_BUFFER_BYTES =
	Number.parseInt(process.env.VIDEO_TRANSLATE_TMP_SPACE_BUFFER_BYTES || "", 10) ||
	256 * 1024 * 1024;
const TMP_SPACE_MULTIPLIER =
	Number.parseFloat(process.env.VIDEO_TRANSLATE_TMP_SPACE_MULTIPLIER || "") || 3;
const TMP_SPACE_WAIT_TIMEOUT_MS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_TMP_SPACE_WAIT_TIMEOUT_MS || "", 10) ||
	120_000;
const TMP_SPACE_WAIT_POLL_MS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_TMP_SPACE_WAIT_POLL_MS || "", 10) ||
	3_000;
const VIDEO_TRANSLATE_MAX_CONCURRENT_JOBS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_MAX_CONCURRENT_JOBS || "", 10) || 2;
const VIDEO_TRANSLATE_TRANSCRIBE_AUDIO_MAX_BYTES =
	Number.parseInt(
		process.env.VIDEO_TRANSLATE_TRANSCRIBE_AUDIO_MAX_BYTES || "",
		10,
	) || 25 * 1024 * 1024;
const PLAN_CAPS = {
	free: {
		maxVideoBytes:
			Number.parseInt(
				process.env.VIDEO_TRANSLATE_MAX_VIDEO_BYTES_FREE || "",
				10,
			) || MAX_VIDEO_BYTES,
		maxMinutes:
			Number.parseInt(process.env.VIDEO_TRANSLATE_MAX_MINUTES_FREE || "", 10) || 10,
	},
	pro: {
		maxVideoBytes:
			Number.parseInt(process.env.VIDEO_TRANSLATE_MAX_VIDEO_BYTES_PRO || "", 10) ||
			MAX_VIDEO_BYTES,
		maxMinutes:
			Number.parseInt(process.env.VIDEO_TRANSLATE_MAX_MINUTES_PRO || "", 10) || 30,
	},
	enterprise: {
		maxVideoBytes:
			Number.parseInt(
				process.env.VIDEO_TRANSLATE_MAX_VIDEO_BYTES_ENTERPRISE || "",
				10,
			) ||
			1024 * 1024 * 1024,
		maxMinutes:
			Number.parseInt(
				process.env.VIDEO_TRANSLATE_MAX_MINUTES_ENTERPRISE || "",
				10,
			) || 120,
	},
};

/** Raw PCM16 from OpenAI streaming TTS; default matches OpenAI docs (24 kHz mono). */
const TTS_PCM_SAMPLE_RATE =
	Number.parseInt(process.env.OPENROUTER_TTS_PCM_SAMPLE_RATE || "", 10) || 24000;
const TTS_PCM_CHANNELS =
	Number.parseInt(process.env.OPENROUTER_TTS_PCM_CHANNELS || "", 10) || 1;

/**
 * Wrap raw little-endian PCM16 audio in a WAV container (e.g. for UploadThing / browsers).
 */
export function pcm16ToWavBuffer(
	pcmBuffer,
	sampleRate = TTS_PCM_SAMPLE_RATE,
	numChannels = TTS_PCM_CHANNELS,
) {
	const bitsPerSample = 16;
	const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
	const blockAlign = (numChannels * bitsPerSample) / 8;
	const dataSize = pcmBuffer.length;
	const out = Buffer.alloc(44 + dataSize);
	out.write("RIFF", 0);
	out.writeUInt32LE(36 + dataSize, 4);
	out.write("WAVE", 8);
	out.write("fmt ", 12);
	out.writeUInt32LE(16, 16);
	out.writeUInt16LE(1, 20);
	out.writeUInt16LE(numChannels, 22);
	out.writeUInt32LE(sampleRate, 24);
	out.writeUInt32LE(byteRate, 28);
	out.writeUInt16LE(blockAlign, 32);
	out.writeUInt16LE(bitsPerSample, 34);
	out.write("data", 36);
	out.writeUInt32LE(dataSize, 40);
	pcmBuffer.copy(out, 44);
	return out;
}

/** Retries for source video fetch when CDN returns 429/502/503/504. */
const VIDEO_DOWNLOAD_MAX_ATTEMPTS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_DOWNLOAD_RETRIES || "", 10) || 5;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse Retry-After header (seconds or HTTP-date). */
function parseRetryAfterMs(headers) {
	const raw = headers.get("retry-after");
	if (!raw) return null;
	const sec = Number.parseInt(raw, 10);
	if (!Number.isNaN(sec)) return sec * 1000;
	const t = Date.parse(raw);
	if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
	return null;
}

/**
 * Fetch video bytes with retries. CDNs (e.g. UploadThing) often return 429 when
 * many server-side fetches hit the same URL without backoff.
 */
async function fetchVideoBufferWithRetries(url, signal, maxVideoBytes) {
	const ua =
		process.env.VIDEO_TRANSLATE_DOWNLOAD_USER_AGENT?.trim() ||
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

	let lastStatus = 0;
	for (let attempt = 1; attempt <= VIDEO_DOWNLOAD_MAX_ATTEMPTS; attempt++) {
		if (signal?.aborted) {
			const e = new Error("Download aborted");
			e.name = "AbortError";
			throw e;
		}

		const res = await fetch(url, {
			signal,
			redirect: "follow",
			headers: {
				"User-Agent": ua,
				Accept: "video/mp4,video/*,*/*;q=0.8",
			},
		});

		if (res.ok) {
			const len = res.headers.get("content-length");
			if (len && Number(len) > maxVideoBytes) {
				throw new Error("Video file too large (content-length)");
			}
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.length > maxVideoBytes) {
				throw new Error(`Video exceeds plan byte limit (${maxVideoBytes} bytes)`);
			}
			return buf;
		}

		lastStatus = res.status;
		try {
			await res.arrayBuffer();
		} catch {
			/* ignore drain errors */
		}

		const retryable =
			res.status === 429 ||
			res.status === 502 ||
			res.status === 503 ||
			res.status === 504;
		if (!retryable || attempt === VIDEO_DOWNLOAD_MAX_ATTEMPTS) {
			throw new Error(`Failed to download video: HTTP ${res.status}`);
		}

		const serverWait = parseRetryAfterMs(res.headers);
		const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1));
		const waitMs =
			serverWait != null ? Math.min(serverWait, 60_000) : backoff;
		const jitter = Math.floor(Math.random() * 400);
		await sleep(waitMs + jitter);
	}

	throw new Error(`Failed to download video: HTTP ${lastStatus}`);
}

function normalizePlanKey(raw) {
	const s = String(raw || "")
		.trim()
		.toLowerCase();
	if (!s) return "free";
	if (["pro", "paid", "plus", "premium"].includes(s)) return "pro";
	if (["enterprise", "team", "business"].includes(s)) return "enterprise";
	return "free";
}

function resolvePlanCaps(rawPlan) {
	const plan = normalizePlanKey(rawPlan);
	return {
		plan,
		maxVideoBytes: PLAN_CAPS[plan].maxVideoBytes,
		maxMinutes: PLAN_CAPS[plan].maxMinutes,
	};
}

async function getTmpFreeBytes() {
	try {
		if (typeof fsp.statfs !== "function") return null;
		const stat = await fsp.statfs(os.tmpdir());
		return Number(stat.bavail) * Number(stat.bsize);
	} catch {
		return null;
	}
}

async function ensureTmpHasSpace(requiredBytes, stageLabel) {
	const freeBytes = await getTmpFreeBytes();
	if (freeBytes == null) return;
	if (freeBytes < requiredBytes) {
		throw new Error(
			`Insufficient temp disk space in ${os.tmpdir()} for ${stageLabel}. Required ${requiredBytes} bytes, available ${freeBytes} bytes.`,
		);
	}
}

async function waitForTmpSpace(requiredBytes, stageLabel, signal) {
	const deadline = Date.now() + Math.max(0, TMP_SPACE_WAIT_TIMEOUT_MS);
	for (;;) {
		if (signal?.aborted) {
			const e = new Error("Temp-space wait aborted");
			e.name = "AbortError";
			throw e;
		}
		const freeBytes = await getTmpFreeBytes();
		if (freeBytes == null || freeBytes >= requiredBytes) return;
		if (Date.now() >= deadline) {
			throw new Error(
				`Insufficient temp disk space in ${os.tmpdir()} for ${stageLabel}. Required ${requiredBytes} bytes, available ${freeBytes} bytes.`,
			);
		}
		await sleep(Math.max(250, TMP_SPACE_WAIT_POLL_MS));
	}
}

let activeVideoJobs = 0;
const videoJobWaiters = [];

async function acquireVideoJobSlot(signal) {
	if (activeVideoJobs < VIDEO_TRANSLATE_MAX_CONCURRENT_JOBS) {
		activeVideoJobs += 1;
		return;
	}
	await new Promise((resolve, reject) => {
		const waiter = { resolve, reject };
		videoJobWaiters.push(waiter);
		const abort = () => {
			const i = videoJobWaiters.indexOf(waiter);
			if (i >= 0) videoJobWaiters.splice(i, 1);
			const e = new Error("Video job queue wait aborted");
			e.name = "AbortError";
			reject(e);
		};
		if (signal) {
			if (signal.aborted) return abort();
			signal.addEventListener("abort", abort, { once: true });
		}
	});
	activeVideoJobs += 1;
}

function releaseVideoJobSlot() {
	activeVideoJobs = Math.max(0, activeVideoJobs - 1);
	const next = videoJobWaiters.shift();
	if (next) next.resolve();
}

async function getMediaDurationSeconds(filePath) {
	const ffprobe = process.env.FFPROBE_PATH?.trim() || "ffprobe";
	try {
		const out = await new Promise((resolve, reject) => {
			execFile(
				ffprobe,
				[
					"-v",
					"error",
					"-show_entries",
					"format=duration",
					"-of",
					"json",
					filePath,
				],
				{ timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
				(err, stdout) => {
					if (err) return reject(err);
					resolve(stdout);
				},
			);
		});
		const parsed = JSON.parse(String(out || "{}"));
		const dur = Number(parsed?.format?.duration);
		if (Number.isFinite(dur) && dur > 0) return dur;
	} catch {
		// Fallback below.
	}

	// Fallback: parse ffmpeg stderr "Duration: HH:MM:SS.xx"
	const ffmpeg = getFfmpegBin();
	const stderr = await new Promise((resolve, reject) => {
		execFile(
			ffmpeg,
			["-i", filePath],
			{ timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
			(_err, _stdout, se) => {
				resolve(String(se || ""));
			},
		);
	}).catch(() => "");
	const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
	if (!m) return null;
	const hh = Number(m[1]);
	const mm = Number(m[2]);
	const ss = Number(m[3]);
	if (!Number.isFinite(hh + mm + ss)) return null;
	return hh * 3600 + mm * 60 + ss;
}

async function enforceDurationLimit(videoPath, maxMinutes) {
	if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) return;
	const secs = await getMediaDurationSeconds(videoPath);
	if (secs == null) {
		throw new Error(
			"Unable to determine video duration for plan validation (ffprobe/ffmpeg metadata unavailable).",
		);
	}
	const maxSecs = maxMinutes * 60;
	if (secs > maxSecs) {
		throw new Error(
			`Video duration exceeds plan limit: ${Math.ceil(secs)}s > ${maxSecs}s (${maxMinutes} min).`,
		);
	}
}

/** youtube.com / youtu.be / shorts / embed — same idea as lib/inkgestAgent.js */
function isYoutubeVideoUrl(url) {
	if (!url || typeof url !== "string") return false;
	return /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)/i.test(
		url.trim(),
	);
}

async function pickLargestVideoFileInDir(dir) {
	const names = await fsp.readdir(dir);
	let bestPath = null;
	let bestSize = 0;
	for (const name of names) {
		if (!/\.(mp4|webm|mkv|mov|m4v)$/i.test(name)) continue;
		const p = path.join(dir, name);
		const st = await fsp.stat(p);
		if (!st.isFile()) continue;
		if (st.size > bestSize) {
			bestSize = st.size;
			bestPath = p;
		}
	}
	if (!bestPath) {
		throw new Error(
			"yt-dlp did not produce a video file (check URL, format, or VIDEO_TRANSLATE_YTDLP_FORMAT)",
		);
	}
	return bestPath;
}

/**
 * Download YouTube via yt-dlp (youtube-dl-exec ships / resolves the binary).
 * Optional: VIDEO_TRANSLATE_YTDLP_BINARY=path to yt-dlp, VIDEO_TRANSLATE_YTDLP_FORMAT=yt-dlp -f string.
 */
async function downloadYoutubeViaYtDlp(url, signal, tmpDir, maxVideoBytes) {
	const customBin = process.env.VIDEO_TRANSLATE_YTDLP_BINARY?.trim();
	const dl = customBin ? createYoutubeDl(customBin) : youtubedl;

	const format =
		process.env.VIDEO_TRANSLATE_YTDLP_FORMAT?.trim() ||
		"bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best[ext=mp4]/best[height<=720]";

	const maxMb = Math.max(1, Math.floor(maxVideoBytes / (1024 * 1024)));

	try {
		await dl.exec(
			url.trim(),
			{
				output: path.join(tmpDir, "input.%(ext)s"),
				format,
				mergeOutputFormat: "mp4",
				noPlaylist: true,
				noWarnings: true,
				maxFilesize: `${maxMb}M`,
			},
			{
				timeout: YTDLP_TIMEOUT_MS,
				signal,
			},
		);
	} catch (e) {
		const tail = e?.stderr ? String(e.stderr).slice(-2500) : "";
		throw new Error(
			`YouTube download failed (yt-dlp). ${tail || e?.message || String(e)}`,
		);
	}

	const videoPath = await pickLargestVideoFileInDir(tmpDir);
	const buf = await fsp.readFile(videoPath);
	if (buf.length > maxVideoBytes) {
		throw new Error(
			`Video exceeds plan byte limit (${maxVideoBytes} bytes)`,
		);
	}
	return { buf, videoPath };
}

function getOpenRouterKey() {
	return process.env.OPENROUTER_API_KEY?.trim() || "";
}

/** Gemini on OpenRouter: use video-capable model; non-YouTube URLs must be sent as base64 data URLs in video_url. */
function geminiVideoModel() {
	return (
		ACTIVE_OPENROUTER_MODELS.video.translate ||
		process.env.OPENROUTER_VIDEO_GEMINI_MODEL?.trim() ||
		"google/gemini-2.5-flash"
	);
}

function ttsModel() {
	const url = customTtsEndpoint();
	if (url) {
		return (
			process.env.CUSTOM_TTS_PROVIDER?.trim() ||
			process.env.CUSTOM_TTS_API_URL?.trim() ||
			process.env.VIDEO_TRANSLATE_TTS_API_URL?.trim() ||
			"custom-tts"
		);
	}
	return (
		process.env.OPENROUTER_TTS_MODEL?.trim() ||
		ACTIVE_OPENROUTER_MODELS.video.tts
	);
}

function getFfmpegBin() {
	return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

function openRouterFetchHeaders() {
	const key = getOpenRouterKey();
	const h = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${key}`,
	};
	/** OpenRouter recommends Referer; missing header sometimes yields generic provider errors for audio routes. */
	const ref = process.env.OPENROUTER_HTTP_REFERER?.trim();
	h.Referer = ref || "https://openrouter.ai";
	const title = process.env.OPENROUTER_APP_TITLE?.trim();
	if (title) h["X-Title"] = title;
	return h;
}

async function execFfmpeg(args, label) {
	const ffmpeg = getFfmpegBin();
	await new Promise((resolve, reject) => {
		execFile(
			ffmpeg,
			args,
			{ timeout: 300_000, maxBuffer: 20 * 1024 * 1024 },
			(err, _stdout, stderr) => {
				if (err) {
					const se = stderr ? String(stderr).slice(0, 3000) : "";
					const hint =
						err.code === "ENOENT"
							? " Install ffmpeg on the host or set FFMPEG_PATH to the binary (e.g. /usr/bin/ffmpeg)."
							: "";
					reject(
						new Error(
							`${label}: ${err.message}${hint}${se ? `\nffmpeg stderr:\n${se}` : ""}`,
						),
					);
					return;
				}
				resolve();
			},
		);
	});
}

function splitTextIntoTtsChunks(text, maxLen) {
	const t = String(text || "").trim();
	if (t.length <= maxLen) return [t];
	const chunks = [];
	let i = 0;
	while (i < t.length) {
		let end = Math.min(i + maxLen, t.length);
		if (end < t.length) {
			const cut = t.lastIndexOf(". ", end);
			const cut2 = t.lastIndexOf("\n", end);
			const best = Math.max(cut, cut2);
			if (best > i + maxLen * 0.4) end = best + 1;
		}
		chunks.push(t.slice(i, end).trim());
		i = end;
	}
	return chunks.filter(Boolean);
}

function customTtsEndpoint() {
	return (
		process.env.CUSTOM_TTS_API_URL?.trim() ||
		process.env.VIDEO_TRANSLATE_TTS_API_URL?.trim() ||
		""
	);
}

function customTtsHeaders() {
	const h = { "Content-Type": "application/json" };
	const bearer = process.env.CUSTOM_TTS_API_KEY?.trim();
	if (bearer) h.Authorization = `Bearer ${bearer}`;
	const apiKey = process.env.CUSTOM_TTS_X_API_KEY?.trim();
	if (apiKey) h["x-api-key"] = apiKey;
	return h;
}

/**
 * OpenRouter chat/completions streaming TTS (e.g. openai/gpt-audio, pcm16).
 * @see https://openrouter.ai/docs/guides/overview/multimodal/audio
 */
async function openRouterTtsSingleAttempt({ text, signal }) {
	const key = getOpenRouterKey();
	if (!key) {
		throw new Error(
			"TTS not configured: set CUSTOM_TTS_API_URL (or VIDEO_TRANSLATE_TTS_API_URL), or set OPENROUTER_API_KEY for OpenRouter TTS.",
		);
	}
	const model =
		process.env.OPENROUTER_TTS_MODEL?.trim() ||
		ACTIVE_OPENROUTER_MODELS.video.tts;
	const voice =
		process.env.OPENROUTER_TTS_VOICE?.trim() ||
		process.env.OPENROUTER_AUDIO_VOICE?.trim() ||
		"alloy";

	const res = await fetch(OPENROUTER_CHAT, {
		method: "POST",
		signal,
		headers: openRouterFetchHeaders(),
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: text }],
			modalities: ["text", "audio"],
			audio: { voice, format: "pcm16" },
			stream: true,
		}),
	});

	if (!res.ok) {
		let msg = "";
		try {
			const j = await res.json();
			msg =
				j?.error?.message ||
				(typeof j?.error === "string" ? j.error : "") ||
				JSON.stringify(j).slice(0, 500);
		} catch {
			msg = (await res.text().catch(() => "")).slice(0, 500);
		}
		throw new Error(`OpenRouter TTS HTTP ${res.status}: ${msg}`);
	}
	if (!res.body) throw new Error("OpenRouter TTS returned empty body");

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let lineBuf = "";
	const b64Parts = [];
	let lastUsage = null;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		lineBuf += decoder.decode(value, { stream: true });
		const lines = lineBuf.split("\n");
		lineBuf = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("data: ")) continue;
			const data = trimmed.slice(6).trim();
			if (data === "[DONE]") continue;
			let parsed;
			try {
				parsed = JSON.parse(data);
			} catch {
				continue;
			}
			if (parsed.error) {
				const e = parsed.error;
				throw new Error(
					typeof e === "string"
						? e
						: e?.message || "OpenRouter TTS stream error",
				);
			}
			if (parsed.usage) lastUsage = parsed.usage;
			const audio = parsed?.choices?.[0]?.delta?.audio;
			if (audio?.data) b64Parts.push(audio.data);
		}
	}

	const fullB64 = b64Parts.join("");
	if (!String(fullB64).trim()) {
		throw new Error("OpenRouter TTS returned no audio data");
	}
	let buf;
	try {
		buf = Buffer.from(fullB64, "base64");
	} catch (e) {
		throw new Error(
			`OpenRouter TTS invalid base64 audio: ${e?.message || String(e)}`,
		);
	}
	if (!buf.length) throw new Error("OpenRouter TTS decoded empty buffer");
	return { buffer: buf, usage: lastUsage };
}

async function ttsSingleAttempt({ text, signal }) {
	const url = customTtsEndpoint();
	if (url) {
		const voiceId =
			process.env.CUSTOM_TTS_VOICE_ID?.trim() ||
			process.env.VIDEO_TRANSLATE_TTS_VOICE_ID?.trim() ||
			null;

		const res = await fetch(url, {
			method: "POST",
			signal,
			headers: customTtsHeaders(),
			body: JSON.stringify({
				text,
				format: "pcm16",
				sample_rate: TTS_PCM_SAMPLE_RATE,
				channels: TTS_PCM_CHANNELS,
				...(voiceId ? { voice_id: voiceId } : {}),
			}),
		});
		const bodyText = await res.text();
		if (!res.ok) {
			throw new Error(
				`Custom TTS HTTP ${res.status}: ${String(bodyText || "").slice(0, 500)}`,
			);
		}

		let parsed;
		try {
			parsed = JSON.parse(bodyText);
		} catch {
			throw new Error("Custom TTS must return JSON with audio_base64");
		}
		const b64 = String(parsed?.audio_base64 ?? "").trim();
		const format = String(parsed?.audio_format ?? "pcm16")
			.trim()
			.toLowerCase();
		if (!b64) throw new Error("Custom TTS returned empty audio_base64");
		if (format !== "pcm16") {
			throw new Error(
				`Custom TTS must return audio_format "pcm16" to preserve existing mux/upload flow. Got "${format}".`,
			);
		}
		return { buffer: Buffer.from(b64, "base64"), usage: null };
	}

	return openRouterTtsSingleAttempt({ text, signal });
}

/**
 * Custom HTTP TTS → pcm16 only, preserving existing voice/video output contracts.
 */
export async function ttsSynthesizeToBuffer({ text, signal }) {
	const chunks = splitTextIntoTtsChunks(text, 2800);
	let mergedTtsUsage = normalizeOpenRouterUsage(null);
	const partBuffers = [];
	for (let i = 0; i < chunks.length; i++) {
		const { buffer: buf, usage: uPart } = await ttsSingleAttempt({
			text: chunks[i],
			signal,
		});
		mergedTtsUsage = mergeOpenRouterUsage(mergedTtsUsage, uPart);
		partBuffers.push(buf);
	}
	return {
		buffer: Buffer.concat(partBuffers),
		format: "pcm16",
		usage: mergedTtsUsage,
	};
}

function parseJsonObjectFromModel(raw) {
	if (!raw || typeof raw !== "string") {
		throw new SyntaxError("Empty model output");
	}
	let t = raw.trim();
	t = t
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/m, "")
		.trim();
	const start = t.indexOf("{");
	if (start === -1) throw new SyntaxError("No JSON object in model output");
	let depth = 0;
	let end = -1;
	for (let i = start; i < t.length; i++) {
		if (t[i] === "{") depth++;
		else if (t[i] === "}") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end === -1) throw new SyntaxError("Unterminated JSON in model output");
	return JSON.parse(t.slice(start, end + 1));
}

async function transcribeAndTranslateWithGeminiMessages({
	model,
	messages,
	signal,
	errorLabel,
}) {
	let res = await fetch(OPENROUTER_CHAT, {
		method: "POST",
		signal,
		headers: openRouterFetchHeaders(),
		body: JSON.stringify({
			model,
			messages,
			temperature: 0.2,
			response_format: { type: "json_object" },
		}),
	});

	let data = await res.json();
	if (!res.ok || data.error) {
		const msg = String(data?.error?.message || data?.error || "");
		const retryNoRf = /response_format|json_object|unsupported/i.test(msg);
		if (retryNoRf) {
			res = await fetch(OPENROUTER_CHAT, {
				method: "POST",
				signal,
				headers: openRouterFetchHeaders(),
				body: JSON.stringify({
					model,
					messages,
					temperature: 0.2,
				}),
			});
			data = await res.json();
		}
	}
	if (!res.ok || data.error) {
		throw new Error(
			data?.error?.message || data?.error || `${errorLabel} HTTP ${res.status}`,
		);
	}

	const content = data?.choices?.[0]?.message?.content;
	const raw = typeof content === "string" ? content : "";
	if (!raw) throw new Error(`Empty response from ${errorLabel}`);

	const parsed = parseJsonObjectFromModel(raw);
	const transcript = String(parsed.transcript ?? "").trim();
	const translation = String(parsed.translation ?? "").trim();
	if (!transcript || !translation) {
		throw new Error(
			`${errorLabel} JSON must include non-empty transcript and translation`,
		);
	}
	return { transcript, translation, usage: data.usage };
}

/**
 * Faster path: extract low-bitrate mono audio and send audio input to Gemini
 * (instead of base64-embedding full MP4).
 */
async function transcribeAndTranslateWithGemini({
	audioBuffer,
	targetLanguage,
	signal,
	model: modelId,
}) {
	const model = modelId?.trim() || geminiVideoModel();
	const userText = `Transcribe this audio exactly and then translate it into ${targetLanguage}. Provide both as a structured JSON object with keys "transcript" and "translation" only.`;
	const audioBase64 = audioBuffer.toString("base64");
	const audioDataUrl = `data:audio/wav;base64,${audioBase64}`;

	// Try two common OpenRouter multimodal audio formats for best compatibility.
	const variants = [
		[
			{
				role: "user",
				content: [
					{ type: "text", text: userText },
					{
						type: "input_audio",
						input_audio: { data: audioBase64, format: "wav" },
					},
				],
			},
		],
		[
			{
				role: "user",
				content: [
					{ type: "text", text: userText },
					{
						type: "audio_url",
						audio_url: { url: audioDataUrl },
					},
				],
			},
		],
	];

	let lastErr = "";
	for (const messages of variants) {
		try {
			return await transcribeAndTranslateWithGeminiMessages({
				model,
				messages,
				signal,
				errorLabel: "Gemini audio",
			});
		} catch (e) {
			lastErr = e?.message || String(e);
		}
	}

	throw new Error(`Gemini audio transcription/translation failed. Last: ${lastErr}`);
}

async function downloadVideoToTempFile(url, signal, maxVideoBytes, maxMinutes) {
	// Avoid pessimistic pre-checks based on plan max bytes. Under traffic, this can
	// fail even when the current file would fit. Do a small startup check first and
	// enforce precise checks once actual file size is known.
	const startupTmpBytes = Math.max(
		64 * 1024 * 1024,
		Math.min(TMP_SPACE_BASE_BUFFER_BYTES, 256 * 1024 * 1024),
	);
	await waitForTmpSpace(startupTmpBytes, "video download start", signal);
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vt-dub-"));
	try {
		if (isYoutubeVideoUrl(url)) {
			const { buf, videoPath } = await downloadYoutubeViaYtDlp(
				url,
				signal,
				tmpDir,
				maxVideoBytes,
			);
			await enforceDurationLimit(videoPath, maxMinutes);
			return { videoPath, tmpDir, buffer: buf };
		}
		const buf = await fetchVideoBufferWithRetries(url, signal, maxVideoBytes);
		if (buf.length > maxVideoBytes) {
			throw new Error(`Video exceeds plan byte limit (${maxVideoBytes} bytes)`);
		}
		const videoPath = path.join(tmpDir, "input.mp4");
		await fsp.writeFile(videoPath, buf);
		await enforceDurationLimit(videoPath, maxMinutes);
		return { videoPath, tmpDir, buffer: buf };
	} catch (e) {
		await rmDirSafe(tmpDir);
		throw e;
	}
}

async function ffmpegStripAudio(inputPath, outMutedPath) {
	await execFfmpeg(
		["-y", "-i", inputPath, "-an", "-vcodec", "copy", outMutedPath],
		"ffmpeg strip audio",
	);
}

/** Extract compact mono WAV for transcription/translation (faster than full video multimodal). */
async function ffmpegExtractTranscribeAudio(inputPath, outAudioPath) {
	await execFfmpeg(
		[
			"-y",
			"-i",
			inputPath,
			"-vn",
			"-ac",
			"1",
			"-ar",
			"16000",
			"-c:a",
			"pcm_s16le",
			outAudioPath,
		],
		"ffmpeg extract transcription audio",
	);
}

/** Mux muted video + raw s16le PCM (from gpt-audio streaming pcm16). */
async function ffmpegMuxPcm16WithVideo(mutedPath, pcmPath, outFinalPath) {
	await execFfmpeg(
		[
			"-y",
			"-i",
			mutedPath,
			"-f",
			"s16le",
			"-ar",
			String(TTS_PCM_SAMPLE_RATE),
			"-ac",
			String(TTS_PCM_CHANNELS),
			"-i",
			pcmPath,
			"-c:v",
			"copy",
			"-c:a",
			"aac",
			"-map",
			"0:v:0",
			"-map",
			"1:a:0",
			"-shortest",
			outFinalPath,
		],
		"ffmpeg mux pcm16 + video",
	);
}

async function uploadMp4Buffer(buffer, jobId) {
	const fileName = `dubbed-${jobId}.mp4`;
	const utFile = new UTFile([buffer], fileName, { type: "video/mp4" });
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(`UploadThing final video failed: ${response.error.message}`);
	}
	return response.data.ufsUrl;
}

async function uploadVttFromText(text, jobId) {
	const vtt = `WEBVTT

00:00:00.000 --> 00:10:00.000
${String(text).replace(/\r\n/g, "\n")}`;
	const fileName = `subs-${jobId}.vtt`;
	const utFile = new UTFile([Buffer.from(vtt, "utf8")], fileName, {
		type: "text/vtt",
	});
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(`UploadThing VTT failed: ${response.error.message}`);
	}
	return response.data.ufsUrl;
}

async function rmDirSafe(dir) {
	await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function newJobId() {
	return `vt_${uuidv4().replace(/-/g, "")}`;
}

async function writeJob(docId, data) {
	await firestore.collection(JOBS_COLL).doc(docId).set(data, { merge: true });
}

async function patchJob(docId, data) {
	await firestore.collection(JOBS_COLL).doc(docId).update(data);
}

export function getVideoTranslateLanguagesResponse() {
	return {
		error: null,
		data: { languages: [...VIDEO_TRANSLATE_TARGET_LANGUAGES] },
	};
}

/**
 * Subscribe to job doc updates until caption is ready, failed, missing, or listener errors.
 * Call the returned function to unsubscribe (e.g. client disconnect or timeout).
 */
export function subscribeVideoTranslateCaptionUpdates(videoTranslateId, onEvent) {
	const id = String(videoTranslateId).trim();
	const ref = firestore.collection(JOBS_COLL).doc(id);
	let unsubscribed = false;
	const unsub = ref.onSnapshot(
		(snap) => {
			if (unsubscribed) return;
			if (!snap.exists) {
				unsubscribed = true;
				unsub();
				onEvent({ kind: "not_found" });
				return;
			}
			const d = snap.data();
			if (d.status === "failed") {
				unsubscribed = true;
				unsub();
				onEvent({
					kind: "failed",
					message: d.error || d.status_message || null,
				});
				return;
			}
			if (d.status === "success") {
				if (d.caption_url) {
					const caption =
						d.caption_text != null && d.caption_text !== ""
							? String(d.caption_text)
							: d.translated_transcript != null
								? String(d.translated_transcript)
								: "";
					unsubscribed = true;
					unsub();
					onEvent({
						kind: "ready",
						data: {
							caption_url: d.caption_url,
							caption,
							...publicTranslateUsageFromDoc(d),
						},
					});
					return;
				}
				unsubscribed = true;
				unsub();
				onEvent({
					kind: "failed",
					message: d.error || "Caption URL unavailable",
				});
				return;
			}
			onEvent({ kind: "progress", status: d.status });
		},
		(err) => {
			if (unsubscribed) return;
			unsubscribed = true;
			try {
				unsub();
			} catch {}
			onEvent({
				kind: "listener_error",
				message: err?.message || String(err),
			});
		},
	);
	return () => {
		if (unsubscribed) return;
		unsubscribed = true;
		try {
			unsub();
		} catch {}
	};
}

export async function getVideoTranslateCaptionResponse(videoTranslateId) {
	if (!videoTranslateId || !String(videoTranslateId).trim()) {
		return {
			error: "Query video_translate_id is required",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}
	const snap = await firestore
		.collection(JOBS_COLL)
		.doc(String(videoTranslateId).trim())
		.get();
	if (!snap.exists) {
		return {
			error: "Unknown video_translate_id",
			code: "NOT_FOUND",
			httpStatus: 404,
		};
	}
	const d = snap.data();
	if (d.status !== "success" || !d.caption_url) {
		return {
			error: "Captions not ready yet or job failed",
			code: "NOT_READY",
			httpStatus: 404,
			data: { status: d.status },
		};
	}
	const caption =
		d.caption_text != null && d.caption_text !== ""
			? String(d.caption_text)
			: (d.translated_transcript != null ? String(d.translated_transcript) : "");
	return {
		error: null,
		data: {
			caption_url: d.caption_url,
			caption,
			...publicTranslateUsageFromDoc(d),
		},
		httpStatus: 200,
	};
}

export async function getVideoTranslateJobStatus(videoTranslateId) {
	if (!videoTranslateId || !String(videoTranslateId).trim()) {
		return {
			error: "Missing video_translate_id",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}
	const snap = await firestore
		.collection(JOBS_COLL)
		.doc(String(videoTranslateId).trim())
		.get();
	if (!snap.exists) {
		return {
			error: null,
			data: {
				video_translate_id: videoTranslateId,
				status: "failed",
				message: "Unknown job id",
				url: null,
				caption_url: null,
				caption: null,
				usage: null,
				tokenUsage: null,
			},
			httpStatus: 404,
		};
	}
	const d = snap.data();
	const captionStr =
		d.caption_text != null && d.caption_text !== ""
			? String(d.caption_text)
			: (d.translated_transcript != null
					? String(d.translated_transcript)
					: null);
	const heygenLike = {
		video_translate_id: d.id || videoTranslateId,
		title: d.title || null,
		output_language: d.output_language || null,
		status:
			d.status === "pending" || d.status === "running"
				? d.status === "pending"
					? "pending"
					: "running"
				: d.status === "success"
					? "success"
					: "failed",
		url:
			d.translated_video_url ||
			d.final_video_url ||
			d.source_video_url ||
			d.video_url ||
			null,
		caption_url: d.caption_url || null,
		caption: captionStr,
		message: d.error || d.status_message || null,
		callback_id: d.callback_id || null,
		transcript_original: d.transcript_original ?? null,
		translated_transcript: d.translated_transcript ?? null,
		source_video_url: d.source_video_url || d.video_url || null,
		...publicTranslateUsageFromDoc(d),
		engine: "openrouter-gemini-dub",
	};
	return { error: null, data: heygenLike, httpStatus: 200 };
}

export async function createVideoTranslateJobs({ videoUrl, body }) {
	if (!getOpenRouterKey()) {
		return {
			error: "OPENROUTER_API_KEY not configured",
			code: "MISSING_API_KEY",
			httpStatus: 503,
		};
	}
	if (!process.env.UPLOADTHING_TOKEN) {
		return {
			error:
				"UPLOADTHING_TOKEN not configured (required to upload dubbed video)",
			code: "MISSING_UPLOAD_TOKEN",
			httpStatus: 503,
		};
	}

	const video_url = String(videoUrl || "").trim();
	const langs = body.output_language
		? [body.output_language]
		: Array.isArray(body.output_languages)
			? body.output_languages
			: [];

	if (!video_url) {
		return {
			error:
				"Provide video_url (or videoUrl) or upload a video file (field: file or video)",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}
	if (!langs.length) {
		return {
			error: "Provide output_language or output_languages",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const { plan, maxVideoBytes, maxMinutes } = resolvePlanCaps(
		body.plan ?? body.user_plan ?? body.subscription_plan ?? body.tier,
	);
	const rawLlm = body.model ?? body.llm_model;
	let videoLlmOpenRouterId;
	let llmPresetLabel = "gemini";
	if (rawLlm != null && String(rawLlm).trim() !== "") {
		const r = resolveTranslateLlmModel(rawLlm);
		if (!r.ok) {
			return {
				error: r.error,
				code: "BAD_REQUEST",
				details: { allowed_models: r.allowed },
				httpStatus: 400,
			};
		}
		videoLlmOpenRouterId = r.openrouterId;
		llmPresetLabel = r.preset;
	} else {
		videoLlmOpenRouterId = geminiVideoModel();
	}

	const baseMeta = {
		video_url,
		title: body.title || null,
		callback_id: body.callback_id || null,
		plan,
		max_video_bytes: maxVideoBytes,
		max_minutes: maxMinutes,
		gemini_model: videoLlmOpenRouterId,
		llm_preset: llmPresetLabel,
		tts_model: ttsModel(),
	};

	const ids = [];
	for (const output_language of langs) {
		const id = newJobId();
		await writeJob(id, {
			id,
			status: "pending",
			video_url,
			source_video_url: video_url,
			output_language: String(output_language),
			...baseMeta,
			createdAt: FieldValue.serverTimestamp(),
			updatedAt: FieldValue.serverTimestamp(),
		});
		ids.push(id);
		queueProcessVideoJob(id);
	}

	if (ids.length === 1) {
		return {
			error: null,
			data: {
				video_translate_id: ids[0],
				video_translate_ids: null,
			},
			httpStatus: 200,
		};
	}
	return {
		error: null,
		data: {
			video_translate_id: null,
			video_translate_ids: ids,
		},
		httpStatus: 200,
	};
}

function queueProcessVideoJob(jobId) {
	setImmediate(() => {
		processVideoTranslateJob(jobId).catch((err) => {
			console.error(`[videoTranslate] job ${jobId} failed:`, err);
			patchJob(jobId, {
				status: "failed",
				error: err?.message || String(err),
				updatedAt: FieldValue.serverTimestamp(),
			}).catch(() => {});
		});
	});
}

async function processVideoTranslateJob(jobId) {
	const signal = AbortSignal.timeout(OPENROUTER_VIDEO_TIMEOUT_MS);
	await acquireVideoJobSlot(signal);
	let tmpDir;
	try {
		const snap = await firestore.collection(JOBS_COLL).doc(jobId).get();
		if (!snap.exists) return;
		const job = snap.data();
		const maxVideoBytes =
			Number.parseInt(String(job.max_video_bytes || ""), 10) || MAX_VIDEO_BYTES;
		const maxMinutes =
			Number.parseInt(String(job.max_minutes || ""), 10) ||
			resolvePlanCaps(job.plan).maxMinutes;

		await patchJob(jobId, {
			status: "running",
			updatedAt: FieldValue.serverTimestamp(),
		});

		const { videoPath, tmpDir: tDir, buffer } = await downloadVideoToTempFile(
			job.video_url,
			signal,
			maxVideoBytes,
			maxMinutes,
		);
		tmpDir = tDir;

		const transcribeAudioPath = path.join(tmpDir, "transcribe_input.wav");
		await ffmpegExtractTranscribeAudio(videoPath, transcribeAudioPath);
		const transcribeAudioBuffer = await fsp.readFile(transcribeAudioPath);
		if (transcribeAudioBuffer.length > VIDEO_TRANSLATE_TRANSCRIBE_AUDIO_MAX_BYTES) {
			throw new Error(
				`Transcription audio too large (${transcribeAudioBuffer.length} bytes); limit is ${VIDEO_TRANSLATE_TRANSCRIBE_AUDIO_MAX_BYTES} bytes.`,
			);
		}
		const { transcript, translation, usage: geminiUsage } =
			await transcribeAndTranslateWithGemini({
				audioBuffer: transcribeAudioBuffer,
				targetLanguage: job.output_language,
				signal,
				model: job.gemini_model,
			});

		const { buffer: ttsBuf, usage: ttsUsage } = await ttsSynthesizeToBuffer({
			text: translation,
			signal,
		});

		const mergedOpenRouterUsage = mergeOpenRouterUsage(
			mergeOpenRouterUsage(null, geminiUsage),
			ttsUsage,
		);
		const usagePayload = buildUsageResponseFields(mergedOpenRouterUsage);

		const mutedPath = path.join(tmpDir, "muted_video.mp4");
		const pcmPath = path.join(tmpDir, "speech.pcm");
		const finalPath = path.join(tmpDir, "final_output.mp4");

		await waitForTmpSpace(
			Math.floor(buffer.length * 1.5 + ttsBuf.length + TMP_SPACE_BASE_BUFFER_BYTES),
			"ffmpeg mux/output",
			signal,
		);
		await fsp.writeFile(pcmPath, ttsBuf);
		await ffmpegStripAudio(videoPath, mutedPath);
		await ffmpegMuxPcm16WithVideo(mutedPath, pcmPath, finalPath);

		const finalBuf = await fsp.readFile(finalPath);
		const translatedVideoUrl = await uploadMp4Buffer(finalBuf, jobId);
		const captionUrl = await uploadVttFromText(translation, jobId).catch(
			() => null,
		);

		await patchJob(jobId, {
			status: "success",
			transcript_original: transcript,
			translated_transcript: translation,
			caption_text: translation,
			translated_video_url: translatedVideoUrl,
			final_video_url: translatedVideoUrl,
			caption_url: captionUrl,
			...usagePayload,
			error: null,
			status_message: null,
			updatedAt: FieldValue.serverTimestamp(),
		});
	} catch (e) {
		await patchJob(jobId, {
			status: "failed",
			error: e?.message || String(e),
			updatedAt: FieldValue.serverTimestamp(),
		});
	} finally {
		if (tmpDir) await rmDirSafe(tmpDir);
		releaseVideoJobSlot();
	}
}
