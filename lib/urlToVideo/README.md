# URL / GitHub → MP4 video

`POST /url-to-video` turns a website or a public GitHub repo into a narrated promo/explainer video.

## Pipeline

| # | Step | How | Cost |
|---|------|-----|------|
| 1 | Ingest | GitHub: `git clone --depth 1` into the job folder, then read the README, manifests, file tree and the top code files, plus stars/topics from the GitHub API. Website: the existing scraper (`scrapeOneUrlResult`). | free |
| 2 | Screenshots | Full-page capture with the browser pool (`captureOneScreenshotWithPage`), cropped into 16:10 (desktop) or 9:16 (mobile) frame candidates | free |
| 3 | Frame analysis | Vision model (`SCREENSHOT_ANALYST_SYSTEM`) scores each frame, picks a focus point and a camera move, and marks bad frames to skip | ~$0.01 |
| 4 | Script + storyboard | `SCRIPT_DIRECTOR_SYSTEM` writes the scenes (hook → problem → features → proof → CTA), with narration, visuals, music mood and theme | ~$0.05–0.08 |
| 5 | Narration | OpenRouter TTS (`gpt-audio-mini` by default), one clip per scene, run in parallel | ~$0.025/min |
| 6 | Frames | HTML templates (`frames.js`: title, screenshot-in-browser, code, stats, bullets, outro) rendered to PNG with Puppeteer | free |
| 7 | Motion | FFmpeg `zoompan` Ken Burns move toward the focus point, with fades | free |
| 8 | Audio | Royalty-free track from Openverse (CC0/CC-BY, attribution returned), or a procedurally generated pad and bass line. Whoosh SFX on cuts, music ducked under the voice with a sidechain compressor | free |
| 9 | Output | `video.mp4` (H.264/AAC, faststart) + `captions.srt` (optionally burned in) | free |
| 10 | Storage | Everything kept in `URL_VIDEO_OUTPUT_DIR/<jobId>/` and uploaded to UploadThing (video, frames, screenshots, narration, music, storyboard) | storage only |

Typical total: **about $0.08–0.15 for a 45–60 s video.** Call `POST /url-to-video/estimate` for a projection. Each finished job returns `cost.total_usd` and a per-stage breakdown taken from OpenRouter's reported usage.

## API

```bash
# start (async) → 202 { job_id, status_url, estimate }
curl -X POST localhost:3001/url-to-video -H 'content-type: application/json' -d '{
  "url": "https://github.com/sindresorhus/slugify",
  "duration_sec": 45, "aspect": "16:9", "voice": "nova",
  "tone": "energetic product launch", "music": "auto", "captions": false
}'

# poll
curl localhost:3001/url-to-video/<job_id>   # status, step, progress, result.video_url, cost

# blocking run (local/dev)
curl -X POST localhost:3001/url-to-video -d '{"url":"https://ihatereading.in","wait":true}' -H 'content-type: application/json'
```

Body options: `url`, `duration_sec` (15–180), `aspect` (`16:9` | `9:16` | `1:1`), `voice` (alloy/echo/fable/onyx/nova/shimmer), `tone`, `audience`, `language`, `music` (`auto` | `openverse` | `generate` | `none` | mp3 URL), `music_volume`, `sfx`, `captions`, `theme` `{background, accent, text, mode}`, `max_frames`, `max_scenes`, `branch`, `script_model`, `vision_model`, `tts_model`, `analyze_screenshots`, `upload`, `keep_local`, `wait`.

## Env

| Var | Default |
|-----|---------|
| `OPENROUTER_API_KEY` | required |
| `UPLOADTHING_TOKEN` | optional. Without it, files stay local only |
| `URL_VIDEO_OUTPUT_DIR` | `$TMPDIR/url-to-video` |
| `URL_VIDEO_SCRIPT_MODEL` | `OPENROUTER_MODEL` or `anthropic/claude-sonnet-4` |
| `URL_VIDEO_VISION_MODEL` | `google/gemini-2.5-flash` |
| `URL_VIDEO_TTS_MODEL` | `openai/gpt-audio-mini` |
| `GITHUB_TOKEN` | optional, raises the GitHub API rate limit |
| `FFMPEG_PATH` | optional. Otherwise the first working one of: system `ffmpeg`, then the bundled `ffmpeg-static`. A broken system install (e.g. a Homebrew build missing `libx265`) is skipped automatically. `ffprobe` is not needed |

Job state is kept in memory, and `manifest.json` in the job folder is updated after every step, so `GET /url-to-video/:id` still works after a restart on the same machine. A render needs a long-running host with Chromium (Fly or Docker). ffmpeg comes bundled via `ffmpeg-static`. Serverless functions are not suitable.
