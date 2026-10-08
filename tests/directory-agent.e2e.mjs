/**
 * End-to-end test for the human-in-the-loop directory agent against a fake directory.
 *   DIRECTORY_AGENT_CHROMIUM_PATH=/path/to/chrome node tests/directory-agent.e2e.mjs
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "da-e2e-"));
process.env.DIRECTORY_AGENT_DIR = dataDir;
process.env.DIRECTORY_AGENT_ALLOW_PRIVATE = "1";
process.env.DIRECTORY_AGENT_SCHEDULER = "0";
delete process.env.OPENROUTER_API_KEY;

/* ------------------------------ fake directory ------------------------------ */
const site = { gitDir: "", hasBadge: false, approved: false, submissions: [], port: 0 };
const base = () => `http://127.0.0.1:${site.port}`;
const BADGE = () => `<a href="${base()}/badge-link"><img src="${base()}/badge.svg" alt="Listed on FakeDir"></a>`;
const page = (body, title = "FakeDir") => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const server = http.createServer((req, res) => {
	const url = new URL(req.url, base());
	const cookie = req.headers.cookie || "";
	const authed = cookie.includes("sess=1");
	const send = (body, code = 200, headers = {}) => {
		res.writeHead(code, { "content-type": "text/html", ...headers });
		res.end(body);
	};
	if (url.pathname === "/") {
		return send(page(`<nav><a href="/login">Log in</a> <a href="/blog">Blog</a> <a href="/submit">Submit your tool</a></nav><h1>FakeDir</h1><p>Best AI tools</p>`));
	}
	if (url.pathname === "/repos/acme/app/readme") {
		res.writeHead(200, { "content-type": "text/plain" });
		return res.end(execFileSync("git", ["--git-dir", site.gitDir, "show", "HEAD:README.md"]).toString());
	}
	if (url.pathname === "/do-login") return send("", 302, { "set-cookie": "sess=1; Path=/", location: "/submit" });
	if (url.pathname === "/product") return send(page(`<h1>Acme Product</h1>${site.hasBadge ? BADGE() : ""}`));
	if (url.pathname === "/captcha-frame") return send(page("<p>captcha</p>"));
	if (url.pathname === "/api/verify-badge") {
		res.writeHead(200, { "content-type": "application/json" });
		let ok = site.hasBadge;
		if (!ok && site.gitDir) {
			try {
				ok = execFileSync("git", ["--git-dir", site.gitDir, "show", "HEAD:README.md"]).toString().includes("badge.svg");
			} catch {}
		}
		return res.end(JSON.stringify({ ok }));
	}
	if (url.pathname === "/submit" && req.method === "GET") {
		if (!authed) {
			return send(page(`<h1>Sign in to submit</h1><form action="/login"><input type="email" name="e"><input type="password" name="p"><button>Sign in</button></form><button>Continue with Google</button>`));
		}
		return send(page(`
<header><a href="/login">Log in</a><input type="search" name="q" placeholder="Search"></header>
<h1>Submit your tool</h1>
<form method="post" action="/submit">
<label for="n">Tool name</label><input id="n" name="name" required>
<label for="w">Website URL</label><input id="w" name="website" type="url" required>
<label for="t">Tagline</label><input id="t" name="tagline" maxlength="60">
<label for="d">Description</label><textarea id="d" name="description" required></textarea>
<label for="c">Category</label><select id="c" name="category"><option value="">Choose</option><option>Developer Tools</option><option>Marketing</option><option>Productivity</option></select>
<label for="tg">Tags</label><input id="tg" name="tags">
<label for="e">Your email</label><input id="e" name="email" type="email" required>
<input name="hp_field" style="display:none">
<label><input type="checkbox" name="agree" required> I agree to the terms</label>
<section><h3>Verify ownership</h3><p>Add this badge to your website to prove ownership:</p>
<pre>${BADGE().replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
<button type="button" onclick="fetch('/api/verify-badge').then(r=>r.json()).then(j=>document.getElementById('vr').textContent=j.ok?'Badge verified':'Badge not found')">Verify badge</button><span id="vr"></span></section>
<iframe src="/captcha-frame?recaptcha/api2/anchor" width="300" height="78"></iframe>
<button type="submit">Submit tool</button>
</form>`));
	}
	if (url.pathname === "/submit" && req.method === "POST") {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			site.submissions.push(Object.fromEntries(new URLSearchParams(body)));
			send("", 303, { location: "/submissions/42" });
		});
		return;
	}
	if (url.pathname === "/submissions/42") {
		return send(page(site.approved ? `<h1>Your tool is approved and live!</h1>` : `<h1>Thank you!</h1><p>Your submission is under review. Approval takes 2-3 business days.</p>`));
	}
	send(page("<h1>404</h1>"), 404);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
site.port = server.address().port;

/* --------------------------------- harness --------------------------------- */
const { directoryAgentRouter: app } = await import("../lib/directoryAgentRouter.js");
const { sweep } = await import("../lib/directoryAgent/agent.js");
const { closeAllSessions } = await import("../lib/directoryAgent/browser.js");

const call = async (method, p, body) => {
	const res = await app.request(p, {
		method,
		headers: { "content-type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	const type = res.headers.get("content-type") || "";
	return { status: res.status, json: type.includes("json") ? await res.json() : null, res };
};
const getTask = async (id) => (await call("GET", `/api/tasks/${id}`)).json.task;
async function waitFor(id, pred, label, ms = 60_000) {
	const end = Date.now() + ms;
	let t;
	while (Date.now() < end) {
		t = await getTask(id);
		if (pred(t)) return t;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`Timed out waiting for ${label}; state=${t.state} step=${t.currentStep} err=${t.error}\n${t.logs.slice(-8).map((l) => l.message).join("\n")}`);
}
const inState = (s) => (t) => t.state === s;
const step = (msg) => console.log(`✓ ${msg}`);

let failed = false;
try {
	/* 1. create + login wall */
	const created = await call("POST", "/api/tasks", {
		directoryUrl: base(),
		product: {
			name: "Acme Product",
			website: `${base()}/product`,
			tagline: "Ship faster with Acme",
			description: "Acme helps teams ship software faster with automated workflows.",
			category: "Developer Tools",
			tags: ["automation", "devtools"],
			email: "founder@acme.test",
		},
	});
	assert.equal(created.status, 201);
	const id = created.json.task.id;
	let t = await waitFor(id, inState("WAITING_FOR_LOGIN"), "login wall");
	assert.equal(t.card.title, "Google Login Required");
	assert.equal(t.approvalRequired, true);
	assert.ok(t.session.browserId && t.session.pageId && t.session.taskId === id);
	assert.ok(t.screenshots.length >= 1);
	step("pauses with WAITING_FOR_LOGIN + approval card + saved screenshot");

	// live input must be refused until the human approved
	assert.equal((await call("POST", `/api/tasks/${id}/live/input`, { type: "back" })).status, 409);

	/* 2. approve opens live session, human logs in through live view, continue */
	await call("POST", `/api/tasks/${id}/approve`);
	t = await getTask(id);
	assert.equal(t.liveSessionOpen, true);
	assert.equal(t.card.type, "continue");
	const frame = await call("GET", `/api/tasks/${id}/live/frame`);
	assert.equal(frame.status, 200);
	assert.equal(frame.res.headers.get("content-type"), "image/jpeg");
	const g = await call("POST", `/api/tasks/${id}/live/input`, { type: "goto", url: `${base()}/do-login` });
	assert.equal(g.status, 200);
	await call("POST", `/api/tasks/${id}/resume`);
	step("approve → live browser → human login → resume");

	/* 3. badge */
	t = await waitFor(id, inState("WAITING_FOR_BADGE"), "badge pause");
	assert.equal(t.card.title, "Badge Verification Required");
	assert.match(t.card.data.badgeCode, /badge\.svg/);
	step("detects badge requirement and extracts badge code");

	await call("POST", `/api/tasks/${id}/approve`); // badge NOT on site yet
	t = await waitFor(id, (x) => x.state === "WAITING_FOR_BADGE" && /not found/i.test(x.humanMessage || ""), "badge re-pause");
	step("verification failure re-pauses (no retry loop)");

	site.hasBadge = true;
	await call("POST", `/api/tasks/${id}/approve`);
	t = await waitFor(id, inState("WAITING_FOR_APPROVAL"), "preview approval");
	step("badge verified → resumes to preview");

	/* 4. preview */
	assert.equal(t.card.title, "Submission Preview");
	assert.equal(t.card.data.summary.name, "Acme Product");
	const vals = Object.fromEntries(t.card.data.fields.map((f) => [f.label.toLowerCase(), f.value]));
	assert.equal(vals["tool name"], "Acme Product");
	assert.equal(vals["category"], "Developer Tools");
	assert.equal(vals["your email"], "founder@acme.test");
	assert.equal(site.submissions.length, 0, "nothing submitted before approval");
	step("preview shows filled form; nothing submitted yet");

	/* 5. approve → captcha gate before submit */
	await call("POST", `/api/tasks/${id}/approve`);
	t = await waitFor(id, inState("WAITING_FOR_CAPTCHA"), "captcha");
	assert.equal(site.submissions.length, 0);
	await call("POST", `/api/tasks/${id}/approve`);
	await call("POST", `/api/tasks/${id}/resume`);
	t = await waitFor(id, inState("WAITING_FOR_CONFIRMATION"), "confirmation wait");
	assert.equal(site.submissions.length, 1);
	assert.equal(site.submissions[0].name, "Acme Product");
	assert.equal(site.submissions[0].tagline, "Ship faster with Acme");
	assert.match(site.submissions[0].tags, /automation/);
	assert.equal(site.submissions[0].agree, "on");
	assert.equal(site.submissions[0].hp_field, "", "honeypot untouched");
	const conf = t.data.confirmation;
	assert.match(conf.confirmationUrl, /\/submissions\/42$/);
	assert.ok(Date.parse(conf.expectedReviewDate) > Date.now());
	assert.equal(t.session, null, "browser released while sleeping");
	step("captcha gate → submit → WAITING_FOR_CONFIRMATION with confirmation data");

	/* 6. follow-up: still pending, then approved */
	t = (await call("POST", `/api/tasks/${id}/check-status?wait=1`)).json.task;
	assert.equal(t.state, "WAITING_FOR_CONFIRMATION");
	assert.equal(t.data.confirmation.checks, 1);
	site.approved = true;
	t = (await call("POST", `/api/tasks/${id}/check-status?wait=1`)).json.task;
	assert.equal(t.state, "COMPLETED");
	assert.equal((await call("POST", `/api/tasks/${id}/check-status`)).status, 409);
	step("check-status: pending → approved → COMPLETED");

	/* 7. cancel, decline, validation, list, 24h expiry */
	const t2 = (await call("POST", "/api/tasks", { directoryUrl: base(), product: { name: "B", website: `${base()}/product`, description: "d" } })).json.task;
	await waitFor(t2.id, inState("WAITING_FOR_LOGIN"), "second task login");
	const cancelled = await call("POST", `/api/tasks/${t2.id}/cancel`);
	assert.equal(cancelled.json.task.state, "CANCELLED");
	assert.equal((await call("POST", `/api/tasks/${t2.id}/cancel`)).status, 409);

	const t3 = (await call("POST", "/api/tasks", { directoryUrl: base(), product: { name: "C", website: `${base()}/product`, description: "d" } })).json.task;
	await waitFor(t3.id, inState("WAITING_FOR_LOGIN"), "third task login");
	const file = path.join(dataDir, "tasks", t3.id, "task.json");
	const raw = JSON.parse(fs.readFileSync(file, "utf8"));
	raw.pauseExpiresAt = new Date(Date.now() - 1000).toISOString();
	fs.writeFileSync(file, JSON.stringify(raw));
	await sweep();
	assert.equal((await getTask(t3.id)).state, "FAILED");
	assert.match((await getTask(t3.id)).error, /24 hours/);

	const t4 = (await call("POST", "/api/tasks", { directoryUrl: base(), product: { name: "D", website: `${base()}/product`, description: "d" } })).json.task;
	await waitFor(t4.id, inState("WAITING_FOR_LOGIN"), "fourth task login");
	assert.equal((await call("POST", `/api/tasks/${t4.id}/decline`)).json.task.state, "CANCELLED");

	assert.equal((await call("POST", "/api/tasks", { directoryUrl: "not a url" })).status, 400);
	assert.equal((await call("GET", "/api/tasks/nope")).status, 404);
	const list = await call("GET", "/api/tasks");
	assert.equal(list.json.count, 4);
	process.env.DIRECTORY_AGENT_TOKEN = "secret";
	assert.equal((await call("GET", "/api/tasks")).status, 401);
	delete process.env.DIRECTORY_AGENT_TOKEN;
	step("cancel / decline / 24h expiry / validation / list / auth");


	/* 8. session restore after a "server restart" (browser gone, cookies on disk) */
	const driveLogin = async (tid) => {
		await waitFor(tid, inState("WAITING_FOR_LOGIN"), "login");
		await call("POST", `/api/tasks/${tid}/approve`);
		await call("POST", `/api/tasks/${tid}/live/input`, { type: "goto", url: `${base()}/do-login` });
		await call("POST", `/api/tasks/${tid}/resume`);
	};
	site.hasBadge = true;
	const product = { name: "Restore Co", website: `${base()}/product`, description: "Restore test product", category: "Marketing", email: "r@acme.test" };
	const t5 = (await call("POST", "/api/tasks", { directoryUrl: base(), product })).json.task;
	await driveLogin(t5.id);
	await waitFor(t5.id, inState("WAITING_FOR_BADGE"), "t5 badge");
	await call("POST", `/api/tasks/${t5.id}/approve`);
	await waitFor(t5.id, inState("WAITING_FOR_APPROVAL"), "t5 approval");
	await closeAllSessions(); // simulate crash/restart
	await call("POST", `/api/tasks/${t5.id}/approve`);
	await waitFor(t5.id, inState("WAITING_FOR_CAPTCHA"), "t5 captcha after restore");
	assert.equal(site.submissions.length, 1, "form was re-filled but not yet submitted");
	await call("POST", `/api/tasks/${t5.id}/approve`);
	await call("POST", `/api/tasks/${t5.id}/resume`);
	await waitFor(t5.id, inState("WAITING_FOR_CONFIRMATION"), "t5 submitted");
	assert.equal(site.submissions.length, 2);
	assert.equal(site.submissions[1].name, "Restore Co");
	step("browser restored from saved cookies; re-fills and resumes without re-approval");

	/* 9. GitHub badge automation (local bare repo stands in for GitHub) */
	const gh = fs.mkdtempSync(path.join(os.tmpdir(), "da-gh-"));
	site.gitDir = path.join(gh, "acme", "app.git");
	fs.mkdirSync(path.dirname(site.gitDir), { recursive: true });
	execFileSync("git", ["init", "--bare", "-b", "main", site.gitDir]);
	const seed = path.join(gh, "seed");
	execFileSync("git", ["clone", site.gitDir, seed], { stdio: "ignore" });
	fs.writeFileSync(path.join(seed, "README.md"), "# App\n\nHello\n");
	execFileSync("git", ["-C", seed, "add", "."]);
	execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], { stdio: "ignore" });
	execFileSync("git", ["-C", seed, "push", "origin", "HEAD:main"], { stdio: "ignore" });
	process.env.GITHUB_TOKEN = "test-token";
	process.env.GITHUB_GIT_BASE = `file://${gh}`;
	process.env.GITHUB_API_BASE = base();
	site.hasBadge = false; // website has no badge: verification must come from the README

	const t6 = (await call("POST", "/api/tasks", { directoryUrl: base(), githubRepo: "acme/app", product: { ...product, name: "Gh Co" } })).json.task;
	await driveLogin(t6.id);
	t = await waitFor(t6.id, inState("WAITING_FOR_BADGE"), "t6 badge");
	assert.equal(t.card.type, "github_badge");
	// decline falls back to the manual card
	t = (await call("POST", `/api/tasks/${t6.id}/decline`)).json.task;
	assert.equal(t.state, "WAITING_FOR_BADGE");
	assert.equal(t.card.type, "badge");
	assert.equal((await call("POST", `/api/tasks/${t6.id}/resume`)).status, 200); // manual verify -> fails (nothing placed)
	await waitFor(t6.id, (x) => x.state === "WAITING_FOR_BADGE" && /not found/i.test(x.humanMessage), "t6 manual fail");
	step("github proposal declined → manual badge card");
	await call("POST", `/api/tasks/${t6.id}/cancel`);

	const t7 = (await call("POST", "/api/tasks", { directoryUrl: base(), githubRepo: "acme/app", product: { ...product, name: "Gh Co 2" } })).json.task;
	await driveLogin(t7.id);
	t = await waitFor(t7.id, inState("WAITING_FOR_BADGE"), "t7 badge");
	assert.equal(t.card.type, "github_badge");
	await call("POST", `/api/tasks/${t7.id}/approve`);
	t = await waitFor(t7.id, (x) => x.state === "WAITING_FOR_APPROVAL" || x.state === "FAILED" || (x.state === "WAITING_FOR_BADGE" && x.card.type === "badge"), "t7 after github");
	assert.equal(t.state, "WAITING_FOR_APPROVAL", t.humanMessage);
	const readme = execFileSync("git", ["--git-dir", site.gitDir, "show", "HEAD:README.md"]).toString();
	assert.match(readme, /badge\.svg/);
	assert.match(readme, /^# App\n\n<a href/);
	step("github automation: clone → edit README → commit → push → verify → resume");
	fs.rmSync(gh, { recursive: true, force: true });

	console.log("\nALL PASSED");
} catch (e) {
	failed = true;
	console.error("\nFAILED:", e.stack || e);
} finally {
	await closeAllSessions();
	server.close();
	fs.rmSync(dataDir, { recursive: true, force: true });
	process.exit(failed ? 1 : 0);
}
