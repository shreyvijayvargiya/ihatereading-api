#!/usr/bin/env node
/**
 * Generate one themed landing HTML per design prompt (25 files).
 * Same content (landing-base.html); only theme CSS changes from MDX tokens.
 *
 * Usage: node scripts/generate-theme-landing-pages.js
 *        npm run generate:theme-landings
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { prompts } from "../ai-examples/simba-ui-ux/prompts/prompts.js";
import { stripMdxOutputSection } from "../lib/imageToCodeDesignThemes.js";
import { parseMdxDesignTokens } from "../lib/parseMdxDesignTokens.js";
import { buildThemeLandingCss } from "../lib/buildThemeLandingCss.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const BASE_TEMPLATE = path.join(
	ROOT,
	"ai-examples/htmlTemplates/landing-base.html",
);
const OUT_DIR = path.join(ROOT, "ai-examples/htmlTemplates");

async function main() {
	const baseHtml = await readFile(BASE_TEMPLATE, "utf-8");
	await mkdir(OUT_DIR, { recursive: true });

	const manifest = [];
	let ok = 0;
	let fail = 0;

	for (const [key, entry] of Object.entries(prompts)) {
		const slug = entry?.name || key;
		const rawMdx = stripMdxOutputSection(entry.prompt || "");
		const tokens = parseMdxDesignTokens(rawMdx, key);
		const themeCss = buildThemeLandingCss(tokens, slug);

		const html = baseHtml
			.replace("/* THEME_STYLES */", themeCss)
			.replace(/<!-- THEME_TITLE -->/g, slug)
			.replace(/<!-- THEME_KEY -->/g, key);

		const outFile = path.join(OUT_DIR, `${slug}.html`);
		await writeFile(outFile, html, "utf-8");

		manifest.push({
			key,
			name: slug,
			file: `${slug}.html`,
			tokens,
		});
		ok++;
		console.log(`✓ ${slug}.html (${key})`);
	}

	const manifestPath = path.join(OUT_DIR, "theme-manifest.json");
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

	console.log(`\nDone: ${ok} generated, ${fail} failed.`);
	console.log(`Output: ${OUT_DIR}`);
	console.log(`Manifest: ${manifestPath}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
