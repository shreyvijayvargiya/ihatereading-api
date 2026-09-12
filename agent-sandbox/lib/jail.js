import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const SESSION_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_FILE_BYTES = Number(process.env.SANDBOX_MAX_FILE_BYTES || 1_000_000);
const MAX_TREE_ENTRIES = 400;

export function dataRoot() {
	if (process.env.SANDBOX_DATA_DIR) {
		return path.resolve(process.env.SANDBOX_DATA_DIR);
	}
	if (process.env.VERCEL) return path.join(os.tmpdir(), "agent-sandbox");
	return path.join(ROOT, ".data");
}

export function normalizeSessionId(raw) {
	const id = String(raw || "").trim();
	if (SESSION_RE.test(id)) return id;
	return "default";
}

export function newSessionId() {
	return `s_${randomBytes(6).toString("hex")}`;
}

export function sessionDir(sessionId) {
	const id = normalizeSessionId(sessionId);
	return path.join(dataRoot(), id);
}

export function assertInside(root, target) {
	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(target);
	const prefix = resolvedRoot.endsWith(path.sep)
		? resolvedRoot
		: resolvedRoot + path.sep;
	if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
		throw new Error("path escapes workspace");
	}
	return resolved;
}

export function resolveInSession(sessionId, rel = ".") {
	const root = sessionDir(sessionId);
	const cleaned = String(rel || ".").replace(/\\/g, "/");
	if (cleaned.includes("\0")) throw new Error("invalid path");
	return assertInside(root, path.join(root, cleaned));
}

const STARTER_APP = `import { useState } from "react";

export default function App() {
  const [n, setN] = useState(0);
  return (
    <main className="wrap">
      <p className="kicker">agent sandbox</p>
      <h1>Write React in src/App.jsx</h1>
      <p>
        The agent can edit files, run shell commands, call APIs, and this
        preview rebuilds with esbuild.
      </p>
      <button type="button" onClick={() => setN((v) => v + 1)}>
        clicks {n}
      </button>
    </main>
  );
}
`;

const STARTER_CSS = `html, body, #root { margin: 0; min-height: 100%; }
body {
  font-family: ui-sans-serif, system-ui, sans-serif;
  background: #11140f;
  color: #e8eadf;
}
.wrap { padding: 32px; max-width: 520px; }
.kicker {
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-size: 11px;
  color: #9aaa6a;
}
h1 { font-size: 28px; font-weight: 560; margin: 8px 0 12px; }
p { line-height: 1.5; color: #c5cbb8; }
button {
  margin-top: 16px;
  border: 0;
  border-radius: 999px;
  padding: 10px 16px;
  background: #d6f26a;
  color: #1a2208;
  font-weight: 650;
  cursor: pointer;
}
`;

const STARTER_ENTRY = `import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);
`;

export async function ensureSession(sessionId) {
	const root = sessionDir(sessionId);
	await fsp.mkdir(path.join(root, "src"), { recursive: true });
	const appPath = path.join(root, "src", "App.jsx");
	if (!fs.existsSync(appPath)) {
		await fsp.writeFile(appPath, STARTER_APP, "utf8");
		await fsp.writeFile(path.join(root, "src", "styles.css"), STARTER_CSS, "utf8");
		await fsp.writeFile(path.join(root, "src", "main.jsx"), STARTER_ENTRY, "utf8");
		await fsp.writeFile(
			path.join(root, "NOTES.md"),
			"# Workspace\n\nThis folder is the agent jail. Stay inside it.\n",
			"utf8",
		);
	}
	return root;
}

export { MAX_FILE_BYTES, MAX_TREE_ENTRIES };
