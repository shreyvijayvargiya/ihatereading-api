/** Minimal Groq key helper (used by translationRefineGlossary.js). */
export function getGroqApiKey() {
	return process.env.GROQ_API_KEY?.trim() || "";
}
