import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import {
	MAX_FILE_BYTES,
	MAX_TREE_ENTRIES,
	ensureSession,
	resolveInSession,
	sessionDir,
} from "./jail.js";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_ROOT = path.resolve(LIB_DIR, "..");
const REPO_ROOT = path.resolve(LIB_DIR, "../..");
const NODE_PATHS = [
	path.join(SANDBOX_ROOT, "node_modules"),
	path.join(REPO_ROOT, "node_modules"),
];

const execFileAsync = promisify(execFile);

const SHELL_TIMEOUT_MS = Number(process.env.SANDBOX_SHELL_TIMEOUT_MS || 20_000);
const HTTP_TIMEOUT_MS = Number(process.env.SANDBOX_HTTP_TIMEOUT_MS || 15_000);
const MAX_HTTP_BYTES = 200_000;
const MAX_SHELL_BYTES = 100_000;

const TOOLS = [
	{
		type: "function",
		function: {
			name: "fs_list",
			description: "List files in the session workspace (relative path).",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Relative directory. Default ." },
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "fs_read",
			description: "Read a text file from the workspace.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "fs_write",
			description: "Write a text file in the workspace. Creates parent folders.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					content: { type: "string" },
				},
				required: ["path", "content"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "fs_remove",
			description: "Delete a file or empty directory in the workspace.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "shell",
			description:
				"Run a shell command with cwd=workspace. 20s timeout. No secret env vars.",
			parameters: {
				type: "object",
				properties: { command: { type: "string" } },
				required: ["command"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "http_request",
			description:
				"HTTP request to a public URL. Private/localhost hosts are blocked.",
			parameters: {
				type: "object",
				properties: {
					url: { type: "string" },
					method: { type: "string" },
					headers: { type: "object" },
					body: { type: "string" },
				},
				required: ["url"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "react_preview",
			description:
				"Bundle src/main.jsx (React) with esbuild and refresh /preview. Optionally overwrite src/App.jsx first.",
			parameters: {
				type: "object",
				properties: {
					code: {
						type: "string",
						description: "Optional full src/App.jsx source",
					},
					css: {
						type: "string",
						description: "Optional full src/styles.css source",
					},
				},
			},
		},
	},
];

export function toolList() {
	return TOOLS;
}

function clip(text, max) {
	const s = String(text ?? "");
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n… truncated ${s.length - max} chars`;
}

async function walkTree(absDir, relBase, out) {
	if (out.length >= MAX_TREE_ENTRIES) return;
	let entries;
	try {
		entries = await fsp.readdir(absDir, { withFileTypes: true });
	} catch {
		return;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const ent of entries) {
		if (out.length >= MAX_TREE_ENTRIES) return;
		if (ent.name === "node_modules" || ent.name === ".git") continue;
		const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
		if (ent.isDirectory()) {
			out.push({ path: rel, type: "dir" });
			await walkTree(path.join(absDir, ent.name), rel, out);
		} else {
			out.push({ path: rel, type: "file" });
		}
	}
}

function isPrivateIp(ip) {
	if (!net.isIP(ip)) return true;
	if (ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0") return true;
	if (ip.startsWith("10.")) return true;
	if (ip.startsWith("192.168.")) return true;
	if (ip.startsWith("169.254.")) return true;
	if (ip.startsWith("::ffff:")) return isPrivateIp(ip.slice(7));
	const m = ip.match(/^172\.(\d+)\./);
	if (m) {
		const n = Number(m[1]);
		if (n >= 16 && n <= 31) return true;
	}
	return false;
}

async function assertPublicUrl(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("invalid url");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("only http/https allowed");
	}
	const host = url.hostname.toLowerCase();
	if (
		host === "localhost" ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		host === "metadata.google.internal"
	) {
		throw new Error("private host blocked");
	}
	const { address } = await lookup(host);
	if (isPrivateIp(address)) throw new Error("private IP blocked");
	return url;
}

const SHELL_ENV = {
	PATH: process.env.PATH || "/usr/bin:/bin:/usr/local/bin",
	HOME: "",
	LANG: "C.UTF-8",
	TERM: "dumb",
};

export async function runTool(sessionId, name, args = {}) {
	await ensureSession(sessionId);
	const input = args && typeof args === "object" ? args : {};

	if (name === "fs_list") {
		const dir = resolveInSession(sessionId, input.path || ".");
		const items = [];
		await walkTree(dir, input.path && input.path !== "." ? String(input.path) : "", items);
		return { items };
	}

	if (name === "fs_read") {
		const file = resolveInSession(sessionId, input.path);
		const st = await fsp.stat(file);
		if (!st.isFile()) throw new Error("not a file");
		if (st.size > MAX_FILE_BYTES) throw new Error("file too large");
		return { path: input.path, content: await fsp.readFile(file, "utf8") };
	}

	if (name === "fs_write") {
		const file = resolveInSession(sessionId, input.path);
		const content = String(input.content ?? "");
		if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("file too large");
		await fsp.mkdir(path.dirname(file), { recursive: true });
		await fsp.writeFile(file, content, "utf8");
		let preview = null;
		if (String(input.path).replace(/\\/g, "/").startsWith("src/")) {
			preview = await bundleReact(sessionId);
		}
		return { ok: true, path: input.path, bytes: Buffer.byteLength(content), preview };
	}

	if (name === "fs_remove") {
		const target = resolveInSession(sessionId, input.path);
		if (target === sessionDir(sessionId)) throw new Error("cannot delete workspace root");
		await fsp.rm(target, { recursive: true, force: true });
		return { ok: true };
	}

	if (name === "shell") {
		const command = String(input.command || "").trim();
		if (!command) throw new Error("command required");
		if (command.length > 4000) throw new Error("command too long");
		const cwd = sessionDir(sessionId);
		try {
			const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
				cwd,
				timeout: SHELL_TIMEOUT_MS,
				maxBuffer: MAX_SHELL_BYTES,
				env: { ...SHELL_ENV, HOME: cwd },
			});
			return {
				ok: true,
				stdout: clip(stdout, MAX_SHELL_BYTES),
				stderr: clip(stderr, MAX_SHELL_BYTES),
			};
		} catch (err) {
			return {
				ok: false,
				stdout: clip(err.stdout, MAX_SHELL_BYTES),
				stderr: clip(err.stderr || err.message, MAX_SHELL_BYTES),
				code: err.code ?? err.status ?? 1,
			};
		}
	}

	if (name === "http_request") {
		const url = await assertPublicUrl(input.url);
		const method = String(input.method || "GET").toUpperCase();
		const headers = {};
		if (input.headers && typeof input.headers === "object") {
			for (const [k, v] of Object.entries(input.headers)) {
				const key = String(k).toLowerCase();
				if (key === "host" || key === "cookie" || key === "authorization") continue;
				headers[k] = String(v);
			}
		}
		const res = await fetch(url, {
			method,
			headers,
			body: ["GET", "HEAD"].includes(method) ? undefined : input.body,
			redirect: "manual",
			signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
		});
		const buf = Buffer.from(await res.arrayBuffer());
		const text = clip(buf.toString("utf8"), MAX_HTTP_BYTES);
		const hdrs = {};
		res.headers.forEach((v, k) => {
			if (["set-cookie"].includes(k)) return;
			hdrs[k] = v;
		});
		return { status: res.status, headers: hdrs, body: text };
	}

	if (name === "react_preview") {
		if (typeof input.code === "string") {
			const file = resolveInSession(sessionId, "src/App.jsx");
			await fsp.writeFile(file, input.code, "utf8");
		}
		if (typeof input.css === "string") {
			const file = resolveInSession(sessionId, "src/styles.css");
			await fsp.writeFile(file, input.css, "utf8");
		}
		return bundleReact(sessionId);
	}

	throw new Error(`unknown tool: ${name}`);
}

export async function bundleReact(sessionId) {
	await ensureSession(sessionId);
	const root = sessionDir(sessionId);
	try {
		const appFile = fs.existsSync(path.join(root, "src", "App.jsx"))
			? "./src/App.jsx"
			: "./src/App.js";
		const result = await esbuild.build({
			stdin: {
				contents: `import { createRoot } from "react-dom/client";
import App from ${JSON.stringify(appFile)};
createRoot(document.getElementById("root")).render(<App />);
`,
				resolveDir: root,
				loader: "jsx",
				sourcefile: "preview-entry.jsx",
			},
			bundle: true,
			write: false,
			format: "iife",
			jsx: "automatic",
			platform: "browser",
			target: ["es2020"],
			minify: true,
			define: { "process.env.NODE_ENV": '"production"' },
			logLevel: "silent",
			absWorkingDir: root,
			nodePaths: NODE_PATHS,
			loader: { ".js": "jsx", ".jsx": "jsx" },
		});
		const js = result.outputFiles.map((f) => f.text).join("\n");
		let css = "";
		try {
			css = await fsp.readFile(path.join(root, "src", "styles.css"), "utf8");
		} catch {
			css = "";
		}
		const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>preview</title>
  <style>${css}</style>
</head>
<body>
  <div id="root"></div>
  <script>${js}</script>
</body>
</html>`;
		await fsp.writeFile(path.join(root, "preview.html"), html, "utf8");
		return { ok: true, preview: "/preview" };
	} catch (err) {
		const message = err.errors
			? err.errors.map((e) => e.text).join("\n")
			: err.message;
		const html = `<!doctype html><html><body style="font-family:ui-monospace,monospace;background:#1a120f;color:#ffb4a8;padding:24px;white-space:pre-wrap">${escapeHtml(message)}</body></html>`;
		await fsp.writeFile(path.join(root, "preview.html"), html, "utf8");
		return { ok: false, error: message, preview: "/preview" };
	}
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export async function readPreviewHtml(sessionId) {
	await bundleReact(sessionId);
	const file = resolveInSession(sessionId, "preview.html");
	return fsp.readFile(file, "utf8");
}
