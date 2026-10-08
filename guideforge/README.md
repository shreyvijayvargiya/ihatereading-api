# GuideForge

AI Research & Engineering Guide Builder for [iHateReading](https://ihatereading.in).

GuideForge turns a topic + keywords into a deeply researched, production-oriented engineering guide in Markdown — with live research visibility, filesystem storage, and image-generation plans.

## Why it exists

Most AI writing tools hide research. GuideForge treats research as the product:

- queries are visible
- scraped URLs are visible
- phases update live
- evidence is stored on disk
- the final guide is auditable Markdown

## Architecture

```text
guideforge/web     Vite React CRM (port 5174)
guideforge/server  HonoJS API (port 8790)
        │
        ├── OpenRouter (planning / synthesis / writing / image prompts)
        └── SCRAPER_BASE_URL → existing ihatereading-api
              POST /google-search
              POST /scrape
              POST /scrape-multiple
```

No database. Jobs and guides live under `server/data/`.

## Directory structure

```text
guideforge/
├── web/                 # CRM frontend
├── server/
│   ├── src/
│   │   ├── routes/      # research, guides, jobs, settings
│   │   ├── ai/          # OpenRouter + pipeline
│   │   ├── research/    # orchestrator
│   │   ├── scraper/     # client to existing APIs
│   │   ├── guides/      # markdown storage
│   │   └── storage/     # filesystem helpers
│   └── data/
│       ├── jobs/
│       ├── guides/<slug>/
│       └── research/
└── README.md
```

## Environment

Copy `server/.env.example` to `server/.env`:

```env
# File: guideforge/server/.env  (NOT the repo-root .env, NOT the Vite app)
PORT=8790
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=openai/gpt-4o-mini
SCRAPER_BASE_URL=http://127.0.0.1:3002
GOOGLE_SEARCH_ENDPOINT=/google-search
SCRAPE_URL_ENDPOINT=/scrape
SCRAPE_MULTIPLE_ENDPOINT=/scrape-multiple
```

If chat returns `User not found`, the key is invalid/revoked — create a new key at openrouter.ai and paste it into `guideforge/server/.env`, then restart the GuideForge server.

## Run

Terminal 1 — existing scraper API (ihatereading-api):

```bash
npm start
# http://127.0.0.1:3002
```

Terminal 2 — GuideForge API:

```bash
cd guideforge/server
npm install
cp .env.example .env   # set a valid OPENROUTER_API_KEY
npm run dev
# http://127.0.0.1:8790
```

Terminal 3 — GuideForge web:

```bash
cd guideforge/web
npm install
npm run dev
# http://127.0.0.1:5174
```

Or from `guideforge/`:

```bash
./scripts/dev.sh
```

OpenRouter chat must accept the key (models list alone is not enough). If chat returns `User not found`, replace `OPENROUTER_API_KEY` with a valid key — research still runs with search/scrape + fallback guide drafting.

## Research jobs

```http
POST /api/research
→ { jobId, status: "queued" }

GET /api/research/:id
→ live job with phases, queries, scrapedUrls, activity, progress
```

The browser never waits for the full research run. The dashboard polls every 2s.

## Guide storage

```text
server/data/guides/<slug>/
  guide.md
  metadata.json
  research.json
  sources.json
  image-plan.json
  sections.json
  status.json
```

## Image plans

V1 produces detailed image-generation prompts (banner, architecture, phase diagrams).  
Providers (OpenAI/Flux/Replicate) can be plugged in later via a generate hook — not included in V1.

## Adding a research phase

1. Add an id to `PHASE_DEFS` in `server/src/utils/helpers.js`
2. Add a query hint in `PHASE_QUERY_HINTS` in `orchestrator.js`
3. Wire enable/disable flags in `expandPhaseFlags`

## Notes

- Do not invent packages, repos, stars, or prices when evidence is missing — the writer prompts enforce verification language.
- A single failed URL does not fail the job.
- Job state is saved after each phase for resumability of completed work after restarts (in-flight jobs need re-queue in V1).
