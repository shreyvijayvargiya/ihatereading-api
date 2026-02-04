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
		if (
			response &&
			response.data &&
			Array.isArray(response.data) &&
			response.data[0] &&
			response.data[0].embedding
		) {
			return response.data[0].embedding;
		}
		console.error(
			"Embedding API returned unexpected format. Full response:",
			JSON.stringify(response, null, 2),
		);
		return null;
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
You are the first agent in a multi-agent UI generation system. Your responsibility is to define the HIGH-LEVEL PRODUCT INTENT and to classify whether the user wants a FULL PAGE (website, landing, tool) or ONLY A COMPONENT (form, card, table, etc.).

[R] ROLE
You are a Senior Product Strategist. You decide:
1) COMPONENT vs PAGE: Did the user ask for only a single UI piece (form, card, table, modal) or for a full page/website?
2) If full page: single-page, multi-page, or dashboard?

[I] INFORMATION
Input is a raw user prompt.

[S] SPECIFICATION (STRICT)
- Output ONLY valid JSON.

TYPE: "component" — Use ONLY when the user asks for a single UI component, NOT a full page or website.
- Examples that MUST be type "component": "feedback form", "contact form", "login form", "signup form", "give me a form", "I need a form for...", "pricing table", "hero section only", "navbar component", "card component", "modal", "widget". The user did NOT ask for a "page", "website", "landing", "homepage", "site", or "tool".
- When type is "component": set navigation.style to "none". pages array MUST have EXACTLY ONE object with purpose that names the component only (e.g. "Feedback form only", "Contact form component", "Login form"). No navbar, hero, or footer—output will be just that component.

TYPE: "dashboard" — Use when the user asks for an APPLICATION, TOOL, or WORKSPACE (data-driven UI, not marketing). MUST use for: "app", "dashboard", "project management", "kanban", "board", "CRM", "admin", "tool", "workspace", "left sidebar" + main area, "modal" for create/add. Set navigation.style to "sidebar" when they mention sidebar. These get APPLICATION layout: functional regions (sidebar list, board columns, modals)—NO hero, NO marketing sections, NO landing-style content.
TYPE: "single-page" | "multi-page" — Use ONLY for marketing/landing/content sites: "landing page", "website", "homepage", "one pager", "marketing page", "portfolio". These get full layout: navbar, hero, sections, footer.
- If the user says "landing page", "simple page", "one pager", or a product description without "app"/"dashboard"/"kanban"/"tool", set type to "single-page" and ONE page in "pages".
- DO NOT use "single-page" for project management, kanban, dashboard, or app-style requests—use "dashboard" so architecture produces functional UI (columns, lists, modals), not hero + cards.
- Sections are handled by the ARCHITECTURE AGENT, not you.

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
- "Give me a feedback form" / "I need a contact form for X" → type: "component". No full page.
- "Project management app", "kanban board", "dashboard with sidebar", "tool with X" → type: "dashboard", navigation.style "sidebar" if sidebar mentioned. Application UI, not landing.
- "Landing page for X" / "Website for X" / "Marketing page" → type: "single-page". Full page with navbar, hero, sections, footer.
- Default to "single-page" only when the request is clearly marketing/landing; use "dashboard" when the request is clearly an app, tool, or workspace (kanban, sidebar, modals, boards).
`;

const architectureAgentPrompt = `
[C] CONTEXT
You are the second agent. You convert product intent into page-level structural architecture. Your output is MANDATORY for the renderer—every region you list MUST be filled with HTML.

[R] ROLE
You are a Principal UX Architect. You define layout logic, hierarchy, and regions, not visuals.

[S] SPECIFICATION (STRICT & MANDATORY)
- Output ONLY valid JSON. One output object for the requested page. NO HTML, NO Tailwind, NO copy. DO NOT invent pages.
- The "regions" array MUST be COMPLETE for the given intent type (see below).

WHEN app_intent.type is "component":
- Output ONLY the requested component. Do NOT add navbar, hero, banner, footer, or any full-page regions.
- "regions" MUST contain exactly ONE (or the minimal set for that component, e.g. form + heading). Example: for "Feedback form only", regions: [{ "name": "form", "purpose": "Standalone feedback form", "elements": ["heading", "name", "email", "message", "submit"] }].
- archetype: use "COMPONENT" or "FORM_A" / "CARD_A" etc. No LP_A, no full-page layout.
- FAIL: Output is INVALID if you add navbar, hero, or footer when type is "component".

WHEN app_intent.type is "dashboard" (APPLICATION / TOOL / WORKSPACE):
- This is APPLICATION UI. Do NOT add hero, banner, marketing sections, or footer. Output ONLY functional regions the user asked for.
- REQUIRED: (1) If user said "sidebar" or "left sidebar": one region "sidebar" with elements: project_list (or item list), create_button, optional settings_link. (2) Main area: if user said "kanban" or "board", use ONE region "kanban_board" with elements: column_todo (header + task_cards + add_task_button), column_in_progress (header + task_cards + add_task_button), column_done (header + task_cards + add_task_button). Each column must be a distinct structural element so the renderer outputs real HTML columns and cards, NOT an image. (3) If user said "modal" or "add new project modal": include region "create_project_modal" with elements: backdrop, panel, title, form_fields, submit, cancel. If user said "add new task": the add_task_button is per column (already in kanban_board elements).
- archetype: use DASH_A or TOOL_A. Never LP_A for dashboard type.
- FAIL: INVALID if you add hero, marketing features section, or footer for dashboard type; or if kanban is described as a single "board" without distinct columns and task_cards.

WHEN app_intent.type is "single-page" | "multi-page" (LANDING / MARKETING only):
- The "regions" array MUST include ALL required full-page regions. Navbar, Hero/Banner, Content sections, Footer as appropriate. E-commerce → navbar, hero/promo, product grid, CTA, footer. Landing → navbar, hero, features/cards, social proof, CTA, footer.

For each region you MUST provide: "name", "purpose", and "elements" (array of concrete data elements). Be specific so the renderer can fill every element. For app regions, elements must be structural (columns, cards, list items, buttons, form fields)—never a single "image" for a board or list.

Required JSON Shape
{
  "page_id": "",
  "archetype": "LP_A | LP_B | DASH_A | CRM_A | TOOL_A | GAME_A | COMPONENT | FORM_A | CARD_A",
  "regions": [
    {
      "name": "",
      "purpose": "",
      "elements": ["list of data elements"]
    }
  ],
  "hierarchy": "primary | secondary | tertiary"
}

[P] PERFORMANCE (MANDATORY)
- Component type → ONLY that component; no navbar/hero/footer.
- Dashboard type → ONLY functional regions (sidebar, kanban_board with columns, modal); no hero, no marketing sections, no footer.
- Single-page/multi-page (landing) → full regions; no missing navbar/hero/cards/footer.
- FAIL: INVALID if component type but you added full-page regions; if dashboard type but you added hero/footer or a single "board" image region; or if page type but you omitted required regions.
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
- When Page Architecture is component-only (archetype COMPONENT or FORM_A or CARD_A, or only one region): output ONLY that component. Do NOT add navbar, hero, banner, or footer. Produce a minimal HTML document or fragment containing just the form/card/table. No full-page layout. When architecture has multiple regions (full page), then include navbar, sections, footer as specified.

APPLICATION UI (dashboard / tool / app — archetype DASH_A, TOOL_A, or regions like sidebar + kanban_board):
- You MUST render REAL APPLICATION UI: real HTML structure, not illustrations or single images. (1) Kanban/board = at least three distinct column sections (e.g. divs), each with a column heading, multiple task cards (div/card with title, optional description), and an "Add task" or "+" button. NEVER use one image or one decorative block to represent the board. (2) Sidebar with projects = a list or grid of project items (each a link or card) plus a "Create" / "New project" button. NEVER use one image to represent the projects area. (3) Modals = HTML: backdrop (fixed overlay) + panel (form with fields and Submit/Cancel). (4) Use images only for avatars, logos, or small item thumbnails—never as the main content of a board, list, or form. The result must look like a working app interface (data-dense, interactive structure), not a landing or marketing page.

TECH STACK
- HTML5
- Tailwind CSS v3 (valid classes only)
- Lucide SVG icons ONLY (using unpkg.com/lucide-static)
- Google Fonts ONLY (❌ Forbidden: Inter, Roboto, Arial, Space Grotesk)

🎨 UI RULES
Apply the following UI behavior laws strictly:

UI Layout Laws:
- All layouts MUST align to a consistent grid
- Use consistent vertical rhythm (spacing scale)
- Cards in a row MUST share equal height unless intentionally varied
- Text baselines must align across adjacent components
- Buttons must be optically centered, not just mathematically centered
- Icon + text pairs must align vertically
- Section padding must feel intentional and balanced

UI REFERENCE TEMPLATE
\${RELEVANT_TEMPLATE_CODE}

UI LIBRARY (CORE BLOCKS)
\${RELEVANT_BLOCKS}

## STRICT USE
- When architecture is APPLICATION (sidebar + kanban_board, DASH_A, TOOL_A): render only functional UI (HTML columns, cards, lists, modals). Do NOT use REFERENCE TEMPLATE hero/marketing layout; do NOT use a single image for board or sidebar. Follow CORE BLOCKS for component patterns only.
- When architecture is full-page LANDING (hero, features, footer): follow REFERENCE TEMPLATE and CORE BLOCKS.
- When architecture is component-only (one region, e.g. form): output ONLY that component. No navbar, hero, footer.

[P] PERFORMANCE
- Zero visual bugs
- Desktop and Mobile Responsive code
- Accessible contrast
- No “AI slop”
- Looks like it shipped from a real company
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
- Use stock photography only. Providers allowed: Unsplash, Pexels. Prefer realistic, literal search queries. Avoid abstract, marketing, or emotional words. Never invent logos, mascots, or brand assets.
- When app_intent.type is "dashboard" or the request is an APPLICATION (project management, kanban, tool, workspace): Only include images for avatars, app/logo area, or small card/list item thumbnails. Do NOT suggest any image for: hero, "kanban board", "projects section" as a whole, or any single image representing a board, list, or form. Application UIs are rendered as HTML (columns, cards, lists); do not replace them with stock photos.
- For landing/marketing pages only: include images for hero, section backgrounds, or card media when they serve a clear UI purpose.

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
- Structure and nesting must match (e.g. 5 sections in -> 5 sections out).
- Fail: omitting any part of the input or injecting new content makes the output invalid.
`;

const monolithicSimbaPrompt = `
[C] CONTEXT
You are Simba, the ultimate Software Engineer. You are a World-Class Software Engineer with 15 years of experience in frontend development in HTML, CSS and Javascript and frontend related technologies. 
You ship high-fidelity, interactive, and functionally complete web experiences.

[S] SPECIFICATIONS
1. UI LAWS (MANDATORY):
   - Produce production-ready HTML only. No "demo" code.
	 - Always use theme tokens for colors, fonts, spacing, shadows from UI HTML LIBRARY and HTML REFERENCE TEMPLATE added below.
   - Use consistent spacing (Tailwind scale), refined color scales, and professional typography.
	 - Add all required sections in details, do not miss any section or page unless asked to skip.
   - No section may feel empty or unfinished. Every part MUST be fully filled.
   - Add subtle motion (hover, focus, active, entrance) where natural using CSS transitions/transforms, statis === dead.
   - BACKGROUND ANIMATIONS & EFFECTS: Use subtle background transitions, gradients shifts, slow-moving blobs, or backdrop-blur effects on hover or for entry to increase visual quality. (e.g., hover:bg-opacity-80, group-hover:scale-105).
   - TEXT VISIBILITY & CONTRAST (CRITICAL): Ensure high contrast at all times (AA/AAA). NEVER use dark text on dark backgrounds or light text on light backgrounds. Check readability for all states (normal, hover, active).
   - Buttons, cards, nav, and forms must feel interactive and respond to user states.
   - Prefer clarity and functional density over pure decoration.

2. TECH STACK
   - HTML5, Tailwind CSS v3 (valid classes only).
   - Lucide SVG icons ONLY (using unpkg.com/lucide-static).

3. CONTENT:
   - NO placeholders, NO "Lorem ipsum". Use realistic, domain-specific copy.
   - LABELS & CONTENT (MANDATORY): Every button, input, tab, and interactive UI element MUST have a clear, descriptive text label. No "empty" states or icon-only buttons without labels.
   - ICONS: Use Lucide icons liberally in buttons, navigation, feature cards, and component headers to enhance scanning and visual interest. (e.g., <i data-lucide="arrow-right"></i>).
   - Every button/tab/link: Visible boundary, Icon + Label (icon-left or icon-right), Hover + Focus + Active state.
   - PRODUCTION COMPONENTS: Use professional, data-dense components (e.g., multi-column grids, complex tables, detailed task cards) instead of simple, generic boxes.
   - APPLICATION vs LANDING: 
     - If "app/dashboard/tool", render functional UI (sidebar lists, board columns, modals). No hero banners.
     - If "landing/website", render marketing UI (hero, features, testimonials, CTA, footer).
   - OMISSION = FAILURE. Every region required for a complete page must be present.

4. IMAGE GUIDELINES:
   - Images are only allowed for avatars, logos, or small item thumbnails
	 - Don't blindly add image in the hero section background. Ask user first. In default scenario, don't add image in the hero section as a background
   - Use high-quality Unsplash URLs for hero sections, avatars, card thumbnails, and section backgrounds where needed
   - Syntax: <img src="https://images.unsplash.com/photo-[ID]?auto=format&fit=crop&q=80&w=1000" alt="[DESCRIPTIVE_ALT]">
   - Match orientation (landscape/portrait) to the layout usage.

5. GENERAL DESIGN GUIDELINES: 
  - You must **not** center align the app container, ie do not add \`.App { text-align: center; }\` in the css file. This disrupts the human natural reading flow of text
  - You must **not** apply universal. Eg: \`transition: all\`. This results in breaking transforms. Always add transitions for specific interactive elements like button, input excluding transforms    
  - Use contextually appropriate colors that match the user's request and **DO NOT** use default dark purple-blue or dark purple-pink combinations or these color combinarions for any gradients, they look common. For general design choices, diversify your color palette beyond purple/blue and purple/pink to keep designs fresh and engaging. Consider using alternative color schemes. 
  - If user asks for a specific color code, you must build website using that color
  - Never ever use typical basic red blue green colors for creating website. Such colors look old. Use different rich colors
  - Do not use system-UI font, always use usecase specific publicly available fonts
  - NEVER: use AI assistant Emoji characters like\`🤖🧠💭💡🔮🎯📚🔍🎭🎬🎪🎉🎊🎁🎀🎂🍰🎈🎨🎭🎲🎰🎮🕹️🎸🎹🎺🎻🥁🎤🎧🎵🎶🎼🎹💰❌💵💳🏦💎🪙💸🤑📊📈📉💹🔢⚖️🏆🥇⚡🌐🔒 etc for icons. Always use **lucid-react** library.
	- If design guidelines are provided, You **MUST** adhere those design guidelines to build website with exact precision
	- Use mild color gradients if the problem statement requires gradients
	- Use Flexbox and Grid for all structural layouts.
	- APPLICATION UI LAYOUT (CRITICAL): Sidebar and Main Content MUST be in a horizontal flex-row or grid layout on desktop. The Sidebar MUST be a fixed-width column (e.g., w-64 or 250px) on the left, and the main content MUST be a flexible column on the right. NEVER stack them vertically on desktop.
	- For mobile, the sidebar should either be hidden/collapsible or stacked correctly.
	- Use 'w-full' for mobile and appropriate 'md:' or 'lg:' widths for desktop.
	- Ensure the sidebar stays fixed or occupies its own column, never overlapping content unless intended as a drawer.
	- Layouts MUST match real-world product standards (e.g., Linear, Stripe, Notion).

GRADIENT RESTRICTION RULE - THE 80/20 PRINCIPLE
	• NEVER use dark colorful gradients in general or apply gradients to entire page.
	• NEVER use dark, vibrant or absolute colorful gradients for buttons
	• NEVER use dark purple/pink gradients for buttons
	• NEVER use complex gradients for more than 20% of visible page area
	• NEVER apply gradients to text content areas or reading sections
	• NEVER use gradients on small UI elements (buttons smaller than 100px width)
	• NEVER layer multiple gradients in the same viewport

ENFORCEMENT RULE:
•Id gradient area exceeds 20% of viewport OR affects readability, THEN use simple two-color gradients(Color with slight lighter version of same color) or solid colors instead. 

ONLY ALLOWED GRADIENT USAGE:
	- Hero sections and major landing areas, Section backgrounds (not content backgrounds), Large CTA buttons and major interactive elements, Decorative overlays and accent elements only
	- Motion is awesome: Every interaction needs micro-animations - hover states, transitions, parallax effects, and entrance animations. Static = dead. 
	- Depth through layers: Use shadows, blurs, gradients, and overlapping elements. Think glass morphism, neumorphism, and 3D transforms for visual hierarchy.
	- Color with confidence: light gradients, and dynamic color shifts on interaction.
	- Whitespace is luxury: Use 2-3x more spacing than feels comfortable. Cramped designs look cheap.
	- Details define quality: Subtle grain textures, noise overlays, custom cursors, selection states, and loading animations separate good from extraordinary.
	- Interactive storytelling: Scroll-triggered animations, progressive disclosure, and elements that respond to mouse position create memorable experiences.
	- Performance is design: Optimize everything - lazy load images, use CSS transforms over position changes, and keep animations at 60fps.

[R] RELEVANT HTML CODE SAMPLES
- Use these as reference to build the website as per user provided prompt. Do not directly copy paste unless required.
HTML REFERENCE TEMPLATE:
\${RELEVANT_TEMPLATE_CODE}

HTML LIBRARY (CORE BLOCKS):
\${RELEVANT_BLOCKS}

[E] EXAMPLES:
<user_prompt>: Create a project management website for a company called "ProjectX"
<thinking>: Based on the user prompt, I need to create a project management website for a company called "ProjectX". I will use the HTML REFERENCE TEMPLATE and HTML LIBRARY to build the website. I'll use 
real world projects as inspiration to create project management that contains kanban board with all tasks and create new tasks button. I'll list all projects in left sidebar overlay with add new project button.
<output>: { "html": "<HTML_CODE>", "summary": "...", "next_updates": [...] }

<user_prompt>: Create a landing page for a company called "ProjectX"
<thinking>: Based on the user prompt, I need to create a landing page for a company called "ProjectX". I will use the HTML REFERENCE TEMPLATE and HTML LIBRARY to build the website. I'll use 
real world projects as inspiration to create landing page that contains hero section with a call to action button. I'll list all features in the features section with a call to action button. I'll list all testimonials in the testimonials section. I'll list all pricing plans in the pricing section. I'll list all contact information in the contact section.
<output>: { "html": "<HTML_CODE>", "summary": "...", "next_updates": [...] }

<user_prompt>: Create a todo list website for a company called "TodoX"
<thinking>: Based on the user prompt, I need to create a todo list website for a company called "TodoX". I will use the HTML REFERENCE TEMPLATE and HTML LIBRARY to build the website. I'll use 
real world todos as inspiration to create todo list that contains todo list with all todos and create new todo button. I'll list all todos in left sidebar overlay with add new todo button.
<output>: { "html": "<HTML_CODE>", "summary": "...", "next_updates": [...] }

<user_prompt>: Create a calculator website for a company called "CalculatorX"
<thinking>: Based on the user prompt, I need to create a calculator website for a company called "CalculatorX". I will use the HTML REFERENCE TEMPLATE and HTML LIBRARY to build the website. I'll use 
real world calculator as inspiration to create calculator that contains calculator with all calculator buttons. I'll list all calculator buttons in left sidebar overlay with add new calculator button.
<output>: { "html": "<HTML_CODE>", "summary": "...", "next_updates": [...] }

<user_prompt>: Create a chat website for a company called "ChatX"
<thinking>: Based on the user prompt, I need to create a chat website for a company called "ChatX". I will use the HTML REFERENCE TEMPLATE and HTML LIBRARY to build the website. I'll use 
real world chat as inspiration to create chat that contains chat with all chat messages and create new chat message button. I'll list all chat messages in left sidebar overlay with add new chat message button.
<output>: { "html": "<HTML_CODE>", "summary": "...", "next_updates": [...] }

<user_prompt>: Create a calendar website for a company called "CalendarX"
<thinking>: Based on the user prompt, I need to create a calendar website for a company called "CalendarX". I will use the HTML REFERENCE TEMPLATE and HTML LIBRARY to build the website. I'll use 
real world calendar as inspiration to create calendar that contains calendar with all calendar events and create new calendar event button. I'll list all calendar events in left sidebar overlay with add new calendar event button.
<output>: { "html": "<HTML_CODE>", "summary": "...", "next_updates": [...] }

<user_prompt>: Create a task management website for a company called "TaskX"
<thinking>: Based on the user prompt, I need to create a task management website for a company called "TaskX". I will use the HTML REFERENCE TEMPLATE and HTML LIBRARY to build the website. I'll use 
real world tasks as inspiration to create task management that contains task management with all tasks and create new task button. I'll list all tasks in left sidebar overlay with add new task button.
<output>: { "html": "<HTML_CODE>", "summary": "...", "next_updates": [...] }
	
[P] PERFORMANCE & VALIDATION
- Zero visual bugs. Responsive (Desktop + Mobile).
- Accessible contrast (AA/AAA).
- No "AI slop" or generic blocks. Looks like it shipped from a real company.
- VALIDATION: Output is INVALID if:
  - Any section is empty or placeholder-filled.
  - Page structure deviates significantly from standard high-quality UX patterns.
  - Interactive elements lack states or icons.
  - Motion is missing where it would add value.

STRICT OUTPUT:
- You must return a JSON object with the following keys:
  - "html": The complete HTML code starting with <!DOCTYPE html>.
  - "summary": A concise summary of what was built (max 2 lines).
  - "next_updates": An array of 3-5 production-level features or updates that could be added next (each feature should be 3-5 words).
- NO markdown, NO explanations outside the JSON object.
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
				content: `Intent Context: ${JSON.stringify(intent)}\nPage Architecture: ${JSON.stringify(architecture)}\nImage Assets: ${JSON.stringify(images)}\nDesign System: ${JSON.stringify(designSystem)}\n\nReminder (STRICT): (1) Include EVERY region from Page Architecture. (2) If this is an APPLICATION (dashboard/tool—sidebar, kanban_board, modal): render real UI only—HTML columns with task cards and add buttons, sidebar as list + button, modal as backdrop+form. Do NOT use any single image to represent the board or the projects area. (3) If this is a landing/marketing page: follow REFERENCE TEMPLATE and CORE BLOCKS.`,
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

async function callMonolithicAgent({
	prompt,
	designSystem,
	relevantBlocks,
	relevantTemplateCode,
}) {
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini",
		messages: [
			{
				role: "system",
				content: monolithicSimbaPrompt
					.replace(
						"${RELEVANT_BLOCKS}",
						relevantBlocks != null && relevantBlocks !== ""
							? relevantBlocks
							: "No specific blocks were matched. Use Tailwind utilities.",
					)
					.replace(
						"${RELEVANT_TEMPLATE_CODE}",
						relevantTemplateCode != null && relevantTemplateCode !== ""
							? "```html\n" + relevantTemplateCode + "\n```"
							: "No reference template. Build clean HTML.",
					),
			},
			{
				role: "user",
				content: `User Request: ${prompt}\nDesign System: ${JSON.stringify(designSystem)}`,
			},
		],
		response_format: { type: "json_object" },
	});
	const content = JSON.parse(response.choices[0].message.content);
	let html = content.html || "";
	html = stripCodeFences(html, "html");
	return {
		html: html.trim(),
		summary: content.summary,
		next_updates: content.next_updates,
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
	convert: callConvertAgent,
	monolithic: callMonolithicAgent,
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

	// Find relevant context before generation
	const relevantBlocks = await findRelevantBlocks(prompt);
	const match = await findRelevantTemplate(prompt);
	const relevantTemplateCode = match
		? match.template.code
		: "No relevant template found.";

	// ALWAYS STREAM
	return streamSSE(c, async (stream) => {
		// 1. Send Meta (Basic context for monolithic)
		await stream.writeSSE({
			event: "meta",
			data: JSON.stringify({
				type: "single-page",
				pages: ["index"],
				intent: {
					app_intent: {
						type: "single-page",
						domain: "generated",
						description: prompt,
					},
					pages: [{ name: "Home", slug: "index", purpose: "Main Page" }],
				},
			}),
		});

		try {
			// 2️⃣ MONOLITHIC GENERATION
			// This single call handles Intent, Architecture, and Rendering
			const { html, summary, next_updates, usage } = await agents.monolithic({
				prompt,
				designSystem,
				relevantBlocks,
				relevantTemplateCode,
			});

			// 2. Send page data
			await stream.writeSSE({
				event: "page",
				data: JSON.stringify({
					slug: "index",
					html,
					summary,
					next_updates,
					usage: {
						renderer: usage.total_tokens,
					},
				}),
			});

			// 3. Send Done with final usage
			await stream.writeSSE({
				event: "done",
				data: JSON.stringify({
					status: "complete",
					usage: {
						total: usage.total_tokens,
					},
				}),
			});
		} catch (err) {
			console.error(`Error in monolithic generation:`, err);
			await stream.writeSSE({
				event: "error",
				data: JSON.stringify({
					error: "Generation failed",
				}),
			});
		}
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

app.get("/get-templates", async (c) => {
	const { name } = await c.req.json();
	const template = templates[name];
	return c.json({
		ok: true,
		...template,
	});
});

const port = 3003;
console.log(`Simba Multi-Agent API running on port ${port}`);

serve({
	fetch: app.fetch,
	port,
});
