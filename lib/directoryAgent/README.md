# Human-in-the-loop directory submission agent

An AI browser agent that submits a SaaS product to a directory website and **pauses whenever a human is
needed** (login, CAPTCHA, badge/ownership proof, final approval, long review waits). One task = one
Playwright browser session that stays alive across pauses (max 24h). Filesystem storage only
(`data/directory-agent/`, git-ignored). No queue, Redis, LangGraph, etc.

Dashboard: `GET /directory-agent` — requires a long-running Node server (browsers + SSE), not serverless.

## Env

| Var | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | Enables the AI planner / field mapper (`DIRECTORY_AGENT_MODEL` to pick a model). Without it, heuristics run alone. |
| `DIRECTORY_AGENT_TOKEN` | Bearer token for `/api/tasks*` (required when `NODE_ENV=production`). Dashboard has a token box; SSE/GETs also accept `?token=`. |
| `GITHUB_TOKEN` | Enables "add badge automatically" (clone → edit README → commit → push → verify). |
| `DIRECTORY_AGENT_DIR` | Storage dir (default `./data/directory-agent`). |
| `DIRECTORY_AGENT_MAX_BROWSERS` | Concurrent browsers; extra tasks stay `QUEUED` (default 5). |
| `DIRECTORY_AGENT_HEADLESS=false` | Show a real browser window. |
| `DIRECTORY_AGENT_CHROMIUM_PATH` | Custom Chromium executable. |
| `DIRECTORY_AGENT_CHECK_INTERVAL_MS` | Follow-up check cadence while waiting for review (default 6h). |
| `DIRECTORY_AGENT_ALLOW_PRIVATE=1` | Allow localhost/private URLs (tests only; otherwise SSRF-blocked). |

## State machine

`QUEUED → RUNNING → WAITING_FOR_{LOGIN|CAPTCHA|BADGE|APPROVAL|CONFIRMATION} → … → COMPLETED | FAILED | CANCELLED`

Waiting states only leave through `RUNNING` (approve / resume / check-status) or an end state. `status` is
`queued | running | paused | completed | failed | cancelled`. Pauses expire (→ `FAILED`) after 24h;
`WAITING_FOR_CONFIRMATION` is exempt and is polled on a schedule.

Steps: `find_submission_page → analyze_form → fill_form → badge_check → preview → submit → post_submit`,
plus `check_status` for follow-ups. Every step is idempotent, a gate cleared by a human is not raised again
for that step, and failures end the task — nothing retries in a loop.

## API

```
POST /api/tasks                  { directoryUrl, product:{name,website,description,tagline?,tags?,category?,email?,logoUrl?}, githubRepo?, submissionUrl? }
GET  /api/tasks[?state=]         GET /api/tasks/events (SSE)      GET /api/tasks/:id
POST /api/tasks/:id/approve      approve the pending card (body {force:true} accepts an unverifiable badge)
POST /api/tasks/:id/decline      decline (cancels; for the GitHub proposal falls back to manual)
POST /api/tasks/:id/resume       "Continue" after the human logged in / solved the CAPTCHA
POST /api/tasks/:id/cancel
POST /api/tasks/:id/check-status[?wait=1]   open the directory, check listing/review status
GET  /api/tasks/:id/screenshots/:file
GET  /api/tasks/:id/live/frame   POST /api/tasks/:id/live/input   (click|type|key|scroll|goto|back)
```

Login/CAPTCHA flow: pause → card `[Approve][Decline]` → **Approve** opens the live browser in the dashboard
(OAuth popups included) → human acts → **Continue** (`/resume`). Badge flow: card shows the extracted
`badgeCode`; **Approve** verifies it (GitHub README / website / the directory's own verify button) and re-pauses
with the reason if not found. Final card shows the submission preview; nothing is sent until **Submit**.

Browser tools (`browser.js`): `open click type upload wait screenshot extract pause resume`. Cookies are saved on
every pause, so a task also resumes after a server restart (the form is re-filled; an approved preview isn't re-asked
if unchanged). A restart mid-submit goes to `WAITING_FOR_CONFIRMATION` instead of risking a double submit.

Test: `DIRECTORY_AGENT_CHROMIUM_PATH=… npm run test:directory-agent` (fake directory covering the whole flow).
