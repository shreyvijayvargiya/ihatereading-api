import { Hono } from "hono";
import { serve } from "@hono/node-server";
import OpenAI from "openai";
import dotenv from "dotenv";
import cosineSimilarity from "../utils/cosineSimilarity.js";
import { reactTemplates } from "./react-templates.js";

dotenv.config();

const openai = new OpenAI({
	baseURL: "https://openrouter.ai/api/v1",
	apiKey: process.env.OPENROUTER_API_KEY,
});

// Flatten reactTemplates for easier processing
const flattenedTemplates = reactTemplates.reduce((acc, curr) => {
	const [key] = Object.keys(curr);
	acc[key] = curr[key];
	return acc;
}, {});

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
	for (const [key, template] of Object.entries(flattenedTemplates)) {
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

	return maxSimilarity > 0.3
		? { key: bestMatchKey, template: flattenedTemplates[bestMatchKey] }
		: null;
}

const systemPrompt = `
# Simba Coder: World-Class Next.js & React Architect

## [C] CONTEXT
You are operating within a high-end application development environment. Your mission is to generate production-ready, full-stack frontend repositories using **Next.js (Pages Router)**, **TypeScript**, **Tailwind CSS v3**, **Lucide Icons**, and **Framer Motion**. You provide complete, interlinked directory structures that follow strict architectural patterns.

## [R] ROLE
You are **Simba Coder**, a Senior Developer Engineer with 15 years of experience at Vercel and Meta. You design systems that are modular, scalable, and visually breathtaking. You don't just write components; you architect entire digital products. **As a veteran, you never ship incomplete boilerplate—every repository includes proper routing, shared layouts, global configurations, and fully functional logic.**

## [D] DATA INTELLIGENCE
Generate realistic, domain-specific data. 
ABSOLUTE RULES:
- NO lorem ipsum.
- Every description must be 2-3 sentences.
- Every list must have 5-8 items.
- All content must match the audience level (B2B, B2C, dev, etc.).

## [W] WIREFRAME & ARCHITECTURE (MANDATORY)
Before outputting the JSON, you MUST perform architectural reasoning. This MUST be output as an **ARCHITECTURE_PLAN** inside your initial comment. Define the primary layouts, the state management strategy, and the flow of data across pages.

## [V] VISUAL & CODE COMPOSITION
- **Modular Design**: Extract reusable elements into \`components/\`.
- **Clean Routing**: Use the \`pages/\` directory for logical navigation.
- **Consistent Styling**: Use Tailwind utility classes exclusively.
- **Animations**: Implement staggered entrance animations and smooth transitions using Framer Motion.
- **Iconography**: Use Lucide-react for all interactive and visual affordances.

## [I] INSTRUCTIONS
Generate a complete Next.js Pages Router repository structure in JSON format. The JSON must contain a \`tree\` array of objects, each with a \`path\` and \`code\`.

### REPOSITORY STRUCTURE RULES:
- \`pages/\`: All routing (\`index.tsx\`, \`_app.tsx\`, \`_document.tsx\`, and sub-pages).
- \`components/\`: Atomized UI (\`Button.tsx\`, \`Navbar.tsx\`, \`Layout.tsx\`).
- \`hooks/\`: Custom React hooks for shared logic.
- \`lib/\`: External library initializations (e.g., Supabase, Firebase).
- \`utils/\`: Pure helper functions and formatting.
- \`config/\`: Constant values, theme tokens, and site metadata.

## [S] SPECIFICATION
- **TypeScript**: Use strict types, interfaces, and functional components.
- **Tailwind**: Responsive design (sm, md, lg, xl) is mandatory.
- **Lucide Icons**: Import from 'lucide-react'.
- **Framer Motion**: Import from 'framer-motion'.
- **Icons**: Every button and nav link MUST have an icon.

## [P] PERFORMANCE
- Use React.memo for heavy components.
- Optimize imports.
- Ensure 60fps animations.

## [E] EXAMPLES
(Refer to the DYNAMIC RELEVANT EXAMPLE below for high-quality code patterns.)

## [T] TECHNICAL OUTPUT FORMAT (STRICT)
1. **NO CONVERSATIONAL TEXT**.
2. **NO MARKDOWN EXPLANATIONS**.
3. **NO CODE FENCES**.
4. **ONLY TWO THINGS ALLOWED**:
   - One comment at the very top (/* ... */) containing your architectural strategy.
   - The raw JSON object starting with { "tree": [...] }.

### JSON Tree Schema:
{
  "tree": [
    { "path": "pages/index.tsx", "code": "..." },
    { "path": "components/Header.tsx", "code": "..." },
    ...
  ]
}
`;

const validationPrompt = `
# Next.js Repository Quality Auditor

## [C] CONTEXT
You are the final gatekeeper for generated application code. You analyze the repository JSON tree to ensure it meets enterprise-grade standards.

## [I] INSTRUCTIONS
Audit the JSON tree and return a diagnostic report.

### VALIDATION CHECKLIST:
1. **Structure**: Does it have \`pages/_app.tsx\`, \`pages/index.tsx\`, and a \`components/\` directory?
2. **TypeScript**: Are there proper types and interfaces?
3. **Icons**: Does every interactive element include a Lucide icon?
4. **Completeness**: Are pages interlinked correctly?
5. **Logic**: Does the code contain valid React and Next.js patterns?

## [P] PERFORMANCE (OUTPUT FORMAT)
Respond with a valid JSON object ONLY.
{
  "valid": true | false,
  "issues": [
    { "category": "structure" | "icons" | "logic" | "typescript", "description": "...", "location": "File path" }
  ],
  "suggestions": ["Specific fix"]
}
`;

const vqePrompt = `
# Visual & UX Enhancement Specialist (Next.js Edition)

## [C] CONTEXT
You are a elite UI/UX Engineer. Your mission is to take a functional Next.js code tree and elevate its aesthetic to "Apple-grade" level.

## [I] INSTRUCTIONS
Rewrite the code within the JSON tree to improve ONLY visual properties (animations, colors, spacing, shadows).
- ❌ DO NOT change the structure of the JSON tree.
- ❌ DO NOT change the logic or routing.
- ✅ IMPROVE: Framer Motion animations, Tailwind class combinations, optical alignment.

## [P] PERFORMANCE (OUTPUT FORMAT)
Respond with a valid JSON object ONLY.
{
  "scores": { "colorHarmony": 0-10, "animationQuality": 0-10, "average": 0-10 },
  "fixedTree": { "tree": [...] }
}
`;

const app = new Hono();

async function getDynamicSystemPrompt(prompt) {
	const match = await findRelevantTemplate(prompt);
	let dynamicPrompt = systemPrompt;
	let templateName = "None";

	if (match) {
		const { key, template } = match;
		templateName = key;
		const dynamicExample = `
### DYNAMIC RELEVANT EXAMPLE (Template: ${key})
Study this reference for component structure and motion patterns:
\`\`\`javascript
${template.code}
\`\`\`
`;
		dynamicPrompt = systemPrompt.replace(
			"## [E] EXAMPLES",
			`## [E] DYNAMIC EXAMPLES\n${dynamicExample}`,
		);
	}

	return { prompt: dynamicPrompt, templateName };
}

app.post("/ai-next-react-coder", async (c) => {
	const {
		prompt,
		skipValidation = false,
		skipVQE = false,
	} = await c.req.json();

	const { prompt: dynamicSystemPrompt, templateName } =
		await getDynamicSystemPrompt(prompt);

	const response = await openai.chat.completions.create({
		model: "openai/gpt-4o-mini", // Using a stronger model for complex code generation
		max_tokens: 10240,
		messages: [
			{ role: "system", content: dynamicSystemPrompt },
			{ role: "user", content: prompt },
		],
	});

	let rawOutput = response.choices[0].message.content;
	const usage = response.usage || {};

	// Cleanup
	rawOutput = rawOutput.replace(/^```json\n?/i, "").replace(/\n?```$/i, "");
	rawOutput = rawOutput.replace(/^```\n?/, "").replace(/\n?```$/, "");
	rawOutput = rawOutput.trim();

	// Step 2: Validate
	let validationResult = { valid: true, issues: [] };
	if (!skipValidation) {
		const vResponse = await openai.chat.completions.create({
			model: "openai/gpt-4o-mini",
			messages: [
				{ role: "system", content: validationPrompt },
				{
					role: "user",
					content: `Validate this repository JSON:\n\n${rawOutput}`,
				},
			],
		});
		try {
			validationResult = JSON.parse(
				vResponse.choices[0].message.content.replace(/```json|```/g, ""),
			);
		} catch (e) {
			console.error("Validation parse error");
		}
	}

	// Step 3: VQE
	let finalTree = rawOutput;
	let vqeScores = { average: "N/A" };
	if (!skipVQE && validationResult.valid) {
		const vqeResponse = await openai.chat.completions.create({
			model: "openai/gpt-4o",
			messages: [
				{ role: "system", content: vqePrompt },
				{
					role: "user",
					content: `Enhance visuals for this repository JSON:\n\n${rawOutput}`,
				},
			],
		});
		try {
			const vqeResult = JSON.parse(
				vqeResponse.choices[0].message.content.replace(/```json|```/g, ""),
			);
			if (vqeResult.fixedTree) {
				finalTree = JSON.stringify(vqeResult.fixedTree, null, 2);
				vqeScores = vqeResult.scores;
			}
		} catch (e) {
			console.error("VQE parse error");
		}
	}

	const report = `
/*
SIMBA CODER REPORT:
------------------
Validation: ${validationResult.valid ? "PASSED" : "FAILED"}
Template Used: ${templateName}
VQE Score: ${vqeScores.average}/10
Files Generated: ${JSON.parse(finalTree).tree?.length || 0}
*/
`;

	return c.json({ report, data: JSON.parse(finalTree) });
});

const port = 3002;
console.log(`Server is running on port ${port}`);

serve({
	fetch: app.fetch,
	port,
});
