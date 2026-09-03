/**
 * DESIGN.md prompts from Refero Styles (styles.refero.design).
 */

export const AI_STYLES_PROMPTS_COLLECTION = "ai-styles-prompts";
export const AI_STYLES_PROMPTS_STATE_COLLECTION = "aiStylesPromptsAgentState";

export const REFERO_ORIGIN = "https://styles.refero.design";
export const REFERO_LIST_URL = `${REFERO_ORIGIN}/?sort=newest`;
export const REFERO_API_STYLES = `${REFERO_ORIGIN}/api/styles`;

export const AI_STYLES_AGENT = {
	id: "discovery-ai-styles-prompts",
	name: "AI DESIGN.md style prompts (Refero)",
	collection: AI_STYLES_PROMPTS_COLLECTION,
	stateCollection: AI_STYLES_PROMPTS_STATE_COLLECTION,
	listUrl: REFERO_LIST_URL,
	targetCount: Number(process.env.AI_STYLES_TARGET || "100"),
	stylesPerRun: Number(process.env.AI_STYLES_PER_RUN || "8"),
	listPageSize: Number(process.env.AI_STYLES_LIST_PAGE || "20"),
};

/** Walk existing Firestore docs: Google + scrape → fill / update / delete. */
export const AI_STYLES_ENRICH = {
	id: "enrich-ai-styles-prompts",
	stateDocId: "discovery-ai-styles-prompts-enrich",
	batchSize: Number(process.env.AI_STYLES_ENRICH_BATCH || "4"),
	intervalMs: Number(process.env.AI_STYLES_ENRICH_INTERVAL_MS || "10000"),
	googlePerDoc: Number(process.env.AI_STYLES_ENRICH_GOOGLE || "2"),
	scrapePerDoc: Number(process.env.AI_STYLES_ENRICH_SCRAPE || "2"),
};

export function stylePageUrl(id) {
	return `${REFERO_ORIGIN}/style/${id}`;
}

export function styleApiUrl(id) {
	return `${REFERO_API_STYLES}/${id}`;
}
