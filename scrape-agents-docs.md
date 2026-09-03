# Discovery & Lead Agents — Firestore Docs

All recurring agents that scrape, score with AI, and store into Firestore.
None of these auto-start on `npm run dev`.
Run via CLI or HTTP. Most need the API server for `/google-search` and/or `/scrape`.
Top mobile apps can run without Puppeteer (HTTP Play pages + iTunes RSS).

**Database (all agents):** Firebase project `ihatereading-4ba52`, Firestore database `(default)` via `getFirestore()` in `config/firebase.js`. There is no named secondary database.

---

## Quick reference

| # | Agent | Database | Collection | State / cursor | CLI | HTTP |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Reddit — Karyam | `ihatereading-4ba52` / `(default)` | `redditKaryamPosts` | — | `npm run reddit:karyam` | `POST /reddit-agents/karyam/run` |
| 2 | Reddit — ihatereading | `ihatereading-4ba52` / `(default)` | `redditIhatereadingPosts` | — | `npm run reddit:ihatereading` | `POST /reddit-agents/ihatereading/run` |
| 19 | Reddit — BuildSaaS | `ihatereading-4ba52` / `(default)` | `redditBuildsaasPosts` | — | `npm run reddit:buildsaas` | `POST /reddit-agents/buildsaas/run` |
| 3 | Reddit — SaaS problems | `ihatereading-4ba52` / `(default)` | `redditSaasPosts` | — | `npm run reddit:saas` | `POST /reddit-agents/saas/run` |
| 13 | Reddit — directory ideas | `ihatereading-4ba52` / `(default)` | `redditDirectoryPosts` | `redditDirectoryAgentState` | `npm run reddit:directories` | `POST /reddit-agents/directories/run` |
| 16 | Reddit — scraping problems | `ihatereading-4ba52` / `(default)` | `redditScrapingPosts` | `redditScrapingAgentState` | `npm run reddit:scraping` | `POST /reddit-agents/scraping/run` |
| 17 | Reddit AI scraper (any topic) | `ihatereading-4ba52` / `(default)` | `redditAiScraperPosts` | `redditAiScraperTopics` | `npm run reddit:ai-scraper` | `POST /reddit-ai-scraper/run` |
| 4 | Reddit monitor (legacy SaaSCRM) | `ihatereading-4ba52` / `(default)` | `redditPosts`, `redditDrafts` | scheduler | auto on local `dev` + QStash | `POST /reddit/run` |
| 5 | Maps — Karyam local leads | `ihatereading-4ba52` / `(default)` | `mapsKaryamLeads` | `mapsKaryamAgentState` | `npm run maps:karyam` | `POST /maps-agents/karyam-local/run` |
| 6 | Karyam LinkedIn leads | `ihatereading-4ba52` / `(default)` | `karyamLinkedInLeads` | `karyamLinkedInState` | `npm run karyam:linkedin` | `POST /karyam-linkedin` |
| 7 | Angel / seed investors | `ihatereading-4ba52` / `(default)` | `angel-seed-investors` | `angelSeedInvestorState` | `npm run angel:investors` | `POST /angel-investors/run` |
| 8 | YC companies | `ihatereading-4ba52` / `(default)` | `yc-companies` | `ycCompaniesState` | `npm run yc:companies` | `POST /yc-companies/run` |
| 9 | Top mobile apps | `ihatereading-4ba52` / `(default)` | `top-mobile-apps` | `topMobileAppsAgentState` | `npm run top:mobile-apps` | `POST /top-mobile-apps/run` |
| 10 | Content research | `ihatereading-4ba52` / `(default)` | `content_research_runs`, `content_calendar` | — | — | `POST /api/content-research` |
| 11 | Company seed | `ihatereading-4ba52` / `(default)` | `companySeeds` | — | — | `POST /company-seed` |
| 12 | Individual influencers | `ihatereading-4ba52` / `(default)` | `individual-influencers` | `individualInfluencersState` | `npm run top:influencers` | `POST /individual-influencers/run` |
| 18 | Dev magazine creators | `ihatereading-4ba52` / `(default)` | `dev-magazine-channels`, `dev-magazine-videos` | `devMagazineAgentState` | `npm run magazine:creators` | `POST /dev-magazine/run` |
| 14 | AI DESIGN.md style prompts | `ihatereading-4ba52` / `(default)` | `ai-styles-prompts` | `aiStylesPromptsAgentState` | `npm run ai:styles` · `npm run ai:styles:enrich` | `POST /ai-styles-prompts/run` · `/enrich` |
| 15 | Claude toprated (chat + tools) | `ihatereading-4ba52` / `(default)` | any name via `table_add_rows` (+ registry `claudeTopratedTables`) | — | — | `POST /claude-toprated/chat` (SSE) |
| 20 | iHateReading internet news | `ihatereading-4ba52` / `(default)` | `ihatereading-internet-news` | `ihatereadingInternetNewsState` | `npm run news:ihatereading` | `POST /internet-news/run` |
| 21 | England football clubs | `ihatereading-4ba52` / `(default)` | `clubs` | `englandClubsState` | `npm run england:clubs` | `POST /england-clubs/run` |
| 22 | Karyam B2B founders | `ihatereading-4ba52` / `(default)` | `karyamFounderLeads` | `karyamFounderAgentState` | `npm run karyam:founders` | `POST /karyam-founders/run` |


Shared scrape primitives: `/scrape`, `/scrape-google-news`, `/scrape-google-maps`, `/google-search`, `/scrape-instagram`, `/scrape-x`, `/scrape-youtube-channel`.
Shared LLM: OpenRouter (`OPENROUTER_API_KEY`) — **opt-in** for Reddit agents (`--llm` / `{ "llm": true }`). Default Reddit runs are scrape-only.

---



## Common patterns

1. **Discover** — RSS, Google SERP, Maps, iTunes RSS, HTTP store category pages, or structured JSON feeds
2. **Dedupe** — SHA-256 hash doc ids (permalink / domain / store id / LinkedIn handle)
3. **Enrich** — optional `/scrape` or HTTP fetch of profile/site/store pages (screenshots, founders, socials)
4. **Score / purify** — OpenRouter JSON → `relevanceScore`, draft message, reasoning (mobile apps skip reject; store all listings)
5. **Store** — Firestore merge; cursor collection rotates queries across runs

Default loop interval for most CLIs: **20–30 seconds**.  
Target caps where relevant (e.g. mobile apps stop at **10,000** unique docs).

---



## 1. Reddit — Karyam Agency Monitor

**Purpose:** Find Reddit posts where founders / businesses need a software agency (MVP, web/app, ecommerce).


|                |                                                                         |
| -------------- | ----------------------------------------------------------------------- |
| **Collection** | `redditKaryamPosts`                                                     |
| **Code**       | `lib/redditAgents/karyam.js`, `configs.js`, `core.js`                   |
| **CLI**        | `npm run reddit:karyam`                                                 |
| **API**        | `POST /reddit-agents/karyam/run` · `GET /reddit-agents/karyam/relevant` |


**Sources:** Public `/new/.rss` for subs like `forhire`, `hireaworker`, `webdev`, `reactjs`, `SaaS`, `shopify`, etc.

**Stored fields (typical):** `permalink`, `title`, `body`, `author`, `subreddit`, `relevanceScore`, `relevanceReason`, `draftMessage`, `fetchedAt`

Default is **scrape-only** (no OpenRouter). Pass `--llm` or `{ "llm": true }` to score.

```bash
npm run reddit:karyam
npm run reddit:karyam -- --llm
npm run reddit:agent -- list
curl -X POST http://localhost:3002/reddit-agents/karyam/run
curl -X POST http://localhost:3002/reddit-agents/karyam/run -H 'content-type: application/json' -d '{"llm":true}'
curl http://localhost:3002/reddit-agents/karyam/relevant
```

---



## 2. Reddit — ihatereading Monitor

**Purpose:** Coding / learning threads that can be matched to ihatereading articles.


|                |                                                                                     |
| -------------- | ----------------------------------------------------------------------------------- |
| **Collection** | `redditIhatereadingPosts`                                                           |
| **CLI**        | `npm run reddit:ihatereading`                                                       |
| **API**        | `POST /reddit-agents/ihatereading/run` · `GET /reddit-agents/ihatereading/relevant` |


**Sources:** Coding / learning subreddits + site content matching.

---



## 2b. Reddit — BuildSaaS (boilerplate / starter kit)

**Purpose:** Find founders looking for a Next.js SaaS starter (auth, Polar/Stripe, admin, blog) to sell [buildsaas.dev](https://www.buildsaas.dev/).


|                |                                                                               |
| -------------- | ----------------------------------------------------------------------------- |
| **Collection** | `redditBuildsaasPosts`                                                        |
| **Code**       | `lib/redditAgents/buildsaas.js`, `configs.js`                                 |
| **CLI**        | `npm run reddit:buildsaas`                                                    |
| **API**        | `POST /reddit-agents/buildsaas/run` · `GET /reddit-agents/buildsaas/relevant` |


**Sources:** Google `site:reddit.com` (boilerplate, ShipFast alternatives, Next.js + Firebase/Polar) + RSS (`r/SaaS`, `r/nextjs`, `r/startups`, …). Does not auto-start on `npm run dev`.

```bash
npm run reddit:buildsaas
curl -X POST http://localhost:3002/reddit-agents/buildsaas/run
curl "http://localhost:3002/reddit-agents/buildsaas/relevant?minScore=4"
```

---



## 3. Reddit — SaaS Problem Finder

**Purpose:** Surface SaaS pain / idea posts (founders describing problems).


|                |                                                                     |
| -------------- | ------------------------------------------------------------------- |
| **Database**   | `ihatereading-4ba52` / Firestore `(default)`                        |
| **Collection** | `redditSaasPosts`                                                   |
| **CLI**        | `npm run reddit:saas`                                               |
| **API**        | `POST /reddit-agents/saas/run` · `GET /reddit-agents/saas/relevant` |


**Sources:** Google `site:reddit.com` + seed RSS (`r/saas`, `r/startups`, `r/entrepreneur`, …).

---



## 3b. Reddit — Directory / aggregator ideas

**Purpose:** Find posts asking for collections, alternatives, directories, datasets (Kaggle-style) so you know which directory website to build (design, AI, SaaS, CRM, logos, emails, …).


|                |                                                                                   |
| -------------- | --------------------------------------------------------------------------------- |
| **Collection** | `redditDirectoryPosts`                                                            |
| **State**      | `redditDirectoryAgentState` (rotates ~10 subs + 3 Google queries per tick)        |
| **Code**       | `lib/redditAgents/directoryIdeas.js`, `configs.js`                                |
| **CLI**        | `npm run reddit:directories` (loops 30s) · `npm run reddit:directories:once`      |
| **API**        | `POST /reddit-agents/directories/run` · `GET /reddit-agents/directories/relevant` |


**Stored fields:** permalink, title, body, `relevanceScore`, `ideaTitle`, `directoryCategory`, `tags`, `solutionFit`

```bash
npm run reddit:directories
npm run reddit:directories -- once
npm run reddit:directories -- list
curl -X POST http://localhost:3002/reddit-agents/directories/run
curl "http://localhost:3002/reddit-agents/directories/relevant?tag=AI"
```

Env: `REDDIT_DIRECTORIES_INTERVAL_MS=30000`, `REDDIT_DIRECTORIES_SUBS_PER_RUN=10`, `REDDIT_DIRECTORIES_QUERIES_PER_RUN=3`.

---



## 3c. Reddit — Scraping / data-collection problems

**Purpose:** Find posts about scraping pain, data collection, directories/databases built by crawling, monitoring agents, and AI scraper agents.


|                |                                                                                 |
| -------------- | ------------------------------------------------------------------------------- |
| **Collection** | `redditScrapingPosts`                                                           |
| **State**      | `redditScrapingAgentState` (rotates ~10 of 20 subs + 3 Google queries per tick) |
| **Code**       | `lib/redditAgents/scrapingProblems.js`, `configs.js`                            |
| **CLI**        | `npm run reddit:scraping` (loops 30s) · `npm run reddit:scraping:once`          |
| **API**        | `POST /reddit-agents/scraping/run` · `GET /reddit-agents/scraping/relevant`     |


**Subs (20):** webscraping, scrapy, datasets, datascience, dataengineering, BigData, MachineLearning, LocalLLaMA, LangChain, ChatGPT, OpenAI, automation, n8n, selfhosted, SEO, forhire, slavelabour, python, learnpython, SaaS.

**Stored fields:** permalink, title, body, `relevanceScore`, `problemType`, `intent`, `tags`, `solutionFit`

```bash
npm run reddit:scraping
npm run reddit:scraping -- once
npm run reddit:scraping -- list
curl -X POST http://localhost:3002/reddit-agents/scraping/run
curl "http://localhost:3002/reddit-agents/scraping/relevant?minScore=4"
```

Env: `REDDIT_SCRAPING_INTERVAL_MS=30000`, `REDDIT_SCRAPING_SUBS_PER_RUN=10`, `REDDIT_SCRAPING_QUERIES_PER_RUN=3`.

---



## 3d. Reddit AI scraper (any topic — do not clone monitors)

**Purpose:** One Reddit pipeline for every new research goal. Pass a **prompt** instead of adding another hardcoded agent (karyam / saas / directories / scraping are the same RSS→store loop with different sub lists).

|                |                                                              |
| -------------- | ------------------------------------------------------------ |
| **Collection** | `redditAiScraperPosts` (filter by `topicId`)                 |
| **State**      | `redditAiScraperTopics` (prompt hash → planned subs/queries) |
| **Code**       | `lib/redditAiScraper/`*, `lib/redditAiScraperRouter.js`      |
| **CLI**        | `npm run reddit:ai-scraper -- --prompt "..."`                |
| **API**        | `POST /reddit-ai-scraper/run`                                |

**Default (scrape-only)**

1. **Google** — `site:reddit.com {prompt}` → thread URLs + sub names  
2. **RSS** — `/new/.rss` for a rotating batch of those subs  
3. **Store** — `relevanceScore: 0`, reason `scrape_only`  

**With `--llm` / `{ "llm": true }`**

1. **LLM plan** — understand prompt → Google queries, seed subreddits, keep/reject rules  
2. **Google** — `site:reddit.com` scrape → thread URLs + extra sub names  
3. **LLM pick** — finalize 10–20 subreddits  
4. **RSS** — `/new/.rss` for a rotating batch of those subs  
5. **LLM enrich** — score, tags, intent, summary → store  

Same prompt reuses the topic (does not re-plan unless `rediscover: true`). New prompt = new topic, same agent. First scrape-only run needs Google (omit `--skip-google`).

```bash
npm run reddit:ai-scraper -- --prompt "find people looking for scrapers, data collection, AI scraper agents"
npm run reddit:ai-scraper -- once --prompt "SaaS founders who need a CRM"
npm run reddit:ai-scraper -- --prompt "..." --llm
npm run reddit:ai-scraper -- topics
npm run reddit:ai-scraper -- list --topic scraping-data-collection
```

```http
POST /reddit-ai-scraper/run
{ "prompt": "people hiring web scrapers or needing datasets", "rediscover": false }

POST /reddit-ai-scraper/run
{ "prompt": "...", "llm": true }

GET /reddit-ai-scraper
GET /reddit-ai-scraper/topics
GET /reddit-ai-scraper/posts?topic=scraping-data-collection
```

Env: `REDDIT_AI_SCRAPER_PROMPT`, `REDDIT_AI_SCRAPER_INTERVAL_MS=30000`, `REDDIT_AI_SCRAPER_SUBS_PER_RUN=10`, `REDDIT_AI_SCRAPER_MAX_SUBS=20`, `REDDIT_USE_LLM=1` (same as `--llm`).

---



## 4. Reddit monitor (legacy SaaSCRM)

**Purpose:** Original saascrm.site Reddit relevance monitor.


|                 |                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------- |
| **Collections** | `redditPosts`, `redditDrafts`                                                                       |
| **Code**        | `lib/redditMonitor/`*, `lib/jobs/redditMonitor.js`                                                  |
| **API**         | `POST /reddit/run` (via `redditMonitorRouter`)                                                      |
| **Auto**        | Off on `npm run dev`. Start from the dashboard (saascrm) or QStash via `npm run reddit:qstash-schedule` |


Env: `REDDIT_RSS_MIN_INTERVAL_MS` (default 60000) in `lib/scrapefast.js`.

---



## 5. Google Maps — Karyam Local Leads

**Purpose:** Physical businesses (cafes, shops, clinics, …) who need a website — Karyam outreach.


|                |                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Collection** | `mapsKaryamLeads`                                                                                                     |
| **State**      | `mapsKaryamAgentState` (per-city cursor)                                                                              |
| **Code**       | `lib/mapsAgents/`*, `lib/mapsScrape.js`                                                                               |
| **CLI**        | `npm run maps:karyam` · `npm run maps:karyam:loop`                                                                    |
| **API**        | `POST /maps-agents/karyam-local/run` · `GET /maps-agents/karyam-local/leads` · `GET /maps-agents/karyam-local/cities` |


**Cities (config):** Kota, Jaipur, Bangalore, Mumbai, New Delhi (`delhi` / `new delhi`), Gurugram, Noida, Pune, Hyderabad, Chennai, Kolkata, Ahmedabad, San Francisco (`sf`), New York (`nyc` / `york`), London, Dubai, Singapore. Add more in `lib/mapsAgents/configs.js` — same CLI (`--city`).  
**Pipeline:** city × category Maps queries → Puppeteer scrape (in-process) → optional website email enrich → LLM score → Firestore.

**Key stored fields:** `name`, `address`, `phone`, `website`, `emails`, `image`, `category`, `rating`, `reviews`, `coordinates`, `mapsUrl`, `cityId`, `city`, `country`, `relevanceScore`, `relevanceReason`, `draftMessage`, `websiteStatus`, `outreachChannel`

```bash
npm run maps:karyam -- --city bangalore
npm run maps:karyam -- --city "new delhi"
npm run maps:karyam -- --city york
npm run maps:karyam -- --city sf --queries 6
npm run maps:karyam -- --loop --city mumbai
npm run maps:karyam -- cities
npm run maps:karyam -- cities
npm run maps:karyam -- leads --city kota
```

```http
POST /maps-agents/karyam-local/run
{ "city": "bangalore", "queriesPerRun": 4 }

GET /maps-agents/karyam-local/leads?city=mumbai&minScore=4
GET /maps-agents/karyam-local/cities
```

Env: `MAPS_KARYAM_INTERVAL_MS=30000`, `MAPS_KARYAM_QUERIES_PER_RUN=4`, `MAPS_USE_HTTP_SCRAPE=true` (optional HTTP to `/scrape-google-maps`).

---



## 6. Karyam LinkedIn Leads

**Purpose:** LinkedIn profiles of founders / CTOs who need custom software, MVP, or a development agency.


|                |                                                              |
| -------------- | ------------------------------------------------------------ |
| **Collection** | `karyamLinkedInLeads`                                        |
| **State**      | `karyamLinkedInState` (per geo/city cursor)                  |
| **Code**       | `lib/karyamLinkedIn/agent.js`                                |
| **CLI**        | `npm run karyam:linkedin`                                    |
| **API**        | `POST /karyam-linkedin` · `GET /karyam-linkedin` · `?info=1` |


**Pipeline:** Google → `site:linkedin.com/in` → enrich contacts → LLM score (+ optional re-scrape).

**Geo (default** `in`**):** `in`, `world`, `us`, `uk`, `ae`, `sg`, `au`, `ca`, `de`, `nl`  
**Cities:** bangalore, delhi-ncr, mumbai, pune, hyderabad, jaipur, chennai, sf, nyc, london, dubai, singapore-city

**Key stored fields:** `name`, `title`, `snippet`, `linkedinUrl`, `linkedinHandle`, `city`, `geoId`, `countryCode`, `kind`, `intent`, `emails`, `email`, `phone`, `website`, `businessName`, `relevanceScore`, `needDev`, `draftMessage`

```bash
npm run karyam:linkedin                          # India default, loops
npm run karyam:linkedin -- once --geo world
npm run karyam:linkedin -- --geo us --city sf
npm run karyam:linkedin -- --city bangalore
npm run karyam:linkedin -- list --geo in
npm run karyam:linkedin -- geos
```

```http
POST /karyam-linkedin
{ "geo": "world", "queriesPerRun": 3 }

GET /karyam-linkedin?minScore=4&geo=in
```

Env: `KARYAM_LI_GEO=in`, `KARYAM_LI_CITY=`, `KARYAM_LI_INTERVAL_MS=30000`, `KARYAM_LI_QUERIES_PER_RUN=3`.

---



## 7. Angel / Seed Investors

**Purpose:** Find angels / seed investors (tech, AI, SaaS, food/agri, deep tech, indie) who write cheques. Platforms: X → LinkedIn → Google.


|                |                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------ |
| **Collection** | `angel-seed-investors`                                                                     |
| **State**      | `angelSeedInvestorState`                                                                   |
| **Code**       | `lib/angelInvestors/`*                                                                     |
| **CLI**        | `npm run angel:investors` · `npm run angel:investors:loop`                                 |
| **API**        | `POST /angel-investors/run` · `GET /angel-investors/list` · `GET /angel-investors/queries` |


**Pipeline:** Google SERP per platform → enrich via `/scrape` → LLM score → hash dedupe store.

**Key stored fields:** `name`, `sourcePlatform`, `sector`, `xUrl`, `xHandle`, `linkedinUrl`, `website`, `emails`, `phones`, `relevanceScore`, `relevanceReason`, `draftMessage`, `investorType`, `checkSize`, `sectors`

```bash
npm run angel:investors
npm run angel:investors -- --platform x
npm run angel:investors -- list
npm run angel:investors:loop
```

Env: `ANGEL_INTERVAL_MS=30000`, `ANGEL_QUERIES_PER_RUN=3`, `ANGEL_ENRICH_PER_RUN=8`.

---



## 8. YC Companies

**Purpose:** Real YC startups (hiring / batch / status) — not listicle junk.


|                |                                                                                   |
| -------------- | --------------------------------------------------------------------------------- |
| **Collection** | `yc-companies`                                                                    |
| **State**      | `ycCompaniesState`                                                                |
| **Code**       | `lib/ycCompanies/`*                                                               |
| **CLI**        | `npm run yc:companies` (loops by default) · `npm run yc:companies:once`           |
| **API**        | `POST /yc-companies/run` · `GET /yc-companies/list` · `GET /yc-companies/sources` |


**Sources:** yc-oss public JSON (`hiring`, `all`, `top`, batches), HN Show, Google `site:ycombinator.com/companies`.

**Key stored fields:** `name`, `slug`, `ycUrl`, `website`, `status`, `batch`, `oneLiner`, `industry`, `founders`, `isHiring`, `jobs`, `teamSize`, `investmentAmount`, `valuation`, `email`, `emails`, `address`, `confidence`, `summary`

```bash
npm run yc:companies
npm run yc:companies -- once --hiring
npm run yc:companies -- list --status Active
npm run yc:companies -- sources
```

Env: `YC_INTERVAL_MS=30000`, `YC_PAGE_SIZE=40`, `YC_ENRICH_PER_RUN=8`.

---



## 9. Top Mobile Apps (App Store + Google Play)

**Purpose:** Discover popular **mobile** apps only (no YC / G2 / Product Hunt / AlternativeTo). Stores every listing found — no LLM reject filter.


|                |                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------ |
| **Collection** | `top-mobile-apps`                                                                          |
| **State**      | `topMobileAppsAgentState` (rotates Apple + Play category sources)                          |
| **Code**       | `lib/topApps/`*, `lib/topMobileAppsRouter.js`                                              |
| **CLI**        | `npm run top:mobile-apps` (loops) · `npm run top:mobile-apps:once`                         |
| **API**        | `POST /top-mobile-apps/run` · `GET /top-mobile-apps/list` · `GET /top-mobile-apps/sources` |


**Pipeline (Puppeteer not required):**

1. **Discover listing URLs**
  - Google Play: HTTP fetch of category/chart pages (`/store/apps/category/…`) and extract `/store/apps/details?id=` (including relative hrefs)
  - Apple: official iTunes RSS JSON (`itunes.apple.com/…/rss/topfreeapplications/limit=50/genre=…/json`)
  - Fallback: Google/Firecrawl/CSE/DuckDuckGo `site:play.google.com/store/apps/details` / `site:apps.apple.com/app`
2. **Visit each listing**
  - Play: HTTP details page → name, developer, rating, downloads, website, icon, screenshots (`play-lh.googleusercontent.com`)
  - Apple: iTunes Lookup API → screenshots, icon, rating, seller, website
3. **Founders / socials** — web search (`"{app}" "{developer}" founder OR creator`) + HTTP fetch of developer website
4. **Store** every unique `playStoreId` / `appStoreId` (hash doc id). Cap **10,000**.

**Categories:** Finance, Fitness, Health, Social Networking, Photo & Video, Productivity, Education, Shopping, Food & Drink, Travel, Music, News, Weather, Utilities, Lifestyle, Business, Entertainment, Games, Medical, Sports, Reference, Navigation, Dating, Kids, Top Charts.

**Key stored fields:** `name`, `platform` (`ios` / `android` / `both`), `store`, `category`, `appStoreUrl`, `playStoreUrl`, `appStoreId`, `playStoreId`, `developer`, `developerUrl`, `website`, `rating`, `reviewCount`, `downloads`, `priceLabel`, `iconUrl`, `screenshots`, `images`, `socials`, `founders`, `creators`, `emails`, `githubUrl`, `companyTwitter`, `companyLinkedIn`, `companyGithub`, `storeMetadata`, `mobileOnly: true`

```bash
npm run top:mobile-apps
npm run top:mobile-apps -- once
npm run top:mobile-apps -- once --category Finance
npm run top:mobile-apps -- --platform ios
npm run top:mobile-apps -- --platform android
npm run top:mobile-apps -- list
npm run top:mobile-apps -- count
npm run top:mobile-apps -- sources
```

```http
POST /top-mobile-apps/run
{ "category": "Finance", "platform": "ios" }

GET /top-mobile-apps
GET /top-mobile-apps/list?category=Games&platform=android
GET /top-mobile-apps/sources
```

Env: `TOP_MOBILE_APPS_INTERVAL_MS=30000`, `TOP_MOBILE_APPS_TARGET=10000`, `TOP_MOBILE_APPS_SOURCES_PER_RUN=2`, `TOP_MOBILE_APPS_LISTINGS_PER_SOURCE=40`.  
`OPENROUTER_API_KEY` is optional (listings still store). `--no-enrich` skips listing + founder enrich.

---



## 12. Individual influencers (X + Instagram + YouTube)

**Purpose:** Find **individual people** (not brands, companies, agencies) with public social accounts. LLM assigns niche **tags** for client-side filters (Spirituality, Fitness, Tech, … plus `top influencers` when notable).


|                |                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| **Collection** | `individual-influencers`                                                                                        |
| **State**      | `individualInfluencersState`                                                                                    |
| **Code**       | `lib/individualInfluencers/`*,* `lib/socialScrapers/`, `lib/individualInfluencersRouter.js`                     |
| **CLI**        | `npm run top:influencers` (loops) · `npm run top:influencers:once`                                              |
| **API**        | `POST /individual-influencers/run` · `GET /individual-influencers/list` · `GET /individual-influencers/queries` |


**Pipeline:** Google SERP per platform → dedicated scrapers (`/scrape-instagram`, `/scrape-x`, `/scrape-youtube-channel`) — **no RapidAPI, no login-modal clicks** → drop below 10k followers when count is known → LLM keeps persons only + tags → hash store.

**Key stored fields:** `name`, `handle`, `platform`, `profileUrl`, `bio`, `avatar`, `followersCount`, `tags`, `category`, `isPerson`, `relevanceScore`, `website`

```bash
npm run top:influencers
npm run top:influencers -- once --platform instagram
npm run top:influencers -- --niche Spirituality
npm run top:influencers -- list --tag Spirituality
```

```http
POST /individual-influencers/run
{ "platform": "x", "niche": "Spirituality" }

GET /individual-influencers/list?tag=Spirituality&platform=instagram
```

Env: `INFLUENCERS_INTERVAL_MS=30000`, `INFLUENCERS_MIN_FOLLOWERS=10000`, `INFLUENCERS_TARGET=500`, `INFLUENCERS_QUERIES_PER_RUN=3`, optional `YOUTUBE_API_KEY`.

---



## 18. Programming magazine creators (YouTube + X)

**Purpose:** Catalog educator channels for magazine covers (frontend, backend, mobile, …) and fetch **latest YouTube videos**. Not the lifestyle influencers agent — brands/tutorial channels are kept. Add topics in `lib/devMagazine/configs.js`; same CLI.

|                |                                                                         |
| -------------- | ----------------------------------------------------------------------- |
| **Collections** | `dev-magazine-channels`, `dev-magazine-videos`                         |
| **State**      | `devMagazineAgentState` (cursor per category/topic/platform)            |
| **Code**       | `lib/devMagazine/`*, `lib/devMagazineRouter.js`                         |
| **CLI**        | `npm run magazine:creators -- --category frontend`                      |
| **API**        | `POST /dev-magazine/run` · `GET /dev-magazine/list` · `GET /dev-magazine/videos` |

**Pipeline:** Google per topic → `/scrape-youtube-channel` / `/scrape-x` → LLM classify cover + topics → latest videos (YouTube Data API if `YOUTUBE_API_KEY`, else channel `/videos` HTML).

**Covers:** frontend, backend, mobile, databases, testing, tools, miscellaneous.

```bash
npm run magazine:creators -- --category frontend
npm run magazine:creators -- --category frontend --topic react --platform youtube
npm run magazine:creators -- --videos --category backend
npm run magazine:creators -- once --category mobile
npm run magazine:creators -- list --category frontend
npm run magazine:creators -- categories
```

```http
POST /dev-magazine/run
{ "category": "frontend", "topic": "react", "platform": "youtube" }

POST /dev-magazine/run
{ "videosOnly": true, "category": "backend" }

GET /dev-magazine/list?category=frontend&topic=react
GET /dev-magazine/videos?category=frontend
GET /dev-magazine/categories
```

Env: `MAGAZINE_INTERVAL_MS=30000`, `MAGAZINE_QUERIES_PER_RUN=3`, `MAGAZINE_VIDEOS_PER_CHANNEL=10`, `MAGAZINE_MIN_FOLLOWERS=1000`, optional `YOUTUBE_API_KEY`.

---



## 14. AI DESIGN.md style prompts (Refero)

**Purpose:** Catalog [Refero Styles](https://styles.refero.design/?sort=newest) cards → each `/style/{id}` DESIGN.md prompt + preview image/video for AI coding agents.


|                |                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------- |
| **Collection** | `ai-styles-prompts`                                                                      |
| **State**      | `aiStylesPromptsAgentState` (`listCursor` on newest feed)                                |
| **Code**       | `lib/aiStylesPrompts/`*, `lib/aiStylesPromptsRouter.js`                                  |
| **CLI**        | `npm run ai:styles` (loops) · `npm run ai:styles:once` · **enrich:** `npm run ai:styles:enrich` |
| **API**        | `POST /ai-styles-prompts/run` · `POST /ai-styles-prompts/enrich` · `GET /ai-styles-prompts/list` · `GET /ai-styles-prompts` |


**Pipeline:**

1. **Discover** — `GET https://styles.refero.design/api/styles?sort=newest` (cursor pagination). Fallback: scrape/HTTP the catalog for `/style/{uuid}` cards (scroll loads more in the browser).
2. **Detail** — `GET /api/styles/{id}` for colors, type, components, screenshot, preview video, `fullResult.designSystem`.
3. **Page scrape** — `POST /scrape` on `https://styles.refero.design/style/{id}` for Copy.md prompt text, extra images/videos (HTTP fallback if Puppeteer is down).
4. **DESIGN.md** — prefer copied page markdown; else rebuild from `designSystem` (same structure as Refero's Copy.md).
5. **LLM enrich** — fills `name`, `url`, `prompt` (full DESIGN.md), tags, category, oneLiner, vibe, `agentPrompt`. API values win over empty LLM strings.
6. **Store** every unique style id. Cap **100**. Incomplete docs (UUID as name, empty prompt, missing website) are **re-hydrated** on later ticks instead of skipped.

### Enrich agent (existing Firestore docs)

Walks `ai-styles-prompts` **4 docs per tick**, every **10s**, until the last document, then exits. Does not auto-start on `npm run dev`.

1. Load 4 docs after the enrich cursor (`aiStylesPromptsAgentState` / `discovery-ai-styles-prompts-enrich`).
2. LLM plans Google queries + scrape URLs from the current object (missing `name` / `url` / `prompt` / fonts / tags / …).
3. `googleSearch` + `POST /scrape` on official sites (not Refero `/style/…`).
4. LLM merge: **update** keys from new evidence, **unset** junk, **delete** empty/duplicate docs, optionally **add** related Refero UUIDs.
5. Dedupes `tags`, `fonts`, `images`, `colors`; official website wins over Refero links. Same official URL as another doc → delete this one.

```bash
npm run ai:styles:enrich
npm run ai:styles:enrich:once
npm run ai:styles:enrich -- --reset
npm run ai:styles:enrich -- status
```

```http
POST /ai-styles-prompts/enrich
{ "batch": 4 }

POST /ai-styles-prompts/enrich
{ "reset": true, "batch": 4 }

GET /ai-styles-prompts/enrich?batch=4
```

Env: `AI_STYLES_ENRICH_INTERVAL_MS=10000`, `AI_STYLES_ENRICH_BATCH=4`. **`OPENROUTER_API_KEY` required.** API server should be up for `/google-search` and `/scrape`.

---

**Client fields (always set together):** `name` (brand, not UUID), `url` (official site, not refero `/style/…`), `prompt` (full DESIGN.md including Agent Prompt Guide). Aliases: `siteName` / `siteUrl` / `designMd`.

**Key stored fields:** `id`, `name`, `url`, `prompt` (full DESIGN.md), `agentPrompt`, `siteName`, `siteUrl`, `sourceUrl`, `northStar`, `description`, `industry`, `category`, `tags`, `colors`, `fonts`, `designMd`, `promptGuide`, `previewImage`, `previewVideo`, `images`, `screenshotUrl`

```bash
npm run ai:styles
npm run ai:styles -- once
npm run ai:styles -- once --styles 10
npm run ai:styles -- list
npm run ai:styles -- count
```

```http
POST /ai-styles-prompts/run
{ "stylesPerRun": 8 }

GET /ai-styles-prompts
GET /ai-styles-prompts/list?tag=editorial&category=E-commerce
```

Env: `AI_STYLES_INTERVAL_MS=30000`, `AI_STYLES_TARGET=100`, `AI_STYLES_PER_RUN=8`. `OPENROUTER_API_KEY` optional (docs still store). `--no-scrape` skips page scrape; `--no-enrich` skips LLM.

---



## 15. Claude toprated (chat agent)

**Purpose:** One Claude (OpenRouter) endpoint that can scrape and persist. A **table** is a new Firestore collection; **each row is a document**. Dedicated scrapers are tools, not separate chat APIs.


|              |                                                                     |
| ------------ | ------------------------------------------------------------------- |
| **Code**     | `lib/claudeToprated/`*, `lib/claudeTopratedRouter.js`               |
| **API**      | `POST /claude-toprated/chat` (SSE) · `GET /claude-toprated`         |
| **Tables**   | `GET /claude-toprated/tables` · `GET /claude-toprated/tables/:name` |
| **Frontend** | Cursor prompt: `prompts/claude-toprated-nextjs-chatbot.md`          |


**Tools**


| Tool                 | Backs onto                                          |
| -------------------- | --------------------------------------------------- |
| `table_add_rows`     | New collection; each row → `docId`                  |
| `table_edit_row`     | Merge one doc                                       |
| `table_remove_row`   | Delete docs                                         |
| `table_list` / `get` | Read tables/rows                                    |
| `scrape_website`     | `POST /scrape`                                      |
| `scrape_maps`        | Maps scrape (`/scrape-google-maps` or in-process)   |
| `scrape_linkedin`    | Google `site:linkedin.com` (+ optional page scrape) |
| `scrape_x`           | `POST /scrape-x`                                    |
| `scrape_instagram`   | `POST /scrape-instagram`                            |
| `scrape_youtube`     | Channel scrape or `POST /scrape-youtube` video      |
| `scrape_github`      | `POST /scrape-git`                                  |
| `scrape_producthunt` | Search + `POST /scrape`                             |
| `google_search`      | Existing search stack                               |


**Realtime:** `POST /claude-toprated/chat` with `{ "message": "...", "messages": [...], "stream": true }` returns `text/event-stream`. Events: `start`, `status`, `tool_call`, `tool_result`, `table`, `done`, `error`. Set `"stream": false` for a single JSON body.

```http
POST /claude-toprated/chat
{ "message": "Find 8 cafes in Jaipur and save them as jaipur-cafes" }

GET /claude-toprated
GET /claude-toprated/tables
GET /claude-toprated/tables/jaipur-cafes
```

Env: `OPENROUTER_API_KEY` required. Optional `CLAUDE_TOPRATED_MODEL` (default `OPENROUTER_MODEL` / `anthropic/claude-sonnet-4`), `CLAUDE_TOPRATED_MAX_ROUNDS` (default 12). Needs the API process so scrape tools can call `/scrape`, `/scrape-git`, `/scrape-youtube`.

---



## 10. Content research

**Purpose:** Keyword / Reddit / internal / external research → content ideas calendar.


|                 |                                                     |
| --------------- | --------------------------------------------------- |
| **Collections** | `content_research_runs/{runId}`, `content_calendar` |
| **Code**        | `lib/contentResearch/`*                             |
| **API**         | `POST /api/content-research`                        |


One-shot research run (not a 30s loop agent). Uses site scrape, Google Suggest/SERP, Reddit via Google, OpenRouter.

---



## 11. Company seed (+ blog topics / AI visibility)

**Purpose:** Scrape company URLs into a structured seed schema; optional follow-up topic / visibility jobs.


|                |                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------- |
| **Collection** | `companySeeds`                                                                                |
| **API**        | `POST /company-seed`, `GET /company-seed/:userId`, `POST /blog-topics`, `POST /ai-visibility` |


---



## 20. iHateReading internet news

**Purpose:** Programming, startups, SaaS, funding/investment, and ihatereading.in news for the iHateReading site. Not a generic world-news crawl.


|                |                                                                                         |
| -------------- | --------------------------------------------------------------------------------------- |
| **Collection** | `ihatereading-internet-news`                                                            |
| **State**      | `ihatereadingInternetNewsState` (rotates 4 of 20 platforms; Google News keyword cursor) |
| **Code**       | `lib/internetNews/`*, `lib/googleNews.js`, `lib/internetNewsRouter.js`                  |
| **CLI**        | `npm run news:ihatereading` (30s loop) · `npm run news:ihatereading:once`               |
| **API**        | `POST /internet-news/run` · `GET /internet-news/list` · `GET /internet-news/platforms`  |


**Pipeline:**

1. **Google News** — `POST /scrape-google-news` `{ "keyword": "startup funding" }` (also `POST /scrape` `{ "keyword": "..." }` with no url). Keywords rotate: programming, SaaS, funding, YC, ihatereading.in, …
2. **20 list platforms** — Hacker News, TechCrunch (`techbase` alias), The Verge, Wired, Ars, VentureBeat, TNW, Product Hunt, Indie Hackers, BetaList, GitHub Blog, DEV, Lobsters, a16z, YC blog, Reuters Tech, Fortune, Axios, Smashing Magazine.
3. Each tick: **4 platforms**, **10–20** top URLs from the list `links` (RSS fallback).
4. **No AI** — store every new URL. `category` + `tags` come from the platform (HN → programming, a16z → investment, …) and the Google News keyword.

Does not auto-start on `npm run dev`.

```bash
npm run news:ihatereading
npm run news:ihatereading:once
npm run news:ihatereading -- --platform hackernews
npm run news:ihatereading -- --platform techbase
npm run news:ihatereading -- --keyword "ihatereading.in"
```

```http
POST /scrape-google-news
{ "keyword": "series A SaaS", "limit": 20 }

POST /scrape
{ "keyword": "programming", "limit": 15 }

POST /internet-news/run
{ "platformsPerRun": 4, "urlsPerPlatform": 15 }

GET /internet-news/list?platform=hackernews&tag=funding&category=startups
```

Env: `NEWS_INTERVAL_MS=30000`, `NEWS_PLATFORMS_PER_RUN=4`, `NEWS_URLS_PER_PLATFORM=15` (clamped 10–20). API server needed for `/scrape` and `/scrape-google-news`.

---



## 21. England football clubs (Soccer Wiki)

**Purpose:** All **England-only** football clubs from [Soccer Wiki country listing](https://en.soccerwiki.org/country.php?action=clubs&countryId=ENG) (333 clubs). No LLM. Default is scrape-and-store the listing table.


|                |                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------- |
| **Collection** | `clubs`                                                                                  |
| **State**      | `englandClubsState` (listing `offset`, stops at 333)                                     |
| **Code**       | `lib/englandClubs/`*, `lib/englandClubsRouter.js`                                        |
| **CLI**        | `npm run england:clubs` (loops to 333) · `npm run england:clubs:once` (one page)                                   |
| **API**        | `POST /england-clubs/run` · `GET /england-clubs/list`                                    |


**Pipeline (one layer):**

1. Scrape `country.php?action=clubs&countryId=ENG` (page 2+ uses `offset=50`, `100`, …).
2. Parse club, manager, league, stadium, location, founded year + Soccer Wiki URLs.
3. Store into Firestore `clubs` (hash id from `eng` + `clubid`). Skip if already stored.
4. Advance offset by 50. **Keep looping** until Firestore has **333** unique clubs, then stop.

Does not auto-start on `npm run dev`. Optional `--enrich` (off by default) Google-searches the official site and `/scrape`s it for emails / socials — still no LLM.

```bash
npm run england:clubs
npm run england:clubs -- once
npm run england:clubs -- --reset
npm run england:clubs -- --enrich
npm run england:clubs -- list
```

```http
POST /england-clubs/run
{ "reset": false, "enrich": false }

GET /england-clubs/list?limit=50
```

Env: `CLUBS_PAGES_PER_RUN=8`, `CLUBS_ENRICH_PER_PAGE=8`. Needs the API server for `/scrape` (and `/google-search` if enriching).

---



## 22. Karyam B2B founder leads (AutoSend CRM)

**Purpose:** Find B2B founders / owners / CTOs / solo builders who need software [karyam.xyz](https://karyam.xyz) can ship (SaaS, AI agents, apps, websites, CRM/ERP, automations, scraping APIs) — then enrich emails and send from the dashboard via AutoSend.


|                |                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| **Collection** | `karyamFounderLeads`                                                                                         |
| **State**      | `karyamFounderAgentState` (rotating query cursor)                                                            |
| **Code**       | `lib/karyamFounders/`*                                                                                       |
| **CLI**        | `npm run karyam:founders` · `npm run karyam:founders:loop`                                                   |
| **API**        | `POST /karyam-founders/run` · `GET /karyam-founders/list` · `GET /karyam-founders/queries` · `POST /karyam-founders/send` |


**Pipeline:** Google SERP over a ~90-query hash → scrape each URL → nested scrape of `/contact` `/about` `/team` + listicle outbound company URLs → optional follow-up Google (`site:domain contact`, `"Company" founder email`) → classify founder / CTO / HR emails → optional OpenRouter drafts → Firestore. AutoSend is **explicit** (`--send` / dashboard Send), never default.

**Intents:** `saas-crm`, `ai-agent`, `mvp`, `mobile`, `web-seo`, `ecommerce`, `ops`, `scraping`, `indie`

**Key stored fields:** `name`, `company`, `role`, `intent`, `website`, `emails`, `founderEmail`, `ctoEmail`, `hrEmail`, `phone`, `linkedinUrl`, `xUrl`, `draftSubject`, `draftMessage`, `relevanceScore`, `outreachStatus`, `autosendEmailId`

```bash
npm run karyam:founders
npm run karyam:founders -- --intent saas-crm --use-ai
npm run karyam:founders -- --loop
npm run karyam:founders -- list --has-email
npm run karyam:founders -- queries
npm run karyam:founders -- send --id <leadId>
```

```http
POST /karyam-founders/run
{ "intent": "saas-crm", "queriesPerRun": 3, "useAI": true }

GET /karyam-founders/list?hasEmail=1&minScore=4
GET /karyam-founders/autosend
POST /karyam-founders/send
{ "ids": ["abc123"] }
```

Dashboard: Collections → Founders. Per-row **Send** uses AutoSend (`AUTOSEND_API_KEY` + verified `AUTOSEND_FROM_EMAIL`). Loop the scraper from Scrapers → Founders.

Env: `KARYAM_FOUNDERS_QUERIES_PER_RUN=3`, `KARYAM_FOUNDERS_ENRICH_PER_RUN=6`, `KARYAM_FOUNDERS_INTERVAL_MS=30000`, `AUTOSEND_API_KEY`, `AUTOSEND_FROM_EMAIL=hello@karyam.xyz`, `AUTOSEND_FROM_NAME=Karyam`, `AUTOSEND_PROJECT_ID` (account keys only).

---



## Related (not lead monitors)


| Surface                        | Role                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `POST /inkgest-agent`          | Prompt → skills (scrape/crawl/blog/table…) — content orchestration, not a Firestore lead loop |
| `POST /browser-agent`          | Puppeteer ReAct trail for SPAs                                                                |
| `POST /maps-leads`             | Conversational Maps lead session (in-memory)                                                  |
| `POST /scrape-google-maps`     | Maps scrape primitive                                                                         |
| `POST /scrape-instagram`       | Public IG profile (OG + page JSON; no login click, no RapidAPI)                               |
| `POST /scrape-x`               | Public X profile (follow-button widget + OG / GraphQL intercept)                              |
| `POST /scrape-youtube-channel` | Public YouTube channel (Data API if `YOUTUBE_API_KEY`, else ytInitialData)                    |
| `POST /google-search`          | SERP primitive                                                                                |
| `POST /scrape`                 | Generic page scrape. `{ "keyword": "…" }` with no url → Google News |
| `POST /scrape-google-news`     | Google News by `keyword` (legacy `city`+`state` still works)         |
| `POST /claude-toprated/chat`   | Claude + scrape/table tools, SSE realtime                                                     |


---



## Env checklist

```bash
OPENROUTER_API_KEY=...
SCRAPE_API_BASE_URL=http://127.0.0.1:3002   # CLI agents that need /google-search or /scrape
PORT=3002

# Optional per-agent
MAPS_KARYAM_INTERVAL_MS=30000
KARYAM_LI_GEO=in
KARYAM_LI_INTERVAL_MS=30000
KARYAM_FOUNDERS_INTERVAL_MS=30000
KARYAM_FOUNDERS_QUERIES_PER_RUN=3
KARYAM_FOUNDERS_ENRICH_PER_RUN=6
AUTOSEND_API_KEY=
AUTOSEND_FROM_EMAIL=hello@karyam.xyz
AUTOSEND_FROM_NAME=Karyam
# AUTOSEND_PROJECT_ID=
ANGEL_INTERVAL_MS=30000
YC_INTERVAL_MS=30000
NEWS_INTERVAL_MS=30000
NEWS_PLATFORMS_PER_RUN=4
NEWS_URLS_PER_PLATFORM=15
TOP_MOBILE_APPS_INTERVAL_MS=30000
TOP_MOBILE_APPS_TARGET=10000
TOP_MOBILE_APPS_SOURCES_PER_RUN=2
TOP_MOBILE_APPS_LISTINGS_PER_SOURCE=40
INFLUENCERS_INTERVAL_MS=30000
INFLUENCERS_MIN_FOLLOWERS=10000
INFLUENCERS_TARGET=500
MAGAZINE_INTERVAL_MS=30000
MAGAZINE_QUERIES_PER_RUN=3
MAGAZINE_VIDEOS_PER_CHANNEL=10
AI_STYLES_INTERVAL_MS=30000
AI_STYLES_TARGET=100
AI_STYLES_PER_RUN=8
CLUBS_PAGES_PER_RUN=8
CLUBS_ENRICH_PER_PAGE=8
CLAUDE_TOPRATED_MODEL=anthropic/claude-sonnet-4
CLAUDE_TOPRATED_MAX_ROUNDS=12
REDDIT_DIRECTORIES_INTERVAL_MS=30000
REDDIT_DIRECTORIES_SUBS_PER_RUN=10
REDDIT_SCRAPING_INTERVAL_MS=30000
REDDIT_SCRAPING_SUBS_PER_RUN=10
REDDIT_AI_SCRAPER_INTERVAL_MS=30000
REDDIT_AI_SCRAPER_SUBS_PER_RUN=10
# REDDIT_USE_LLM=1   # opt-in OpenRouter scoring for Reddit CLIs
REDDIT_RSS_MIN_INTERVAL_MS=60000
```

---



## Typical local workflow

```bash
# Terminal 1 — API (scrapers + routers)
npm run dev

# Terminal 2 — dashboard (Vite, opens browser)
npm run dashboard


# Terminal 2+ — agents (pick any)
npm run reddit:karyam
npm run reddit:directories
npm run reddit:scraping
npm run reddit:ai-scraper -- --prompt "people looking for scrapers and datasets"
npm run maps:karyam -- --city bangalore --loop
npm run karyam:linkedin -- --geo in
npm run karyam:founders -- --loop
npm run angel:investors:loop
npm run yc:companies
npm run top:mobile-apps
npm run top:influencers
npm run magazine:creators -- --category frontend --topic react
npm run ai:styles
npm run england:clubs
```

---



## Deduping & uniqueness


| Agent            | Hash key                                    |
| ---------------- | ------------------------------------------- |
| Reddit agents    | permalink                                   |
| Scraping problems | permalink                                  |
| Directory ideas  | permalink                                   |
| Maps Karyam      | mapsUrl / name+phone+address                |
| LinkedIn Karyam  | linkedinUrl / handle / email                |
| Karyam founders  | website / linkedinUrl / email / sourceUrl   |
| Angel investors  | xUrl / linkedinUrl / website / email / name |
| YC companies     | YC slug / ycUrl / website                   |
| Top mobile apps  | `playStoreId` or `appStoreId`               |
| Influencers      | `platform:handle` (or YouTube channel id)   |
| Dev magazine     | `platform:handle` / YouTube `videoId`       |
| AI style prompts | Refero style UUID                           |
| England clubs    | `eng` + Soccer Wiki `clubid` (or name)      |


Never create a new agent folder for a new city/category when the existing agent already accepts `--city` / `--category` / `--geo` — extend config instead.