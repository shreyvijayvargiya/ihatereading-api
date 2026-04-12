/**
 * Named TTS presets for video / voice translate (OpenRouter gpt-audio `audio.voice`).
 * Same billing path as the default; presets map to standard OpenAI audio voices.
 */

/** Default when `voice` is omitted (unchanged from prior behavior). */
export const DEFAULT_TRANSLATE_TTS_VOICE = "alloy";

/**
 * Friendly preset names → OpenAI-compatible voice ids for streaming audio.
 * Keys are matched case-insensitively.
 */
export const TRANSLATE_TTS_VOICE_PRESETS = Object.freeze({
	allen: "echo",
	zanskar: "onyx",
	simba: "fable",
	john: "nova",
	riley: "shimmer",
	sam: "alloy",
});

/** Allow passing a raw voice id (same set gpt-audio typically supports). */
const ALLOWED_RAW_VOICE_IDS = new Set([
	"alloy",
	"echo",
	"fable",
	"onyx",
	"nova",
	"shimmer",
	"ash",
	"ballad",
	"coral",
	"sage",
	"verse",
]);

/**
 * @param {unknown} raw - Preset name (e.g. "Allen", "allen") or raw voice id (e.g. "echo")
 * @returns {{
 *   ok: true,
 *   voice: string,
 *   preset: string | null,
 * } | { ok: false, error: string, allowed: { presets: string[], voice_ids: string[] } }}
 */
export function resolveTranslateTtsVoice(raw) {
	if (raw == null || String(raw).trim() === "") {
		return {
			ok: true,
			voice: DEFAULT_TRANSLATE_TTS_VOICE,
			preset: null,
		};
	}
	const s = String(raw).trim();
	const key = s.toLowerCase();

	if (Object.prototype.hasOwnProperty.call(TRANSLATE_TTS_VOICE_PRESETS, key)) {
		return {
			ok: true,
			voice: TRANSLATE_TTS_VOICE_PRESETS[key],
			preset: key,
		};
	}

	if (ALLOWED_RAW_VOICE_IDS.has(key)) {
		return {
			ok: true,
			voice: key,
			preset: null,
		};
	}

	return {
		ok: false,
		error: `Unknown voice "${s}". Use a preset (${Object.keys(TRANSLATE_TTS_VOICE_PRESETS).join(", ")}) or a supported voice id (${[...ALLOWED_RAW_VOICE_IDS].sort().join(", ")}).`,
		allowed: {
			presets: [...Object.keys(TRANSLATE_TTS_VOICE_PRESETS)].sort(),
			voice_ids: [...ALLOWED_RAW_VOICE_IDS].sort(),
		},
	};
}
