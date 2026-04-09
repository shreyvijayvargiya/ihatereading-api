/**
 * Video translate / dub pipeline (OpenRouter + FFmpeg + UploadThing + Firestore):
 * 1) Video URL → download (HTTP fetch, or yt-dlp for YouTube watch/shorts/youtu.be) → base64 data URL for Gemini.
 * 2) Gemini: transcribe + translate → JSON { transcript, translation } via response_format json_object.
 * 3) openai/gpt-audio: TTS → streaming audio must use audio.format "pcm16" (OpenAI; mp3/wav unsupported with stream=true).
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
} from "./openRouterUsage.js";
import { resolveTranslateLlmModel } from "./translateLlmModels.js";

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
	40 * 1024 * 1024;
const OPENROUTER_VIDEO_TIMEOUT_MS =
	Number.parseInt(process.env.OPENROUTER_VIDEO_TIMEOUT_MS || "", 10) || 600_000;

/** Subprocess timeout for yt-dlp (YouTube downloads can be slow). */
const YTDLP_TIMEOUT_MS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_YTDLP_TIMEOUT_MS || "", 10) ||
	OPENROUTER_VIDEO_TIMEOUT_MS;

/** Raw PCM16 from OpenAI streaming TTS; default matches OpenAI docs (24 kHz mono). */
const TTS_PCM_SAMPLE_RATE =
	Number.parseInt(process.env.OPENROUTER_TTS_PCM_SAMPLE_RATE || "", 10) || 24000;
const TTS_PCM_CHANNELS =
	Number.parseInt(process.env.OPENROUTER_TTS_PCM_CHANNELS || "", 10) || 1;

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
async function fetchVideoBufferWithRetries(url, signal) {
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
			if (len && Number(len) > MAX_VIDEO_BYTES) {
				throw new Error("Video file too large (content-length)");
			}
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.length > MAX_VIDEO_BYTES) {
				throw new Error(
					`Video exceeds VIDEO_TRANSLATE_MAX_VIDEO_BYTES (${MAX_VIDEO_BYTES} bytes)`,
				);
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
async function downloadYoutubeViaYtDlp(url, signal, tmpDir) {
	const customBin = process.env.VIDEO_TRANSLATE_YTDLP_BINARY?.trim();
	const dl = customBin ? createYoutubeDl(customBin) : youtubedl;

	const format =
		process.env.VIDEO_TRANSLATE_YTDLP_FORMAT?.trim() ||
		"bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best[ext=mp4]/best[height<=720]";

	const maxMb = Math.max(1, Math.floor(MAX_VIDEO_BYTES / (1024 * 1024)));

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
	if (buf.length > MAX_VIDEO_BYTES) {
		throw new Error(
			`Video exceeds VIDEO_TRANSLATE_MAX_VIDEO_BYTES (${MAX_VIDEO_BYTES} bytes)`,
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
		process.env.OPENROUTER_VIDEO_GEMINI_MODEL?.trim() ||
		"google/gemini-2.5-flash"
	);
}

function ttsModel() {
	return process.env.OPENROUTER_VIDEO_TTS_MODEL?.trim() || "openai/gpt-audio";
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

function formatOpenRouterHttpError(status, bodyText) {
	const raw = String(bodyText || "").slice(0, 4000);
	try {
		const j = JSON.parse(raw);
		const e = j.error;
		if (e && typeof e === "object") {
			return `${JSON.stringify(e)}`;
		}
		return String(e?.message || e || raw);
	} catch {
		return raw || `HTTP ${status}`;
	}
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
					reject(
						new Error(
							`${label}: ${err.message}${se ? `\nffmpeg stderr:\n${se}` : ""}`,
						),
					);
					return;
				}
				resolve();
			},
		);
	});
}

/**
 * Streaming TTS: OpenAI only allows audio.format "pcm16" when stream=true (not mp3/wav).
 */
function buildTtsFallbackList() {
	const custom = process.env.OPENROUTER_VIDEO_TTS_MODEL?.trim();
	const core = [
		{ model: "openai/gpt-audio", format: "pcm16" },
		{ model: "openai/gpt-audio-mini", format: "pcm16" },
	];
	if (custom) {
		const prepend = [{ model: custom, format: "pcm16" }];
		const seen = new Set();
		const out = [];
		for (const x of [...prepend, ...core]) {
			const k = `${x.model}\0${x.format}`;
			if (seen.has(k)) continue;
			seen.add(k);
			out.push(x);
		}
		return out;
	}
	return core;
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

async function readSseAudioStream(reader, decoder, onErrorPayload) {
	let sseBuffer = "";
	const audioChunks = [];
	/** OpenRouter sends `usage` on the last streaming chunk (includes `cost` in USD when available). */
	let lastUsage = null;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		sseBuffer += decoder.decode(value, { stream: true });
		const lines = sseBuffer.split("\n");
		sseBuffer = lines.pop() || "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("data: ")) continue;
			const payload = trimmed.slice(6).trim();
			if (payload === "[DONE]") continue;
			let parsed;
			try {
				parsed = JSON.parse(payload);
			} catch {
				continue;
			}
			if (parsed.error) {
				onErrorPayload(parsed.error);
			}
			if (parsed.usage) lastUsage = parsed.usage;
			const audio = parsed?.choices?.[0]?.delta?.audio;
			if (audio?.data) audioChunks.push(audio.data);
		}
	}
	return { audioChunks, usage: lastUsage };
}

/**
 * Single TTS attempt: stream audio output → Buffer (decoded from base64 chunks).
 */
async function ttsSingleAttempt({ text, model, format, signal }) {
	const res = await fetch(OPENROUTER_CHAT, {
		method: "POST",
		signal,
		headers: openRouterFetchHeaders(),
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "user",
					content: `Speak the following narration clearly and naturally for video dubbing, with no introduction or preamble. Only the spoken words:\n\n${text}`,
				},
			],
			modalities: ["text", "audio"],
			audio: { voice: "alloy", format },
			stream: true,
		}),
	});

	if (!res.ok) {
		const bodyText = await res.text();
		throw new Error(formatOpenRouterHttpError(res.status, bodyText));
	}

	if (!res.body) throw new Error("TTS: empty response body");

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let streamErr;
	const { audioChunks, usage } = await readSseAudioStream(reader, decoder, (e) => {
		streamErr = e;
	});
	if (streamErr) {
		throw new Error(
			typeof streamErr === "object"
				? JSON.stringify(streamErr)
				: String(streamErr),
		);
	}
	if (!audioChunks.length) {
		throw new Error(
			"No audio chunks in TTS stream (empty or unsupported modality for this model)",
		);
	}
	return {
		buffer: Buffer.from(audioChunks.join(""), "base64"),
		usage,
	};
}

/**
 * gpt-audio streaming → pcm16 only; optional chunking + ffmpeg concat raw PCM.
 * Exported for text-only voice translation (OpenRouter TTS).
 */
export async function ttsSynthesizeToBuffer({ text, signal }) {
	const fallbacks = buildTtsFallbackList();
	const chunks = splitTextIntoTtsChunks(text, 2800);
	let lastErr = "";

	for (const { model, format } of fallbacks) {
		try {
			const ext = "pcm";
			if (chunks.length === 1) {
				const { buffer: buf, usage: u0 } = await ttsSingleAttempt({
					text: chunks[0],
					model,
					format,
					signal,
				});
				return { buffer: buf, format: "pcm16", usage: u0 };
			}
			const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vt-tts-"));
			try {
				const paths = [];
				let mergedTtsUsage = normalizeOpenRouterUsage(null);
				for (let i = 0; i < chunks.length; i++) {
					const { buffer: buf, usage: uPart } = await ttsSingleAttempt({
						text: chunks[i],
						model,
						format,
						signal,
					});
					mergedTtsUsage = mergeOpenRouterUsage(mergedTtsUsage, uPart);
					const p = path.join(tmpDir, `p${i}.${ext}`);
					await fsp.writeFile(p, buf);
					paths.push(p);
				}
				const listPath = path.join(tmpDir, "list.txt");
				const listBody = paths
					.map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
					.join("\n");
				await fsp.writeFile(listPath, listBody, "utf8");
				const outPath = path.join(tmpDir, `merged.${ext}`);
				await execFfmpeg(
					["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath],
					"ffmpeg concat TTS PCM segments",
				);
				return {
					buffer: await fsp.readFile(outPath),
					format: "pcm16",
					usage: mergedTtsUsage,
				};
			} finally {
				await rmDirSafe(tmpDir);
			}
		} catch (e) {
			lastErr = e?.message || String(e);
		}
	}

	throw new Error(
		`TTS failed after fallbacks (pcm16 + gpt-audio / gpt-audio-mini). Last: ${lastErr}`,
	);
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

/**
 * Gemini: video as base64 data URL + JSON transcript + translation.
 */
async function transcribeAndTranslateWithGemini({
	videoDataUrl,
	targetLanguage,
	signal,
	model: modelId,
}) {
	const model = modelId?.trim() || geminiVideoModel();
	const userText = `Transcribe this video exactly and then translate it into ${targetLanguage}. Provide both as a structured JSON object with keys "transcript" and "translation" only.`;

	const messages = [
		{
			role: "user",
			content: [
				{ type: "text", text: userText },
				{
					type: "video_url",
					video_url: { url: videoDataUrl },
				},
			],
		},
	];

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
			data?.error?.message ||
				data?.error ||
				`Gemini video HTTP ${res.status}`,
		);
	}

	const content = data?.choices?.[0]?.message?.content;
	const raw = typeof content === "string" ? content : "";
	if (!raw) throw new Error("Empty response from Gemini");

	const parsed = parseJsonObjectFromModel(raw);
	const transcript = String(parsed.transcript ?? "").trim();
	const translation = String(parsed.translation ?? "").trim();
	if (!transcript || !translation) {
		throw new Error(
			"Gemini JSON must include non-empty transcript and translation",
		);
	}
	return { transcript, translation, usage: data.usage };
}

async function downloadVideoToTempFile(url, signal) {
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vt-dub-"));
	try {
		if (isYoutubeVideoUrl(url)) {
			const { buf, videoPath } = await downloadYoutubeViaYtDlp(
				url,
				signal,
				tmpDir,
			);
			return { videoPath, tmpDir, buffer: buf };
		}
		const buf = await fetchVideoBufferWithRetries(url, signal);
		const videoPath = path.join(tmpDir, "input.mp4");
		await fsp.writeFile(videoPath, buf);
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
							usage: d.usage ?? null,
							tokenUsage: d.tokenUsage ?? null,
							priceUsd: d.priceUsd ?? null,
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
			usage: d.usage ?? null,
			tokenUsage: d.tokenUsage ?? null,
			priceUsd: d.priceUsd ?? null,
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
				priceUsd: null,
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
		usage: d.usage ?? null,
		tokenUsage: d.tokenUsage ?? null,
		priceUsd: d.priceUsd ?? null,
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
	const snap = await firestore.collection(JOBS_COLL).doc(jobId).get();
	if (!snap.exists) return;
	const job = snap.data();

	await patchJob(jobId, {
		status: "running",
		updatedAt: FieldValue.serverTimestamp(),
	});

	let tmpDir;
	try {
		const { videoPath, tmpDir: tDir, buffer } = await downloadVideoToTempFile(
			job.video_url,
			signal,
		);
		tmpDir = tDir;

		const mime = "video/mp4";
		const videoDataUrl = `data:${mime};base64,${buffer.toString("base64")}`;

		const { transcript, translation, usage: geminiUsage } =
			await transcribeAndTranslateWithGemini({
				videoDataUrl,
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
	}
}
