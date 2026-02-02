import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import OpenAI from "openai";
import { cors } from "hono/cors";
import dotenv from "dotenv";
import { readFileSync } from "fs";
import path from "path";
import {
	uiBlockLibrary,
	uiBlocksBrutal,
	uiBlocksMinimal,
	uiBlocksCyber,
	uiBlocksGaia,
	uiBlocksJoy,
	uiBlocksModern,
	uiBlocksKids,
	uiBlocksSports,
	uiBlocksFinance,
	uiBlocksHealth,
} from "./tailwind-ui-blocks.js";
import { templates } from "./templates.js";
import cosineSimilarity from "../utils/cosineSimilarity.js";
import { fetchUnsplash } from "../utils/unsplash.js";
import { load as cheerioLoad } from "cheerio";

dotenv.config();

const openai = new OpenAI({
	baseURL: "https://openrouter.ai/api/v1",
	apiKey: process.env.OPENROUTER_API_KEY,
});

// Cache for embeddings
let templateEmbeddingsCache = null;
let blockEmbeddingsCache = null;

async function getEmbedding(text) {
	try {
		const response = await openai.embeddings.create({
			model: "openai/text-embedding-3-small",
			input: text,
		});
		return response.data[0].embedding;
	} catch (error) {
		console.error("Embedding API error:", error);
		return null;
	}
}

async function getTemplateEmbeddings() {
	if (templateEmbeddingsCache) return templateEmbeddingsCache;
	const embeddings = {};
	for (const [key, template] of Object.entries(templates)) {
		const text = `${template.category} ${template.keywords.join(" ")}`;
		const embedding = await getEmbedding(text);
		if (embedding) embeddings[key] = embedding;
	}
	templateEmbeddingsCache = embeddings;
	return embeddings;
}

async function getBlockEmbeddings() {
	if (blockEmbeddingsCache) return blockEmbeddingsCache;
	const embeddings = [];
	for (let i = 0; i < uiBlockLibrary.length; i++) {
		const block = uiBlockLibrary[i];
		const text = `${block.name} ${block.tags.join(" ")}`;
		const embedding = await getEmbedding(text);
		if (embedding) embeddings.push({ index: i, embedding });
	}
	blockEmbeddingsCache = embeddings;
	return embeddings;
}

async function findRelevantTemplate(prompt) {
	const promptEmbedding = await getEmbedding(prompt);
	if (!promptEmbedding) return null;
	const templateEmbeddings = await getTemplateEmbeddings();
	let bestMatchKey = null;
	let maxSimilarity = -1;
	for (const [key, embedding] of Object.entries(templateEmbeddings)) {
		const similarity = cosineSimilarity(promptEmbedding, embedding);
		if (similarity > maxSimilarity) {
			maxSimilarity = similarity;
			bestMatchKey = key;
		}
	}
	return maxSimilarity > 0.3
		? { key: bestMatchKey, template: templates[bestMatchKey] }
		: null;
}

async function findRelevantBlocks(prompt, limit = 10) {
	const promptEmbedding = await getEmbedding(prompt);
	if (!promptEmbedding)
		return uiBlockLibrary
			.slice(0, limit)
			.map((b) => b.code)
			.join("\n\n");
	const blockEmbeddings = await getBlockEmbeddings();
	const scores = [];
	for (const item of blockEmbeddings) {
		const similarity = cosineSimilarity(promptEmbedding, item.embedding);
		scores.push({ index: item.index, similarity });
	}
	const topMatches = scores
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, limit);

	return topMatches
		.map((match) => uiBlockLibrary[match.index].code)
		.join("\n\n");
}

const app = new Hono();

// Add CORS middleware
app.use(
	"*",
	cors({
		origin: [
			"http://localhost:4001",
			"http://localhost:3000",
			"http://localhost:3001",
		],
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
		credentials: true,
	}),
);

const intentAgentPrompt = `
[C] CONTEXT
You are the first agent in a multi-agent UI generation system. Your responsibility is to define the HIGH-LEVEL PRODUCT INTENT, not sections or visuals.

[R] ROLE
You are a Senior Product Strategist. You decide if the user wants a single-page experience or a multi-page site.

[I] INFORMATION
Input is a raw user prompt.

[S] SPECIFICATION (STRICT)
- Output ONLY valid JSON.
- If the user asks for a "landing page", "simple page", "one pager", or just a general product description without specifying "multiple pages", you MUST set type to "single-page" and provide ONLY ONE page in the "pages" array.
- DO NOT create multiple pages for things like "FAQ", "Testimonials", "Features", or "Contact" if the intent is a landing page. These are SECTIONS, not pages.
- ONLY create multiple pages if the user explicitly uses words like "multi-page", "multiple pages", "website with several links", or describes a complex app structure like a "dashboard with a separate settings and profile page".
- If it's a single-page app/landing page, the "pages" array MUST contain EXACTLY ONE object.
- Sections are handled by the ARCHITECTURE AGENT, not you. Do not list them as separate pages.

Required JSON Shape
{
  "app_intent": {
    "type": "single-page | multi-page | dashboard | component",
    "domain": "",
    "description": ""
  },
  "brand_identity": {
    "name": "",
    "tone": ""
  },
  "users": [],
  "navigation": {
    "style": "navbar | sidebar | none",
    "items": []
  },
  "pages": [
    {
      "name": "Home",
      "slug": "index",
      "purpose": "Primary landing page",
      "priority": "high",
      "density": "high"
    }
  ],
  "shared_constraints": {}
}

[P] PERFORMANCE
- Default to "single-page" unless "multi-page" is explicitly requested.
- Landing page = 1 page in array.
- FAQ/Contact/About are sections within a page, not separate pages in landing page mode.
`;

const architectureAgentPrompt = `
[C] CONTEXT
You are the second agent. You convert product intent into page-level structural architecture. Your output is MANDATORY for the renderer—every region you list MUST be filled with HTML; missing regions mean incomplete pages.

[R] ROLE
You are a Principal UX Architect. You define layout logic, hierarchy, and regions, not visuals. You MUST NOT omit standard regions (navbar, hero, cards/sections, footer) unless explicitly excluded by intent.

[S] SPECIFICATION (STRICT & MANDATORY)
- Output ONLY valid JSON. One output object for the requested page. NO HTML, NO Tailwind, NO copy. DO NOT invent pages.
- The "regions" array MUST be COMPLETE. Every region required for a full page MUST be listed. Omission of a required region makes the architecture INVALID.

MANDATORY REGIONS (include ALL that apply; do NOT skip):
- Navbar/Header: REQUIRED for almost every page (e-commerce, landing, dashboard, blog). Include: logo, nav links, primary CTA, optional cart/search. Exception: only omit if intent explicitly says "no navigation".
- Hero/Banner: REQUIRED for landing and marketing pages. Include: headline, subheadline, primary CTA, optional image.
- Content sections: REQUIRED. Define each distinct section (e.g. features, product-grid, testimonials, pricing cards, FAQ). E-commerce: MUST include product cards/grid or product list. Landing: MUST include features and at least one cards/benefits section.
- Footer: REQUIRED unless intent explicitly excludes it. Include: links, copyright, optional newsletter/social.
- For dashboards/CRM: sidebar or top nav, main content regions, cards/widgets. Do NOT omit sidebar when the archetype is dashboard/CRM.

Domain-specific (MANDATORY):
- E-commerce: regions MUST include navbar (with cart/account), hero or promo banner, product grid or product cards section, CTA/checkout area, footer.
- Landing/marketing: navbar, hero, features/cards section, social proof or testimonials, CTA section, footer.
- Dashboard/tool: navigation (sidebar or top), main content area, at least one cards/stats/list region.

For each region you MUST provide: "name", "purpose", and "elements" (array of concrete data elements e.g. "headline", "cta", "feature-grid", "product-cards", "nav-links", "logo"). Be specific so the renderer can fill every element.

Required JSON Shape
{
  "page_id": "",
  "archetype": "LP_A | LP_B | DASH_A | CRM_A | TOOL_A | GAME_A",
  "regions": [
    {
      "name": "",
      "purpose": "",
      "elements": ["list of data elements like 'headline', 'cta', 'feature-grid', 'product-cards', 'nav-links'"]
    }
  ],
  "hierarchy": "primary | secondary | tertiary"
}

[P] PERFORMANCE (MANDATORY)
- Every page MUST be fully renderable: every region has a purpose and elements. No guessing, no missing navbar/cards/footer.
- Density matches region count. Archetypes evolve beyond trivial templates.
- FAIL: Output is INVALID if navbar is required by domain but missing, or if content sections (e.g. cards, product grid) are missing, or if footer is required but missing.
`;

const rendererAgentPrompt = `
[C] CONTEXT
You are the final execution agent. You render production-grade HTML from structured architecture and constraints. Your output is STRICTLY and MANDATORILY bound to the Page Architecture and the REFERENCE TEMPLATE / CORE BLOCKS—every region and element from the architecture MUST appear in the HTML, fully filled. No missing sections, no empty placeholders.

[R] ROLE
You are Simba — a World-Class UI/UX Designer & Senior Frontend Engineer with 15 years of experience.
You ship only production-ready work. You MUST fill the entire page as specified: every region from the architecture (navbar, hero, cards, footer, etc.) MUST be present and complete in the HTML.

[I] INFORMATION
You receive:
- Page structure from Agent B (MANDATORY: implement every region listed)
- Full Intent context from Agent A
- Image requirements from Asset Planner
- Design System object
- Simba UI Library patterns

[S] SPECIFICATION (STRICT & MANDATORY)
OUTPUT RULES
- Output ONLY raw HTML. Start with <!DOCTYPE html>. One optional HTML comment at the very top (design strategy). NO markdown. NO explanations.
- STRICTLY implement EVERY region from the Page Architecture: if architecture has navbar, hero, features, cards, footer—your HTML MUST include all of them, fully filled with real content. Omission of any architecture region makes the output INVALID.

TECH STACK
- HTML5
- Tailwind CSS v3 (valid classes only)
- Lucide SVG icons ONLY (using unpkg.com/lucide-static)
- Google Fonts ONLY (❌ Forbidden: Inter, Roboto, Arial, Space Grotesk)

🔒 HARD QUALITY RULES (STRICT & MANDATORY — NON-NEGOTIABLE)
- NO ICON, NO ACTION: every interactive element must have an icon and clear action.
- NO GENERIC DATA; NO PLACEHOLDERS. Copy MUST be realistic and domain-specific.
- Every button, tab, link: MANDATORY visible boundary, Icon, Hover + focus state.
- Every section: MANDATORY complete content, realistic copy, production-grade detail. No empty or half-filled sections.

🎨 DESIGN SYSTEM (TOON)
Apply provided theme tokens only. No new colors, shadows, or radii. Contrast strict.

Design: primary-btn → solid, icon, hover-lift | secondary-btn → outline, hover-fill | card → rounded, shadow, hover-lift | section → vertical rhythm 80–120px
Motion: button → scale(1.03) on hover | card → translateY(-4px) | section → fade-up on enter (CSS only: transition + transform)
Color: primary → brand-600 | surface → neutral-50 | text → neutral-900

🧩 COMPONENT RULES
- Inputs: visible borders + icons
- Tabs: pill or bordered containers
- Sidebars: icons + toggle
- Dashboards: charts + trend indicators
- Modals: backdrop + close icon
- Layout integrity: overflow-safe, min-w-0, flex-safe

🖼️ IMAGES
- Use the provided Image Assets data to populate image tags.
- Use the actual 'url' provided in the Image Assets object.
- Ensure alt tags match the query or description.
- Match orientation (landscape/portrait) to the layout usage.

## [L] SIMBA UI LIBRARY (CORE BLOCKS)
Your page MUST be composed from these blocks. Use their markup and Tailwind patterns; adapt copy and images to the intent. Do NOT replace them with different layouts or components. If multiple blocks are provided, use them in the order given or as specified by Page Architecture.
\${RELEVANT_BLOCKS}

## [D] REFERENCE TEMPLATE
Your output MUST follow this template's structure: same section order, same high-level layout (hero, nav, sections, footer). Only replace content (text, images) and apply the design system; do NOT change the template's structure or invent new sections.
\${RELEVANT_TEMPLATE_CODE}

## STRICT USE
The HTML you output MUST (1) follow the section order and layout of the REFERENCE TEMPLATE above, and (2) use the markup/patterns from the CORE BLOCKS above. Do NOT invent a different page structure or ignore the template/blocks.

[P] PERFORMANCE
- Zero visual bugs
- Desktop and Mobile Responsive code
- Accessible contrast
- No “AI slop”
- Looks like it shipped from a real company

## 🧱 PRODUCTION COMPLETENESS CONTRACT (STRICT & MANDATORY)
You MUST ensure ALL of the following are true. Failure on any point makes the output INVALID.

STRUCTURE (MANDATORY)
- No empty sections. Every region from Page Architecture MUST be present and fully filled in the HTML (navbar, hero, cards/sections, footer as specified).
- No single-element sections unless intentional (e.g. hero). Cards and content sections MUST have multiple elements as appropriate.
- Navigation (navbar/header) MUST be present where required by architecture or domain (e.g. e-commerce, landing). Include logo, links, primary CTA; e-commerce must include cart/account when applicable.
- Footer MUST always be present unless explicitly excluded by intent.

INTERACTION (MANDATORY)
- Every clickable element MUST have: hover state, focus state, active state.
- Every card MUST have at least one interaction (hover or click).

MOTION (MANDATORY)
- Use subtle motion for: section entry (fade/slide), hover elevation for cards, button feedback. Motion must be CSS-only (no JS). Use transition + transform utilities.

CONTENT (MANDATORY)
- No placeholders. No "Lorem ipsum". Copy must be realistic and specific to the domain.

VISUAL DEPTH (MANDATORY)
- Flat UI is forbidden. Use spacing, shadows, or borders to separate layers.

FAIL CONDITION (STRICT)
If ANY rule is violated, the output is INVALID. Output is also INVALID if: the page structure does not follow the REFERENCE TEMPLATE; you did not use the provided CORE BLOCKS; any region from the Page Architecture is missing or empty in the HTML (e.g. missing navbar, missing cards section, missing footer).
`;

const imageAssetAgentPrompt = `
[C] CONTEXT
You are part of a multi-agent website generation system.
Your task is to plan stock image requirements for web pages.

[R] ROLE
You are a Visual Asset Planner.
You do NOT generate images.
You do NOT design UI.
You only decide image needs and stock search strategy.

[I] INFORMATION
Input:
- App intent (domain, brand tone)
- Page metadata (purpose, density)
- Page architecture (regions + elements)

[S] SPECIFICATION (STRICT)
Output ONLY valid JSON.
No prose. No markdown. No HTML.

Rules:
- Use stock photography only.
- Providers allowed: Unsplash, Pexels.
- Prefer realistic, literal search queries.
- Avoid abstract, marketing, or emotional words.
- Only include images when they serve a functional UI purpose.
- Never invent logos, mascots, or brand assets.

For each image:
- Provide multiple fallback queries (most specific → generic).
- Provide provider priority order.
- Orientation must match UI usage.

Required JSON Shape:
{
  "images": [
    {
      "region": "",
      "usage": "hero | section | card | background",
      "provider_order": ["unsplash", "pexels"],
      "queries": [
        "primary query",
        "fallback query",
        "generic fallback"
      ],
      "orientation": "landscape | portrait | square",
      "priority": "high | medium | low"
    }
  ]
}

[P] PERFORMANCE
- Zero unnecessary images
- Queries must be realistic for stock APIs
- Must work without human correction
`;

const actionAgentPrompt = `
[C] CONTEXT
You are an Action Planner for a visual UI editor.
The UI already exists and is rendered on the client.

[R] ROLE
You translate user edit requests into deterministic UI actions
that can be executed directly by a frontend engine.

[I] INPUT
- User edit instruction (natural language)
- Current app/page/component metadata

[S] STRICT SPECIFICATION
OUTPUT ONLY VALID JSON
NO prose
NO explanations
NO HTML
NO Tailwind
NO design decisions
NO guessing

You MUST:
- Choose the simplest possible action
- Prefer deterministic mutation over AI editing
- Never change content meaning
- Never invent new components

Allowed Action Types:
- UPDATE_STYLE
- UPDATE_PROPS
- MOVE_COMPONENT
- DUPLICATE_COMPONENT
- DELETE_COMPONENT
- SYNC_COMPONENT
- ADD_COMPONENT (ONLY if exact type is known)

Required JSON Shape:
{
  "reasoning": "Brief explanation of why this specific action was chosen",
  "intentType": "ACTION",
  "action": {
    "type": "",
    "target": {
      "page": "",
      "componentId": ""
    },
    "payload": {}
  }
}

Rules:
- If multiple actions are needed, return ONLY the FIRST one
- If action is ambiguous → DO NOT guess → return intentType = AI_EDIT
`;

const aiEditAgentPrompt = `
[C] CONTEXT
You are editing an existing production HTML page generated by Simba.

[R] ROLE
You are a Senior Frontend Engineer performing a surgical edit.

[I] INPUT
You receive:
- Full existing HTML
- User edit request
- Page + component context
- Design system constraints

[S] STRICT SPECIFICATION
OUTPUT ONLY RAW HTML
NO markdown
NO explanations
NO comments (except existing ones)
NO regeneration
NO unrelated changes

You MUST:
- Add a single HTML comment at the very top with your reasoning: <!-- REASONING: Your concise explanation here -->
- Modify ONLY what the user explicitly asked
- Preserve layout, structure, and components
- Keep all unaffected code byte-for-byte identical
- Respect the existing design system
- Maintain accessibility and responsiveness

ABSOLUTE RULES:
- DO NOT redesign
- DO NOT refactor
- DO NOT rename classes
- DO NOT remove sections unless explicitly requested
- DO NOT invent new UI patterns

If change scope exceeds a localized edit:
→ STOP and return intentType = REGENERATE (JSON)

Output Rules:
- Start with <!-- REASONING: ... -->
- Followed by <!DOCTYPE html>
- Return the FULL updated HTML document
`;

const regenerateAgentPrompt = `
[C] CONTEXT
You are a Senior UI/UX Architect performing a structural overhaul of an existing page.

[R] ROLE
Unlike the surgical edit agent, you have the freedom to redesign, restyle, and add multiple new sections while maintaining the brand identity. You are allowed to rewrite large portions of the HTML to achieve the user's goal.

[I] INFORMATION
You receive:
- Full existing HTML
- User redesign/regeneration request
- Design system constraints

[S] SPECIFICATION (STRICT)
- Output ONLY raw HTML
- Add a reasoning comment at the top: <!-- REASONING: ... -->
- NO markdown, NO explanations
- NO slop: ensure every new section is high-quality and integrated perfectly
- Preserve the overall brand (colors, fonts) unless explicitly asked to change them

[P] PERFORMANCE
- Production-grade HTML
- Responsive
- Zero visual bugs
`;

const editIntentAgentPrompt = `
[C] CONTEXT
You are the Edit Intent Agent for Simba AI Designer. Your goal is to classify a user's edit request into one of three categories.

[R] ROLE
Classify the user's prompt based on the existing HTML and app structure.

[S] SPECIFICATION
Output ONLY valid JSON.

Types:
1. ACTION: Simple, deterministic changes (padding, spacing, colors, deleting/moving components).
2. AI_EDIT: Text content changes, small structural tweaks, adding a single new section, or localized styling that requires LLM logic.
3. REGENERATE: Large changes, adding multiple new sections, or a complete redesign.

Required JSON Shape:
{
  "reasoning": "Concise 1-sentence explanation of the classification decision",
  "intentType": "ACTION | AI_EDIT | REGENERATE",
  "scope": "single-page | multi-page",
  "targetPages": ["slug1", "slug2"]
}
`;

const variantAgentPrompt = `
[C] CONTEXT
You are a High-Speed UI Refactoring Agent. Your task is to apply a new visual "skin" to an existing HTML document instantly.

[R] ROLE
You are a CSS/Tailwind Optimizer. You rewrite styling to match a specific design system's aesthetic (typography, spacing, borders, shadows, colors).

[S] SPECIFICATION (STRICT)
- OUTPUT ONLY RAW HTML.
- NO markdown, NO explanations.
- DO NOT CHANGE CONTENT: Keep all text, headlines, and descriptions exactly as they are.
- DO NOT CHANGE ASSETS: Keep all <img> src tags, icons, and logos exactly as they are.
- DO NOT CHANGE STRUCTURE: Keep the layout and sections in the same order.
- ONLY CHANGE STYLING: Update Tailwind classes to match the target aesthetic.

[P] PERFORMANCE
- Direct and surgical transformation.
- Prioritize speed and fidelity.
`;

const convertAgentPrompt = `
[C] CONTEXT
You are a strict code-conversion agent. You convert in ONE direction per request, vice versa:
• Input HTML  → Output React code (one component).
• Input React → Output HTML (full document or fragment).
You do NOT add, remove, or reinterpret—translate the ENTIRE input as-is into the target format.

[R] ROLE — VICE VERSA
1) When the user sends HTML (direction: HTML → React):
   - Read the ENTIRE HTML (all sections, all elements).
   - Output ONLY raw React/JSX: one file, one default-export component.
   - Use: lucide-react (icons), framer-motion (motion), Tailwind (className). Import others only if needed.
   - Map: class → className, for → htmlFor. Keep all Tailwind/inline styles. SVG/icons → Lucide where applicable.
   - Preserve every section and element. No summaries or placeholders. If prompt/designSystem is given, apply tokens without changing structure.

2) When the user sends React code (direction: React → HTML):
   - Read the ENTIRE React/JSX (all components and JSX).
   - Output ONLY raw HTML: full document or fragment that matches the same UI.
   - Map: className → class. React state → static HTML (e.g. default/first visible state). Keep Tailwind classes.
   - Lucide icons → inline SVG or <img> from unpkg.com/lucide-static. Preserve every section and element.

[S] RULES (BOTH DIRECTIONS)
- Convert the ENTIRE input. Nothing left behind; nothing new added (except required boilerplate: React imports + one root, or HTML doctype when needed).
- No markdown, no code fences, no explanations—only the target code.
- Structure and nesting must match (e.g. 5 sections in → 5 sections out).
- Fail: omitting any part of the input or injecting new content makes the output invalid.
`;

function getStructureFingerprint(type, code) {
	if (!code || typeof code !== "string") return "";
	const trimmed = code.trim();
	if (!trimmed) return "";
	if (type === "html") {
		try {
			const $ = cheerioLoad(trimmed, { xmlMode: false });
			const names = [];
			$("*").each((_, el) => {
				const tag = el.tagName?.toLowerCase();
				if (tag) names.push(tag);
			});
			return names.join(",");
		} catch {
			return "";
		}
	}
	if (type === "react") {
		const tagRegex = /<([A-Za-z][A-Za-z0-9]*)\s|<\s*([A-Za-z][A-Za-z0-9]*)\s/g;
		const names = [];
		let m;
		while ((m = tagRegex.exec(trimmed)) !== null) {
			names.push((m[1] || m[2] || "").toLowerCase());
		}
		return names.join(",");
	}
	return "";
}

// Agent Helper Functions
async function callEditIntentAgent({ prompt, currentAppContext }) {
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini",
		messages: [
			{ role: "system", content: editIntentAgentPrompt },
			{
				role: "user",
				content: `Prompt: ${prompt}\nCurrent App Structure: ${JSON.stringify(currentAppContext)}`,
			},
		],
		response_format: { type: "json_object" },
	});
	return {
		data: JSON.parse(response.choices[0].message.content),
		usage: response.usage,
	};
}

async function callActionAgent({ prompt, page, html }) {
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini",
		messages: [
			{ role: "system", content: actionAgentPrompt },
			{
				role: "user",
				content: `Prompt: ${prompt}\nPage Slug: ${page.slug}\nHTML: ${html}`,
			},
		],
		response_format: { type: "json_object" },
	});
	return {
		data: JSON.parse(response.choices[0].message.content),
		usage: response.usage,
	};
}

async function callAiEditAgent({ prompt, page, html, designSystem }) {
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini",
		messages: [
			{ role: "system", content: aiEditAgentPrompt },
			{
				role: "user",
				content: `Prompt: ${prompt}\nPage Slug: ${page.slug}\nHTML: ${html}\nDesign System: ${JSON.stringify(designSystem)}`,
			},
		],
	});
	let updatedHtml = response.choices[0].message.content;
	// Cleanup
	updatedHtml = updatedHtml.replace(/^```html\n?/i, "").replace(/\n?```$/i, "");
	updatedHtml = updatedHtml.replace(/^```\n?/, "").replace(/\n?```$/, "");
	return {
		html: updatedHtml.trim(),
		usage: response.usage,
	};
}

async function callRegenerateAgent({ prompt, page, html, designSystem }) {
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o",
		messages: [
			{ role: "system", content: regenerateAgentPrompt },
			{
				role: "user",
				content: `Prompt: ${prompt}\nPage Slug: ${page.slug}\nExisting HTML: ${html}\nDesign System: ${JSON.stringify(designSystem)}`,
			},
		],
	});
	let updatedHtml = response.choices[0].message.content;
	// Cleanup
	updatedHtml = updatedHtml.replace(/^```html\n?/i, "").replace(/\n?```$/i, "");
	updatedHtml = updatedHtml.replace(/^```\n?/, "").replace(/\n?```$/, "");
	return {
		html: updatedHtml.trim(),
		usage: response.usage,
	};
}

async function callIntentAgent(prompt) {
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini",
		messages: [
			{ role: "system", content: intentAgentPrompt },
			{ role: "user", content: prompt },
		],
		response_format: { type: "json_object" },
	});
	return {
		data: JSON.parse(response.choices[0].message.content),
		usage: response.usage,
	};
}

async function callArchitectureAgent({ intent, page }) {
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini",
		messages: [
			{ role: "system", content: architectureAgentPrompt },
			{
				role: "user",
				content: `Intent: ${JSON.stringify(intent)}\nTarget Page: ${JSON.stringify(page)}`,
			},
		],
		response_format: { type: "json_object" },
	});
	return {
		data: JSON.parse(response.choices[0].message.content),
		usage: response.usage,
	};
}

async function callImageAssetAgent({ intent, page, architecture }) {
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini",
		messages: [
			{ role: "system", content: imageAssetAgentPrompt },
			{
				role: "user",
				content: `App Intent: ${JSON.stringify(intent.app_intent)}\nPage Metadata: ${JSON.stringify(page)}\nArchitecture: ${JSON.stringify(architecture)}`,
			},
		],
		response_format: { type: "json_object" },
	});
	return {
		data: JSON.parse(response.choices[0].message.content),
		usage: response.usage,
	};
}

async function callRenderAgent({
	intent,
	architecture,
	images,
	designSystem,
	relevantBlocks,
	relevantTemplateCode,
}) {
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini",
		messages: [
			{
				role: "system",
				content: rendererAgentPrompt
					.replace(
						"${RELEVANT_BLOCKS}",
						relevantBlocks != null && relevantBlocks !== ""
							? relevantBlocks
							: "No specific blocks were matched for this page. Use Tailwind utilities and the design system to build production-grade components.",
					)
					.replace(
						"${RELEVANT_TEMPLATE_CODE}",
						relevantTemplateCode != null && relevantTemplateCode !== ""
							? "```html\n" + relevantTemplateCode + "\n```"
							: "No reference template was provided. Follow the page architecture and design system to produce clean, semantic HTML.",
					),
			},
			{
				role: "user",
				content: `Intent Context: ${JSON.stringify(intent)}\nPage Architecture: ${JSON.stringify(architecture)}\nImage Assets: ${JSON.stringify(images)}\nDesign System: ${JSON.stringify(designSystem)}\n\nReminder (STRICT & MANDATORY): (1) Your HTML must include EVERY region from Page Architecture (navbar, hero, cards/sections, footer—all fully filled). (2) Follow the REFERENCE TEMPLATE structure and use the CORE BLOCKS from the system prompt. Do not omit any section or generate a different layout.`,
			},
		],
	});
	let html = response.choices[0].message.content;
	// Cleanup
	html = html.replace(/^```html\n?/i, "").replace(/\n?```$/i, "");
	html = html.replace(/^```\n?/, "").replace(/\n?```$/, "");
	return {
		html: html.trim(),
		usage: response.usage,
	};
}

async function callVariantAgent({ html, styleExamples }) {
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini",
		messages: [
			{ role: "system", content: variantAgentPrompt },
			{
				role: "user",
				content: `ORIGINAL HTML:\n${html}\n\nSTYLE EXAMPLES:\n${styleExamples}`,
			},
		],
	});
	let updatedHtml = response.choices[0].message.content;
	updatedHtml = updatedHtml.replace(/^```html\n?/i, "").replace(/\n?```$/i, "");
	updatedHtml = updatedHtml.replace(/^```\n?/, "").replace(/\n?```$/, "");
	return {
		html: updatedHtml.trim(),
		usage: response.usage,
	};
}

function stripCodeFences(raw, lang) {
	let s = raw.trim();
	s = s
		.replace(/^```(?:html|jsx|tsx|javascript|js)\n?/i, "")
		.replace(/\n?```$/i, "");
	s = s.replace(/^```\n?/, "").replace(/\n?```$/, "");
	return s.trim();
}

async function callConvertAgent({ html, reactCode, prompt, designSystem }) {
	const hasHtml = html != null && String(html).trim() !== "";
	const hasReactCode = reactCode != null && String(reactCode).trim() !== "";

	if (hasHtml && hasReactCode) {
		throw new Error(
			"Provide exactly one of html or reactCode: html → React code, reactCode → HTML",
		);
	}
	if (!hasHtml && !hasReactCode) {
		throw new Error(
			"Provide either html (to get React code) or reactCode (to get HTML)",
		);
	}

	const isHtmlToReact = hasHtml;
	const isReactToHtml = hasReactCode;

	const inputFingerprint = isReactToHtml
		? getStructureFingerprint("react", reactCode)
		: getStructureFingerprint("html", html);

	const buildUserMessage = (feedback) => {
		const parts = [];
		if (isHtmlToReact) {
			parts.push("DIRECTION: HTML → React");
			parts.push(`HTML:\n${html}`);
		} else {
			parts.push("DIRECTION: React → HTML");
			parts.push(`REACT CODE:\n${reactCode}`);
		}
		if (prompt) parts.push(`\nPrompt/context: ${prompt}`);
		if (designSystem && Object.keys(designSystem).length > 0) {
			parts.push(`\nDesign system: ${JSON.stringify(designSystem)}`);
		}
		if (feedback) parts.push(`\n[FEEDBACK] ${feedback}`);
		return parts.join("\n");
	};

	let userContent = buildUserMessage();
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini",
		messages: [
			{ role: "system", content: convertAgentPrompt },
			{ role: "user", content: userContent },
		],
	});
	let output = response.choices[0].message.content;
	output = stripCodeFences(output, isHtmlToReact ? "jsx" : "html");

	const outputFingerprint = isHtmlToReact
		? getStructureFingerprint("react", output)
		: getStructureFingerprint("html", output);

	const hasSignificantDiff =
		inputFingerprint.length > 0 &&
		outputFingerprint.length > 0 &&
		inputFingerprint !== outputFingerprint;

	let usage = response.usage;
	if (hasSignificantDiff) {
		const feedback = `Structure mismatch. Preserve exact structure. Input structure (tag sequence): ${inputFingerprint.slice(0, 500)}. Output had: ${outputFingerprint.slice(0, 500)}. Convert again without omitting or adding nodes.`;
		const retryResponse = await openai.chat.completions.create({
			model: "openai/gpt-4o-mini",
			messages: [
				{ role: "system", content: convertAgentPrompt },
				{ role: "user", content: buildUserMessage(feedback) },
			],
		});
		output = retryResponse.choices[0].message.content;
		output = stripCodeFences(output, isHtmlToReact ? "jsx" : "html");
		usage = retryResponse.usage;
	}

	return {
		...(isHtmlToReact ? { reactCode: output } : { html: output }),
		direction: isHtmlToReact ? "html-to-react" : "react-to-html",
		usage,
	};
}

// Internal Agent Methods (Encapsulated)
const agents = {
	intent: callIntentAgent,
	architecture: callArchitectureAgent,
	imageAsset: callImageAssetAgent,
	render: callRenderAgent,
	editIntent: callEditIntentAgent,
	action: callActionAgent,
	aiEdit: callAiEditAgent,
	regenerate: callRegenerateAgent,
	variant: callVariantAgent,
	convert: callConvertAgent,
};

// Main Public Orchestrator
app.post("/simba", async (c) => {
	const {
		prompt,
		designSystem = {
			font: "Plus Jakarta Sans",
			radius: "rounded-2xl",
			color: "zinc",
			stroke: "border",
			mode: "light",
		},
	} = await c.req.json();

	let totalUsage = {
		intent: 0,
		architecture: 0,
		imageAsset: 0,
		renderer: 0,
		total: 0,
	};

	// 1️⃣ INTENT
	const { data: intent, usage: intentUsage } = await agents.intent(prompt);
	totalUsage.intent += intentUsage.total_tokens;
	totalUsage.total += intentUsage.total_tokens;

	// Determine if it's single page or multi page
	const isSinglePage =
		intent.app_intent.type === "single-page" ||
		intent.app_intent.type === "component" ||
		intent.pages.length === 1;

	// ALWAYS STREAM
	return streamSSE(c, async (stream) => {
		// 1. Send Meta
		await stream.writeSSE({
			event: "meta",
			data: JSON.stringify({
				type: isSinglePage ? "single-page" : "multi-page",
				intent,
				pages: intent.pages.map(
					(p) => p.slug || p.name.toLowerCase().replace(/\s+/g, "-"),
				),
			}),
		});

		const tasks = intent.pages.map(async (page) => {
			const slug = page.slug || page.name.toLowerCase().replace(/\s+/g, "-");
			try {
				// Find relevant blocks and templates for this specific page
				const relevantBlocks = await findRelevantBlocks(
					`${intent.app_intent.domain} ${page.purpose}`,
				);
				const match = await findRelevantTemplate(
					`${intent.app_intent.domain} ${page.purpose}`,
				);
				const relevantTemplateCode = match
					? match.template.code
					: "No relevant template found.";

				// 2️⃣ ARCHITECTURE
				const { data: architecture, usage: archUsage } =
					await agents.architecture({
						intent,
						page,
					});

				// 2.5️⃣ IMAGE ASSETS
				const { data: imagePlan, usage: imageUsage } = await agents.imageAsset({
					intent,
					page,
					architecture,
				});

				// Fetch actual images from Unsplash based on the plan
				const images = await Promise.all(
					(imagePlan.images || []).map(async (imgReq) => {
						const query = imgReq.queries[0] || "business";
						try {
							const results = await fetchUnsplash(query);
							const selectedImage = results[0] || null;
							return {
								...imgReq,
								url: selectedImage
									? selectedImage.url
									: `https://images.unsplash.com/photo-1497215728101-856f4ea42174?auto=format&fit=crop&q=80&w=1000`, // fallback
								alt: selectedImage ? selectedImage.alt : query,
							};
						} catch (error) {
							console.error(
								`Error fetching image for query "${query}":`,
								error,
							);
							return {
								...imgReq,
								url: `https://images.unsplash.com/photo-1497215728101-856f4ea42174?auto=format&fit=crop&q=80&w=1000`,
								alt: query,
							};
						}
					}),
				);

				// 3️⃣ RENDER
				// We pass relevant context to the prompt injection variables
				const { html, usage: renderUsage } = await agents.render({
					intent,
					architecture,
					images,
					designSystem,
					relevantBlocks,
					relevantTemplateCode,
				});

				// Update usage
				totalUsage.architecture += archUsage.total_tokens;
				totalUsage.imageAsset += imageUsage.total_tokens;
				totalUsage.renderer += renderUsage.total_tokens;
				totalUsage.total +=
					archUsage.total_tokens +
					imageUsage.total_tokens +
					renderUsage.total_tokens;

				// Send page data
				// To handle the \n issue and make it readable, we can send the HTML in chunks or as a dedicated event
				// But for consistency with JSON parsers, we keep it in JSON.
				// However, we'll ensure the HTML itself is cleaned.
				await stream.writeSSE({
					event: "page",
					data: JSON.stringify({
						slug,
						html,
						usage: {
							architecture: archUsage.total_tokens,
							imageAsset: imageUsage.total_tokens,
							renderer: renderUsage.total_tokens,
						},
					}),
				});
			} catch (err) {
				console.error(`Error generating page ${slug}:`, err);
				await stream.writeSSE({
					event: "error",
					data: JSON.stringify({
						slug,
						error: "Page generation failed",
					}),
				});
			}
		});

		// Let all tasks run
		await Promise.allSettled(tasks);

		// 4. Send Done with final usage
		await stream.writeSSE({
			event: "done",
			data: JSON.stringify({
				status: "complete",
				usage: totalUsage,
			}),
		});
	});
});

// Edit/Action Orchestrator
app.post("/agent-edit", async (c) => {
	const {
		prompt,
		currentAppContext, // { intent, pages: { slug: html } }
		designSystem = {
			font: "Plus Jakarta Sans",
			radius: "rounded-2xl",
			color: "zinc",
			stroke: "border",
			mode: "light",
		},
	} = await c.req.json();

	let totalUsage = {
		editIntent: 0,
		action: 0,
		aiEdit: 0,
		total: 0,
	};

	// 1️⃣ Decide Intent
	const { data: editIntent, usage: editIntentUsage } = await agents.editIntent({
		prompt,
		currentAppContext,
	});
	totalUsage.editIntent += editIntentUsage.total_tokens;
	totalUsage.total += editIntentUsage.total_tokens;

	if (editIntent.intentType === "REGENERATE") {
		// 3️⃣ REGENERATE Flow (Streaming)
		return streamSSE(c, async (stream) => {
			await stream.writeSSE({
				event: "meta",
				data: JSON.stringify({
					intentType: "REGENERATE",
					reasoning: editIntent.reasoning,
					scope: editIntent.scope,
					targetPages: editIntent.targetPages,
					usage: totalUsage,
				}),
			});

			const tasks = editIntent.targetPages.map(async (slug) => {
				try {
					const currentHtml = currentAppContext.pages[slug];
					const { html: updatedHtml, usage: regenUsage } =
						await agents.regenerate({
							prompt,
							page: { slug },
							html: currentHtml,
							designSystem,
						});

					totalUsage.total += regenUsage.total_tokens;

					await stream.writeSSE({
						event: "page",
						data: JSON.stringify({
							slug,
							html: updatedHtml,
							usage: {
								regenerate: regenUsage.total_tokens,
							},
						}),
					});
				} catch (err) {
					console.error(`Error regenerating page ${slug}:`, err);
					await stream.writeSSE({
						event: "error",
						data: JSON.stringify({
							slug,
							error: "Page regeneration failed",
						}),
					});
				}
			});

			await Promise.allSettled(tasks);

			await stream.writeSSE({
				event: "done",
				data: JSON.stringify({
					status: "complete",
					usage: totalUsage,
				}),
			});
		});
	}

	if (editIntent.intentType === "ACTION") {
		// For ACTION, we pick the first target page
		const targetSlug = editIntent.targetPages[0];
		const currentHtml = currentAppContext.pages[targetSlug];

		const { data: actionData, usage: actionUsage } = await agents.action({
			prompt,
			page: { slug: targetSlug },
			html: currentHtml,
		});

		totalUsage.action += actionUsage.total_tokens;
		totalUsage.total += actionUsage.total_tokens;

		return c.json({
			intentType: "ACTION",
			reasoning: editIntent.reasoning,
			actionReasoning: actionData.reasoning,
			action: actionData.action,
			usage: totalUsage,
		});
	}

	// 2️⃣ AI_EDIT Flow (Streaming)
	return streamSSE(c, async (stream) => {
		await stream.writeSSE({
			event: "meta",
			data: JSON.stringify({
				intentType: "AI_EDIT",
				reasoning: editIntent.reasoning,
				scope: editIntent.scope,
				targetPages: editIntent.targetPages,
				usage: totalUsage,
			}),
		});

		const tasks = editIntent.targetPages.map(async (slug) => {
			try {
				const currentHtml = currentAppContext.pages[slug];
				const { html: updatedHtml, usage: aiEditUsage } = await agents.aiEdit({
					prompt,
					page: { slug },
					html: currentHtml,
					designSystem,
				});

				totalUsage.aiEdit += aiEditUsage.total_tokens;
				totalUsage.total += aiEditUsage.total_tokens;

				await stream.writeSSE({
					event: "page",
					data: JSON.stringify({
						slug,
						html: updatedHtml,
						usage: {
							aiEdit: aiEditUsage.total_tokens,
						},
					}),
				});
			} catch (err) {
				console.error(`Error editing page ${slug}:`, err);
				await stream.writeSSE({
					event: "error",
					data: JSON.stringify({
						slug,
						error: "Page edit failed",
					}),
				});
			}
		});

		await Promise.allSettled(tasks);

		await stream.writeSSE({
			event: "done",
			data: JSON.stringify({
				status: "complete",
				usage: totalUsage,
			}),
		});
	});
});
// 1. Pick a random design system theme
const designSystems = [
	{
		name: "Brutal",
		blocks: Object.values(uiBlocksBrutal).map((b) => b.code),
	},
	{
		name: "Minimal",
		blocks: Object.values(uiBlocksMinimal).map((b) => b.code),
	},
	{ name: "Cyber", blocks: Object.values(uiBlocksCyber).map((b) => b.code) },
	{ name: "Gaia", blocks: Object.values(uiBlocksGaia).map((b) => b.code) },
	{ name: "Joy", blocks: Object.values(uiBlocksJoy).map((b) => b.code) },
	{
		name: "Modern",
		blocks: Object.values(uiBlocksModern).map((b) => b.code),
	},
	{ name: "Kids", blocks: Object.values(uiBlocksKids).map((b) => b.code) },
	{
		name: "Sports",
		blocks: Object.values(uiBlocksSports).map((b) => b.code),
	},
	{
		name: "Finance",
		blocks: Object.values(uiBlocksFinance).map((b) => b.code),
	},
	{
		name: "Health",
		blocks: Object.values(uiBlocksHealth).map((b) => b.code),
	},
];

// Variant Generation Orchestrator
app.post("/generate-variant", async (c) => {
	const { html } = await c.req.json();

	const randomSystem =
		designSystems[Math.floor(Math.random() * designSystems.length)];
	const styleExamples = randomSystem.blocks.join("\n\n");

	// 2. Stream the variant generation
	return streamSSE(c, async (stream) => {
		await stream.writeSSE({
			event: "meta",
			data: JSON.stringify({
				type: "variant",
				chosenTheme: randomSystem.name,
				engine: "ai",
			}),
		});

		try {
			// Optimization: variant agent already uses gpt-4o-mini
			const { html: variantHtml, usage } = await agents.variant({
				html,
				styleExamples,
			});

			await stream.writeSSE({
				event: "page",
				data: JSON.stringify({
					slug: "variant",
					html: variantHtml,
					usage,
				}),
			});
		} catch (err) {
			console.error("Variant generation failed:", err);
			await stream.writeSSE({
				event: "error",
				data: JSON.stringify({ error: "Variant generation failed" }),
			});
		}

		await stream.writeSSE({
			event: "done",
			data: JSON.stringify({ status: "complete" }),
		});
	});
});

// Convert: HTML ↔ React (one endpoint, one prompt)
app.post("/convert-to-code", async (c) => {
	try {
		const body = await c.req.json();
		const { html, prompt, designSystem } = body;
		const reactCode = await readFileSync(
			path.join(
				path.basename(import.meta.url),
				"../frontend/SampleLandingPage.jsx",
			),
			"utf8",
		);

		const result = await agents.convert({
			html: html ?? null,
			reactCode: reactCode ?? null,
			prompt: prompt ?? "",
			designSystem: designSystem ?? {},
		});

		return c.json({
			ok: true,
			...result,
		});
	} catch (err) {
		console.error("Convert failed:", err);
		return c.json(
			{
				ok: false,
				error: err.message || "Convert failed",
			},
			400,
		);
	}
});

const port = 3002;
console.log(`Simba Multi-Agent API running on port ${port}`);

serve({
	fetch: app.fetch,
	port,
});
