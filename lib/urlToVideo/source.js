/**
 * Source ingestion for the URL → video pipeline.
 * - GitHub: shallow-clones the repo locally, reads README / manifests / tree / key code files,
 *   pulls stars & topics from the GitHub API.
 * - Website: uses the existing scraper (injected) for markdown + metadata.
 * Then captures full-page screenshots (injected capture fn) and crops them into frame candidates.
 */
import { execFile } from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { cropImage, probeImageSize, toPreviewJpeg } from "./media.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "out", "vendor", "target", "__pycache__", ".venv", "venv", "coverage", ".turbo", ".cache"]);
const CODE_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".py", ".go", ".rs", ".rb", ".java", ".kt", ".swift", ".c", ".cc", ".cpp", ".h", ".cs", ".php", ".ex", ".vue", ".svelte", ".sh", ".zig", ".lua", ".dart", ".scala"]);
const MANIFESTS = ["package.json", "pyproject.toml", "setup.py", "Cargo.toml", "go.mod", "Gemfile", "pom.xml", "build.gradle", "composer.json", "pubspec.yaml", "deno.json"];
const MAX_CLONE_SECONDS = Number.parseInt(process.env.URL_VIDEO_CLONE_TIMEOUT_SEC || "", 10) || 120;

export function parseGithubRepo(url) {
	try {
		const u = new URL(url);
		if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
		const [owner, repoRaw] = u.pathname.split("/").filter(Boolean);
		if (!owner || !repoRaw) return null;
		return { owner, repo: repoRaw.replace(/\.git$/i, "") };
	} catch {
		return null;
	}
}

function git(args, cwd) {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, timeout: MAX_CLONE_SECONDS * 1000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`git ${args[0]} failed: ${String(stderr || err.message).slice(-1500)}`));
			else resolve(String(stdout));
		});
	});
}

async function githubApi(pathname) {
	const headers = { Accept: "application/vnd.github+json", "User-Agent": "ihatereading-url-to-video" };
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const res = await fetch(`https://api.github.com${pathname}`, { headers, signal: AbortSignal.timeout(15_000) });
	if (!res.ok) throw new Error(`GitHub API ${pathname}: HTTP ${res.status}`);
	return res.json();
}

async function walk(root, rel = "", out = [], limit = 5000) {
	if (out.length >= limit) return out;
	const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const e of entries) {
		if (out.length >= limit) break;
		const p = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) {
			if (!SKIP_DIRS.has(e.name)) await walk(root, p, out, limit);
		} else if (e.isFile()) {
			const st = await fsp.stat(path.join(root, p)).catch(() => null);
			out.push({ path: p, size: st?.size || 0 });
		}
	}
	return out;
}

async function readText(file, max = 20_000) {
	try {
		const buf = await fsp.readFile(file);
		if (buf.includes(0)) return null; // binary
		return buf.toString("utf8").slice(0, max);
	} catch {
		return null;
	}
}

/** Score files so the director sees entry points and examples before internals. */
function codeScore(p) {
	const name = path.basename(p).toLowerCase();
	let s = 0;
	if (/^(examples?|demo|samples?)\//i.test(p) || /\/(examples?|demo)\//i.test(p)) s += 6;
	if (/^(index|main|app|lib|mod|cli|server)\.[a-z]+$/.test(name)) s += 5;
	if (/^src\//.test(p)) s += 2;
	if (/(test|spec|\.d\.ts|config|\.min\.)/i.test(p)) s -= 6;
	s -= p.split("/").length * 0.5;
	return s;
}

/**
 * Clone the repo into workDir/repo and collect everything the director needs.
 * @returns {Promise<{ source: object, codeFiles: object[], repoDir: string, screenshotTargets: object[] }>}
 */
export async function ingestGithub({ owner, repo, branch, workDir, log }) {
	const repoDir = path.join(workDir, "repo");
	const cloneUrl = `https://github.com/${owner}/${repo}.git`;
	log(`cloning ${cloneUrl}`);
	const cloneArgs = ["clone", "--depth", "1", "--filter=blob:limit=2m", "--single-branch"];
	if (branch) cloneArgs.push("--branch", branch);
	await git([...cloneArgs, cloneUrl, repoDir], workDir);

	const [meta, languages, files, head] = await Promise.all([
		githubApi(`/repos/${owner}/${repo}`).catch(() => null),
		githubApi(`/repos/${owner}/${repo}/languages`).catch(() => null),
		walk(repoDir),
		git(["log", "-1", "--format=%H|%cI|%s"], repoDir).catch(() => ""),
	]);

	const readmeEntry = files.find((f) => /^readme(\.(md|markdown|rst|txt))?$/i.test(f.path));
	const readme = readmeEntry ? await readText(path.join(repoDir, readmeEntry.path), 14_000) : null;
	const manifests = {};
	for (const m of MANIFESTS) {
		if (files.some((f) => f.path === m)) manifests[m] = await readText(path.join(repoDir, m), 2500);
	}

	const extCounts = {};
	for (const f of files) {
		const ext = path.extname(f.path).toLowerCase() || "(none)";
		extCounts[ext] = (extCounts[ext] || 0) + 1;
	}

	const candidates = files
		.filter((f) => CODE_EXTS.has(path.extname(f.path).toLowerCase()) && f.size > 80 && f.size < 40_000)
		.sort((a, b) => codeScore(b.path) - codeScore(a.path))
		.slice(0, 10);
	const codeFiles = [];
	for (const f of candidates) {
		const text = await readText(path.join(repoDir, f.path), 40_000);
		if (!text) continue;
		const lines = text.split("\n");
		codeFiles.push({
			path: f.path,
			line_count: lines.length,
			preview: lines
				.slice(0, 45)
				.map((l, i) => `${String(i + 1).padStart(3)}| ${l.slice(0, 140)}`)
				.join("\n"),
		});
	}

	const [sha, committedAt, lastCommit] = head.trim().split("|");
	const source = {
		type: "github",
		url: `https://github.com/${owner}/${repo}`,
		name: meta?.name || repo,
		full_name: `${owner}/${repo}`,
		description: meta?.description || null,
		homepage: meta?.homepage || null,
		topics: meta?.topics || [],
		stars: meta?.stargazers_count ?? null,
		forks: meta?.forks_count ?? null,
		open_issues: meta?.open_issues_count ?? null,
		license: meta?.license?.spdx_id || null,
		primary_language: meta?.language || null,
		languages: languages || null,
		default_branch: meta?.default_branch || branch || null,
		last_commit: lastCommit ? { sha: sha?.slice(0, 7), date: committedAt, message: lastCommit } : null,
		file_count: files.length,
		file_types: Object.fromEntries(Object.entries(extCounts).sort((a, b) => b[1] - a[1]).slice(0, 12)),
		tree: files.slice(0, 250).map((f) => f.path),
		manifests,
		readme,
	};

	const screenshotTargets = [{ id: "repo", url: source.url, label: "GitHub repository page (header, file list, rendered README)", maxCrops: 4 }];
	if (source.homepage && /^https?:\/\//.test(source.homepage)) {
		screenshotTargets.push({ id: "home", url: source.homepage, label: "Project homepage", maxCrops: 3 });
	}
	return { source, codeFiles, repoDir, screenshotTargets };
}

/**
 * @param {{ url: string, scrape: (url: string) => Promise<{ markdown?: string, data?: object }>, log: Function }} p
 */
export async function ingestWebsite({ url, scrape, log }) {
	log(`scraping ${url}`);
	let scraped = null;
	try {
		scraped = await scrape(url);
	} catch (e) {
		log(`scrape failed (${e?.message}); continuing with screenshots only`);
	}
	const meta = scraped?.data?.metadata || scraped?.data || {};
	const source = {
		type: "website",
		url,
		title: meta.title || meta["og:title"] || null,
		description: meta.description || meta["og:description"] || null,
		site_name: meta["og:site_name"] || null,
		theme_color: meta["theme-color"] || null,
		content: String(scraped?.markdown || "").slice(0, 14_000),
	};
	return {
		source,
		codeFiles: [],
		repoDir: null,
		screenshotTargets: [{ id: "site", url, label: "Website", maxCrops: 6 }],
	};
}

/**
 * Capture each target full-page and slice it into frame-sized crops.
 * @param {{ targets: object[], capture: (url: string, opts: object) => Promise<Buffer>, workDir: string,
 *   maxFrames: number, vertical: boolean, log: Function }} p
 * @returns {Promise<{ id: string, source: string, url: string, file: string, preview: string, width: number, height: number }[]>}
 */
export async function captureFrameCandidates({ targets, capture, workDir, maxFrames, vertical, log }) {
	const dir = path.join(workDir, "screenshots");
	await fsp.mkdir(dir, { recursive: true });
	const frames = [];
	for (const t of targets) {
		const device = vertical ? "mobile" : "desktop";
		let buf;
		try {
			log(`screenshot ${t.url} (${device}, full page)`);
			buf = await capture(t.url, { device, fullPage: true });
		} catch (e) {
			log(`screenshot failed for ${t.url}: ${e?.message}`);
			continue;
		}
		const full = path.join(dir, `${t.id}-full.png`);
		await fsp.writeFile(full, buf);
		const { width, height } = await probeImageSize(full);
		// Desktop crops are 16:10, mobile crops 9:16 — close to the final frame window.
		const cropH = Math.min(height, Math.round(vertical ? width * (16 / 9) : width * 0.625));
		const usable = Math.min(height, cropH * 8);
		const count = Math.max(1, Math.min(t.maxCrops, Math.floor(usable / cropH), maxFrames - frames.length));
		for (let i = 0; i < count; i++) {
			const y = count === 1 ? 0 : Math.round(((usable - cropH) * i) / (count - 1));
			const id = `${t.id}-${i + 1}`;
			const file = path.join(dir, `${id}.png`);
			const preview = path.join(dir, `${id}.jpg`);
			await cropImage(full, file, { x: 0, y, width, height: cropH });
			await toPreviewJpeg(file, preview);
			frames.push({ id, source: `${t.label} — section ${i + 1}/${count} (y=${y}px of ${height}px)`, url: t.url, file, preview, width, height: cropH });
		}
		if (frames.length >= maxFrames) break;
	}
	return frames;
}

export function readCodeSnippet(repoDir, file, start, end) {
	if (!repoDir || !file) return null;
	const abs = path.resolve(repoDir, file);
	if (!abs.startsWith(path.resolve(repoDir) + path.sep)) return null;
	if (!fs.existsSync(abs)) return null;
	const lines = fs.readFileSync(abs, "utf8").split("\n");
	const s = Math.max(1, Number.parseInt(start, 10) || 1);
	const e = Math.min(lines.length, Math.max(s, Number.parseInt(end, 10) || s + 15), s + 17);
	return { startLine: s, lines: lines.slice(s - 1, e).map((l) => l.replace(/\t/g, "  ").slice(0, 110)) };
}
