import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const loadSkills = {
	landingPageSkill: {
		name: "landing-page-production-html-generator",
		description:
			"Generates production-ready 2025–2026 landing pages using pure HTML5 + modern CSS (no frameworks), optimized for performance, SEO, accessibility, and conversion.",
		metadata: {
			version: "1.0",
			stack: "HTML5 + Modern CSS (Grid/Flexbox), optional minimal vanilla JS",
			output: [
				"index.html",
				"styles.css",
				"optional script.js",
				"deployment notes",
			],
		},
		skill: await readFile(
			path.join(__dirname, "landing-page-creation-skill.md"),
			"utf-8",
		),
	},
	htmlUIImproveSkill: {
		name: "html-ui-improve-skill",
		description:
			"Refactors and improves existing HTML/CSS landing pages to production-level UI quality (2025–2026), enhancing hierarchy, responsiveness, accessibility, and performance without changing content meaning.",
		metadata: {
			version: "1.0",
			accepts: ["html", "css"],
			outputs: [
				"refactored html",
				"refactored css",
				"diff patch",
				"improvement report",
			],
		},
		skill: await readFile(
			path.join(__dirname, "html-ui-enhancement-skill.md"),
			"utf-8",
		),
	},
};
