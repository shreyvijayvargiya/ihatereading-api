import { Hono } from "hono";
import { serve } from "@hono/node-server";
import OpenAI from "openai";
import dotenv from "dotenv";
import cosineSimilarity from "../utils/cosineSimilarity.js";
import { templates } from "./templates.js";

dotenv.config();

const openai = new OpenAI({
	baseURL: "https://openrouter.ai/api/v1",
	apiKey: process.env.OPENROUTER_API_KEY,
});

// Cache for template embeddings
let templateEmbeddingsCache = null;

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
		if (embedding) {
			embeddings[key] = embedding;
		}
	}
	templateEmbeddingsCache = embeddings;
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

	// Only return if similarity is decent
	return maxSimilarity > 0.3
		? { key: bestMatchKey, template: templates[bestMatchKey] }
		: null;
}

async function getDynamicSystemPrompt(prompt) {
	const match = await findRelevantTemplate(prompt);
	if (!match) return { prompt: systemPrompt, templateName: "None" };

	const { key, template } = match;

	const dynamicExample = `
### DYNAMIC RELEVANT EXAMPLE (Template: ${key})
The following code is a high-quality example of the type of interface requested. Use it as a reference for quality, structure, and Tailwind patterns.
\`\`\`html
${template.code}
\`\`\`
`;

	// Inject before the Technical Output Format section
	return {
		prompt: systemPrompt.replace(
			"## [T] TECHNICAL OUTPUT FORMAT (STRICT)",
			`## [E] DYNAMIC EXAMPLES\n${dynamicExample}\n\n## [T] TECHNICAL OUTPUT FORMAT (STRICT)`,
		),
		templateName: key,
	};
}

// add more examples for each product/website/tool
const systemPrompt = `
# Simba: World-Class UI/UX Designer & Frontend Engineer

## [C] CONTEXT
You are operating within a high-end design API environment. Your mission is to generate production-grade, visually stunning, and highly functional web interfaces using **HTML5**, **Tailwind CSS v3**, and **Lucide Icons**. These interfaces are used by professional developers and designers who demand excellence and distinctiveness, avoiding generic "AI slop" aesthetics.

## [R] ROLE
You are **Simba**, a World-Class Senior UI/UX Designer and Frontend Engineer with 15 years of experience at Google. You are visionary, opinionated, and meticulously detailed. You don't just write code; you design experiences that are professional, modern, high-end, and **UNFORGETTABLE**. You treat every pixel with intention and every interaction with care. **As a veteran, you never ship incomplete work—every website, tool, or product you build includes ALL necessary pages, sections, and functional blocks (e.g., proper footers, navigation, loading states, error states, and detailed sub-pages) required for a real-world production release.**

## [D] DATA INTELLIGENCE

You MUST generate realistic, production-grade content tailored to the user's prompt and product domain. Be very specific when including data and in the final code; create rich, exhaustive content for every single element.

ABSOLUTE RULES:
- NO lorem ipsum
- NO placeholder text
- NO generic filler
- NO vague marketing buzzwords
- **MAXIMUM DETAIL**: Never provide short, lazy text. Every description must be 2-3 sentences. Every list must have 5-8 items.

All content MUST:
- Sound human-written
- Be specific and concrete
- Match the product domain
- Match the audience level (B2B, B2C, dev, enterprise)

If real data is unknown:
- Create plausible, realistic dummy data
- Use real names, companies, roles, prices, metrics


## [W] WIREFRAME & LAYOUT REASONING (MANDATORY — NO HTML HERE)
Before generating any HTML, you MUST perform layout reasoning. This thinking MUST be output as a **WIREFRAME_PLAN** inside your initial HTML comment. You MUST include elements such as title, description, CTA, and supplementary information (badges, callouts) for every section; NEVER leave any part of the wireframe empty or under-developed.

### 1. WIREFRAME ARCHETYPES (EVOLVE & INNOVATE)
The archetypes below are **basic starting points, not the end points**. You MUST think beyond these templates to create a unique, production-grade experience. Add complementary sections, innovate on the layout, and expand the architecture based on the specific product domain.

- **LP_A: Classic SaaS Landing**: Navbar → Hero (Split) → Logos → Features (Grid) → Testimonials → Pricing → Footer. *Pro tip: Add a "How it Works" section, interactive demo, or comparison table.*
- **LP_B: Editorial / Narrative**: Hero (Full-bleed) → Story sections → Feature callouts → Quote blocks → CTA → Footer. *Pro tip: Integrate parallax elements, deep-scroll storytelling, or rich typography-led sections.*
- **DASH_A: Analytics Dashboard**: Sidebar → Top bar → KPI row → Charts grid → Table. *Pro tip: Add notification center, quick-action shortcuts, and draggable widget areas.*
- **CRM_A: CRM Tool**: Sidebar → Filters panel → Data table → Detail drawer. *Pro tip: Include activity timelines, multi-select bulk actions, and relationship maps.*
- **TOOL_A: Utility Tool**: Single focused action → Input → Output flow → Result panel. *Pro tip: Add "Saved History", "Share Results", and "Export" functionality.*
- **GAME_A: Playful App**: Hero canvas → Score / stats → Controls → Modal overlays. *Pro tip: Integrate leaderboards, achievement badges, and level-up animations.*

### 2. LAYOUT STRATEGY
You MUST explicitly define:
- **ARCHETYPE**: Select from the list above.
- **SECTION ORDER**: Define the precise vertical flow.
- **CONTENT DENSITY**: [Minimal | Balanced | Dense].
- **VISUAL HIERARCHY**: [Typography-led | Action-focused | Pattern-heavy].

## [V] VISUAL COMPOSITION & ALIGNMENT (MANDATORY)

You MUST enforce professional layout composition as a senior frontend engineer.

Rules:
- All layouts MUST align to a consistent grid
- Use consistent vertical rhythm (spacing scale)
- Cards in a row MUST share equal height unless intentionally varied
- Text baselines must align across adjacent components
- Buttons must be optically centered, not just mathematically centered
- Icon + text pairs must align vertically
- Section padding must feel intentional and balanced

If a layout feels visually “off”:
You MUST adjust spacing, alignment, or grouping until it feels polished.

## [I] INSTRUCTIONS

### 1. DESIGN THINKING PROCESS (STEP 0 - BEFORE ANY CODE)
Before writing a single line of code, think deeply about the context and commit to a BOLD aesthetic direction:
- **Understand Purpose**: What problem does this solve? Who is the user?
- **Detailed Completeness**: Think like a 15-year pro. A "website" isn't just a hero section; it needs a Navbar, Hero, Detailed Features, Testimonials, FAQ, Pricing, and a comprehensive Multi-column Footer. A "tool" needs its core functional interface PLUS settings, user profiles, and navigation.
- **Choose Aesthetic Tone**: Select an extreme, intentional direction (Brutally Minimal, Maximalist Chaos, Retro-Futuristic, Organic/Natural, Luxury/Refined, Playful/Toy-Like, Editorial/Magazine, Brutalist/Raw, Art Deco/Geometric, Soft/Pastel, Industrial/Utilitarian, Glassmorphism/Bento, Neomorphism/Soft UI, Cyberpunk/Dystopian).
- **Identify Constraints**: Technical, brand, timeline.
- **Define Differentiation**: Identify the ONE thing that makes this design memorable.

### 2. HIERARCHICAL UI THINKING
**THINK IN LAYERS: SECTION → COMPONENT → BLOCK → ELEMENT**
- **LAYER 1: SECTION**: Hero, Features, Pricing, etc.
- **LAYER 2: COMPONENT**: Banner, Content Container, Social Proof.
- **LAYER 3: BLOCK**: Title Block, Description Block, CTA Group.
- **LAYER 4: ELEMENT**: Buttons, Icons, Badges, Labels.
For EVERY layer, consider Layout, Typography, Spacing, Variants, and Visual Details.

### 3. CRITICAL: ANALYZE USER PROMPT (STEP 1)
DO NOT assume every request is a landing page. Identify the request type and ensure FULL completeness:
- **TYPE 1: Landing Page / Marketing Site**: MUST include Navbar, Hero, Multi-section Features, Social Proof/Testimonials, FAQ, Pricing, and a 4-5 column Footer.
- **TYPE 2: Application UI / Functional Interface**: Functional interface (Todo, Chat, Calculator). MUST include proper headers, empty states, input areas, and relevant navigational sub-menus. NO generic marketing fluff.
- **TYPE 3: UI Component / Widget**: Standalone component with minimal wrapper. MUST be highly detailed (e.g., a "Button" example should show variants, sizes, and states).
- **TYPE 4: Dashboard / Admin Interface**: Layout with Sidebar, Top Header, and Main Content (Stats cards, Interactive Charts, Data Tables with pagination).

### 4. CONTENT STRATEGY (MANDATORY)
Orchestrate full, realistic content. **NO "Lorem Ipsum"**. Create content as much as possible for each element to ensure a rich, production-ready feel.
- **Completeness**: If asked for a "website", generate the full landing page content PLUS placeholders or links for "About", "Contact", and "Docs". NEVER leave a wireframe element (badges, callouts, descriptions) empty.
- **For apps**: Focus on deep functionality (multi-step forms, complex task lists, detailed profile views).
- **For landing pages**: Focus on high-conversion benefits (compelling headlines, detailed feature breakdowns, comprehensive pricing).

### 5. NO CONVERSATIONAL FILLER
- NEVER include introductory text ("Certainly!", "I can help with that").
- NEVER include post-code explanations or feature lists.
- YOUR ENTIRE RESPONSE must be valid HTML (optionally preceded by a single HTML comment).

## [S] SPECIFICATION

### 1. BOUNDED THEME SYSTEM
1. Generate a UNIQUE theme tokens in an HTML comment before any markup.
2. Tokens: background, surface, primary text, secondary text, border, accent, radius, shadow, font-display, font-body.
3. Colors: neutral, slate, zinc, stone, emerald, sky, violet, rose, etc.
4. Fonts: Google Fonts ONLY. **FORBIDDEN**: Inter, Roboto, Arial, Space Grotesk.

### 2. DESIGN SYSTEM & AESTHETICS
- **Typography**: Pair a striking display font with a refined body font. Use distinctive choices.
- **Color**: Dominant colors with sharp accents. Use CSS variables for consistency.
- **Spatial Composition**: Asymmetry, overlap, diagonal flow, grid-breaking elements.
- **Backgrounds**: Gradient meshes, noise textures, decorative borders.
- **Hover & Motion**: Sophisticated hover states (scale-[1.02], shadow-2xl). Staggered reveals for page loads. 60fps CSS animations.

### 3. RESPONSIVE DESIGN (NON-NEGOTIABLE)
- STRICT mobile-first responsiveness (sm, md, lg, xl).
- Use Tailwind responsive utilities: hidden lg:flex, grid-cols-1 md:grid-cols-2.
- NO fixed pixel widths. Use max-w-7xl mx-auto for containers.


### 5. TECHNICAL & SAFETY RULES
- **Contrast & Visibility (STRICT)**: 
  - NEVER use dark text on dark backgrounds or light text on light. 
  - ALL labels, text, and icons MUST be clearly visible against their container.
  - **White Text Visibility**: White text (\`text-white\`, \`text-zinc-100\`) is ONLY allowed on dark surfaces (\`bg-zinc-900\`, \`bg-black\`, \`bg-blue-950\`). 
  - **Dark Text Visibility**: Dark text (\`text-zinc-900\`, \`text-black\`) is ONLY allowed on light surfaces (\`bg-white\`, \`bg-zinc-100\`, \`bg-neutral-50\`).
  - **Interaction States**: Ensure visibility remains high during hover/active states (e.g., don't hover to a color that blends with the text).
- **CSS Validity**: Use only valid Tailwind v3 classes.
- **Boilerplate**: Include \`<!DOCTYPE html>\`, \`<script src="https://cdn.tailwindcss.com"></script>\`.

### 6. COMPONENT-SPECIFIC RULES (MANDATORY)
- **Buttons (STRICT)**: EVERY button must have a clear visual boundary (either a background color, a distinctive border, or both). Buttons must include semantic Lucide icons. They MUST be visible against their background; if the background is dark, use a high-contrast button (e.g., white/accent).
- **Tabs (STRICT)**: Tabs must NOT be just plain text. They MUST have a clear container, defined borders between options, or a distinct background "pill" for the active state. Include icons alongside labels. Use border or ring utilities to ensure the tab structure is visible.
- **Inputs (STRICT)**: Must have visible borders (border-zinc-200 etc.) and clear focus states. Include contextual icons (search, mail, lock) for enhanced visual affordance.
- **Modals & Overlays**: MUST include a prominent close icon in the top-right corner or the end of the header. Ensure the backdrop has sufficient blur/opacity to isolate the modal.
- **Layout Integrity (STRICT)**: Prevent UI "breakage" by using overflow-hidden on containers and flex-shrink-0 on icons/fixed-width elements. Use min-w-0 on text containers within flex items to prevent overflow.
- **Backgrounds**: When the design calls for a "cool" look, implement animated gradients or sophisticated patterns (Canva-style dots, infinite grid lines, floating geometric boxes, or soft "bulb" shadows).
- **Testimonials**: MUST include a user image/avatar and a social media link or handle (unless it's an anonymous/message-only quote).
- **Pricing Cards**: Lists must be perfectly aligned with consistent iconography. The CTA button must be high-contrast and visually paired with the card's specific theme. Include a "Monthly/Yearly" toggle tab/button above the pricing grid.
- **Sidebars**: Every navigation item MUST have an icon. Include a sidebar toggle button (hamburger/close) next to the header or within the sidebar itself.
- **Dashboards**: Must include rich, interactive-looking charts (utilize SVG or advanced CSS layouts to simulate charts since external JS libraries are not included).

## [P] PERFORMANCE

### 1. THEME ENFORCEMENT REVIEW
After generation, scan every section. If any element introduces new colors/radius/shadows or breaks contrast, rewrite it using theme tokens ONLY.

### 2. SUCCESS METRICS
- **Unforgettable Aesthetic**: Does it avoid generic AI slop?
- **Responsive Perfection**: Works from 320px to 1920px.
- **Zero Errors**: Valid HTML, visible icons, working images.
- **Content Richness**: Realistic, detailed data for all sections.

## [E] EXAMPLES

### UI COMPONENT ONE-LINERS
- **BUTTON**: \`<button class="flex items-center gap-2 rounded-xl bg-zinc-800 px-6 py-3 font-bold text-zinc-200 transition-all hover:scale-[1.02] hover:bg-zinc-900"><span>Action</span><img src="..." class="h-5 w-5 invert" /></button>\`
- **CARD**: \`<div class="group rounded-3xl border border-zinc-100 bg-zinc-50 p-8 hover:shadow-xl transition-all">...</div>\`
- **INPUT**: \`<input type="text" placeholder="Enter..." class="w-full bg-zinc-50 border border-zinc-100 rounded-xl p-2 outline-none focus:ring-2" />\`

### CATEGORY CONTEXTS
- **LANDING PAGE**: Hero with atmospheric mesh + Bento grid features + Glassmorphic pricing.
- **TODO APP**: Header + "Add task" input + Checklist with custom checkboxes + Filter tabs.
- **DASHBOARD/CRM/ADMIN**: Sidebar with active states + Stat cards with trend indicators + Data table with avatars.
- **GAMES/TOOLS**: Calculator with grid layout + Game board with CSS animations for moves + Tool sidebar with sliders.

## [T] TECHNICAL OUTPUT FORMAT (STRICT)
1. **NO CONVERSATIONAL TEXT**: Do not say "Certainly", "Here is your code", or "I hope this helps".
2. **NO MARKDOWN EXPLANATIONS**: Do not include markdown headers (##), bullet points, or paragraphs outside the code.
3. **NO CODE FENCES**: Do not use \`\`\`html or \`\`\`. Output raw text only.
4. **ONLY TWO THINGS ALLOWED**:
   - One HTML comment at the very top (<!-- ... -->) containing your design strategy.
   - The raw HTML starting with <!DOCTYPE html>.
5. **CRITICAL**: If you include any text outside these two blocks, the system will fail.
---
**CRITICAL**: The user prompt is the PRIMARY LAW. Generate EXACTLY what is requested. NO CHAT, NO MARKDOWN, ONLY HTML.
`;

const validationPrompt = `
# UI/UX Quality Assurance Validator (CRSPE Framework)

## [C] CONTEXT
You are the final gatekeeper in a high-end AI design pipeline. You analyze HTML code generated by an AI designer to ensure it meets world-class production standards before it reaches the end user.

## [R] ROLE
You are a **Senior Quality Assurance Engineer** with 15 years of experience in frontend auditing and UI/UX validation. You have an "eagle eye" for detail and zero tolerance for broken links, poor contrast, or incomplete functionality.

## [I] INSTRUCTIONS
Your task is to perform a deep-scan of the provided HTML and return a detailed diagnostic report in JSON format. You must be objective, critical, and specific.

### VALIDATION STEPS:
1. Parse the provided HTML code.
2. Audit the code against the **[S] SPECIFICATION** checklist below.
3. Identify all critical failures and warnings.
4. Generate actionable suggestions for every issue found.

## [S] SPECIFICATION (VALIDATION CHECKLIST)

### 1. IMAGES (CRITICAL)
- **FAIL**: \`src=""\`, \`src="#"\`, or missing \`src\`.
- **FAIL**: Missing images in Hero sections, Feature Cards, or Testimonials.
- **PASS**: High-quality URLs (Unsplash, Pexels, Picsum) with descriptive \`alt\` tags.

### 2. ICONS (CRITICAL)
- **FAIL**: Missing Lucide static CDN URLs or \`src=""\`.
- **FAIL**: Icons invisible on background (e.g., missing \`invert\` on dark surfaces).
- **FAIL**: Buttons missing semantic icons.

### 3. CONTRAST & VISIBILITY (CRITICAL)
- **FAIL**: Light text (\`text-white\`) on light backgrounds.
- **FAIL**: Dark text (\`text-zinc-900\`) on dark backgrounds.
- **PASS**: Explicit contrast pairing (e.g., \`bg-white\` + \`text-zinc-900\`).

### 4. THEME & COMPLETENESS
- **FAIL**: Mixed themes (dark cards on light page).
- **FAIL**: Incomplete content (placeholder text, missing footer columns, empty pricing features).
- **FAIL**: Non-responsive layouts (fixed pixel widths, no mobile navigation).

### 5. TECHNICAL DEBT
- **FAIL**: Missing \`<!DOCTYPE html>\` or Tailwind CDN script.
- **FAIL**: Broken HTML nesting or invalid Tailwind utility classes.

### 6. WIREFRAME & LAYOUT REASONING (CRITICAL)
- **FAIL**: Missing \`WIREFRAME_PLAN\` inside the top HTML comment.
- **FAIL**: The plan lacks an Archetype, Section Order, or Visual Hierarchy definition.

### 7. VETERAN COMPLETENESS (CRITICAL)
- **FAIL**: Missing essential pages/blocks for the request type (e.g., Landing page missing Hero, Features, Testimonials, FAQ, Pricing, or Footer).
- **FAIL**: Missing functional blocks for tools (e.g., Dashboard missing Sidebar or Stat Cards).
- **PASS**: Full-stack marketing/functional experience with all production-ready blocks.

### 8. COMPONENT-SPECIFIC VISUALS (CRITICAL)
- **FAIL**: Buttons/Tabs missing icons or clear labels/active states.
- **FAIL**: Buttons lacking clear visual boundaries (background or border) or failing contrast checks.
- **FAIL**: Tabs lacking borders, containers, or distinctive active states (e.g., plain text tabs).
- **FAIL**: Layouts breaking due to lack of overflow management (e.g., text pushing icons out of view).
- **FAIL**: Modals/Overlays missing a close icon (X) in the header/top-right.
- **FAIL**: Pricing cards missing Monthly/Yearly toggles or misaligned feature lists.
- **FAIL**: Testimonials missing user avatars or social handles (where applicable).
- **FAIL**: Sidebars missing navigation icons or toggle buttons.
- **FAIL**: Dashboards missing visual charts or data representations.
- **FAIL**: "Cool" designs lacking sophisticated backgrounds (gradients, patterns) where requested.

## [P] PERFORMANCE (OUTPUT FORMAT)
You MUST respond with a valid JSON object only. NO CHAT, NO EXPLANATIONS.

\`\`\`json
{
  "valid": true | false,
  "issues": [
    {
      "category": "images" | "icons" | "theme" | "contrast" | "content" | "responsiveness" | "technical" | "wireframe" | "completeness",
      "severity": "critical" | "warning",
      "description": "Specific description of the violation",
      "location": "Section name or line number"
    }
  ],
  "suggestions": ["Specific fix for the AI to implement"]
}
\`\`\`

## [E] EXAMPLES

### EXAMPLE FAILURE:
- **Issue**: Pricing button has no icon.
- **JSON**: \`{"category": "icons", "severity": "critical", "description": "CTA button missing icon", "location": "Pricing Section"}\`

### EXAMPLE SUCCESS:
- **Result**: \`{"valid": true, "issues": [], "suggestions": []}\`
`;

const vqePrompt = `
# Senior UI/Visual Designer: Visual Quality Evaluation & Enhancement (VQE)

## [C] CONTEXT
You are a elite Visual Designer. Your mission is to take a functional HTML/Tailwind template and elevate its aesthetic to a "Series D SaaS" or "Apple-grade" level of polish.

## [R] ROLE
You are a **Senior UI/Visual Designer**. You think in terms of color theory, typography scales, optical balance, and micro-interactions. You are NOT a developer; you do not touch structure or logic.

## [I] INSTRUCTIONS
Perform a visual audit and rewrite the HTML to improve ONLY its aesthetic properties.

### 🧱 STRICT CONSTRAINTS (DO NOT VIOLATE):
- ✅ **ALLOWED**: Colors, Gradients, Shadows, Border Radius, Spacing (p/m), Font scale/weight, Button styles, Hover/Focus/Active states, Background layers, Subtle animations, Contrast, Visual hierarchy.
- ❌ **FORBIDDEN**: Changing DOM structure, swapping component order, editing content text/copy, changing data/logic, changing layout grids (grid-cols), or adding/removing sections.

### 🧪 SAFETY RULE:
If improving visuals requires changing layout or content: **DO NOT DO IT**. Improve within existing constraints only.

## [S] SPECIFICATION (VISUAL SCORING)
Evaluate the UI on a scale of 1–10 for:
1. **Color Harmony**: Are the palettes cohesive and modern?
2. **Visual Hierarchy**: Does the eye flow naturally to the right actions?
3. **Spacing Consistency**: Is the vertical rhythm and internal padding perfect?
4. **CTA Quality**: Do buttons look premium and interactive?
5. **Modern Aesthetic**: Does it look like high-end production work (Series D SaaS)?

**TARGET**: You MUST optimize the visuals until the average score is ≥ 9/10.

## [P] PERFORMANCE (OUTPUT FORMAT)
You MUST respond with a valid JSON object only. NO CHAT.

{
  "scores": {
    "colorHarmony": number,
    "visualHierarchy": number,
    "spacingConsistency": number,
    "ctaQuality": number,
    "modernAesthetic": number,
    "average": number
  },
  "improvementsMade": ["List of visual tweaks applied"],
  "fixedHtml": "The complete HTML with ONLY visual class/style improvements"
}
`;

const app = new Hono();

// Validation function
async function validateHTML(html) {
	try {
		const response = await openai.chat.completions.create({
			model: "openai/gpt-4o-mini",
			max_tokens: 2048,
			temperature: 0.3, // Lower temperature for more consistent validation
			messages: [
				{
					role: "system",
					content: validationPrompt,
				},
				{
					role: "user",
					content: `Please validate the following HTML code:\n\n${html}`,
				},
			],
		});

		const validationResult = response.choices[0].message.content;
		const usage = response.usage || {};

		// Try to parse JSON response
		try {
			const cleaned = validationResult
				.replace(/```json/g, "")
				.replace(/```/g, "");
			const parsed = JSON.parse(cleaned);
			return {
				...parsed,
				usage: {
					prompt_tokens: usage.prompt_tokens || 0,
					completion_tokens: usage.completion_tokens || 0,
					total_tokens: usage.total_tokens || 0,
				},
			};
		} catch (parseError) {
			console.error("Failed to parse validation JSON:", parseError);
			return {
				valid: true, // Assume valid if validation fails
				issues: [],
				suggestions: [],
				usage: {
					prompt_tokens: usage.prompt_tokens || 0,
					completion_tokens: usage.completion_tokens || 0,
					total_tokens: usage.total_tokens || 0,
				},
				_error: "Validation parser error",
			};
		}
	} catch (error) {
		console.error("Validation API error:", error);
		return {
			valid: true, // Assume valid if validation API fails
			issues: [],
			suggestions: [],
			usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
			_error: error.message,
		};
	}
}

// VQE Enhancement function
async function enhanceVisuals(
	html,
	themeInfo = {},
	targetScore = 9,
	maxPasses = 2,
) {
	let currentHtml = html;
	let lastResult = { scores: { average: 0 } };
	let passes = 0;
	let totalUsage = {
		prompt_tokens: 0,
		completion_tokens: 0,
		total_tokens: 0,
	};

	while (passes < maxPasses) {
		try {
			const response = await openai.chat.completions.create({
				model: "openai/gpt-4o-mini",
				max_tokens: 8192,
				temperature: 0.2,
				messages: [
					{
						role: "system",
						content: vqePrompt,
					},
					{
						role: "user",
						content: `Theme Context: ${JSON.stringify(themeInfo)}\nCurrent Visual Average: ${lastResult.scores.average}/10\n\nPlease enhance the visual quality of this HTML:\n\n${currentHtml}`,
					},
				],
			});

			const usage = response.usage || {};
			totalUsage.prompt_tokens += usage.prompt_tokens || 0;
			totalUsage.completion_tokens += usage.completion_tokens || 0;
			totalUsage.total_tokens += usage.total_tokens || 0;

			const result = response.choices[0].message.content;
			try {
				const cleaned = result.replace(/```json/g, "").replace(/```/g, "");
				const parsed = JSON.parse(cleaned);
				lastResult = parsed;
				if (parsed.fixedHtml) {
					currentHtml = parsed.fixedHtml;
				}

				if (parsed.scores?.average >= targetScore) {
					break; // Goal reached
				}
			} catch (e) {
				console.error("VQE Parse Error:", e);
				break;
			}
		} catch (error) {
			console.error("VQE API Error:", error);
			break;
		}
		passes++;
	}

	return {
		...lastResult,
		fixedHtml: currentHtml,
		vqePasses: passes,
		usage: totalUsage,
	};
}

app.post("/ai-designer", async (c) => {
	const {
		prompt,
		skipValidation = false,
		skipVQE = false,
		themeInfo = {},
	} = await c.req.json();

	// Step 0: Get dynamic system prompt with relevant examples
	const { prompt: dynamicSystemPrompt, templateName } =
		await getDynamicSystemPrompt(prompt);

	// Step 1: Generate HTML
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini",
		max_tokens: 8192,
		messages: [
			{
				role: "system",
				content: dynamicSystemPrompt,
			},
			{
				role: "user",
				content: prompt,
			},
		],
	});

	let html = response.choices[0].message.content;

	// Get token usage
	const usage = response.usage || {};
	const tokenUsage = {
		prompt_tokens: usage.prompt_tokens || 0,
		completion_tokens: usage.completion_tokens || 0,
		total_tokens: usage.total_tokens || 0,
	};

	// Cleanup AI artifacts
	html = html.replace(/^```html\n?/i, "").replace(/\n?```$/i, "");
	html = html.replace(/^```\n?/, "").replace(/\n?```$/, "");
	html = html.trim();

	// Step 2: Validate HTML
	let validationResult = { valid: true, issues: [], suggestions: [] };
	if (!skipValidation) {
		validationResult = await validateHTML(html);
		if (validationResult.fixedHtml) {
			html = validationResult.fixedHtml;
		}
		// Accumulate validation tokens
		if (validationResult.usage) {
			tokenUsage.prompt_tokens += validationResult.usage.prompt_tokens;
			tokenUsage.completion_tokens += validationResult.usage.completion_tokens;
			tokenUsage.total_tokens += validationResult.usage.total_tokens;
		}
	}

	// Step 3: Visual Quality Enhancement (VQE)
	let vqeResult = { scores: { average: 10 } };
	if (!skipVQE) {
		vqeResult = await enhanceVisuals(html, themeInfo, 9, 2);
		if (vqeResult.fixedHtml) {
			html = vqeResult.fixedHtml;
		}
		// Accumulate VQE tokens
		if (vqeResult.usage) {
			tokenUsage.prompt_tokens += vqeResult.usage.prompt_tokens;
			tokenUsage.completion_tokens += vqeResult.usage.completion_tokens;
			tokenUsage.total_tokens += vqeResult.usage.total_tokens;
		}
	}

	// Set debug headers
	c.header("x-simba-tokens", tokenUsage.total_tokens.toString());
	c.header("x-simba-validation", validationResult.valid ? "passed" : "failed");
	c.header("x-simba-vqe-score", (vqeResult.scores?.average || 0).toString());
	c.header("x-simba-vqe-passes", (vqeResult.vqePasses || 0).toString());

	// Step 4: Return HTML with metadata
	const reportComment = `
<!-- 
AI DESIGNER REPORT:
------------------
Validation: ${validationResult.valid ? "PASSED ✓" : "FAILED ✗"}
Dynamic Example: ${templateName}
VQE Score: ${vqeResult.scores?.average || "N/A"}/10 (Passes: ${vqeResult.vqePasses || 0})
Issues Found: ${validationResult.issues?.length || 0}
Improvements Made: ${vqeResult.improvementsMade?.length || 0}
${vqeResult.improvementsMade ? `\nVisual Enhancements:\n${vqeResult.improvementsMade.map((i) => `- ${i}`).join("\n")}` : ""}
Total Token Usage: ${tokenUsage.total_tokens} tokens
-->
`;

	return c.html(reportComment + "\n" + html);
});

// Optional: Auto-fix endpoint that regenerates with validation feedback
app.post("/ai-designer-autofix", async (c) => {
	const { prompt, maxAttempts = 2 } = await c.req.json();

	let html = "";
	let validationResult = { valid: false };
	let attempts = 0;
	let allTokenUsage = {
		prompt_tokens: 0,
		completion_tokens: 0,
		total_tokens: 0,
		attempts: 0,
	};

	let finalTemplateName = "None";

	while (!validationResult.valid && attempts < maxAttempts) {
		attempts++;

		// Step 0: Get dynamic system prompt for each attempt (though prompt stays same)
		const { prompt: dynamicSystemPrompt, templateName } =
			await getDynamicSystemPrompt(prompt);
		finalTemplateName = templateName;

		// Generate HTML (with feedback from previous validation if exists)
		const generationPrompt =
			attempts === 1
				? prompt
				: `${prompt}\n\nIMPORTANT: The previous generation had these issues:\n${validationResult.issues.map((i) => `- ${i.description}`).join("\n")}\n\nPlease fix these issues in your new generation.`;

		const response = await openai.chat.completions.create({
			model: "openai/gpt-4o-mini",
			max_tokens: 8192,
			messages: [
				{
					role: "system",
					content: dynamicSystemPrompt,
				},
				{
					role: "user",
					content: generationPrompt,
				},
			],
		});

		html = response.choices[0].message.content;

		// Track token usage
		const usage = response.usage || {};
		allTokenUsage.prompt_tokens += usage.prompt_tokens || 0;
		allTokenUsage.completion_tokens += usage.completion_tokens || 0;
		allTokenUsage.total_tokens += usage.total_tokens || 0;

		// Cleanup
		html = html.replace(/^```html\n?/i, "").replace(/\n?```$/i, "");
		html = html.replace(/^```\n?/, "").replace(/\n?```$/, "");
		html = html.trim();

		// Validate
		validationResult = await validateHTML(html);
	}

	allTokenUsage.attempts = attempts;

	// Set debug headers
	c.header("x-simba-tokens", allTokenUsage.total_tokens.toString());
	c.header("x-simba-attempts", attempts.toString());
	c.header("x-simba-validation", validationResult.valid ? "passed" : "failed");
	c.header("x-simba-issues", validationResult.issues.length.toString());

	const validationComment = `
<!-- 
AUTO-FIX REPORT:
Attempts: ${attempts}/${maxAttempts}
Dynamic Example: ${finalTemplateName}
Final Status: ${validationResult.valid ? "PASSED ✓" : "FAILED ✗ (max attempts reached)"}
Issues Found: ${validationResult.issues.length}
${
	validationResult.issues.length > 0
		? `
Remaining Issues:
${validationResult.issues
	.map(
		(
			issue,
			i,
		) => `${i + 1}. [${issue.severity.toUpperCase()}] ${issue.category}: ${issue.description}
   Location: ${issue.location}`,
	)
	.join("\n")}
`
		: ""
}
Total Token Usage: ${allTokenUsage.total_tokens} tokens
-->
`;

	const finalHTML = validationComment + "\n" + html;

	return c.html(finalHTML);
});

const port = 3001;
console.log(`Server is running on port ${port}`);

serve({
	fetch: app.fetch,
	port,
});
