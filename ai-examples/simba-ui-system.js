import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import OpenAI from "openai";
import { cors } from "hono/cors";
import dotenv from "dotenv";


dotenv.config();

const app = new Hono();

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

const openai = new OpenAI({
	baseURL: "https://openrouter.ai/api/v1",
	apiKey: process.env.OPENROUTER_API_KEY,
});

function safeJsonParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		// Heuristic: try to extract the largest JSON substring
		const first = text.indexOf("{");
		const last = text.lastIndexOf("}");
		if (first !== -1 && last !== -1 && last > first) {
			return JSON.parse(text.slice(first, last + 1));
		}
		throw new Error("Invalid JSON from model");
	}
}

// ─────────────────────────────────────────────────────────────
// 1) BRAND & SYSTEM INTENT (NO TOON here)
// ─────────────────────────────────────────────────────────────
const brandIntentAgentPrompt = `
[C] You are defining a DESIGN SYSTEM, not UI screens.

[R] Role
You are a Design Director creating a scalable UI foundation.

[I] Input
User brand prompt + preferences.

[S] Output rules (STRICT)
- Output ONLY JSON.
- No Tailwind.
- No components.
- Define style constraints only.

You must decide:
- Brand name suggestion (1-2 words, optional but preferred)
- Brand personality
- Visual intensity
- Motion philosophy
- Accessibility level
- Confidence (low|medium|high) and a short style label (kebab-case)

Output JSON shape:
{
  "meta": {
    "brand": "",
    "confidence": "low|medium|high",
    "style": "",
    "locked": false
  },
  "brand": {
    "tone": "",
    "personality": [],
    "risk_level": "low|medium|high",
    "accessibility": "AA|AAA"
  },
  "visual_intent": {
    "contrast": "low|medium|high",
    "colorfulness": "low|medium|high",
    "radius_style": "sharp|soft|round",
    "motion": "none|subtle|expressive"
  }
}
`;

// ─────────────────────────────────────────────────────────────
// 2) DESIGN SYSTEM GENERATOR (MOST IMPORTANT)
// ─────────────────────────────────────────────────────────────
const designSystemAgentPrompt = `
[C] You generate a PRODUCTION DESIGN SYSTEM.

[R] Role
Senior Design Systems Engineer (Stripe / Linear level)

[I] Input
- Brand intent JSON (meta, brand, visual_intent)
- User preferences

[S] HARD RULES (STRICT)
- Output ONLY JSON.
- Tailwind is the ONLY output format: every token value MUST be a Tailwind utility class (or a space-separated list of Tailwind classes).
- No arbitrary values (no custom hex, no inline styles, no bracket arbitrary values like w-[13px]).
- No placeholders.
- Include states: hover, focus, active/press, disabled, loading (where applicable).
- Include motion primitives using Tailwind classes only (transition, duration, easing, transform, motion-safe).
- Include layout primitives (container widths, section spacing, card spacing, grid gaps).
- Include rules list (short, enforceable).

Output JSON shape:
{
  "tokens": {
    "font": { "base": "", "heading": "", "body": "" },
    "color": { "bg": "", "surface": "", "primary": "", "accent": "", "border": "", "mutedText": "", "danger": "", "success": "" },
    "radius": { "sm": "", "md": "", "lg": "" },
    "shadow": { "card": "", "popover": "" },
    "spacing": { "section": "", "container": "", "card": "", "input": "", "gridGap": "" },
    "typography": { "h1": "", "h2": "", "h3": "", "body": "", "caption": "" }
  },
  "motion": {
    "base": "",
    "hover": "",
    "press": "",
    "focus": "",
    "enterFrom": "",
    "enterTo": ""
  },
  "layout": {
    "container": "",
    "section": "",
    "grid": ""
  },
  "rules": []
}
`;

// ─────────────────────────────────────────────────────────────
// 3) UI LIBRARY GENERATOR (components built on tokens)
// ─────────────────────────────────────────────────────────────
const uiLibraryAgentPrompt = `
[C] You are generating a UI COMPONENT LIBRARY.

[R] Role
Staff Frontend Engineer (Tailwind + Design Systems)

[I] Input
- Design system JSON (tokens, motion, layout, rules)
- Brand intent JSON

[S] RULES (STRICT)
- Output ONLY JSON.
- Components must be built ONLY from the provided tokens/motion/layout (compose classes; no inline styles).
- Each component must include: base, variants, sizes, states.
- Components must be composable and reusable.
- Include the following components keys EXACTLY:
  button, input, card, navbar, modal, table, badge, alert, dropdown, tabs, tooltip

Output JSON shape:
{
  "components": {
    "button": { "base": "", "variants": {}, "sizes": {}, "states": {} },
    "input": { "base": "", "variants": {}, "sizes": {}, "states": {} },
    "card": { "base": "", "variants": {}, "sizes": {}, "states": {} },
    "navbar": { "base": "", "variants": {}, "sizes": {}, "states": {} },
    "modal": { "base": "", "variants": {}, "sizes": {}, "states": {} },
    "table": { "base": "", "variants": {}, "sizes": {}, "states": {} },
    "badge": { "base": "", "variants": {}, "sizes": {}, "states": {} },
    "alert": { "base": "", "variants": {}, "sizes": {}, "states": {} },
    "dropdown": { "base": "", "variants": {}, "sizes": {}, "states": {} },
    "tabs": { "base": "", "variants": {}, "sizes": {}, "states": {} },
    "tooltip": { "base": "", "variants": {}, "sizes": {}, "states": {} }
  }
}
`;

async function runBrandIntentAgent({ prompt, preferences }) {
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini",
		messages: [
			{ role: "system", content: brandIntentAgentPrompt },
			{
				role: "user",
				content: `Prompt: ${prompt}\nPreferences: ${JSON.stringify(preferences || {})}`,
			},
		],
		response_format: { type: "json_object" },
	});
	return {
		data: safeJsonParse(response.choices[0].message.content),
		usage: response.usage,
	};
}

async function runDesignSystemAgent({ brandIntent, preferences }) {
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini",
		messages: [
			{ role: "system", content: designSystemAgentPrompt },
			{
				role: "user",
				content: `Brand intent: ${JSON.stringify(brandIntent)}\nPreferences: ${JSON.stringify(preferences || {})}`,
			},
		],
		response_format: { type: "json_object" },
	});
	return {
		data: safeJsonParse(response.choices[0].message.content),
		usage: response.usage,
	};
}

async function runUiLibraryAgent({ designSystem, brandIntent }) {
	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini",
		messages: [
			{ role: "system", content: uiLibraryAgentPrompt },
			{
				role: "user",
				content: `Design system: ${JSON.stringify(designSystem)}\nBrand intent: ${JSON.stringify(brandIntent)}`,
			},
		],
		response_format: { type: "json_object" },
	});
	return {
		data: safeJsonParse(response.choices[0].message.content),
		usage: response.usage,
	};
}

// API: POST /simba/ui-system
app.post("/simba/ui-system", async (c) => {
	const { prompt, preferences = {}, stream = false } = await c.req.json();

	const doWork = async (emit) => {
		const { data: brandIntent } = await runBrandIntentAgent({
			prompt,
			preferences,
		});
		emit?.("stage", { stage: 1, name: "brand_intent", data: brandIntent });

		const { data: designSystem } = await runDesignSystemAgent({
			brandIntent,
			preferences,
		});
		emit?.("stage", { stage: 2, name: "design_system", data: designSystem });

		const { data: uiLibrary } = await runUiLibraryAgent({
			designSystem,
			brandIntent,
		});
		emit?.("stage", { stage: 3, name: "ui_library", data: uiLibrary });

		return {
			meta: brandIntent.meta,
			design_system: designSystem,
			ui_library: uiLibrary,
		};
	};

	if (stream) {
		return streamSSE(c, async (s) => {
			const emit = async (event, payload) => {
				await s.writeSSE({ event, data: JSON.stringify(payload) });
			};
			await emit("meta", { type: "ui-system", engine: "ai" });
			try {
				const finalPayload = await doWork(emit);
				await emit("result", finalPayload);
				await emit("done", { status: "complete" });
			} catch (err) {
				console.error("ui-system failed:", err);
				await emit("error", { error: err.message || "ui-system failed" });
			}
		});
	}

	try {
		const finalPayload = await doWork();
		return c.json(finalPayload);
	} catch (err) {
		console.error("ui-system failed:", err);
		return c.json({ error: err.message || "ui-system failed" }, 400);
	}
});

const port = 3003;
console.log(`Simba UI System API running on port ${port}`);
serve({ fetch: app.fetch, port });
