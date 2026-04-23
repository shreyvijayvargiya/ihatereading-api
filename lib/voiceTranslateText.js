/**
 * Text or audio → multiple target languages: OpenRouter transcription (audio) +
 * JSON translation + optional OpenRouter TTS (pcm16) per language.
 */
import path from "node:path";
import {
	mergeOpenRouterUsage,
	normalizeOpenRouterUsage,
	buildUsageResponseFields,
} from "./openRouterUsage.js";
import {
	ttsSynthesizeToBuffer,
	pcm16ToWavBuffer,
} from "./videoTranslateOpenRouter.js";
import {
	TRANSLATE_LLM_PRESETS,
	resolveTranslateLlmModel,
} from "./translateLlmModels.js";
import { ACTIVE_OPENROUTER_MODELS } from "./activeOpenRouterModels.js";

const OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions";

const OPENROUTER_TIMEOUT_MS =
	Number.parseInt(process.env.OPENROUTER_TIMEOUT_MS || "", 10) || 90_000;

const MAX_TEXT_CHARS =
	Number.parseInt(process.env.VOICE_TRANSLATE_TEXT_MAX_CHARS || "", 10) || 12_000;
const MAX_LANGUAGES =
	Number.parseInt(process.env.VOICE_TRANSLATE_TEXT_MAX_LANGUAGES || "", 10) || 12;
const MAX_AUDIO_BYTES =
	Number.parseInt(process.env.VOICE_TRANSLATE_MAX_AUDIO_BYTES || "", 10) ||
	25 * 1024 * 1024;

function openRouterHeaders() {
	const key = process.env.OPENROUTER_API_KEY;
	const h = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${key}`,
	};
	const ref = process.env.OPENROUTER_HTTP_REFERER?.trim();
	if (ref) h.Referer = ref;
	else h.Referer = "https://ihatereading.in";
	const title = process.env.OPENROUTER_APP_TITLE?.trim();
	if (title) h["X-Title"] = title;
	return h;
}

/**
 * OpenRouter may return `message.content` as a string or as an array of parts
 * (e.g. [{ type: "text", text: "..." }]). Normalize to a single string.
 */
function assistantMessageText(message) {
	if (!message || typeof message !== "object") return "";
	const c = message.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && typeof part.text === "string") {
					return part.text;
				}
				return "";
			})
			.join("");
	}
	return "";
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

function normalizeLanguageList(raw) {
	if (!raw) return [];
	const arr = Array.isArray(raw) ? raw : [raw];
	const seen = new Set();
	const out = [];
	for (const x of arr) {
		const s = String(x ?? "").trim();
		if (!s || seen.has(s.toLowerCase())) continue;
		seen.add(s.toLowerCase());
		out.push(s);
	}
	return out;
}

/** Map file extension or OpenRouter input_audio format string. */
function extensionToAudioFormat(ext) {
	const e = String(ext || "").toLowerCase().replace(/^\./, "");
	const map = {
		mp3: "mp3",
		wav: "wav",
		m4a: "m4a",
		aac: "aac",
		ogg: "ogg",
		oga: "ogg",
		webm: "ogg",
		flac: "flac",
		aiff: "aiff",
		aif: "aiff",
		mp4: "m4a",
		pcm: "pcm16",
	};
	return map[e] || null;
}

export function guessAudioFormatFromFilename(filename) {
	const ext = path.extname(filename || "").toLowerCase();
	return extensionToAudioFormat(ext);
}

/**
 * Fetch remote audio bytes (e.g. UploadThing URL after upload).
 */
export async function fetchAudioBufferFromUrl(url, signal) {
	const res = await fetch(String(url).trim(), {
		signal,
		redirect: "follow",
		headers: {
			"User-Agent":
				process.env.VOICE_TRANSLATE_AUDIO_FETCH_UA?.trim() ||
				"Mozilla/5.0 (compatible; ihatereading-api/1.0)",
		},
	});
	if (!res.ok) {
		throw new Error(`Failed to fetch audio URL: HTTP ${res.status}`);
	}
	const len = res.headers.get("content-length");
	if (len && Number(len) > MAX_AUDIO_BYTES) {
		throw new Error(`Audio file too large (max ${MAX_AUDIO_BYTES} bytes)`);
	}
	const ab = await res.arrayBuffer();
	const buf = Buffer.from(ab);
	if (buf.length > MAX_AUDIO_BYTES) {
		throw new Error(`Audio file too large (max ${MAX_AUDIO_BYTES} bytes)`);
	}
	return buf;
}

async function transcribeAudioWithOpenRouter({
	buffer,
	format,
	signal,
	model: modelOverride,
}) {
	const model =
		modelOverride?.trim() ||
		process.env.OPENROUTER_VOICE_TRANSLATE_TRANSCRIBE_MODEL?.trim() ||
		TRANSLATE_LLM_PRESETS.gemini;

	const fmt = format || "mp3";
	const base64 = buffer.toString("base64");

	const userText =
		'Transcribe the spoken content verbatim in the original language. Reply with ONLY a JSON object: {"transcript":"<full transcript>"}';

	const messages = [
		{
			role: "user",
			content: [
				{ type: "text", text: userText },
				{
					type: "input_audio",
					input_audio: {
						data: base64,
						format: fmt,
					},
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
		const msg =
			chatData.error?.message ||
			chatData.error ||
			`OpenRouter HTTP ${chatRes.status}`;
		throw new Error(String(msg));
	}

	const content = assistantMessageText(chatData.choices?.[0]?.message);
	if (!content?.trim()) {
		throw new Error("Empty transcription from model");
	}

	let parsed;
	try {
		parsed = parseJsonObjectFromModel(content);
	} catch (e) {
		throw new Error(`Invalid transcription JSON: ${e?.message || String(e)}`);
	}

	const transcript = String(parsed?.transcript ?? "").trim();
	if (!transcript) {
		throw new Error("Transcription produced empty transcript");
	}

	return { transcript, usage: chatData.usage, model };
}

/**
 * @param {{
 *   text?: string,
 *   audioUrl?: string,
 *   audioBuffer?: Buffer,
 *   audioFormat?: string,
 *   languages: unknown,
 *   includeAudio?: boolean,
 *   model?: string,
 *   llmModel?: string,
 *   signal?: AbortSignal,
 *   afterTranslatedTts?: (results: Array<Record<string, unknown>>) => Promise<void>,
 * }} opts
 *
 * Provide one of: non-empty `text`, or `audioUrl`, or `audioBuffer` (after server upload).
 * If both text and audio are supplied, audio wins.
 * When `afterTranslatedTts` is set (e.g. UploadThing), it runs after pcm16 TTS so `results` can be replaced with URLs before the response is built.
 */
export async function runVoiceTranslateText({
	text,
	audioUrl,
	audioBuffer,
	audioFormat,
	languages,
	includeAudio = true,
	model: modelParam,
	llmModel: llmModelParam,
	signal: outerSignal,
	afterTranslatedTts,
}) {
	if (!process.env.OPENROUTER_API_KEY?.trim()) {
		return {
			error: "OPENROUTER_API_KEY not configured",
			code: "MISSING_API_KEY",
			httpStatus: 503,
		};
	}

	const rawModel = modelParam ?? llmModelParam;
	let translationModelId;
	let transcribeModelId;
	let llmPresetName;

	if (rawModel != null && String(rawModel).trim() !== "") {
		const r = resolveTranslateLlmModel(rawModel);
		if (!r.ok) {
			return {
				error: r.error,
				code: "BAD_REQUEST",
				details: { allowed_models: r.allowed },
				httpStatus: 400,
			};
		}
		translationModelId = r.openrouterId;
		transcribeModelId = r.openrouterId;
		llmPresetName = r.preset;
	} else {
		translationModelId =
			ACTIVE_OPENROUTER_MODELS.voice.translate ||
			process.env.OPENROUTER_VOICE_TRANSLATE_MODEL?.trim() ||
			process.env.OPENROUTER_MODEL?.trim() ||
			TRANSLATE_LLM_PRESETS.gemini;
		transcribeModelId =
			ACTIVE_OPENROUTER_MODELS.voice.transcribe ||
			process.env.OPENROUTER_VOICE_TRANSLATE_TRANSCRIBE_MODEL?.trim() ||
			TRANSLATE_LLM_PRESETS.gemini;
	}

	const langs = normalizeLanguageList(languages);
	if (!langs.length) {
		return {
			error:
				"Provide languages as a non-empty array of language names (e.g. [\"Spanish\",\"French\"])",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}
	if (langs.length > MAX_LANGUAGES) {
		return {
			error: `At most ${MAX_LANGUAGES} languages per request`,
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const signal =
		outerSignal ||
		AbortSignal.timeout(Math.max(OPENROUTER_TIMEOUT_MS, 180_000));

	const hasAudio =
		(audioBuffer && audioBuffer.length > 0) ||
		(audioUrl && String(audioUrl).trim());

	let source = "";
	let sourceType = "text";
	let transcribeModel = null;
	let audioInputUrl = null;
	let mergedUsage = normalizeOpenRouterUsage(null);

	if (hasAudio) {
		sourceType = "audio";
		let buf = audioBuffer;
		let fmt =
			(audioFormat && extensionToAudioFormat(audioFormat)) ||
			(typeof audioFormat === "string" && audioFormat.length <= 8
				? audioFormat.toLowerCase()
				: null);

		if (audioUrl) {
			audioInputUrl = String(audioUrl).trim();
		}
		if (!buf && audioUrl) {
			buf = await fetchAudioBufferFromUrl(String(audioUrl).trim(), signal);
		}

		if (!buf?.length) {
			return {
				error: "Missing or empty audio buffer",
				code: "BAD_REQUEST",
				httpStatus: 400,
			};
		}
		if (buf.length > MAX_AUDIO_BYTES) {
			return {
				error: `Audio file too large (max ${MAX_AUDIO_BYTES} bytes)`,
				code: "BAD_REQUEST",
				httpStatus: 400,
			};
		}

		if (!fmt && audioUrl) {
			try {
				const p = new URL(String(audioUrl)).pathname;
				fmt = guessAudioFormatFromFilename(p) || "mp3";
			} catch {
				fmt = "mp3";
			}
		}
		if (!fmt) fmt = "mp3";

		try {
			const tr = await transcribeAudioWithOpenRouter({
				buffer: buf,
				format: fmt,
				signal,
				model: transcribeModelId,
			});
			source = tr.transcript;
			transcribeModel = tr.model;
			mergedUsage = mergeOpenRouterUsage(
				mergedUsage,
				normalizeOpenRouterUsage(tr.usage),
			);
		} catch (e) {
			return {
				error: e?.message || String(e),
				code: "TRANSCRIBE_ERROR",
				httpStatus: 502,
			};
		}
	} else {
		source = String(text ?? "").trim();
		if (!source) {
			return {
				error:
					"Provide non-empty text, or audio_url, or upload an audio file (field: audio or file)",
				code: "BAD_REQUEST",
				httpStatus: 400,
			};
		}
	}

	if (!hasAudio && source.length > MAX_TEXT_CHARS) {
		return {
			error: `text exceeds ${MAX_TEXT_CHARS} characters`,
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const model = translationModelId;

	const system = `You translate prose for voice dubbing. Reply with ONLY a JSON object (no markdown) with this exact shape:
{"translations":[{"language":"<exact label from the request>","transcript":"<full translation>"}]}
Include one object per requested language. The "language" value must match the requested label exactly (case-sensitive). "transcript" must be the complete translation, natural for spoken delivery.`;

	const user = `Source text:\n"""${source}"""\n\nTarget languages (use these exact strings for "language"): ${JSON.stringify(langs)}`;

	const translationBody = (withJsonObject) =>
		JSON.stringify({
			model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			temperature: 0.25,
			...(withJsonObject ? { response_format: { type: "json_object" } } : {}),
		});

	let chatRes = await fetch(OPENROUTER_CHAT, {
		method: "POST",
		signal,
		headers: openRouterHeaders(),
		body: translationBody(true),
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
				body: translationBody(false),
			});
			chatData = await chatRes.json().catch(() => ({}));
		}
	}
	if (!chatRes.ok || chatData.error) {
		const msg =
			chatData.error?.message ||
			chatData.error ||
			`OpenRouter HTTP ${chatRes.status}`;
		const upstream = chatRes.status;
		/** Do not forward 404 — clients mistake it for a missing API route. */
		let httpStatus = 502;
		if (upstream === 429) httpStatus = 429;
		else if (upstream === 401 || upstream === 403) httpStatus = upstream;
		return {
			error: String(msg),
			code: "OPENROUTER_ERROR",
			upstream_status: upstream,
			httpStatus,
		};
	}

	let content = assistantMessageText(chatData.choices?.[0]?.message);
	if (!content?.trim()) {
		chatRes = await fetch(OPENROUTER_CHAT, {
			method: "POST",
			signal,
			headers: openRouterHeaders(),
			body: translationBody(false),
		});
		chatData = await chatRes.json().catch(() => ({}));
		if (!chatRes.ok || chatData.error) {
			const msg =
				chatData.error?.message ||
				chatData.error ||
				`OpenRouter HTTP ${chatRes.status}`;
			return {
				error: String(msg),
				code: "OPENROUTER_ERROR",
				upstream_status: chatRes.status,
				httpStatus: 502,
			};
		}
		content = assistantMessageText(chatData.choices?.[0]?.message);
	}
	if (!content?.trim()) {
		return {
			error: "Empty translation from model",
			code: "OPENROUTER_ERROR",
			httpStatus: 502,
		};
	}

	let parsed;
	try {
		parsed = parseJsonObjectFromModel(content);
	} catch (e) {
		return {
			error: `Invalid JSON from model: ${e?.message || String(e)}`,
			code: "PARSE_ERROR",
			httpStatus: 502,
		};
	}

	const rows = Array.isArray(parsed?.translations)
		? parsed.translations
		: null;
	if (!rows?.length) {
		return {
			error:
				'Model must return { "translations": [ { "language", "transcript" }, ... ] }',
			code: "PARSE_ERROR",
			httpStatus: 502,
		};
	}

	mergedUsage = mergeOpenRouterUsage(
		mergedUsage,
		normalizeOpenRouterUsage(chatData.usage),
	);

	const byLang = new Map();
	for (const row of rows) {
		const lang = String(row?.language ?? "").trim();
		const transcript = String(row?.transcript ?? "").trim();
		if (lang && transcript)
			byLang.set(lang.toLowerCase(), { language: lang, transcript });
	}

	const results = [];
	for (const label of langs) {
		const hit = byLang.get(label.toLowerCase());
		if (!hit) {
			return {
				error: `Missing translation for language "${label}" in model output`,
				code: "TRANSLATION_INCOMPLETE",
				httpStatus: 502,
			};
		}
		results.push({ ...hit });
	}

	if (includeAudio) {
		for (let i = 0; i < results.length; i++) {
			const t = results[i].transcript;
			try {
				const { buffer, format, usage: ttsUsage } = await ttsSynthesizeToBuffer({
					text: t,
					signal,
				});
				mergedUsage = mergeOpenRouterUsage(
					mergedUsage,
					normalizeOpenRouterUsage(ttsUsage),
				);
				results[i] = {
					...results[i],
					audio_base64: buffer.toString("base64"),
					audio_format: format || "pcm16",
				};
			} catch (e) {
				return {
					error: e?.message || String(e),
					code: "TTS_ERROR",
					httpStatus: 502,
				};
			}
		}
	}

	if (
		includeAudio &&
		results.length &&
		typeof afterTranslatedTts === "function"
	) {
		try {
			await afterTranslatedTts(results);
		} catch (e) {
			return {
				error: e?.message || "TTS audio upload failed",
				code: "UPLOAD_ERROR",
				httpStatus: 502,
			};
		}
	}

	const usagePayload = buildUsageResponseFields(mergedUsage);
	return {
		error: null,
		data: {
			source_type: sourceType,
			source_text: source,
			...(typeof llmPresetName === "string"
				? { llm_preset: llmPresetName }
				: {}),
			...(sourceType === "audio" && {
				audio_input_url: audioInputUrl,
				transcribe_model: transcribeModel,
			}),
			model,
			results,
		},
		httpStatus: 200,
		...usagePayload,
	};
}

/**
 * Upload translated TTS (pcm16 in `results[].audio_base64`) to UploadThing as WAV.
 * Sets `audio_url` / `audioUrl`; removes `audio_base64` so the client gets real URLs.
 */
export async function uploadVoiceTranslateTtsToUploadThing(
	results,
	uploadAudioBufferToUploadThing,
	requestId,
) {
	if (!process.env.UPLOADTHING_TOKEN?.trim() || !Array.isArray(results)) {
		return;
	}
	const rid = String(requestId ?? "")
		.replace(/[^a-zA-Z0-9-]/g, "")
		.slice(0, 36);
	for (let i = 0; i < results.length; i++) {
		const row = results[i];
		const b64 = row?.audio_base64;
		if (!b64 || typeof b64 !== "string") continue;
		let pcmBuf;
		try {
			pcmBuf = Buffer.from(b64.trim(), "base64");
		} catch (e) {
			throw new Error(
				`Invalid TTS audio_base64 for row ${i}: ${e?.message || String(e)}`,
			);
		}
		if (!pcmBuf.length) {
			throw new Error(`Empty TTS audio payload after base64 decode (row ${i})`);
		}
		const wav = pcm16ToWavBuffer(pcmBuf);
		const safeLang = String(row.language ?? "lang")
			.replace(/[^a-zA-Z0-9_-]/g, "_")
			.slice(0, 64);
		const name = `voice-translate-tts-${rid || "req"}-${i}-${safeLang}.wav`;
		const url = await uploadAudioBufferToUploadThing(wav, name);
		if (!url || typeof url !== "string") {
			throw new Error("UploadThing returned no URL for translated TTS");
		}
		const { audio_base64: _b64, ...withoutB64 } = row;
		results[i] = {
			...withoutB64,
			audio_url: url,
			audioUrl: url,
			audio_format: "pcm16",
		};
	}
}
