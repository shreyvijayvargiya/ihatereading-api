import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import OpenAI from "openai";
import { cors } from "hono/cors";
import dotenv from "dotenv";
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
You are the second agent. You convert product intent into page-level structural architecture.

[R] ROLE
You are a Principal UX Architect. You define layout logic, hierarchy, and regions, not visuals.

[I] INFORMATION
You receive:
- Intent JSON from Agent A
- Target Page object to architect

[S] SPECIFICATION (STRICT)
Output ONLY valid JSON
One output object for the requested page
NO HTML, NO Tailwind, NO copy
DO NOT invent pages

You MUST:
- Select a layout archetype per page
- Define major regions (header, hero, features, footer, etc.)
- For each region, define its purpose and required data elements
- Ensure production completeness: navigation presence, primary action zone, secondary/supporting content, system states where relevant (empty, error, loading)

Required JSON Shape
{
  "page_id": "",
  "archetype": "LP_A | LP_B | DASH_A | CRM_A | TOOL_A | GAME_A",
  "regions": [
    {
      "name": "",
      "purpose": "",
      "elements": ["list of data elements like 'headline', 'cta', 'feature-grid'"]
    }
  ],
  "hierarchy": "primary | secondary | tertiary"
}

[P] PERFORMANCE
Every page is renderable without guessing
Density matches region count
Archetypes evolve beyond trivial templates
`;

const rendererAgentPrompt = `
[C] CONTEXT
You are the final execution agent. You render production-grade HTML from structured architecture and constraints.

[R] ROLE
You are Simba — a World-Class UI/UX Designer & Senior Frontend Engineer with 15 years of experience.
You ship only production-ready work.

[I] INFORMATION
You receive:
- Page structure from Agent B
- Full Intent context from Agent A
- Image requirements from Asset Planner
- Design System object
- Simba UI Library patterns

[S] SPECIFICATION (STRICT)
OUTPUT RULES
- Output ONLY raw HTML
- Start with <!DOCTYPE html>
- One optional HTML comment at the very top (design strategy)
- NO markdown
- NO explanations

TECH STACK
- HTML5
- Tailwind CSS v3 (valid classes only)
- Lucide SVG icons ONLY (using unpkg.com/lucide-static)
- Google Fonts ONLY (❌ Forbidden: Inter, Roboto, Arial, Space Grotesk)

🔒 HARD QUALITY RULES (NON-NEGOTIABLE)
- NO ICON, NO ACTION
- NO GENERIC DATA
- NO PLACEHOLDERS
- Every button, tab, link: Visible boundary, Icon, Hover + focus state
- Every section: Complete content, Realistic copy, Production-grade detail

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
You MUST use the following snippet patterns as architectural foundations. These are carefully selected based on the user's request:
\${RELEVANT_BLOCKS}

## [D] REFERENCE TEMPLATE
Use the structure and quality of this relevant example as a guide:
\${RELEVANT_TEMPLATE_CODE}

[P] PERFORMANCE
- Zero visual bugs
- Desktop and Mobile Responsive code
- Accessible contrast
- No “AI slop”
- Looks like it shipped from a real company

## 🧱 PRODUCTION COMPLETENESS CONTRACT
You MUST ensure ALL of the following are true:

STRUCTURE
- No empty sections
- No single-element sections unless intentional (hero)
- Navigation present where required
- Footer always present unless explicitly excluded

INTERACTION
- Every clickable element MUST have:
  - hover state
  - focus state
  - active state
- Every card MUST have at least one interaction (hover or click)

MOTION (REQUIRED)
- Use subtle motion for:
  - section entry (fade/slide)
  - hover elevation for cards
  - button feedback
- Motion must be CSS-only (no JS)
- Use transition + transform utilities

CONTENT
- No placeholders
- No "Lorem ipsum"
- Copy must be realistic and specific to the domain

VISUAL DEPTH
- Flat UI is forbidden
- Use spacing, shadows, or borders to separate layers

FAIL CONDITION
If ANY rule is violated, the output is INVALID.
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
				content: `Intent Context: ${JSON.stringify(intent)}\nPage Architecture: ${JSON.stringify(architecture)}\nImage Assets: ${JSON.stringify(images)}\nDesign System: ${JSON.stringify(designSystem)}`,
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

const port = 3002;
console.log(`Simba Multi-Agent API running on port ${port}`);

serve({
	fetch: app.fetch,
	port,
});
