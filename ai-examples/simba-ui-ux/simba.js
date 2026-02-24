import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import OpenAI from "openai";
import { cors } from "hono/cors";
import dotenv from "dotenv";
import { search } from "./scripts/core.js";
import { uiBlockLibrary } from "../tailwind-ui-blocks.js";
import { templates } from "../templates.js";
import cosineSimilarity from "../../utils/cosineSimilarity.js";
import { prompts } from "./prompts/prompts.js";
import { loadSkills } from "./skills/loadSkills.js";

dotenv.config();

const openai = new OpenAI({
	baseURL: "https://openrouter.ai/api/v1",
	apiKey: process.env.OPENROUTER_API_KEY,
});

// Cache for embeddings
let templateEmbeddingsCache = null;
let blockEmbeddingsCache = null;
let promptEmbeddingsCache = null;

async function getEmbedding(text) {
	if (!text || typeof text !== "string") {
		console.warn("getEmbedding: Invalid or empty text provided.");
		return null;
	}
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

async function getPromptEmbeddings() {
	if (promptEmbeddingsCache) return promptEmbeddingsCache;
	const embeddings = {};
	for (const [key, promptObj] of Object.entries(prompts)) {
		// Extract first 500 chars as context for embedding to understand design system meaning
		const text = promptObj.prompt?.slice(0, 500).replace(/<[^>]*>/g, "") || ""; // strip tags
		const embedding = await getEmbedding(text);
		if (embedding) embeddings[key] = embedding;
	}
	promptEmbeddingsCache = embeddings;
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
		? {
				key: bestMatchKey,
				template: templates[bestMatchKey],
				code: templates[bestMatchKey].code,
				similarity: maxSimilarity,
			}
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

const monolithicSimbaPrompt = `
[C] CONTEXT
You are a deterministic HTML rendering engine.
You strictly transform structured input into production-grade HTML.

────────────────────────────────────────
[R] DESIGN REASONING ENGINE (MANDATORY)
Before generating any code, you MUST internally reason through:
1. INDUSTRY MATCHING: Identify the product category (SaaS, Fintech, Healthcare, E-commerce, Luxury, etc.).
2. STYLE PRIORITY: Choose the best UI style (Minimalism, Glassmorphism, Neo-Brutalism, Soft UI, etc.).
3. COLOR PSYCHOLOGY: Select an industry-appropriate palette (e.g., Soft Pink/Sage for Wellness, Navy/Indigo for SaaS).
4. TYPOGRAPHY PAIRING: Select a Google Font combination that matches the brand mood.
5. ANTI-PATTERN FILTERING: Identify industry-specific "no-gos" (e.g., NO harsh animations for Healthcare, NO bright neons for Finance).

────────────────────────────────────────
[S] PRODUCTION LAWS (NON-NEGOTIABLE)

1. NO PLACEHOLDERS / NO COMMENTS:
   - NEVER use comments like "<!-- 3 more cards -->" or "<!-- Add others here -->".
   - You MUST render EVERY SINGLE item specified in the architecture. If architecture says 10 items, you render 10 distinct HTML blocks with 10 distinct real names/values.
   - NO placeholders ("Item 1", "Placeholder", "Lorem Ipsum"). Use domain-specific real data.
   - FAILURE TO COMPLY = IMMEDIATE FAILURE.

2. ARCHITECTURAL DENSITY (MANDATORY MINIMUMS):
   - DASHBOARD: Sidebar (min 10 REAL items) + TopBar + StatsRow (min 4 distinct cards with trends) + Filters + Data View (min 10 rows/cards) + RightPanel (activity feed).
   - LANDING PAGE: 10+ sections (Hero, Multi-column Features, Bento Grid, Problem/Solution, How it Works, Testimonials (min 6), Pricing (3 tiers), FAQ (8+ items), Footer).
   - Sidebar/Navbar MUST have 8-12 navigation items, search, and user profile.
   - ALL lists (cards, table rows, nav items) must have at least 8-10 unique items.
   - OMISSION = FAILURE. Every view MUST be fully realized with no empty spaces or placeholders.

3. INTERACTION & ACCESSIBILITY:
   - MANDATORY: Add CSS transitions to every button, card, and link (hover:scale-[1.02], transition-all duration-300).
   - MANDATORY: Use entrance animations on EVERY section and major card (class="animate-in fade-in slide-in-from-bottom-4 duration-1000").
   - MANDATORY: Ensure WCAG AA compliance (text contrast, focus states, cursor-pointer on all clickables).

4. TECH STACK & ICONS:
   - HTML5 + Tailwind CSS v3 (Play CDN: <script src="https://cdn.tailwindcss.com"></script>).
   - Lucide Icons: MANDATORY USE <i data-lucide="icon-name"></i>. 
   - NEVER use <img> tags for icons. NEVER use "lucide-static" images.
   - Initialize with <script src="https://unpkg.com/lucide@latest"></script> and <script>lucide.createIcons();</script> before </body>.
   - Real Unsplash images only (e.g., https://images.unsplash.com/photo-...).

5. REAL CONTENT PROTOCOL:
  - All names, metrics, and testimonials must be fictional but realistic.
	- Do not claim affiliation with real companies.
	- Do not fabricate real-world claims.

────────────────────────────────────────
[OUTPUT FORMAT — STRICT JSON]
Return a JSON object:
{
  "design_system_reasoning": {
    "industry": "Identified Industry",
    "style": "Chosen UI Style",
    "color_palette": { "primary": "HEX", "secondary": "HEX", "cta": "HEX" },
    "typography": "Chosen Font Pairing",
    "anti_patterns_avoided": ["Rule 1", "Rule 2"]
  },
  "intent": "single-page | multi-page | component",
  "pages": [
    {
      "slug": "index",
      "html": "<!DOCTYPE html>...",
      "summary": "Concise 1-2 line summary of this specific page"
    }
  ],
  "next_updates": [
    "Feature idea 1 (3-5 words)",
    "Feature idea 2 (3-5 words)",
    "Feature idea 3 (3-5 words)",
    "Feature idea 4 (3-5 words)",
    "Feature idea 5 (3-5 words)"
  ]
}
- NO markdown.
- NO explanations.
- Use relative links (href="product.html") between pages.
- Avoid unnecessary verbose markup.
- Avoid redundant wrapper divs.
- Keep class lists efficient.
- REINFORCEMENT: If you use placeholders or comments, the generation will be REJECTED. Build it like a $100k production project.
`;

// above this simple one prompt we need skills to improve UI for existing code based on the product requirements
// for example product is landing page than landing page skills load for AI agent post generation making it better UI

async function findRelevantDesignSystem(prompt) {
	const promptEmbedding = await getEmbedding(prompt);
	if (!promptEmbedding) return prompts.modernDark.prompt;

	const promptEmbeddings = await getPromptEmbeddings();
	let bestMatchKey = "modernDark";
	let maxSimilarity = -1;

	for (const [key, embedding] of Object.entries(promptEmbeddings)) {
		const similarity = cosineSimilarity(promptEmbedding, embedding);
		if (similarity > maxSimilarity) {
			maxSimilarity = similarity;
			bestMatchKey = key;
		}
	}

	return prompts[bestMatchKey]?.prompt || prompts.modernDark.prompt;
}

async function callMonolithicAgent({ prompt }) {
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o", // Upgraded to gpt-4o for production density
		messages: [
			{
				role: "system",
				content: monolithicSimbaPrompt,
			},
			{
				role: "user",
				content: `User Request: ${prompt}`,
			},
		],
		response_format: { type: "json_object" },
	});

	const content = JSON.parse(response.choices[0].message.content);
	const pages = (content.pages || []).map((page) => ({
		...page,
		html: stripCodeFences(page.html || "", "html").trim(),
	}));

	return {
		intent: content.intent || "single-page",
		design_system_reasoning: content.design_system_reasoning,
		pages,
		next_updates: content.next_updates,
		usage: response.usage.total_tokens,
	};
}

/**
 * Utility to strip markdown code fences from AI output
 * @param {string} content - The content to strip
 * @param {string} language - The language to strip (e.g. "html", "json")
 * @returns {string} - The stripped content
 */
function stripCodeFences(content, language = "") {
	if (!content) return "";
	const regex = new RegExp(`^\`\`\`${language}[\\s\\S]*?\\n|\\n\`\`\`$`, "g");
	const fallbackRegex = /^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/;

	// Try standard regex
	let stripped = content.replace(regex, "");

	// If still has fences, try fallback
	const match = content.match(fallbackRegex);
	if (match) {
		stripped = match[1];
	}

	return stripped.replace(/```/g, "").trim();
}

async function callDesignWebsiteAgent({ prompt }) {
	// 1. Find relevant product features and required sections from CSVs
	const [productInfo, sectionInfo] = await Promise.all([
		search(prompt, "product", 1),
		search(prompt, "section", 1),
	]);

	const productDetails = productInfo.results[0]
		? JSON.stringify(productInfo.results[0], null, 2)
		: "No specific product guidelines found.";

	const sectionDetails = sectionInfo.results[0]
		? JSON.stringify(sectionInfo.results[0], null, 2)
		: "No specific section requirements found.";

	// 2. DESIGNER AGENT: Finalize Design, Wireframe, and High-Fidelity Content
	const availableThemes = Object.keys(prompts);
	const designerResponse = await openai.chat.completions.create({
		model: "openai/gpt-4o", // Upgraded to gpt-4o for high-fidelity content planning
		messages: [
			{
				role: "system",
				content: `You are a World-Class UI/UX Designer and Content Strategist. 
Your task is to analyze the user's request and industry context to create a COMPLETE, High-Fidelity Wireframe and Content Plan.

INDUSTRY GUIDELINES:
${productDetails}

REQUIRED PAGE SECTIONS & DATA:
${sectionDetails}

You MUST:
1. Select the most appropriate visual theme from this list: ${availableThemes.join(", ")}.
2. Design the FULL page architecture based on the REQUIRED SECTIONS above.
3. High-fidelity content for EVERY section: Write the actual headlines, descriptions, labels, and features. NO PLACEHOLDERS.
4. For Dashboards: Define Sidebar with 10+ items, TopBar, 4+ Stat Cards with real labels/values, and a complex Data View (table or kanban).
5. Design System reasoning: Explain colors, typography, and layout choices based on the product type.
6. Interactive Elements: Define specific buttons, hover states, and animations.

Return a JSON object:
{
  "selected_theme": "selected_theme_key",
  "design_reasoning": "Detailed explanation of the visual strategy",
  "wireframe": {
    "navigation": { "style": "navbar | sidebar", "logo": "...", "links": ["...", "..."], "cta": "..." },
    "pages": [
      {
        "slug": "index",
        "sections": [
          {
            "id": "hero",
            "content": { "headline": "...", "subheadline": "...", "cta_primary": "...", "cta_secondary": "..." },
            "visual_spec": "Detailed description of layout, background, and animations for this section"
          },
          {
            "id": "features",
            "content": { "title": "...", "items": [{ "title": "...", "desc": "...", "icon": "..." }] },
            "visual_spec": "..."
          }
          // ... more sections
        ],
        "footer": { "columns": [...] }
      }
    ]
  }
}`,
			},
			{ role: "user", content: prompt },
		],
		response_format: { type: "json_object" },
	});

	const designPlan = JSON.parse(designerResponse.choices[0].message.content);
	const selectedKey = designPlan.selected_theme;
	const themePrompt = prompts[selectedKey] || prompts.modernDark;
	const wireframeJson = JSON.stringify(designPlan.wireframe, null, 2);

	// Combine the theme prompt with the production standards
	const systemPrompt = `
${themePrompt}

────────────────────────────────────────
[OUTPUT FORMAT — STRICT JSON]
Return a JSON object:
{
  "design_system_reasoning": {
    "industry": "Identified Industry",
    "style": "Chosen UI Style",
    "color_palette": { "primary": "HEX", "secondary": "HEX", "cta": "HEX" },
    "typography": "Chosen Font Pairing",
    "anti_patterns_avoided": ["Rule 1", "Rule 2"]
  },
  "intent": "single-page | multi-page | component",
  "pages": [
    {
      "slug": "index",
      "html": "<!DOCTYPE html>...",
      "summary": "Concise 1-2 line summary of this specific page"
    }
  ],
  "next_updates": [
    "Feature idea 1 (3-5 words)",
    "Feature idea 2 (3-5 words)",
    "Feature idea 3 (3-5 words)",
    "Feature idea 4 (3-5 words)",
    "Feature idea 5 (3-5 words)"
  ]
}
- NO markdown.
- NO explanations.
- Use relative links (href="product.html") between pages.
- Avoid unnecessary verbose markup.
- Avoid redundant wrapper divs.
- Keep class lists efficient.
- REINFORCEMENT: If you use placeholders or comments, the generation will be REJECTED. Build it like a $100k production project.
`;

	// 3. FRONTEND DEVELOPER AGENT: Implement the wireframe into pixel-perfect code
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o",
		messages: [
			{
				role: "system",
				content: systemPrompt,
			},
			{
				role: "user",
				content: `User Request: ${prompt}

HIGH-FIDELITY WIREFRAME & CONTENT PLAN (FOLLOW THIS EXACTLY):
${wireframeJson}

DESIGN STRATEGY:
${designPlan.design_reasoning}

PRODUCT GUIDELINES:
${productDetails}

FRONTEND DEVELOPER INSTRUCTIONS:
- You are a Senior Frontend Engineer. Your ONLY job is to implement the above wireframe into a pixel-perfect, high-fidelity production application.
- Use the content (headlines, text, lists) provided in the wireframe exactly. Do not invent new content unless requested.
- CORE PRODUCTION LAWS:
  - NO PLACEHOLDERS. Render every single section and item defined in the wireframe.
  - NO COMMENTS like "<!-- add more -->". The output must be 100% complete.
  - MANDATORY ANIMATIONS: Use Tailwind entrance animations on every major section.
  - INTERACTION: Every clickable element MUST have hover states and smooth transitions.
  - ICONS: Use Lucide icons strictly as <i data-lucide="...">.

OUTPUT: Return the strict JSON format specified in the system instructions.`,
			},
		],
		response_format: { type: "json_object" },
	});
	const content = JSON.parse(response.choices[0].message.content);
	const pages = (content.pages || []).map((page) => ({
		...page,
		html: stripCodeFences(page.html || "", "html").trim(),
	}));

	return {
		intent: content.intent || "single-page",
		design_system_reasoning:
			content.design_system_reasoning || designPlan.design_reasoning,
		pages,
		next_updates: content.next_updates,
		usage: response.usage,
	};
}

// Internal Agent Methods (Encapsulated)
const agents = {
	monolithic: callMonolithicAgent,
	designWebsite: callDesignWebsiteAgent,
};

// Main Public Orchestrator
app.post("/simba", async (c) => {
	const { prompt } = await c.req.json();

	// ALWAYS STREAM
	return streamSSE(c, async (stream) => {
		try {
			// 1️⃣ MONOLITHIC GENERATION
			// This single call handles Intent, Architecture, and Rendering
			const { intent, design_system_reasoning, pages, next_updates, usage } =
				await agents.monolithic({
					prompt,
				});

			// 2. Send Meta (Now we know the actual intent and pages)
			await stream.writeSSE({
				event: "meta",
				data: JSON.stringify({
					type: intent,
					design_system_reasoning,
					pages: pages.map((p) => p.slug),
					intent: {
						app_intent: {
							type: intent,
							domain: "generated",
							description: prompt,
						},
						pages: pages.map((p) => ({
							name: p.slug.charAt(0).toUpperCase() + p.slug.slice(1),
							slug: p.slug,
							purpose: p.summary,
						})),
					},
				}),
			});

			// 3. Send each page data
			for (const page of pages) {
				await stream.writeSSE({
					event: "page",
					data: JSON.stringify({
						slug: page.slug,
						html: page.html,
						summary: page.summary,
						next_updates, // Same next updates for the whole app
						usage: {
							renderer: usage.total_tokens,
						},
					}),
				});
			}

			// 4. Send Done with final usage
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

const MOBILE_SCREEN_GENERATOR_PROMPT = `You are an elite mobile UI/UX designer and frontend developer specializing in creating production-ready mobile app screens. You generate complete, pixel-perfect HTML/CSS code for mobile applications in a single response.

# CRITICAL RULES - READ CAREFULLY

1. **OUTPUT FORMAT**: Return ONLY a valid JSON object with this EXACT structure (no markdown, no code blocks, no extra text):
{
  "html": "complete HTML string",
  "css": "complete CSS string",
  "metadata": {
    "title": "Screen Name",
    "description": "Brief description",
    "screenType": "type",
    "primaryColor": "#hex",
    "categories": ["category1", "category2"]
  }
}

2. **MOBILE-FIRST**: Every screen MUST be optimized for mobile devices (375px-428px width)

3. **PRODUCTION QUALITY**: Code must be deployment-ready, not a prototype

# TECH STACK REQUIREMENTS

## Required CDNs (ALWAYS include in HTML):
\`\`\`html
<!-- Tailwind CSS Browser -->
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>

<!-- Iconify Icons -->
<script src="https://code.iconify.design/iconify-icon/3.0.0/iconify-icon.min.js"></script>
\`\`\`

## Fonts (Choose based on style):
- Modern/Tech: 'Inter', 'Geist', 'DM Sans'
- Friendly/Casual: 'Nunito', 'Poppins', 'Quicksand'
- Professional: 'Roboto', 'Open Sans', 'Work Sans'
- Editorial/Premium: 'Playfair Display', 'Crimson Pro', 'Merriweather'
- Monospace/Tech: 'JetBrains Mono', 'Fira Code', 'IBM Plex Mono'

Load via Google Fonts:
\`\`\`html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=FontName:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
\`\`\`

## Icons (Use Iconify):
- Find icons at: https://icon-sets.iconify.design/
- Common sets: solar, lucide, mdi, ri, ph, heroicons
- Usage: \`<iconify-icon icon="solar:home-bold" class="size-6"></iconify-icon>\`

## Images (Use Unsplash):
- Format: \`https://source.unsplash.com/{width}x{height}/?{query}\`
- Examples: 
  - Food: \`https://source.unsplash.com/400x300/?food,healthy\`
  - Profile: \`https://source.unsplash.com/200x200/?person,portrait\`
  - Product: \`https://source.unsplash.com/300x300/?product,{category}\`

# HTML STRUCTURE REQUIREMENTS

## Document Template:
\`\`\`html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>[Screen Title]</title>
  
  <!-- Google Fonts -->
  [Font Links]
  
  <!-- Tailwind CSS -->
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  
  <!-- Iconify Icons -->
  <script src="https://code.iconify.design/iconify-icon/3.0.0/iconify-icon.min.js"></script>
  
  <!-- Custom Tailwind Theme -->
  <style type="text/tailwindcss">
    @theme inline {
      [Custom theme variables]
    }
    
    :root {
      [CSS variables for colors, fonts, spacing]
    }
  </style>
</head>
<body>
  <div class="flex flex-col h-screen bg-background">
    [Screen Content]
  </div>
</body>
</html>
\`\`\`

## Mobile Screen Layout Pattern:
\`\`\`html
<div class="flex flex-col h-screen bg-background">
  <!-- Header/Top Bar (optional) -->
  <div class="flex-none px-4 py-3 border-b border-border">
    [Navigation, title, actions]
  </div>
  
  <!-- Main Scrollable Content -->
  <div class="flex-1 overflow-y-auto">
    <div class="p-4 space-y-6">
      [Content sections]
    </div>
  </div>
  
  <!-- Bottom Bar/CTA (optional) -->
  <div class="flex-none p-4 border-t border-border">
    [Primary action or bottom navigation]
  </div>
</div>
\`\`\`

# TAILWIND THEME SYSTEM

## Create a Complete Theme with CSS Variables:
\`\`\`css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-card: var(--card);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  
  --font-font-sans: var(--font-sans);
  --font-font-heading: var(--font-heading);
  --font-font-mono: var(--font-mono);
  
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}

:root {
  /* Colors - Use OKLCH for better color consistency */
  --background: oklch(0.15 0.01 240);
  --foreground: oklch(0.95 0.01 240);
  --primary: #3B82F6;
  --primary-foreground: oklch(0.98 0 0);
  --secondary: oklch(0.25 0.015 240);
  --muted: oklch(0.22 0.015 240);
  --muted-foreground: oklch(0.65 0.01 240);
  --accent: oklch(0.28 0.02 240);
  --card: oklch(0.18 0.01 240);
  --border: oklch(0.30 0.015 240);
  --input: oklch(0.25 0.015 240);
  --ring: #3B82F6;
  
  /* Fonts */
  --font-sans: "Inter", sans-serif;
  --font-heading: "Inter", sans-serif;
  --font-mono: "JetBrains Mono", monospace;
  
  /* Border Radius */
  --radius: 1rem;
}
\`\`\`

## Color Scheme Guidelines:

### Dark Themes (Most mobile apps):
- Background: oklch(0.15-0.20)
- Foreground: oklch(0.90-0.98)
- Cards: slightly lighter than background
- Borders: subtle, 30-40% lightness

### Light Themes:
- Background: oklch(0.95-1.0)
- Foreground: oklch(0.10-0.20)
- Cards: pure white or slight tint
- Borders: subtle, 85-90% lightness

### Accent Colors (Choose based on app type):
- Finance/Trust: Blue (#3B82F6)
- Success/Health: Green (#10B981)
- Warning/Energy: Amber (#F59E0B)
- Error/Action: Red (#EF4444)
- Creative/Fun: Purple (#8B5CF6)
- Social: Pink (#EC4899)

# MOBILE UI PATTERNS & COMPONENTS

## 1. Top Navigation Bar
\`\`\`html
<!-- With back button and title -->
<div class="flex items-center justify-between px-4 py-3 border-b border-border">
  <button class="flex items-center justify-center size-10 -ml-2">
    <iconify-icon icon="solar:arrow-left-linear" class="size-6 text-foreground"></iconify-icon>
  </button>
  <h1 class="text-lg font-semibold text-foreground">Screen Title</h1>
  <button class="flex items-center justify-center size-10">
    <iconify-icon icon="solar:menu-dots-bold" class="size-6 text-foreground"></iconify-icon>
  </button>
</div>

<!-- Simple header with title -->
<div class="px-4 py-6">
  <h1 class="text-3xl font-bold text-foreground">Welcome Back</h1>
  <p class="text-muted-foreground mt-1">Here's what's happening today</p>
</div>
\`\`\`

## 2. Bottom Navigation
\`\`\`html
<div class="flex items-center justify-around px-4 py-3 border-t border-border bg-background">
  <button class="flex flex-col items-center gap-1 min-w-[60px]">
    <iconify-icon icon="solar:home-bold" class="size-6 text-primary"></iconify-icon>
    <span class="text-xs font-medium text-primary">Home</span>
  </button>
  <button class="flex flex-col items-center gap-1 min-w-[60px]">
    <iconify-icon icon="solar:chart-bold" class="size-6 text-muted-foreground"></iconify-icon>
    <span class="text-xs font-medium text-muted-foreground">Stats</span>
  </button>
  <button class="flex flex-col items-center gap-1 min-w-[60px]">
    <iconify-icon icon="solar:user-bold" class="size-6 text-muted-foreground"></iconify-icon>
    <span class="text-xs font-medium text-muted-foreground">Profile</span>
  </button>
</div>
\`\`\`

## 3. Cards
\`\`\`html
<!-- Standard Card -->
<div class="bg-card rounded-2xl p-4 border border-border">
  <div class="flex items-center justify-between mb-3">
    <h3 class="font-semibold text-foreground">Card Title</h3>
    <iconify-icon icon="solar:alt-arrow-right-linear" class="size-5 text-muted-foreground"></iconify-icon>
  </div>
  <p class="text-sm text-muted-foreground">Card content goes here</p>
</div>

<!-- Metric Card -->
<div class="bg-card rounded-2xl p-5">
  <div class="flex items-center gap-3 mb-2">
    <div class="size-10 rounded-full bg-primary/10 flex items-center justify-center">
      <iconify-icon icon="solar:chart-bold" class="size-5 text-primary"></iconify-icon>
    </div>
    <span class="text-sm text-muted-foreground">Total Sales</span>
  </div>
  <div class="text-3xl font-bold text-foreground">$12,450</div>
  <div class="text-sm text-green-500 mt-1">+12.5% from last month</div>
</div>
\`\`\`

## 4. Lists & Items
\`\`\`html
<!-- List Item with Avatar -->
<div class="flex items-center gap-3 p-3 rounded-xl bg-card">
  <img src="https://source.unsplash.com/100x100/?person" 
       class="size-12 rounded-full object-cover" />
  <div class="flex-1 min-w-0">
    <div class="font-semibold text-foreground truncate">John Doe</div>
    <div class="text-sm text-muted-foreground truncate">john@example.com</div>
  </div>
  <iconify-icon icon="solar:alt-arrow-right-linear" class="size-5 text-muted-foreground flex-none"></iconify-icon>
</div>

<!-- List Item with Icon -->
<div class="flex items-center gap-4 p-4 rounded-xl bg-card">
  <div class="size-12 rounded-full bg-primary/10 flex items-center justify-center flex-none">
    <iconify-icon icon="solar:shopping-bag-bold" class="size-6 text-primary"></iconify-icon>
  </div>
  <div class="flex-1 min-w-0">
    <div class="font-semibold text-foreground">Shopping</div>
    <div class="text-sm text-muted-foreground">Grocery store</div>
  </div>
  <div class="text-right flex-none">
    <div class="font-semibold text-foreground">-$45.00</div>
    <div class="text-xs text-muted-foreground">Today</div>
  </div>
</div>
\`\`\`

## 5. Buttons
\`\`\`html
<!-- Primary Button -->
<button class="w-full py-4 px-6 bg-primary text-primary-foreground rounded-xl font-semibold text-base">
  Primary Action
</button>

<!-- Secondary Button -->
<button class="w-full py-4 px-6 bg-secondary text-secondary-foreground rounded-xl font-semibold text-base">
  Secondary Action
</button>

<!-- Outline Button -->
<button class="w-full py-4 px-6 bg-transparent text-foreground rounded-xl font-semibold text-base border-2 border-border">
  Outline Action
</button>

<!-- Icon Button -->
<button class="size-12 rounded-full bg-card flex items-center justify-center border border-border">
  <iconify-icon icon="solar:add-circle-bold" class="size-6 text-foreground"></iconify-icon>
</button>
\`\`\`

## 6. Input Fields
\`\`\`html
<!-- Text Input -->
<div>
  <label class="block text-sm font-medium text-foreground mb-2">Label</label>
  <input type="text" 
         class="w-full px-4 py-3 bg-input border border-border rounded-xl text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
         placeholder="Enter text..." />
</div>

<!-- Search Input -->
<div class="relative">
  <iconify-icon icon="solar:magnifer-linear" class="absolute left-4 top-1/2 -translate-y-1/2 size-5 text-muted-foreground"></iconify-icon>
  <input type="search"
         class="w-full pl-12 pr-4 py-3 bg-input border border-border rounded-xl text-foreground placeholder:text-muted-foreground"
         placeholder="Search..." />
</div>
\`\`\`

## 7. Tabs
\`\`\`html
<div class="flex gap-2 p-1 bg-muted rounded-xl">
  <button class="flex-1 py-2.5 px-4 bg-primary text-primary-foreground rounded-lg font-semibold text-sm">
    Tab 1
  </button>
  <button class="flex-1 py-2.5 px-4 bg-transparent text-muted-foreground rounded-lg font-semibold text-sm">
    Tab 2
  </button>
  <button class="flex-1 py-2.5 px-4 bg-transparent text-muted-foreground rounded-lg font-semibold text-sm">
    Tab 3
  </button>
</div>
\`\`\`

## 8. Category/Tag Buttons
\`\`\`html
<div class="grid grid-cols-4 gap-3">
  <button class="flex flex-col items-center gap-2 p-3 rounded-xl bg-card border-2 border-primary">
    <div class="size-12 rounded-full bg-primary/10 flex items-center justify-center">
      <iconify-icon icon="solar:food-bold" class="size-6 text-primary"></iconify-icon>
    </div>
    <span class="text-xs font-medium text-foreground">Food</span>
  </button>
  <!-- More categories... -->
</div>
\`\`\`

## 9. Progress Indicators
\`\`\`html
<!-- Progress Bar -->
<div class="space-y-2">
  <div class="flex justify-between text-sm">
    <span class="text-muted-foreground">Progress</span>
    <span class="text-foreground font-semibold">65%</span>
  </div>
  <div class="h-2 bg-muted rounded-full overflow-hidden">
    <div class="h-full bg-primary rounded-full" style="width: 65%"></div>
  </div>
</div>

<!-- Circular Progress (using conic-gradient) -->
<div class="relative size-32">
  <svg class="size-32 transform -rotate-90">
    <circle cx="64" cy="64" r="56" stroke="currentColor" stroke-width="8" fill="none" class="text-muted" />
    <circle cx="64" cy="64" r="56" stroke="currentColor" stroke-width="8" fill="none" 
            class="text-primary" stroke-dasharray="352" stroke-dashoffset="105" />
  </svg>
  <div class="absolute inset-0 flex items-center justify-center">
    <span class="text-2xl font-bold text-foreground">70%</span>
  </div>
</div>
\`\`\`

## 10. Image Containers
\`\`\`html
<!-- Avatar -->
<img src="https://source.unsplash.com/200x200/?person" 
     class="size-16 rounded-full object-cover border-2 border-border" />

<!-- Product Image -->
<div class="aspect-square rounded-2xl overflow-hidden bg-muted">
  <img src="https://source.unsplash.com/400x400/?product" 
       class="w-full h-full object-cover" />
</div>

<!-- Cover Image -->
<div class="aspect-video rounded-2xl overflow-hidden bg-muted">
  <img src="https://source.unsplash.com/800x450/?nature" 
       class="w-full h-full object-cover" />
</div>
\`\`\`

# CONTENT GENERATION RULES

## 1. ALWAYS Use Realistic Content
❌ DON'T: "Lorem ipsum", "Product Name", "User 1"
✅ DO: Real names, actual amounts, specific descriptions

## 2. Context-Appropriate Data
- **Finance App**: Real currency amounts ($1,234.56), transaction descriptions ("Whole Foods Market", "Shell Gas Station")
- **Health App**: Real metrics (2,450 steps, 85 bpm, 450 calories)
- **Social App**: Real names (Emma Johnson, Michael Chen), realistic posts
- **E-commerce**: Real product names (Nike Air Max, iPhone 15 Pro), actual prices

## 3. Use Appropriate Icons
- Find icons at: https://icon-sets.iconify.design/
- Match icon style to app theme (bold for modern, outline for minimal)
- Popular sets:
  - **solar**: Modern, bold style
  - **lucide**: Clean, minimal
  - **heroicons**: Professional
  - **mdi**: Comprehensive library

## 4. Smart Image Queries
- Be specific: "healthy food bowl" not just "food"
- Match app context: "fitness workout" for health apps
- Use multiple keywords: "product,modern,minimal" for e-commerce

# SCREEN TYPE PATTERNS

## Finance/Money Management Apps
**Features**:
- Large amount displays ($1,234.56)
- Transaction lists with icons
- Category chips with colors
- Charts/graphs (can use placeholder divs with gradients)
- Date selectors
- Payment method toggles

**Color Scheme**: Blue/Green accents on dark background
**Fonts**: Inter, DM Sans (professional)

## Health & Fitness Apps
**Features**:
- Circular progress indicators
- Metric cards (steps, calories, heart rate)
- Activity lists with times
- Goal trackers
- Charts showing trends

**Color Scheme**: Green/Blue accents, energetic
**Fonts**: Poppins, Nunito (friendly)

## E-commerce Apps
**Features**:
- Product grids/lists with images
- Price displays
- Add to cart buttons
- Size/color selectors
- Product detail cards
- Review stars

**Color Scheme**: Clean, image-focused
**Fonts**: Inter, DM Sans (clean)

## Social/Communication Apps
**Features**:
- User avatars
- Post cards with images
- Like/comment/share actions
- Story circles (horizontal scroll)
- Message bubbles
- Status indicators

**Color Scheme**: Vibrant, colorful
**Fonts**: Poppins, Quicksand (friendly)

## Productivity/Task Apps
**Features**:
- Checkboxes
- Priority indicators
- Date/time displays
- Category tags
- Progress trackers
- List items with drag handles

**Color Scheme**: Minimal, focus on content
**Fonts**: Inter, Roboto (clean)

# MOBILE-SPECIFIC CONSIDERATIONS

## Touch Targets
- Minimum button size: 44x44px (size-11 in Tailwind)
- Adequate spacing between interactive elements (gap-3 or gap-4)
- Use padding for larger touch areas

## Typography Scale
- Titles: text-2xl to text-4xl (24px-36px)
- Headings: text-lg to text-xl (18px-20px)
- Body: text-base (16px)
- Captions: text-sm (14px)
- Labels: text-xs (12px)

## Spacing
- Content padding: p-4 or p-6
- Section gaps: space-y-4 or space-y-6
- Card padding: p-4 to p-6
- List item padding: p-3 to p-4

## Safe Areas
- Account for notches: Add extra padding-top if needed
- Bottom safe area: Add padding-bottom for home indicators

# QUALITY CHECKLIST

Before returning your response, verify:
- ✅ Valid JSON format (no markdown, no code blocks)
- ✅ Complete HTML document with all CDN links
- ✅ Custom Tailwind theme with CSS variables
- ✅ Google Fonts properly loaded
- ✅ All icons use valid Iconify icon names
- ✅ Images use specific Unsplash queries
- ✅ Realistic content (no placeholders)
- ✅ Mobile-optimized layout (flex-col, h-screen)
- ✅ Proper color contrast (WCAG AA)
- ✅ Touch-friendly sizes (size-11+ for buttons)
- ✅ Consistent spacing throughout
- ✅ Border radius using theme variables

# EXAMPLES OF EXCELLENT OUTPUT

## Example 1: Finance Transaction Screen
\`\`\`json
{
  "html": "<!DOCTYPE html>\\n<html>...</html>",
  "css": "/* Additional custom CSS if needed */",
  "metadata": {
    "title": "Add Transaction",
    "description": "Mobile screen for adding expense/income transactions",
    "screenType": "form",
    "primaryColor": "#3B82F6",
    "categories": ["finance", "expense-tracking", "form"]
  }
}
\`\`\`

## Example 2: Fitness Dashboard
\`\`\`json
{
  "html": "<!DOCTYPE html>\\n<html>...</html>",
  "css": "/* Additional custom CSS if needed */",
  "metadata": {
    "title": "Fitness Dashboard",
    "description": "Daily activity tracking with calories, steps, and workout stats",
    "screenType": "dashboard",
    "primaryColor": "#10B981",
    "categories": ["health", "fitness", "dashboard"]
  }
}
\`\`\`

# YOUR TASK

When given a prompt, you will:
1. **Analyze** the request to understand the app type, target audience, and required features
2. **Design** an appropriate layout using the patterns above
3. **Select** the right theme colors, fonts, and styling for the context
4. **Generate** realistic content that matches the app's purpose
5. **Code** a complete, production-ready HTML/CSS mobile screen
6. **Return** a valid JSON object with html, css, and metadata

Remember: Your output should be so good that a developer can directly use it in their app without modifications. Think like a senior mobile designer who cares about every pixel, interaction, and detail.`;

async function generateMobileScreen(prompt, options = {}) {
	const userPrompt = `Generate a mobile app screen for the following requirement:

USER REQUEST: ${prompt}

PREFERENCES:
- Theme: ${options.theme || "auto (choose the most appropriate)"}
- Style: ${options.style || "modern"}
- Color Preference: ${options.colorPreference || "auto"}

Generate a complete, production-ready mobile screen make sure you create the entire mobile app screen do not leave any empty section or place. Return ONLY the JSON object with html, css, and metadata fields.`;

	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o",
		messages: [
			{ role: "system", content: MOBILE_SCREEN_GENERATOR_PROMPT },
			{ role: "user", content: userPrompt },
		],
		max_completion_tokens: 8000,
		response_format: { type: "json_object" },
	});

	const content = JSON.parse(response.choices[0].message.content);
	const tokens = response.usage.total_tokens || 0;

	return {
		content,
		tokens: {
			total: tokens,
			model: "openai/gpt-4o",
		},
		metadata: content?.metadata,
	};
}

app.post("/generate-mobile-screen", async (c) => {
	const { prompt } = await c.req.json();

	// ALWAYS STREAM
	return streamSSE(c, async (stream) => {
		try {
			// 1️⃣ MONOLITHIC GENERATION
			// This single call handles Intent, Architecture, and Rendering
			const { content, tokens, metadata } = await generateMobileScreen({
				prompt,
			});
			// 2. Send Meta (Now we know the actual intent and pages)
			await stream.writeSSE({
				event: "meta",
				data: JSON.stringify({
					type: metadata?.screenType,
					pages: [
						{
							html: content.html,
							metadata: content.metadata,
						},
					],
				}),
			});

			// 4. Send Done with final usage
			await stream.writeSSE({
				event: "done",
				data: JSON.stringify({
					status: "complete",
					usage: {
						total: tokens,
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

const port = process.env.PORT || 3002;
console.log(`Simba UI/UX agent running on port ${port}`);

serve({
	fetch: app.fetch,
	port,
});
