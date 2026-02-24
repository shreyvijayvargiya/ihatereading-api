// design_system.js
import { search, DATA_DIR } from "./core.js";
import fs from "fs";
import path from "path";

const REASONING_FILE = "ui-reasoning.csv";

const SEARCH_CONFIG = {
	product: { max_results: 1 },
	style: { max_results: 3 },
	color: { max_results: 2 },
	landing: { max_results: 2 },
	typography: { max_results: 2 },
};

export class DesignSystemGenerator {
	constructor() {
		this.reasoningData = this._loadReasoning();
	}

	_loadReasoning() {
		const filepath = path.join(DATA_DIR, REASONING_FILE);
		if (!fs.existsSync(filepath)) return [];

		const content = fs.readFileSync(filepath, "utf-8");
		const lines = content.split("\n");
		if (lines.length === 0) return [];
		const headers = lines[0].split(",").map((h) => h.trim());

		return lines
			.slice(1)
			.filter((line) => line.trim())
			.map((line) => {
				const values = line.split(",").map((v) => v.trim());
				return headers.reduce((obj, header, i) => {
					obj[header] = values[i] || "";
					return obj;
				}, {});
			});
	}

	async _multiDomainSearch(query, stylePriority = []) {
		const results = {};
		for (const [domain, config] of Object.entries(SEARCH_CONFIG)) {
			if (domain === "style" && stylePriority.length > 0) {
				const priorityQuery = stylePriority.slice(0, 2).join(" ");
				const combinedQuery = `${query} ${priorityQuery}`;
				results[domain] = await search(combinedQuery, domain, config.max_results);
			} else {
				results[domain] = await search(query, domain, config.max_results);
			}
		}
		return results;
	}

	_findReasoningRule(category) {
		const categoryLower = category.toLowerCase();

		// Try exact match first
		for (const rule of this.reasoningData) {
			if (rule["UI_Category"]?.toLowerCase() === categoryLower) {
				return rule;
			}
		}

		// Try partial match
		for (const rule of this.reasoningData) {
			const uiCat = rule["UI_Category"]?.toLowerCase() || "";
			if (uiCat.includes(categoryLower) || categoryLower.includes(uiCat)) {
				return rule;
			}
		}

		return null;
	}

	_applyReasoning(category) {
		const rule = this._findReasoningRule(category);

		if (!rule) {
			return {
				pattern: "Hero + Features + CTA",
				style_priority: ["Minimalism", "Flat Design"],
				color_mood: "Professional",
				typography_mood: "Clean",
				key_effects: "Subtle hover transitions",
				anti_patterns: "",
			};
		}

		return {
			pattern: rule["Recommended_Pattern"] || "",
			style_priority: (rule["Style_Priority"] || "").split("+").map((s) => s.trim()),
			color_mood: rule["Color_Mood"] || "",
			typography_mood: rule["Typography_Mood"] || "",
			key_effects: rule["Key_Effects"] || "",
			anti_patterns: rule["Anti_Patterns"] || "",
		};
	}

	async generate(query, projectName = null) {
		// Step 1: Search product to get category
		const productResult = await search(query, "product", 1);
		const category = productResult.results[0]?.["Product Type"] || "General";

		// Step 2: Get reasoning rules
		const reasoning = this._applyReasoning(category);
		const stylePriority = reasoning.style_priority || [];

		// Step 3: Multi-domain search
		const searchResults = await this._multiDomainSearch(query, stylePriority);

		// Step 4: Extract best matches
		const styleResults = searchResults.style?.results || [];
		const colorResults = searchResults.color?.results || [];
		const typographyResults = searchResults.typography?.results || [];
		const landingResults = searchResults.landing?.results || [];

		// Step 5: Build design system
		const googleFontsUrl = typographyResults[0]?.["Google Fonts URL"] || "";
		const safeGoogleFontsUrl = googleFontsUrl.startsWith("http") 
			? googleFontsUrl 
			: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap";

		return {
			project_name: projectName || query.toUpperCase(),
			category,
			pattern: {
				name: landingResults[0]?.["Pattern Name"] || reasoning.pattern,
				sections:
					landingResults[0]?.["Section Order"] || "Hero > Features > CTA",
				cta_placement: landingResults[0]?.["Primary CTA Placement"] || "Above fold",
				conversion: landingResults[0]?.["Conversion Optimization"] || "",
			},
			style: {
				name: styleResults[0]?.["Style Category"] || "Minimalism",
				effects: styleResults[0]?.["Effects & Animation"] || reasoning.key_effects,
				keywords: styleResults[0]?.["Keywords"] || "",
				performance: styleResults[0]?.["Performance"] || "",
				accessibility: styleResults[0]?.["Accessibility"] || "",
			},
			colors: {
				primary: colorResults[0]?.["Primary (Hex)"] || "#2563EB",
				secondary: colorResults[0]?.["Secondary (Hex)"] || "#3B82F6",
				cta: colorResults[0]?.["CTA (Hex)"] || "#F97316",
				background: colorResults[0]?.["Background (Hex)"] || "#F8FAFC",
				text: colorResults[0]?.["Text (Hex)"] || "#1E293B",
			},
			typography: {
				heading: typographyResults[0]?.["Heading Font"] || "Inter",
				body: typographyResults[0]?.["Body Font"] || "Inter",
				google_fonts_url: safeGoogleFontsUrl,
			},
			anti_patterns: reasoning.anti_patterns,
		};
	}
}

export function formatAsciiBox(designSystem) {
	const project = designSystem.project_name;
	const p = designSystem.pattern;
	const s = designSystem.style;
	const c = designSystem.colors;
	const t = designSystem.typography;

	return `
+----------------------------------------------------------------------------------------+
|  TARGET: ${project} - RECOMMENDED DESIGN SYSTEM                                      |
+----------------------------------------------------------------------------------------+
|                                                                                        |
|  PATTERN: ${p.name}                                                  |
|     Conversion: ${p.conversion}                                     |
|     CTA: ${p.cta_placement}                                       |
|     Sections: ${p.sections}                                           |
|                                                                                        |
|  STYLE: ${s.name}                                                              |
|     Keywords: ${s.keywords}        |
|     Performance: ${s.performance} | Accessibility: ${s.accessibility}                                    |
|                                                                                        |
|  COLORS:                                                                               |
|     Primary:    ${c.primary}                                                    |
|     Secondary:  ${c.secondary}                                                   |
|     CTA:        ${c.cta}                                                         |
|     Background: ${c.background}                                                   |
|     Text:       ${c.text}                                                     |
|                                                                                        |
|  TYPOGRAPHY: ${t.heading} / ${t.body}                                           |
|     Google Fonts: ${t.google_fonts_url}                  |
|                                                                                        |
|  KEY EFFECTS:                                                                          |
|     ${s.effects}                |
|                                                                                        |
|  AVOID (Anti-patterns):                                                                |
|     ${designSystem.anti_patterns}       |
|                                                                                        |
|  PRE-DELIVERY CHECKLIST:                                                               |
|     [ ] No emojis as icons (use SVG: Heroicons/Lucide)                                 |
|     [ ] cursor-pointer on all clickable elements                                       |
|     [ ] Hover states with smooth transitions (150-300ms)                               |
|     [ ] Light mode: text contrast 4.5:1 minimum                                        |
|     [ ] Focus states visible for keyboard nav                                          |
|     [ ] prefers-reduced-motion respected                                               |
|     [ ] Responsive: 375px, 768px, 1024px, 1440px                                       |
|                                                                                        |
+----------------------------------------------------------------------------------------+
`;
}
