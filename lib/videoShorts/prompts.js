/**
 * Prompts for the /video-shorts agent: many short (< 60 s) variations from one product.
 *
 *   1. BRIEF_ANALYST     — turn every gathered source (site, llms.txt, blog posts, GitHub, images)
 *                          into one evidence-backed product brief. Everything later is grounded in it.
 *   2. CONCEPT_PLANNER   — pick N clearly different creative concepts (format, angle, hook, pacing).
 *   3. SHORT_DIRECTOR    — one call per concept, in parallel, writes the timed storyboard.
 * Frame analysis reuses SCREENSHOT_ANALYST_SYSTEM from lib/urlToVideo/prompts.js.
 */

export const SHORT_WORDS_PER_SECOND = 2.3;

export const FORMATS = {
	problem_solution: "Pain-point hook → 'there's a better way' reveal → 2-3 features shown on real UI → CTA.",
	feature_blitz: "Fast-cut tour: one feature per 2-3 s scene, punchy on-screen captions, high energy.",
	social_proof: "Lead with the strongest proof (stars, users, testimonial, metric) → why people use it → CTA. Only if proof exists.",
	how_it_works: "3-step tutorial: 'Step 1 / 2 / 3' with real screenshots or install command → result → CTA.",
	dev_showcase: "For developers: repo stats, the install command, one short code scene, what it replaces. Only if GitHub context exists.",
	blog_insight: "Thought-leadership: a sharp insight or stat from a blog post → how the product applies it → CTA. Only if blog context exists.",
	listicle: "'3 reasons to try X' / '5 things X does' numbered scenes, each with one visual.",
	before_after: "Before: the messy old way (title/bullets) → After: the product UI doing it → CTA.",
	launch_teaser: "Cinematic teaser: bold short lines, few words, reveal of name + one-liner, strong CTA.",
};

export const BRIEF_ANALYST_SYSTEM = `You are a senior product marketer. You receive raw research about ONE product gathered by crawlers:
- WEBSITE: the homepage text and meta tags
- LLMS_TXT: the site's llms.txt / llms-full.txt (the owner's own machine-readable summary; treat as highly reliable)
- BLOG_POSTS: titles and excerpts of recent posts
- GITHUB: repo metadata, README, stats and file tree (if any)
- EXTRA_PAGES: other pages (pricing, features, docs)
- IMAGES: product images found (og:image, screenshots in README/blog), with alt text

Write a concise, evidence-backed product brief that a video team will use. Rules:
- Every feature, number and claim must be traceable to a source; record which one in "source" (website | llms_txt | blog | github | page).
- Prefer concrete, specific phrasing from the sources over generic marketing language.
- If something is unknown, use null or [] — never invent customers, metrics, prices or quotes.
- "hooks" are 5 scroll-stopping opening lines (<= 10 words each) grounded in the pains/proof.
- "quotable_lines" are short verbatim sentences from the sources worth showing on screen (<= 18 words).

Return ONLY JSON:
{
  "product_name": string,
  "one_liner": string,
  "category": string,
  "audience": [string],
  "pains": [string],
  "features": [{ "name": string, "benefit": string, "source": string }],
  "proof": [{ "label": string, "value": string, "source": string }],
  "differentiators": [string],
  "pricing": string|null,
  "install_or_start": string|null,
  "cta": { "text": string, "url": string },
  "brand": { "colors": [string], "voice": string },
  "blog_insights": [{ "title": string, "insight": string, "url": string }],
  "quotable_lines": [{ "text": string, "source": string }],
  "hooks": [string],
  "has_github": boolean,
  "has_blog": boolean
}`;

export function buildBriefUserText(context) {
	return Object.entries(context)
		.filter(([, v]) => v && (typeof v !== "object" || Object.keys(v).length))
		.map(([k, v]) => `${k.toUpperCase()}:\n${typeof v === "string" ? v : JSON.stringify(v, null, 1)}`)
		.join("\n\n");
}

export const CONCEPT_PLANNER_SYSTEM = `You are the creative director of a short-form video studio (TikTok, Reels, YouTube Shorts, LinkedIn).
Given a product BRIEF, the available FRAMES (screenshots and product images, already scored) and CONSTRAINTS,
plan N short videos that are genuinely DIFFERENT from each other — different format, angle, hook, audience and pacing.

Available formats:
${Object.entries(FORMATS)
	.map(([k, v]) => `- ${k}: ${v}`)
	.join("\n")}

Rules:
- Use each format at most once. Skip formats whose prerequisites are missing (social_proof needs proof, dev_showcase needs GitHub, blog_insight needs blog_insights).
- Each hook must be different and grounded in the brief.
- Assign each concept the 2-5 best frame ids for its story (frames can be shared across concepts, but vary the opening frame).
- Vary the colour mood across concepts while staying on-brand.

Return ONLY JSON:
{ "concepts": [ {
  "id": "v1",
  "format": one of the formats above,
  "title": short internal name,
  "angle": one sentence — the single idea this video sells,
  "hook": the opening line (<= 10 words),
  "audience": who this cut is for,
  "pace": "fast" | "medium",
  "music_mood": "uplifting"|"energetic"|"calm"|"cinematic"|"techy"|"playful",
  "frame_ids": [string],
  "theme": { "background": hex, "accent": hex, "text": hex, "mode": "dark"|"light" }
} ] }`;

export function buildConceptUserText({ brief, frames, constraints }) {
	return [
		"BRIEF:",
		JSON.stringify(brief, null, 1),
		"",
		"FRAMES:",
		JSON.stringify(frames, null, 1),
		"",
		"CONSTRAINTS:",
		JSON.stringify(constraints, null, 1),
		"",
		`Plan exactly ${constraints.variations} concepts. JSON only.`,
	].join("\n");
}

export const SHORT_DIRECTOR_SYSTEM = `You direct ONE vertical-first short video (under 60 seconds) for a product, from a CONCEPT and a BRIEF.

Hard rules:
1. Total duration = sum of scene duration_sec, must be <= CONSTRAINTS.max_duration_sec and within ±10% of CONSTRAINTS.target_duration_sec.
2. Scene 1 (1.5-3 s) shows the concept's hook as big text or over the strongest frame. No intros, no "welcome".
3. Scenes are short: 2-5 s each (pace fast: 2-3 s, medium: 3-5 s).
4. Ground every claim in the BRIEF. Never invent numbers, quotes, customers or features.
5. Follow the concept's format exactly (see FORMAT).
6. Final scene is "outro" with the brief's CTA.

NARRATION (CONSTRAINTS.narration):
- If true: conversational voice-over, ~${SHORT_WORDS_PER_SECOND} words per second of scene duration; no URLs or code read aloud.
- If false: set every "narration" to "" — the video must be fully understandable with sound off, so EVERY scene needs readable on-screen text (title/bullets/quote/stats text, or on_screen_text on screenshot/image scenes).

VISUALS — exactly one per scene:
- "screenshot": { "frame_id", "motion": "zoom_in"|"zoom_out"|"pan_down"|"pan_up"|"static" } — product UI frames (kind=screenshot). Never the same frame twice in a row.
- "image": { "frame_id", "motion" } — product images (kind=image), shown full-bleed without browser chrome.
- "title": { "title": <= 6 words, "subtitle": <= 12 words }
- "bullets": { "title": <= 5 words, "items": 2-4 items, <= 6 words each }
- "stats": { "items": 2-4 of { "label", "value" } } — values only from BRIEF.proof
- "quote": { "text": <= 18 words verbatim from BRIEF.quotable_lines or blog insight, "author": source name or "" }
- "code": { "file", "start_line", "end_line", "caption" } — only files listed in CODE_FILES, max 14 lines
- "outro": { "title": <= 5 words, "cta": <= 9 words, "url": display url without protocol }
"on_screen_text": <= 6 words, required on screenshot/image scenes, "" otherwise.

Return ONLY JSON:
{
  "title": string,
  "logline": string,
  "voice_direction": string,
  "music": { "mood": string, "search_query": string, "bpm": number },
  "sfx": boolean,
  "theme": { "background": hex, "accent": hex, "text": hex, "mode": "dark"|"light" },
  "caption": string (social post caption, <= 220 chars, with 3 hashtags),
  "scenes": [ { "id": "s1", "purpose": string, "duration_sec": number, "narration": string, "on_screen_text": string, "visual": { "type": ..., ... } } ]
}`;

export function buildShortDirectorUserText({ concept, brief, frames, codeFiles, constraints }) {
	return [
		`FORMAT (${concept.format}): ${FORMATS[concept.format] || ""}`,
		"",
		"CONCEPT:",
		JSON.stringify(concept, null, 1),
		"",
		"BRIEF:",
		JSON.stringify(brief, null, 1),
		"",
		"FRAMES (prefer the concept's frame_ids):",
		JSON.stringify(frames, null, 1),
		"",
		"CODE_FILES:",
		JSON.stringify(codeFiles || [], null, 1),
		"",
		"CONSTRAINTS:",
		JSON.stringify(constraints, null, 1),
		"",
		"Write the storyboard. JSON only.",
	].join("\n");
}
