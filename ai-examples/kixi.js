// app.ts - Main Hono.js Application
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import OpenAI from "openai";
const app = new Hono();

dotenv.config();

const openai = new OpenAI({
	baseURL: "https://openrouter.ai/api/v1",
	apiKey: process.env.OPENROUTER_API_KEY,
});

const baseURL = "https://openrouter.ai/api/v1/chat/completions";
const apiKey = process.env.OPENROUTER_API_KEY;

// CORS middleware
app.use("/*", cors());

// =============================================================================
// AI AGENT SKILLS - Prompts for each stage
// =============================================================================

const SKILLS = {
	context_analyzer: `You are an expert UI/UX analyst. Analyze screen generation requests and extract key information.

Given a user prompt, return a JSON object with:
{
  "projectType": "saas-dashboard" | "ecommerce" | "social" | "utility" | "landing" | "form" | etc,
  "industry": string,
  "targetPlatform": "web" | "mobile" | "tablet",
  "complexity": "simple" | "medium" | "complex",
  "screenCount": number,
  "primaryPurpose": string,
  "recommendedComponents": string[],
  "userIntent": string,
  "keyFeatures": string[]
}

Be intelligent about understanding context. For example:
- "SAAS dashboard" = web, complex, charts/tables
- "Mobile calorie tracker" = mobile, medium, forms/lists
- "Landing page" = web, simple, hero/features
- "E-commerce product page" = web/mobile, medium, images/cart

Return ONLY valid JSON, no markdown formatting.`,

	wireframe_generator: `You are an expert wireframe designer. Create detailed structural layouts.

Given context about a screen, return a JSON wireframe specification:
{
  "layout": "sidebar-content" | "tabs" | "list-detail" | "grid" | "single-column" | "split",
  "sections": [
    {
      "id": "header",
      "type": "header" | "nav" | "hero" | "content" | "sidebar" | "footer" | "modal",
      "components": ["logo", "nav-menu", "user-avatar", etc],
      "gridArea": "1 / 1 / 2 / 3" // CSS Grid area (optional),
      "behavior": "sticky" | "fixed" | "scroll" | "collapse"
    }
  ],
  "navigation": {
    "type": "top-nav" | "sidebar" | "tabs" | "bottom-nav" | "drawer",
    "items": ["Home", "Products", etc]
  },
  "responsive": {
    "mobile": "single-column stacked",
    "tablet": "description",
    "desktop": "description"
  }
}

Consider platform conventions:
- Mobile: Bottom tabs, hamburger menus, full-width sections
- Web: Sidebars, multi-column layouts, hover states
- Tablet: Hybrid of both

Return ONLY valid JSON, no markdown formatting.`,

	content_generator: `You are an expert content strategist. Generate realistic, contextual content for screens.

Given context, wireframe, and platform, return JSON content:
{
  "headings": {
    "main": "string",
    "sub": "string",
    "sections": ["string"]
  },
  "copy": {
    "hero": "string",
    "descriptions": ["string"],
    "cta": ["string"]
  },
  "data": {
    "metrics": [
      { "label": "string", "value": "number/string", "trend": "+12%", "icon": "lucide-icon-name" }
    ],
    "lists": [
      { "title": "string", "subtitle": "string", "meta": "string" }
    ],
    "chartData": {
      "labels": ["Mon", "Tue", ...],
      "datasets": [{ "label": "string", "data": [numbers] }]
    }
  },
  "images": [
    { "query": "unsplash-search-term", "alt": "string", "width": 1200, "height": 800 }
  ],
  "users": [
    { "name": "string", "role": "string", "avatar": "initials" }
  ],
  "actions": [
    { "label": "string", "type": "primary" | "secondary" | "tertiary" }
  ]
}

Rules:
1. Generate REALISTIC data (actual numbers, not placeholders)
2. Use industry-appropriate terminology
3. Create coherent narratives
4. Include 5-10 items for lists
5. Use proper date/time formats
6. Make metrics believable
7. Choose appropriate Lucide icon names
8. Use descriptive Unsplash queries

Return ONLY valid JSON, no markdown formatting.`,

	theme_selector: `You are an expert design system architect. Select or generate appropriate themes.

Given context and preferences, return a theme configuration:
{
  "name": "Theme Name",
  "reasoning": "Why this theme fits the project",
  "colors": {
    "bg": "#hex",
    "surface": "#hex",
    "text": "#hex",
    "textSecondary": "#hex",
    "accent": "#hex",
    "border": "#hex"
  },
  "fonts": {
    "heading": "'Font Name', fallback",
    "body": "'Font Name', fallback"
  },
  "typography": {
    "titleSize": "2.5rem - 3.5rem",
    "subtitleSize": "1.125rem - 1.5rem",
    "bodySize": "1rem - 1.125rem",
    "lineHeight": "1.6 - 1.9"
  }
}

Theme selection logic:
- SAAS/Tech: Dark themes, blue/purple accents, modern sans-serifs
- E-commerce/Fashion: Bold themes, image-focused, variety of colors
- Finance/Professional: Conservative themes, blues/greys, classic fonts
- Health/Fitness: Fresh themes, greens/blues, friendly fonts
- Creative/Agency: Bold themes, unique colors, display fonts

Ensure WCAG AA contrast compliance.
Return ONLY valid JSON, no markdown formatting.`,

	component_assembler: `You are an expert frontend architect. Assemble components into structured HTML.

Given wireframe, content, theme, and platform, return component tree:
{
  "structure": [
    {
      "component": "header",
      "classes": ["header", "sticky"],
      "children": [
        {
          "component": "logo",
          "content": { "text": "Brand", "icon": "lucide-icon" }
        },
        {
          "component": "nav",
          "children": [...]
        }
      ]
    },
    {
      "component": "main",
      "classes": ["main-content"],
      "children": [...]
    }
  ],
  "componentMap": {
    "metric-card": {
      "element": "div",
      "classes": ["metric-card"],
      "structure": "icon + label + value + trend"
    },
    // ... other reusable components
  }
}

Component library to use:
- metric-card: Icon, label, value, trend indicator
- chart-container: Title, chart placeholder, legend
- data-table: Headers, rows with alternating colors
- list-item: Avatar/icon, title, subtitle, meta, action
- button: Text, icon (optional), variant classes
- input-group: Label, input, helper text, error state
- card: Header, body, footer
- hero: Heading, subheading, CTA buttons, image
- feature-block: Icon, heading, description
- navigation: List of links with icons

Map content to components semantically.
Return ONLY valid JSON, no markdown formatting.`,

	code_generator: `You are an expert frontend developer. Generate production-ready HTML and CSS.

Given component tree, theme, and platform, generate complete code.

Requirements:
1. Semantic HTML5 (header, main, section, article, nav, etc.)
2. Mobile-first responsive CSS
3. CSS Grid and Flexbox for layouts
4. CSS Custom Properties for theming
5. Modern CSS (clamp, min, max, calc)
6. Smooth transitions and animations
7. Accessibility (ARIA labels, semantic elements, focus states)
8. Lucide icons from CDN: <script src="https://unpkg.com/lucide@latest"></script>
9. Initialize icons: <script>lucide.createIcons();</script>
10. Unsplash images: https://source.unsplash.com/{width}x{height}/?{query}
11. Interactive states (hover, focus, active)
12. Loading states where appropriate
13. Empty states for lists/tables
14. Error states for forms
15. No JavaScript dependencies (except Lucide)

Return JSON:
{
  "html": "complete HTML document string",
  "css": "complete CSS string",
  "assets": {
    "images": ["url1", "url2"],
    "icons": ["lucide:icon-name1", "lucide:icon-name2"]
  },
  "features": ["responsive", "accessible", "animated"]
}

Platform-specific considerations:
- Mobile: Larger touch targets (44px min), thumb-friendly navigation, simpler layouts
- Web: Hover states, complex layouts, keyboard navigation, multi-column

Return ONLY valid JSON, no markdown formatting.`,
};

// =============================================================================
// LLM HELPER FUNCTIONS
// =============================================================================

async function callLLM({
	skill,
	input,
	model = "openai/gpt-4o",
}) {
	const systemPrompt = SKILLS[skill];

	const response = await openai.chat.completions.create({
		model,
		messages: [
				{ role: "system", content: systemPrompt },
				{
					role: "user",
					content:
						typeof input === "string" ? input : JSON.stringify(input, null, 2),
				},
			],
			temperature: 0.7,
			response_format: { type: "json_object" },
  });

	const content = JSON.parse(response.choices[0].message.content);

	// Try to parse JSON, removing markdown code blocks if present
	return {
		result: content,
		tokens: response.usage.total_tokens,
	};
}

// =============================================================================
// ENDPOINT 1: /api/analyze - Context Understanding
// =============================================================================

app.post("/api/analyze", async (c) => {
	try {
		const body = await c.req.json();
		const { prompt, targetPlatform = "auto", preferences = {} } = body;

		if (!prompt) {
			return c.json({ error: "Prompt is required" }, 400);
		}

		// Call context analyzer
		const { result: context, tokens } = await callLLM({
			skill: "context_analyzer",
			input: { prompt, targetPlatform, preferences },
		});

		// Auto-detect platform if needed
		if (targetPlatform === "auto") {
			context.targetPlatform = context.targetPlatform || "web";
		} else {
			context.targetPlatform = targetPlatform;
		}

		// Estimate token usage for full generation
		const complexityMultiplier = {
			simple: 0.7,
			medium: 1.0,
			complex: 1.5,
		};

		const baseTokens = 9500;
		const estimatedTokens = Math.round(
			baseTokens * complexityMultiplier[context.complexity],
		);

		const analysisId = uuidv4();

		return c.json({
			analysisId,
			context,
			plan: {
				wireframeComplexity:
					context.complexity === "complex" ? "detailed" : "standard",
				contentDepth:
					context.complexity === "simple" ? "minimal" : "comprehensive",
				themeStyle: `${context.industry}-${context.projectType}`,
				estimatedTokens,
			},
			tokens: {
				analysis: tokens,
			},
		});
	} catch (error) {
		console.error("Error in /api/analyze:", error);
		return c.json(
			{ error: "Failed to analyze request", details: error.message },
			500,
		);
	}
});

// =============================================================================
// ENDPOINT 2: /api/generate/screen - Main Screen Generation
// =============================================================================

app.post("/api/generate/screen", async (c) => {
	try {
		const body = await c.req.json();
		const { prompt, platform = "web", analysisId, options = {} } = body;

		if (!prompt) {
			return c.json({ error: "Prompt is required" }, 400);
		}

		const screenId = uuidv4();
		const tokenUsage = { total: 0 };

		// Step 1: Context Analysis
		console.log("Step 1: Analyzing context...");
		const { result: context, tokens: t1 } = await callLLM({
			skill: "context_analyzer",
			input: { prompt, targetPlatform: platform },
		});
		tokenUsage.analysis = t1;
		tokenUsage.total += t1;

		// Step 2: Wireframe Generation
		console.log("Step 2: Generating wireframe...");
		const { result: wireframe, tokens: t2 } = await callLLM({
			skill: "wireframe_generator",
			input: { context, platform },
		});
		tokenUsage.wireframe = t2;
		tokenUsage.total += t2;

		// Step 3: Content Generation
		console.log("Step 3: Generating content...");
		const { result: content, tokens: t3 } = await callLLM({
			skill: "content_generator",
			input: { context, wireframe, platform },
		});
		tokenUsage.content = t3;
		tokenUsage.total += t3;

		// Step 4: Theme Selection/Generation
		console.log("Step 4: Selecting theme...");
		const { result: theme, tokens: t4 } = await callLLM({
			skill: "theme_selector",
			input: {
				context,
				platform,
				preference: options.themePreference || "auto",
			},
		});
		tokenUsage.theme = t4;
		tokenUsage.total += t4;

		// Step 5: Component Assembly
		console.log("Step 5: Assembling components...");
		const { result: componentTree, tokens: t5 } = await callLLM({
			skill: "component_assembler",
			input: { wireframe, content, theme, platform },
		});
		tokenUsage.componentAssembly = t5;
		tokenUsage.total += t5;

		// Step 6: Code Generation
		console.log("Step 6: Generating code...");
		const { result: codeOutput, tokens: t6 } = await callLLM({
			skill: "code_generator",
			input: { componentTree, theme, platform, content },
		});
		tokenUsage.codeGeneration = t6;
		tokenUsage.total += t6;

		console.log(`Total tokens used: ${tokenUsage.total}`);

		return c.json({
			screenId,
			metadata: {
				title: content.headings?.main || "Generated Screen",
				description: context.primaryPurpose,
				platform,
				complexity: context.complexity,
				generatedAt: new Date().toISOString(),
			},
			wireframe,
			theme,
			content,
			code: {
				html: codeOutput.html,
				css: codeOutput.css,
			},
			assets: codeOutput.assets,
			tokens: tokenUsage,
		});
	} catch (error) {
		console.error("Error in /api/generate/screen:", error);
		return c.json(
			{ error: "Failed to generate screen", details: error.message },
			500,
		);
	}
});

// =============================================================================
// ENDPOINT 3: /api/refine - Screen Refinement
// =============================================================================

app.post("/api/refine", async (c) => {
	try {
		const body = await c.req.json();
		const {
			screenId,
			refinementPrompt,
			preserveContent = true,
			previousCode,
		} = body;

		if (!refinementPrompt || !previousCode) {
			return c.json(
				{ error: "refinementPrompt and previousCode are required" },
				400,
			);
		}

		const newScreenId = `${screenId}-v${Date.now()}`;
		const tokenUsage = { total: 0 };

		// Create refinement prompt
		const refinementInput = {
			originalCode: previousCode,
			refinementRequest: refinementPrompt,
			preserveContent,
			instructions: `
        User wants to refine the following screen:
        
        Current HTML:
        ${previousCode.html?.substring(0, 2000)}...
        
        Current CSS:
        ${previousCode.css?.substring(0, 2000)}...
        
        Refinement request: ${refinementPrompt}
        
        ${preserveContent ? "IMPORTANT: Keep all existing content (text, images, data). Only modify layout, styling, and structure." : "You can modify content as needed."}
        
        Return the same JSON format as code_generator skill.
      `,
		};

		const { result: refinedCode, tokens } = await callLLM({
			skill: "code_generator",
			input: refinementInput,
		});

		tokenUsage.refinement = tokens;
		tokenUsage.total += tokens;

		return c.json({
			screenId: newScreenId,
			changes: [refinementPrompt],
			code: {
				html: refinedCode.html,
				css: refinedCode.css,
			},
			assets: refinedCode.assets,
			tokens: tokenUsage,
		});
	} catch (error) {
		console.error("Error in /api/refine:", error);
		return c.json(
			{ error: "Failed to refine screen", details: error.message },
			500,
		);
	}
});

// =============================================================================
// ENDPOINT 4: /api/generate/component - Single Component Generation
// =============================================================================

app.post("/api/generate/component", async (c) => {
	try {
		const body = await c.req.json();
		const { prompt, platform = "web", style = "modern" } = body;

		if (!prompt) {
			return c.json({ error: "Prompt is required" }, 400);
		}

		const componentId = uuidv4();
		const tokenUsage = { total: 0 };

		// Generate component directly
		const componentInput = {
			type: "single-component",
			description: prompt,
			platform,
			style,
			requirements:
				"Create a reusable, self-contained component with variants and props",
		};

		const { result: componentCode, tokens } = await callLLM({
			skill: "code_generator",
			input: componentInput,
		});

		tokenUsage.total = tokens;

		return c.json({
			componentId,
			name: extractComponentName(prompt),
			code: {
				html: componentCode.html,
				css: componentCode.css,
			},
			props: extractProps(componentCode.html),
			variants: ["default", "primary", "secondary"],
			tokens: tokenUsage,
		});
	} catch (error) {
		console.error("Error in /api/generate/component:", error);
		return c.json(
			{ error: "Failed to generate component", details: error.message },
			500,
		);
	}
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function extractComponentName(prompt) {
	// Simple extraction from prompt
	const words = prompt.split(" ").filter((w) => w.length > 3);
	return words
		.slice(0, 2)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join("");
}

function extractProps(html) {
	// Extract common data attributes or placeholders
	const props = new Set();
	const matches = html.matchAll(/\{\{(\w+)\}\}/g);
	for (const match of matches) {
		props.add(match[1]);
	}
	return Array.from(props);
}

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get("/health", (c) => {
  console.log("here")
	return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

app.onError((err, c) => {
	console.error("Global error:", err);
	return c.json(
		{
			error: "Internal server error",
			message: err.message,
		},
		500,
	);
});

console.log("Kixi is running on PORT:3003")
serve({
  fetch: app.fetch,
  port: 3003
});

export default app;
