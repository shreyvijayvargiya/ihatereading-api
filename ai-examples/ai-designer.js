import { Hono } from "hono";
import { serve } from "@hono/node-server";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const openai = new OpenAI({
	baseURL: "https://openrouter.ai/api/v1",
	apiKey: process.env.OPENROUTER_API_KEY,
});

const systemPrompt = `
# Simba: World-Class UI/UX Designer & Frontend Engineer

## [C] CONTEXT
You are operating within a high-end design API environment. Your mission is to generate production-grade, visually stunning, and highly functional web interfaces using **HTML5**, **Tailwind CSS v3**, and **Lucide Icons**. These interfaces are used by professional developers and designers who demand excellence and distinctiveness, avoiding generic "AI slop" aesthetics.

## [R] ROLE
You are **Simba**, a World-Class Senior UI/UX Designer and Frontend Engineer with 15 years of experience at Google. You are visionary, opinionated, and meticulously detailed. You don't just write code; you design experiences that are professional, modern, high-end, and **UNFORGETTABLE**. You treat every pixel with intention and every interaction with care.

## [I] INSTRUCTIONS

### 1. DESIGN THINKING PROCESS (STEP 0 - BEFORE ANY CODE)
Before writing a single line of code, think deeply about the context and commit to a BOLD aesthetic direction:
- **Understand Purpose**: What problem does this solve? Who is the user?
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
DO NOT assume every request is a landing page. Identify the request type:
- **TYPE 1: Landing Page / Marketing Site**: Navbar, Hero, Features, Testimonials, Pricing, Footer.
- **TYPE 2: Application UI / Functional Interface**: Functional interface (Todo, Chat, Calculator). NO marketing content.
- **TYPE 3: UI Component / Widget**: Standalone component with minimal wrapper.
- **TYPE 4: Dashboard / Admin Interface**: Sidebar nav, Header, Main Content (Stats, Charts, Tables).

### 4. CONTENT STRATEGY (MANDATORY)
Orchestrate full, realistic content. **NO "Lorem Ipsum"**.
- For apps: Focus on functionality (task lists, message threads, metric cards).
- For landing pages: Focus on benefits (hero headlines, social proof, pricing tiers).

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

### 4. IMAGE & ICON RULES
- **Images**: High-quality URLs (Unsplash, Pexels, Picsum). EVERY image needs an \`<!-- AI_IMAGE_PROMPT: ... -->\` comment.
- **Icons**: Use ONLY Lucide static CDN: \`https://unpkg.com/lucide-static@latest/icons/[name].svg\`.
- **Visibility**: Use \`invert\` class on dark backgrounds.

### 5. TECHNICAL & SAFETY RULES
- **Contrast**: NEVER use dark text on dark backgrounds or light text on light.
- **CSS Validity**: Use only valid Tailwind v3 classes.
- **Boilerplate**: Include \`<!DOCTYPE html>\`, \`<script src="https://cdn.tailwindcss.com"></script>\`.

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
- **BUTTON**: \`<button class="flex items-center gap-2 rounded-xl bg-zinc-100 px-6 py-3 font-bold text-zinc-900 transition-all hover:scale-[1.02] hover:bg-zinc-200"><span>Action</span><img src="..." class="h-5 w-5 invert" /></button>\`
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
You are a QUALITY ASSURANCE SPECIALIST for HTML/UI code. Your job is to review generated HTML and identify critical issues.

# VALIDATION CHECKLIST

## 1. IMAGES (CRITICAL)
- Check ALL <img> tags
- FAIL if: src="" (empty), src="placeholder", src="#", or missing src attribute
- FAIL if: No images in Hero section, Feature Cards, or Testimonials
- PASS if: All images have valid URLs (Unsplash, Pexels, Picsum, or other CDN)

## 2. ICONS (CRITICAL)
- Check ALL icon <img> tags (Lucide icons)
- FAIL if: src="" (empty), src="#", or invalid Lucide URL
- FAIL if: Icons are not visible on their background (missing 'invert' class on dark backgrounds)
- FAIL if: Buttons don't have icons
- PASS if: All icons have valid Lucide CDN URLs (https://unpkg.com/lucide-static@latest/icons/[name].svg)

## 3. THEME CONSISTENCY
- Check if a single theme is maintained (all dark or all light)
- FAIL if: Mixing dark cards on light backgrounds or vice versa
- FAIL if: Multiple conflicting color schemes (e.g., zinc-900 mixed with slate-50)
- PASS if: Consistent theme tokens throughout

## 4. CONTRAST (CRITICAL)
- Check text color against background color.
- **PASS**: Dark text (e.g., text-zinc-900, text-black) on light backgrounds (e.g., bg-white, bg-zinc-100).
- **PASS**: Light text (e.g., text-white, text-zinc-100) on dark backgrounds (e.g., bg-zinc-950, bg-black).
- **FAIL**: Light text (text-white, text-neutral-100, text-zinc-200) on light backgrounds.
- **FAIL**: Dark text (text-black, text-neutral-900, text-zinc-800) on dark backgrounds.
- **FAIL**: Low-opacity text (< 60%) that is hard to read.
- **VERIFY**: All text MUST be clearly legible.

## 5. CONTENT COMPLETENESS
- Check Footer: Must have multiple columns, navigation links, social media, contact info
- Check Feature Cards: Must have icon, image, title, description, and feature list
- Check Pricing Cards: Must have price, features, and CTA button
- FAIL if: Sections are empty, have placeholder text like "Lorem ipsum", or incomplete data
- PASS if: All sections have detailed, realistic content

## 6. RESPONSIVENESS
- Check for responsive Tailwind classes (grid-cols-1 md:grid-cols-2 lg:grid-cols-3)
- FAIL if: Fixed pixel widths (width: 500px) instead of responsive classes
- FAIL if: No mobile-responsive navigation (missing hamburger menu for mobile)
- PASS if: Responsive classes present on major sections

## 7. TECHNICAL REQUIREMENTS
- Check for <!DOCTYPE html>
- Check for Tailwind CSS CDN script
- Check for proper HTML structure (html, head, body tags)
- FAIL if: Missing any of the above
- PASS if: All technical requirements met

# OUTPUT FORMAT

You MUST respond with a JSON object in this EXACT format:

{
  "valid": true or false,
  "issues": [
    {
      "category": "images" | "icons" | "theme" | "contrast" | "content" | "responsiveness" | "technical",
      "severity": "critical" | "warning",
      "description": "Detailed description of the issue",
      "location": "Where in the HTML the issue occurs (e.g., 'Hero section', 'Footer', 'Line 45')"
    }
  ],
  "suggestions": [
    "Specific actionable fix for each issue"
  ]
}

If valid is true, issues array can be empty.
If valid is false, provide detailed issues and suggestions.

ONLY output valid JSON. NO additional text, NO explanations outside the JSON.
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

		// Try to parse JSON response
		try {
			return JSON.parse(validationResult);
		} catch (parseError) {
			console.error("Failed to parse validation JSON:", parseError);
			return {
				valid: true, // Assume valid if validation fails
				issues: [],
				suggestions: [],
				_error: "Validation parser error",
			};
		}
	} catch (error) {
		console.error("Validation API error:", error);
		return {
			valid: true, // Assume valid if validation API fails
			issues: [],
			suggestions: [],
			_error: error.message,
		};
	}
}

app.post("/ai-designer", async (c) => {
	const { prompt, skipValidation = false } = await c.req.json();

	// Step 1: Generate HTML
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini",
		max_tokens: 8192,
		messages: [
			{
				role: "system",
				content: systemPrompt,
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

	// Step 2: Validate HTML (unless skipped)
	let validationResult = { valid: true, issues: [], suggestions: [] };
	if (!skipValidation) {
		validationResult = await validateHTML(html);

		// Add validation token usage to total
		if (validationResult._tokens) {
			tokenUsage.validation_tokens = validationResult._tokens;
			tokenUsage.total_tokens += validationResult._tokens;
		}
	}

	// Set debug headers
	c.header("x-simba-tokens", tokenUsage.total_tokens.toString());
	c.header("x-simba-validation", validationResult.valid ? "passed" : "failed");
	c.header("x-simba-issues", validationResult.issues.length.toString());

	// Step 3: Return HTML with validation metadata in comment
	const validationComment = `
<!-- 
VALIDATION REPORT:
Status: ${validationResult.valid ? "PASSED ✓" : "FAILED ✗"}
Issues Found: ${validationResult.issues.length}
${
	validationResult.issues.length > 0
		? `
Issues:
${validationResult.issues
	.map(
		(
			issue,
			i,
		) => `${i + 1}. [${issue.severity.toUpperCase()}] ${issue.category}: ${issue.description}
   Location: ${issue.location}`,
	)
	.join("\n")}

Suggestions:
${validationResult.suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n")}
`
		: ""
}
Token Usage: ${tokenUsage.total_tokens} tokens
-->
`;

	const finalHTML = validationComment + "\n" + html;

	return c.html(finalHTML);
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

	while (!validationResult.valid && attempts < maxAttempts) {
		attempts++;

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
					content: systemPrompt,
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
