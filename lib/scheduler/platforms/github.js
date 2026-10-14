/**
 * GitHub adapter: commits a markdown file via the Contents API.
 *
 * Payload: {
 *   path: "content/blog/my-post.md",   required
 *   content: "# Markdown body",        required
 *   repo?: "owner/name",               default GITHUB_POST_REPO
 *   branch?: "main",                   default GITHUB_POST_BRANCH or repo default
 *   message?: "commit message",
 *   frontmatter?: { title: "..." }     optional, prepended as YAML
 * }
 * Auth: GITHUB_TOKEN (needs contents:write on the repo).
 */

import { httpError, requireEnv } from "./util.js";

const API = "https://api.github.com";

function resolve(payload) {
	const repo = payload.repo || process.env.GITHUB_POST_REPO || "";
	const branch = payload.branch || process.env.GITHUB_POST_BRANCH || "";
	return { repo, branch };
}

export function validate(payload) {
	const p = payload || {};
	const { repo } = resolve(p);
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("github: repo must be 'owner/name' (payload.repo or GITHUB_POST_REPO)");
	if (!p.path || typeof p.path !== "string" || p.path.startsWith("/") || p.path.split("/").includes(".."))
		throw new Error("github: path must be a relative file path");
	if (typeof p.content !== "string" || !p.content.trim()) throw new Error("github: content is required");
}

function withFrontmatter(content, fm) {
	if (!fm || typeof fm !== "object" || !Object.keys(fm).length) return content;
	// JSON-encoded values are valid YAML scalars/flow collections.
	const lines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
	return `---\n${lines.join("\n")}\n---\n\n${content}`;
}

export async function publish(payload) {
	const token = requireEnv("GITHUB_TOKEN");
	const { repo, branch } = resolve(payload);
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"Content-Type": "application/json",
	};
	const url = `${API}/repos/${repo}/contents/${payload.path.split("/").map(encodeURIComponent).join("/")}`;

	// Existing file? Updating requires its blob sha.
	const existing = await fetch(branch ? `${url}?ref=${encodeURIComponent(branch)}` : url, { headers });
	let sha;
	if (existing.ok) sha = (await existing.json()).sha;
	else if (existing.status !== 404) throw await httpError(existing, "github");

	const body = {
		message: payload.message || `${sha ? "Update" : "Add"} ${payload.path}`,
		content: Buffer.from(withFrontmatter(payload.content, payload.frontmatter), "utf8").toString("base64"),
	};
	if (branch) body.branch = branch;
	if (sha) body.sha = sha;

	const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
	if (!res.ok) throw await httpError(res, "github");
	const json = await res.json();
	return { url: json.content?.html_url, commit: json.commit?.sha, updated: Boolean(sha) };
}
