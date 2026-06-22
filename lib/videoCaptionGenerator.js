/**
 * AI video caption generator: download video → extract audio → OpenRouter timed
 * transcription → SRT → FFmpeg burn-in → UploadThing (captioned MP4 + VTT/SRT).
 */
import { v4 as uuidv4 } from "uuid";
import { execFile } from "child_process";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../config/firebase.js";
import { UTApi, UTFile } from "uploadthing/server";
import {
	buildUsageResponseFields,
	normalizeOpenRouterUsage,
	publicTranslateUsageFromDoc,
} from "./openRouterUsage.js";
import { resolveTranslateLlmModel, TRANSLATE_LLM_PRESETS } from "./translateLlmModels.js";

const JOBS_COLL = "videoCaptionJobs";
const OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions";

const utapi = new UTApi({ token: process.env.UPLOADTHING_TOKEN });

const MAX_VIDEO_BYTES =
	Number.parseInt(process.env.VIDEO_CAPTION_MAX_VIDEO_BYTES || "", 10) ||
	Number.parseInt(process.env.VIDEO_TRANSLATE_MAX_VIDEO_BYTES || "", 10) ||
	200 * 1024 * 1024;
const MAX_MINUTES =
	Number.parseInt(process.env.VIDEO_CAPTION_MAX_MINUTES || "", 10) ||
	Number.parseInt(process.env.VIDEO_TRANSLATE_MAX_MINUTES_FREE || "", 10) ||
	10;
const OPENROUTER_TIMEOUT_MS =
	Number.parseInt(process.env.OPENROUTER_VIDEO_TIMEOUT_MS || "", 10) || 600_000;
const TRANSCRIBE_AUDIO_MAX_BYTES =
	Number.parseInt(process.env.VIDEO_CAPTION_TRANSCRIBE_AUDIO_MAX_BYTES || "", 10) ||
	25 * 1024 * 1024;
const VIDEO_DOWNLOAD_MAX_ATTEMPTS =
	Number.parseInt(process.env.VIDEO_CAPTION_DOWNLOAD_RETRIES || "", 10) || 5;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOpenRouterKey() {
	return process.env.OPENROUTER_API_KEY?.trim() || "";
}

function getFfmpegBin() {
	return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

function getFfprobeBin() {
	return process.env.FFPROBE_PATH?.trim() || "ffprobe";
}

function openRouterHeaders() {
	const key = getOpenRouterKey();
	const h = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${key}`,
	};
	const ref = process.env.OPENROUTER_HTTP_REFERER?.trim();
	h.Referer = ref || "https://ihatereading.in";
	const title = process.env.OPENROUTER_APP_TITLE?.trim();
	if (title) h["X-Title"] = title;
	return h;
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

function parseRetryAfterMs(headers) {
	const raw = headers.get("retry-after");
	if (!raw) return null;
	const sec = Number.parseInt(raw, 10);
	if (!Number.isNaN(sec)) return sec * 1000;
	const t = Date.parse(raw);
	if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
	return null;
}

async function fetchVideoBufferWithRetries(url, signal, maxVideoBytes) {
	const ua =
		process.env.VIDEO_CAPTION_DOWNLOAD_USER_AGENT?.trim() ||
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
				throw new Error(`Video exceeds byte limit (${maxVideoBytes} bytes)`);
			}
			return buf;
		}

		lastStatus = res.status;
		try {
			await res.arrayBuffer();
		} catch {
			/* ignore */
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
		await sleep(waitMs + Math.floor(Math.random() * 400));
	}

	throw new Error(`Failed to download video: HTTP ${lastStatus}`);
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
							? " Install ffmpeg on the host or set FFMPEG_PATH."
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

async function getVideoDurationSeconds(videoPath) {
	const ffprobe = getFfprobeBin();
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
					"default=noprint_wrappers=1:nokey=1",
					videoPath,
				],
				{ timeout: 30_000 },
				(err, stdout) => {
					if (err) reject(err);
					else resolve(stdout);
				},
			);
		});
		const sec = Number.parseFloat(String(out).trim());
		if (Number.isFinite(sec) && sec > 0) return sec;
	} catch {
		/* fall through */
	}

	const ffmpeg = getFfmpegBin();
	const stderr = await new Promise((resolve, reject) => {
		execFile(
			ffmpeg,
			["-i", videoPath, "-f", "null", "-"],
			{ timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
			(_err, _stdout, errOut) => {
				if (errOut) resolve(String(errOut));
				else reject(new Error("ffmpeg produced no stderr for duration"));
			},
		);
	});
	const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
	if (!m) throw new Error("Unable to determine video duration");
	return (
		Number(m[1]) * 3600 + Number(m[2]) * 60 + Number.parseFloat(m[3])
	);
}

async function enforceDurationLimit(videoPath, maxMinutes) {
	const sec = await getVideoDurationSeconds(videoPath);
	if (sec > maxMinutes * 60) {
		throw new Error(
			`Video duration ${Math.ceil(sec)}s exceeds plan limit (${maxMinutes} minutes)`,
		);
	}
	return sec;
}

async function downloadVideoToTempFile(url, signal, maxVideoBytes, maxMinutes) {
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vcap-"));
	try {
		const buf = await fetchVideoBufferWithRetries(url, signal, maxVideoBytes);
		const videoPath = path.join(tmpDir, "input.mp4");
		await fsp.writeFile(videoPath, buf);
		const durationSec = await enforceDurationLimit(videoPath, maxMinutes);
		return { videoPath, tmpDir, buffer: buf, durationSec };
	} catch (e) {
		await rmDirSafe(tmpDir);
		throw e;
	}
}

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

function escapeFfmpegSubPath(p) {
	return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

async function ffmpegBurnCaptions(inputPath, srtPath, outPath, style = "bottom") {
	const escaped = escapeFfmpegSubPath(srtPath);
	const alignment = style === "top" ? 8 : 2;
	const marginV = style === "top" ? 40 : 60;
	const vf = `subtitles='${escaped}':force_style='Alignment=${alignment},Fontsize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=${marginV}'`;
	await execFfmpeg(
		["-y", "-i", inputPath, "-vf", vf, "-c:a", "copy", outPath],
		"ffmpeg burn captions",
	);
}

function msToSrtTime(ms) {
	const total = Math.max(0, Math.floor(ms));
	const h = Math.floor(total / 3_600_000);
	const m = Math.floor((total % 3_600_000) / 60_000);
	const s = Math.floor((total % 60_000) / 1000);
	const msRem = total % 1000;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(msRem).padStart(3, "0")}`;
}

function distributeTranscriptToSegments(transcript, durationSec) {
	const sentences = String(transcript || "")
		.split(/(?<=[.!?])\s+|\n+/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (!sentences.length) return [];

	const totalMs = Math.max(1000, Math.floor(durationSec * 1000));
	const slice = Math.floor(totalMs / sentences.length);
	return sentences.map((text, i) => ({
		start_ms: i * slice,
		end_ms: i === sentences.length - 1 ? totalMs : (i + 1) * slice,
		text,
	}));
}

function normalizeSegments(raw, durationSec) {
	if (!Array.isArray(raw)) {
		return typeof raw === "string" && raw.trim()
			? distributeTranscriptToSegments(raw, durationSec)
			: [];
	}
	const out = [];
	for (const row of raw) {
		const text = String(row?.text ?? "").trim();
		if (!text) continue;
		let startMs = Number(row?.start_ms ?? row?.startMs);
		let endMs = Number(row?.end_ms ?? row?.endMs);
		if (!Number.isFinite(startMs)) {
			const startSec = Number(row?.start ?? row?.start_sec ?? row?.startSec);
			startMs = Number.isFinite(startSec) ? startSec * 1000 : NaN;
		}
		if (!Number.isFinite(endMs)) {
			const endSec = Number(row?.end ?? row?.end_sec ?? row?.endSec);
			endMs = Number.isFinite(endSec) ? endSec * 1000 : NaN;
		}
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
			continue;
		}
		out.push({ start_ms: Math.floor(startMs), end_ms: Math.floor(endMs), text });
	}
	return out;
}

function buildSrtContent(segments) {
	return segments
		.map((seg, i) => {
			const start = msToSrtTime(seg.start_ms);
			const end = msToSrtTime(seg.end_ms);
			return `${i + 1}\n${start} --> ${end}\n${seg.text}\n`;
		})
		.join("\n");
}

function buildVttContent(segments) {
	const body = segments
		.map((seg) => {
			const start = msToSrtTime(seg.start_ms).replace(",", ".");
			const end = msToSrtTime(seg.end_ms).replace(",", ".");
			return `${start} --> ${end}\n${seg.text}\n`;
		})
		.join("\n");
	return `WEBVTT\n\n${body}`;
}

async function transcribeTimedCaptions({
	audioBuffer,
	language,
	durationSec,
	signal,
	model,
}) {
	const userText = `Listen to this audio from a short-form video (~${Math.ceil(durationSec)} seconds). Transcribe the spoken content in ${language || "the original language"} and return timed caption segments.

Reply with ONLY a JSON object:
{
  "transcript": "<full verbatim transcript>",
  "segments": [
    { "start_ms": 0, "end_ms": 2500, "text": "<caption line>" }
  ]
}

Rules:
- segments must cover the full spoken content in chronological order
- each segment should be 1-2 short lines suitable for on-screen captions (shorts/Reels style)
- start_ms and end_ms are integers in milliseconds from video start
- do not overlap segments; end_ms must be greater than start_ms`;

	const audioBase64 = audioBuffer.toString("base64");
	const messages = [
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
	];

	let chatRes = await fetch(OPENROUTER_CHAT, {
		method: "POST",
		signal,
		headers: openRouterHeaders(),
		body: JSON.stringify({
			model,
			messages,
			temperature: 0.1,
			response_format: { type: "json_object" },
		}),
	});

	let chatData = await chatRes.json().catch(() => ({}));
	if (!chatRes.ok || chatData.error) {
		const msg = String(chatData?.error?.message || chatData?.error || "");
		const retryNoRf = /response_format|json_object|unsupported/i.test(msg);
		if (retryNoRf) {
			chatRes = await fetch(OPENROUTER_CHAT, {
				method: "POST",
				signal,
				headers: openRouterHeaders(),
				body: JSON.stringify({
					model,
					messages,
					temperature: 0.1,
				}),
			});
			chatData = await chatRes.json().catch(() => ({}));
		}
	}

	if (!chatRes.ok || chatData.error) {
		throw new Error(
			chatData.error?.message ||
				chatData.error ||
				`OpenRouter HTTP ${chatRes.status}`,
		);
	}

	const content = chatData.choices?.[0]?.message?.content;
	if (!content || typeof content !== "string") {
		throw new Error("Empty caption transcription from model");
	}

	const parsed = parseJsonObjectFromModel(content);
	const transcript = String(parsed?.transcript ?? "").trim();
	let segments = normalizeSegments(parsed?.segments, durationSec);
	if (!segments.length && transcript) {
		segments = distributeTranscriptToSegments(transcript, durationSec);
	}
	if (!segments.length) {
		throw new Error("Model returned no caption segments");
	}

	return {
		transcript: transcript || segments.map((s) => s.text).join(" "),
		segments,
		usage: chatData.usage,
		model,
	};
}

async function uploadMp4Buffer(buffer, jobId) {
	const fileName = `captioned-${jobId}.mp4`;
	const utFile = new UTFile([buffer], fileName, { type: "video/mp4" });
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(`UploadThing captioned video failed: ${response.error.message}`);
	}
	return response.data.ufsUrl;
}

async function uploadCaptionSidecar(buffer, jobId, ext, mime) {
	const fileName = `captions-${jobId}${ext}`;
	const utFile = new UTFile([buffer], fileName, { type: mime });
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(`UploadThing caption file failed: ${response.error.message}`);
	}
	return response.data.ufsUrl;
}

async function rmDirSafe(dir) {
	await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function newJobId() {
	return `vc_${uuidv4().replace(/-/g, "")}`;
}

async function writeJob(docId, data) {
	await firestore.collection(JOBS_COLL).doc(docId).set(data, { merge: true });
}

async function patchJob(docId, data) {
	await firestore.collection(JOBS_COLL).doc(docId).update(data);
}

function resolveCaptionModel(raw) {
	if (raw != null && String(raw).trim() !== "") {
		const r = resolveTranslateLlmModel(raw);
		if (!r.ok) return r;
		return { ok: true, openrouterId: r.openrouterId, preset: r.preset };
	}
	return {
		ok: true,
		openrouterId:
			process.env.VIDEO_CAPTION_TRANSCRIBE_MODEL?.trim() ||
			process.env.OPENROUTER_VOICE_TRANSLATE_TRANSCRIBE_MODEL?.trim() ||
			TRANSLATE_LLM_PRESETS.gemini,
		preset: "gemini",
	};
}

export async function createVideoCaptionJob({ videoUrl, body = {} }) {
	if (!getOpenRouterKey()) {
		return {
			error: "OPENROUTER_API_KEY not configured",
			code: "MISSING_API_KEY",
			httpStatus: 503,
		};
	}
	if (!process.env.UPLOADTHING_TOKEN?.trim()) {
		return {
			error:
				"UPLOADTHING_TOKEN not configured (required to upload captioned video)",
			code: "MISSING_UPLOAD_TOKEN",
			httpStatus: 503,
		};
	}

	const video_url = String(videoUrl || "").trim();
	if (!video_url) {
		return {
			error:
				"Provide video_url (or videoUrl) or upload a video file (field: file or video)",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const modelRes = resolveCaptionModel(body.model ?? body.llm_model);
	if (!modelRes.ok) {
		return {
			error: modelRes.error,
			code: "BAD_REQUEST",
			details: { allowed_models: modelRes.allowed },
			httpStatus: 400,
		};
	}

	const language = String(body.language ?? body.caption_language ?? "en").trim();
	const captionStyle =
		String(body.caption_style ?? body.style ?? "bottom").toLowerCase() === "top"
			? "top"
			: "bottom";
	const burnCaptions = body.burn_captions !== false && body.burnCaptions !== false;

	const id = newJobId();
	await writeJob(id, {
		id,
		status: "pending",
		video_url,
		source_video_url: video_url,
		language,
		caption_style: captionStyle,
		burn_captions: burnCaptions,
		llm_model: modelRes.openrouterId,
		llm_preset: modelRes.preset,
		max_video_bytes: MAX_VIDEO_BYTES,
		max_minutes: MAX_MINUTES,
		createdAt: FieldValue.serverTimestamp(),
		updatedAt: FieldValue.serverTimestamp(),
	});

	queueProcessCaptionJob(id);

	return {
		error: null,
		data: {
			video_caption_id: id,
		},
		httpStatus: 200,
	};
}

function queueProcessCaptionJob(jobId) {
	setImmediate(() => {
		processVideoCaptionJob(jobId).catch((err) => {
			console.error(`[videoCaption] job ${jobId} failed:`, err);
			patchJob(jobId, {
				status: "failed",
				error: err?.message || String(err),
				updatedAt: FieldValue.serverTimestamp(),
			}).catch(() => {});
		});
	});
}

async function processVideoCaptionJob(jobId) {
	const signal = AbortSignal.timeout(OPENROUTER_TIMEOUT_MS);
	let tmpDir;
	try {
		const snap = await firestore.collection(JOBS_COLL).doc(jobId).get();
		if (!snap.exists) return;
		const job = snap.data();

		await patchJob(jobId, {
			status: "running",
			updatedAt: FieldValue.serverTimestamp(),
		});

		const maxVideoBytes =
			Number.parseInt(String(job.max_video_bytes || ""), 10) || MAX_VIDEO_BYTES;
		const maxMinutes =
			Number.parseInt(String(job.max_minutes || ""), 10) || MAX_MINUTES;

		const { videoPath, tmpDir: tDir, durationSec } = await downloadVideoToTempFile(
			job.video_url,
			signal,
			maxVideoBytes,
			maxMinutes,
		);
		tmpDir = tDir;

		const transcribeAudioPath = path.join(tmpDir, "transcribe_input.wav");
		await ffmpegExtractTranscribeAudio(videoPath, transcribeAudioPath);
		const transcribeAudioBuffer = await fsp.readFile(transcribeAudioPath);
		if (transcribeAudioBuffer.length > TRANSCRIBE_AUDIO_MAX_BYTES) {
			throw new Error(
				`Transcription audio too large (${transcribeAudioBuffer.length} bytes)`,
			);
		}

		const { transcript, segments, usage, model } = await transcribeTimedCaptions({
			audioBuffer: transcribeAudioBuffer,
			language: job.language,
			durationSec,
			signal,
			model: job.llm_model,
		});

		const usagePayload = buildUsageResponseFields(
			normalizeOpenRouterUsage(usage),
		);

		const srtContent = buildSrtContent(segments);
		const vttContent = buildVttContent(segments);
		const srtPath = path.join(tmpDir, "captions.srt");
		await fsp.writeFile(srtPath, srtContent, "utf8");

		let captionedVideoUrl = null;
		if (job.burn_captions !== false) {
			const finalPath = path.join(tmpDir, "captioned_output.mp4");
			await ffmpegBurnCaptions(
				videoPath,
				srtPath,
				finalPath,
				job.caption_style || "bottom",
			);
			const finalBuf = await fsp.readFile(finalPath);
			captionedVideoUrl = await uploadMp4Buffer(finalBuf, jobId);
		}

		const captionUrl = await uploadCaptionSidecar(
			Buffer.from(vttContent, "utf8"),
			jobId,
			".vtt",
			"text/vtt",
		);
		const srtUrl = await uploadCaptionSidecar(
			Buffer.from(srtContent, "utf8"),
			jobId,
			".srt",
			"application/x-subrip",
		).catch(() => null);

		await patchJob(jobId, {
			status: "success",
			transcript,
			caption_text: transcript,
			captions: segments,
			caption_url: captionUrl,
			srt_url: srtUrl,
			captioned_video_url: captionedVideoUrl,
			final_video_url: captionedVideoUrl,
			video_url_output: captionedVideoUrl,
			transcribe_model: model,
			...usagePayload,
			error: null,
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

export async function getVideoCaptionJobStatus(id) {
	const jobId = String(id || "").trim();
	if (!jobId) {
		return {
			error: "Missing video caption job id",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const snap = await firestore.collection(JOBS_COLL).doc(jobId).get();
	if (!snap.exists) {
		return {
			error: "Unknown video_caption_id",
			code: "NOT_FOUND",
			httpStatus: 404,
		};
	}

	const d = snap.data();
	const captionedVideoUrl =
		d.captioned_video_url || d.final_video_url || d.video_url_output || null;

	const data = {
		video_caption_id: jobId,
		status: d.status || "pending",
		source_video_url: d.source_video_url || d.video_url || null,
		language: d.language || null,
		transcript: d.transcript ?? d.caption_text ?? null,
		caption: d.caption_text ?? d.transcript ?? null,
		caption_url: d.caption_url || null,
		srt_url: d.srt_url || null,
		captioned_video_url: captionedVideoUrl,
		final_video_url: captionedVideoUrl,
		videoUrl: captionedVideoUrl,
		video_url: captionedVideoUrl,
		captions: d.captions || null,
		burn_captions: d.burn_captions ?? true,
		error: d.status === "failed" ? d.error || "Job failed" : null,
		...publicTranslateUsageFromDoc(d),
		engine: "openrouter-caption-ffmpeg",
	};

	return { error: null, data, httpStatus: 200 };
}
