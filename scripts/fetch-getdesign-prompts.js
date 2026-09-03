#!/usr/bin/env node
/**
 * Fetch DESIGN.md prompts from getdesign.md into simba-ui-ux/prompts/{slug}.md
 *
 *   node scripts/fetch-getdesign-prompts.js
 *   npm run simba:getdesign
 *
 * Each company: scrape https://getdesign.md/{slug}/design-md (copy/download content),
 * fall back to GitHub raw DESIGN.md. 30s between companies. Skips files that already exist.
 */

import "dotenv/config";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrapeUrl } from "../lib/scrapefast.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(
	__dirname,
	"../ai-examples/simba-ui-ux/prompts",
);

const INTERVAL_MS = Number(process.env.GETDESIGN_INTERVAL_MS || 30_000);

/** Folder names from getdesign.md / VoltAgent awesome-design-md catalog */
const COMPANIES = [
	"airbnb",
	"airtable",
	"apple",
	"binance",
	"bmw-m",
	"bmw",
	"bugatti",
	"cal",
	"claude",
	"clay",
	"clickhouse",
	"cohere",
	"coinbase",
	"composio",
	"cursor",
	"dell-1996",
	"elevenlabs",
	"expo",
	"ferrari",
	"figma",
	"framer",
	"hashicorp",
	"hp",
	"ibm",
	"intercom",
	"kraken",
	"lamborghini",
	"linear.app",
	"lovable",
	"mastercard",
	"meta",
	"minimax",
	"mintlify",
	"miro",
	"mistral.ai",
	"mongodb",
	"nike",
	"nintendo-2001",
	"notion",
	"nvidia",
	"ollama",
	"opencode.ai",
	"pinterest",
	"playstation",
	"posthog",
	"raycast",
	"renault",
	"replicate",
	"resend",
	"revolut",
	"runwayml",
	"sanity",
	"sentry",
	"shopify",
	"slack",
	"spacex",
	"spotify",
	"starbucks",
	"stripe",
	"supabase",
	"superhuman",
	"tesla",
	"theverge",
	"together.ai",
	"uber",
	"vercel",
	"vodafone",
	"voltagent",
	"warp",
	"webflow",
	"wired",
	"wise",
	"x.ai",
	"zapier",
];

const GITHUB_RAW = (slug) =>
	`https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/${encodeURIComponent(slug)}/DESIGN.md`;

const PAGE_URL = (slug) => `https://getdesign.md/${slug}/design-md`;

function looksLikeDesignMd(text) {
	const t = String(text || "").trim();
	if (t.length < 400) return false;
	if (/^---\s*\n[\s\S]*?(version:\s*alpha|name:\s*)/m.test(t)) return true;
	if (/^#\s+.+/m.test(t) && /colors:|typography:|## Colors|# Design/i.test(t))
		return true;
	return false;
}

function extractFromScrape(row) {
	const md = String(row?.markdown || row?.data?.markdown || "").trim();
	if (looksLikeDesignMd(md)) {
		const fm = md.match(/^---\s*\n[\s\S]*?\n---\s*\n[\s\S]*/);
		return fm ? fm[0].trim() : md;
	}
	const html = String(row?.html || row?.data?.html || "");
	const pre = html.match(/<pre[^>]*>[\s\S]*?<\/pre>/i);
	if (pre) {
		const text = pre[0]
			.replace(/<[^>]+>/g, "")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.trim();
		if (looksLikeDesignMd(text)) return text;
	}
	return "";
}

async function fetchGithubDesignMd(slug) {
	const res = await fetch(GITHUB_RAW(slug), {
		signal: AbortSignal.timeout(20_000),
		headers: { "User-Agent": "ihatereading-getdesign-fetch/1.0" },
	});
	if (!res.ok) throw new Error(`GitHub raw HTTP ${res.status}`);
	const text = await res.text();
	if (!looksLikeDesignMd(text)) throw new Error("GitHub body is not DESIGN.md");
	return text.trim() + "\n";
}

async function fetchViaScrape(slug, baseUrl) {
	const url = PAGE_URL(slug);
	const row = await scrapeUrl(url, {
		baseUrl,
		timeoutMs: 75_000,
		timeout: 50_000,
		includeImages: false,
		includeLinks: true,
		waitForSelector: "h1, pre, code, [class*='markdown']",
	});
	return extractFromScrape(row);
}

async function fileExists(file) {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

async function fetchOne(slug, baseUrl) {
	let md = "";
	let source = "";
	try {
		console.log(`[getdesign] scrape ${PAGE_URL(slug)}`);
		md = await fetchViaScrape(slug, baseUrl);
		if (md) source = "scrape";
	} catch (err) {
		console.warn(`[getdesign] scrape fail ${slug}: ${err?.message || err}`);
	}
	if (!md) {
		console.log(`[getdesign] github raw ${slug}`);
		md = await fetchGithubDesignMd(slug);
		source = "github";
	}
	return { md, source };
}

async function main() {
	const args = process.argv.slice(2);
	const force = args.includes("--force");
	const noSleep = args.includes("--no-sleep");
	const only = args.includes("--only")
		? args[args.indexOf("--only") + 1]
		: null;
	const slugs = only
		? COMPANIES.filter((s) => s === only)
		: COMPANIES;

	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;

	await mkdir(OUT_DIR, { recursive: true });
	console.log(
		`[getdesign] ${slugs.length} companies → ${OUT_DIR} interval=${INTERVAL_MS / 1000}s base=${baseUrl}`,
	);

	let saved = 0;
	let skipped = 0;
	let failed = 0;

	for (let i = 0; i < slugs.length; i++) {
		const slug = slugs[i];
		const file = path.join(OUT_DIR, `${slug}.md`);
		if (!force && (await fileExists(file))) {
			console.log(`[getdesign] skip existing ${slug}.md (${i + 1}/${slugs.length})`);
			skipped += 1;
			continue;
		}

		try {
			const { md, source } = await fetchOne(slug, baseUrl);
			await writeFile(file, md, "utf8");
			saved += 1;
			console.log(
				`[getdesign] wrote ${slug}.md (${md.length} chars via ${source}) ${i + 1}/${slugs.length}`,
			);
		} catch (err) {
			failed += 1;
			console.error(`[getdesign] FAIL ${slug}: ${err?.message || err}`);
		}

		const last = i === slugs.length - 1;
		if (!last && !noSleep) {
			console.log(`[getdesign] sleeping ${INTERVAL_MS / 1000}s…`);
			await new Promise((r) => setTimeout(r, INTERVAL_MS));
		}
	}

	console.log(
		JSON.stringify({ saved, skipped, failed, total: slugs.length, outDir: OUT_DIR }, null, 2),
	);
}

main().catch((err) => {
	console.error("[getdesign] fatal:", err?.message || err);
	process.exit(1);
});
