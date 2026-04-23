/**
 * Single source of truth for default OpenRouter model IDs.
 *
 * Change models here to affect BOTH:
 * - POST /api/video-translate
 * - POST /api/voice-translate/text
 *
 * Request-level overrides via `model` / `llm_model` still take precedence.
 * Env vars still work as fallback/override where applicable, but the goal is:
 * edit THIS file for quick testing.
 */

export const ACTIVE_OPENROUTER_MODELS = {
	voice: {
		/** Default LLM used for translation/chat when client does not pass `model`/`llm_model`. */
		translate: "openai/gpt-oss-120b:free",
		/** Default LLM used for transcription when audio is provided (when client does not pass `model`/`llm_model`). */
		transcribe: "openai/gpt-oss-120b:free",
	},
	video: {
		/** Default LLM used for video translation pipeline (transcribe+translate stage). */
		translate: "google/gemini-2.5-flash",
		/** Default model used for TTS dubbing. */
		tts: "openai/gpt-audio",
	},
};

