# Video shorts agent

`POST /video-shorts` turns one product into **several different short videos (< 60 s)**, each with or without audio.
The dashboard page is at **`/video-shorts`** (`dashboard/src/pages/VideoShortsPage.tsx`).

## How the agent uses context

| Stage | What happens | Parallel? |
|---|---|---|
| 1. Gather context (`context.js`) | Homepage (scraper text plus cheerio discovery of links, meta tags, og:image and a GitHub link) · `llms.txt` / `llms-full.txt` · blog index → newest posts, each scraped · GitHub repo (given, URL itself, or discovered on the site), cloned locally · pricing/features/docs pages · product images (og:image, page images, README images, blog covers) downloaded and filtered by size | all sources at once |
| 2. Frames | Screenshots of homepage / pricing / blog post / repo (scrolled viewport shots, falling back to full-page, then the offline README) **plus** real product images | targets at once |
| 3. Analyse frames | Vision model scores every frame, picks a focus point and a camera move, and marks frames to skip | one call |
| 4. Product brief | `BRIEF_ANALYST_SYSTEM` merges every source into one evidence-backed brief: features, proof, pains, quotable lines, blog insights, hooks. Each claim records its source; nothing is invented | one call |
| 5. Concepts | `CONCEPT_PLANNER_SYSTEM` picks N *different* formats (problem_solution, feature_blitz, social_proof, how_it_works, dev_showcase, blog_insight, listicle, before_after, launch_teaser), each with its own hook, audience, pace, music mood, frames and palette. Formats whose evidence is missing are skipped | one call |
| 6. Storyboards | `SHORT_DIRECTOR_SYSTEM`, one call per concept. Without narration, every scene carries readable on-screen text | **all concepts at once** |
| 7. Render | Shared `renderStoryboardVideo()` from `lib/urlToVideo`: frames (Puppeteer, serialized), motion clips + audio (FFmpeg) → MP4 (under 59 s enforced) → UploadThing | `render_concurrency` (default 2) |

## Audio is a request parameter

```jsonc
"audio": false                                         // fully silent MP4 (no audio track)
"audio": { "narration": false, "music": "auto" }       // music + SFX, no voice; on-screen text carries the story
"audio": { "narration": true, "music": "generate", "sfx": true, "voice": "nova" }
```
`music`: `auto` (Openverse CC0/CC-BY) · `generate` (procedural, offline) · `none` · an mp3 URL.

## API

| Method | Path | |
|---|---|---|
| POST | `/video-shorts` | start (202) → `{ job_id }`; `wait: true` blocks until done |
| GET | `/video-shorts/:id` | live status: `sources`, `frames`, `brief`, `variants[]` (each with status/progress/result), `cost` |
| GET | `/video-shorts` | recent jobs |
| POST | `/video-shorts/estimate` | projected cost for the same body |
| GET | `/video-shorts/formats` | format catalogue |
| GET | `/video-shorts/:id/file?p=` | local frames/MP4 (Range support) when UploadThing isn't configured |

Body: `url`, `github_url?`, `blog_url?`, `extra_urls?`, `variations` (1–6, default 3), `duration_sec` (10–59, default 30), `aspect` (`9:16` default, `1:1`, `16:9`), `formats?`, `tone?`, `audience?`, `language?`, `audio`, `captions?`, `max_screenshots?`, `max_images?`, `max_blog_posts?`, `render_concurrency?`, `script_model?`, `vision_model?`, `tts_model?`, `upload?`, `wait?`.

## Cost

These are rough estimates from list prices. Real costs come from OpenRouter's reported usage and are returned per stage and per variant.
- Shared per run: brief + concepts + vision ≈ **$0.05–0.07** (Sonnet 4 + Gemini 2.5 Flash)
- Per variant: storyboard ≈ $0.04, plus voice-over ≈ $0.025/min when narration is on
- 3 narrated 30 s shorts ≈ **$0.20–0.30**. Silent or music-only is cheaper. Screenshots, images, music and rendering are free

Env: `VIDEO_SHORTS_OUTPUT_DIR` (default `$TMPDIR/video-shorts`) and `VIDEO_SHORTS_SCRIPT_MODEL`, plus everything listed in `lib/urlToVideo/README.md`.
