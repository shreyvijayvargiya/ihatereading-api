/**
 * GitHub README badge automation: clone -> edit README -> commit -> push -> verify.
 * Uses the git CLI with a bearer header so the token never lands in a URL or log.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const GIT_BASE = () => (process.env.GITHUB_GIT_BASE || "https://github.com").replace(/\/$/, "");
const API_BASE = () => (process.env.GITHUB_API_BASE || "https://api.github.com").replace(/\/$/, "");

export const githubToken = () => process.env.GITHUB_TOKEN?.trim() || "";

export function parseRepo(input) {
	if (!input) return null;
	const m = String(input)
		.trim()
		.replace(/\.git$/, "")
		.match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)\/?$/);
	return m ? { owner: m[1], repo: m[2], slug: `${m[1]}/${m[2]}` } : null;
}

const scrub = (s, token) => (token ? String(s).split(token).join("***") : String(s));

async function git(args, { cwd, token } = {}) {
	const auth = token
		? ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`]
		: [];
	try {
		const { stdout } = await exec("git", [...auth, ...args], {
			cwd,
			timeout: 90_000,
			maxBuffer: 4 * 1024 * 1024,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		return stdout.trim();
	} catch (e) {
		throw new Error(`git ${args[0]} failed: ${scrub(e.stderr || e.message, token).split("\n").slice(0, 3).join(" ")}`);
	}
}

/** URLs inside the badge snippet are what we match on, so reformatting by the host doesn't matter. */
export function badgeNeedles(badgeCode) {
	const urls = [...String(badgeCode).matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((m) => m[0]);
	return urls.length ? urls : [String(badgeCode).replace(/\s+/g, " ").trim()];
}

export const containsBadge = (content, badgeCode) =>
	badgeNeedles(badgeCode).every((n) => content.replace(/\s+/g, " ").includes(n));

export function toMarkdownBadge(badgeCode) {
	// An HTML snippet is valid inside Markdown, so we insert it verbatim.
	return badgeCode.trim();
}

export async function addBadgeToReadme({ repo, badgeCode, workRoot }) {
	const token = githubToken();
	if (!token) throw new Error("GITHUB_TOKEN is not configured");
	const dir = await fs.mkdtemp(path.join(workRoot || os.tmpdir(), "badge-"));
	try {
		await git(["clone", "--depth", "1", `${GIT_BASE()}/${repo.slug}.git`, dir], { token });
		const files = await fs.readdir(dir);
		const readme = files.find((f) => /^readme(\.(md|markdown))?$/i.test(f));
		if (!readme) throw new Error("Repository has no README");
		const file = path.join(dir, readme);
		const original = await fs.readFile(file, "utf8");
		if (containsBadge(original, badgeCode)) return { changed: false, file: readme };

		const badge = toMarkdownBadge(badgeCode);
		const lines = original.split("\n");
		const h1 = lines.findIndex((l) => /^# /.test(l));
		const next =
			h1 === 0
				? [lines[0], "", badge, ...lines.slice(1)].join("\n")
				: `${badge}\n\n${original}`;
		await fs.writeFile(file, next);

		const ident = [
			"-c",
			`user.name=${process.env.GITHUB_COMMIT_NAME || "Directory Agent"}`,
			"-c",
			`user.email=${process.env.GITHUB_COMMIT_EMAIL || "directory-agent@users.noreply.github.com"}`,
		];
		await git([...ident, "commit", "-am", "docs: add directory verification badge"], { cwd: dir });
		await git(["push", "origin", "HEAD"], { cwd: dir, token });
		return { changed: true, file: readme };
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

export async function readRepoReadme(repo) {
	const token = githubToken();
	const res = await fetch(`${API_BASE()}/repos/${repo.slug}/readme`, {
		headers: {
			Accept: "application/vnd.github.raw+json",
			"User-Agent": "directory-agent",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`GitHub README fetch failed (${res.status})`);
	return res.text();
}
