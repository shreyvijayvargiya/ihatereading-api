// main.js
import { generateDesignSystem, getStackGuidelines } from "./search.js";
import { search } from "./core.js";

async function main() {
	const query = process.argv[2];
	if (!query) {
		console.error("Usage: node main.js <query>");
		process.exit(1);
	}

	const projectName = process.argv[3] || "SIMBA_PROJECT";

	// 1. Generate Design System (ASCII format for prompt)
	const designSystemAscii = await generateDesignSystem(query, projectName, "ascii");

	// 2. Get Stack Guidelines (HTML-Tailwind)
	const stackResult = await getStackGuidelines(query, "html-tailwind");
	const stackGuidelines = stackResult.results
		.map((r, i) => `Guideline ${i + 1}:\n- Description: ${r.Guideline || r.Description}\n- Implementation: ${r.Implementation || r.Example}`)
		.join("\n\n");

	// 3. Get UX Guidelines
	const uxResult = await search(query, "ux", 5);
	const uxGuidelines = uxResult.results
		.map((r, i) => `UX Rule ${i + 1}:\n- Category: ${r.Category}\n- Do: ${r.Do}\n- Don't: ${r["Don't"]}`)
		.join("\n\n");

	// 4. Combine into final system prompt
	const prompt = `
[C] CONTEXT
You are Simba Pro Max, the world's most advanced UI/UX Engineer.
Your task is to build a PRODUCTION-GRADE website based on the following Design System and Guidelines.

${designSystemAscii}

────────────────────────────────────────
[S] STACK GUIDELINES (HTML + TAILWIND)
${stackGuidelines}

────────────────────────────────────────
[U] UX & ACCESSIBILITY RULES
${uxGuidelines}

────────────────────────────────────────
[P] PRODUCTION LAWS (NON-NEGOTIABLE)
1. NO PLACEHOLDERS: Render every section with real, domain-specific data.
2. DENSITY: Dashboards must have Sidebar + TopBar + Stats + Main Area + Activity Feed. Landing pages must have 10+ high-fidelity sections.
3. MOTION: Add CSS transitions and entrance animations to every element.
4. ICONS: Use Lucide icons only (<i data-lucide="icon-name"></i>) and initialize at end of body.
5. ASSETS: Use real Unsplash images and Gravatar for avatars.

────────────────────────────────────────
[OUTPUT FORMAT — STRICT JSON]
Return a JSON object:
{
  "design_system_reasoning": {
    "industry": "Identified Industry",
    "style": "Chosen UI Style",
    "color_palette": { "primary": "HEX", "secondary": "HEX", "cta": "HEX" },
    "typography": "Chosen Font Pairing"
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
`;

	console.log(prompt);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
