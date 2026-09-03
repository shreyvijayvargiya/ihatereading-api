/**
 * Any URL → domain-routed scrape → free OpenRouter LLM → free image model → UploadThing.
 * YouTube / Reddit / GitHub use those scrapers; everything else uses POST /scrape.
 * Models are hardcoded :free slugs (not env).
 */

import { createRequire } from "node:module";
import { UTApi, UTFile } from "uploadthing/server";
import { parseJsonFromLLM } from "./geoPipeline/parseLlmJson.js";
import { resolveScrapeBaseUrl } from "./scrapefast.js";

const require = createRequire(import.meta.url);
const youtubedl = require("youtube-dl-exec");

const utapi = new UTApi({ token: process.env.UPLOADTHING_TOKEN });

export const IG_CAROUSEL_LLM_MODEL = "google/gemini-2.0-flash-exp:free";
export const IG_CAROUSEL_IMAGE_MODEL =
	"google/gemini-2.5-flash-image-preview:free";

const MAX_SLIDES = 20;
const DEFAULT_SLIDES = 8;
const SOURCE_MAX_CHARS = 18_000;
const IMAGE_CONCURRENCY = 2;
const IG_SIZE = "1080x1350";
const IG_ASPECT = "4:5";

const YT_ID_RE =
	/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/;

export function parseYoutubeId(input) {
	const raw = String(input || "").trim();
	if (!raw) return "";
	if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
	try {
		const u = new URL(raw);
		const v = u.searchParams.get("v");
		if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
	} catch {
		/* not a URL */
	}
	const m = raw.match(YT_ID_RE);
	return m?.[1] || "";
}

export function isYoutubeUrl(url) {
	return Boolean(parseYoutubeId(url));
}

export function isRedditUrl(url) {
	return /reddit\.com/i.test(String(url || ""));
}

export function isGithubUrl(url) {
	try {
		const host = new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase();
		return host === "github.com" || host.endsWith(".github.com");
	} catch {
		return /github\.com/i.test(String(url || ""));
	}
}

export function classifySourceUrl(raw) {
	const s = String(raw || "").trim();
	if (isYoutubeUrl(s)) return "youtube";
	if (isRedditUrl(s)) return "reddit";
	if (isGithubUrl(s)) return "github";
	return "web";
}

function normalizeInputUrl(raw) {
	const s = String(raw || "").trim();
	const ytId = parseYoutubeId(s);
	if (ytId && !/^https?:\/\//i.test(s)) {
		return `https://www.youtube.com/watch?v=${ytId}`;
	}
	if (/^https?:\/\//i.test(s)) return s;
	throw new Error("A valid http(s) URL is required");
}

function scrapeBase(opts = {}) {
	return resolveScrapeBaseUrl(opts.c || null);
}

function openRouterHeaders() {
	const key = process.env.OPENROUTER_API_KEY?.trim();
	if (!key) throw new Error("OPENROUTER_API_KEY is required");
	return {
		Authorization: `Bearer ${key}`,
		"Content-Type": "application/json",
	};
}

function json3ToText(data) {
	const events = Array.isArray(data?.events) ? data.events : [];
	const chunks = [];
	for (const ev of events) {
		if (!Array.isArray(ev.segs)) continue;
		const line = ev.segs.map((s) => s.utf8 || "").join("");
		if (line && line !== "\n") chunks.push(line.replace(/\n/g, " ").trim());
	}
	return chunks.filter(Boolean).join(" ");
}

function vttToText(raw) {
	return String(raw || "")
		.replace(/^WEBVTT.*$/m, "")
		.replace(/^\d+$/gm, "")
		.replace(
			/\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}.*$/gm,
			"",
		)
		.replace(/<[^>]+>/g, "")
		.replace(/\n{2,}/g, "\n")
		.trim();
}

function pickCaptionTracks(info) {
	const subs =
		info?.subtitles && typeof info.subtitles === "object" ? info.subtitles : {};
	const auto =
		info?.automatic_captions && typeof info.automatic_captions === "object"
			? info.automatic_captions
			: {};
	const prefer = ["en", "en-US", "en-GB", "en-orig", "en-en", "a.en"];
	for (const lang of prefer) {
		if (Array.isArray(subs[lang]) && subs[lang].length) return subs[lang];
		if (Array.isArray(auto[lang]) && auto[lang].length) return auto[lang];
	}
	for (const [lang, tracks] of Object.entries(subs)) {
		if (/^en/i.test(lang) && Array.isArray(tracks) && tracks.length) return tracks;
	}
	for (const [lang, tracks] of Object.entries(auto)) {
		if (/^en/i.test(lang) && Array.isArray(tracks) && tracks.length) return tracks;
	}
	const firstSub = Object.values(subs).find((t) => Array.isArray(t) && t.length);
	if (firstSub) return firstSub;
	return Object.values(auto).find((t) => Array.isArray(t) && t.length) || [];
}

function transcriptFromYoutubeResponse(data) {
	const rows = data?.data?.transcript;
	if (!Array.isArray(rows)) return "";
	return rows
		.map((t) => (typeof t === "string" ? t : t?.text || ""))
		.filter(Boolean)
		.join(" ");
}

async function scrapeYoutubeEndpoint(url, baseUrl) {
	const res = await fetch(`${baseUrl}/scrape-youtube`, {
		method: "POST",
		signal: AbortSignal.timeout(45_000),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id: url }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.success === false) {
		throw new Error(
			data.details || data.error || `YouTube scrape HTTP ${res.status}`,
		);
	}
	const text = transcriptFromYoutubeResponse(data).replace(/\s+/g, " ").trim();
	if (!text) throw new Error("YouTube scraper returned an empty transcript");
	return {
		title: `YouTube: ${parseYoutubeId(url) || url}`,
		text,
		kind: "youtube",
		endpoint: "/scrape-youtube",
	};
}

async function scrapeYoutubeYtDlp(youtubeUrl) {
	const info = await youtubedl(youtubeUrl, {
		dumpSingleJson: true,
		skipDownload: true,
		noWarnings: true,
		noCheckCertificates: true,
		noPlaylist: true,
		preferFreeFormats: true,
		addHeader: ["referer:youtube.com", "user-agent:googlebot"],
	});
	const tracks = pickCaptionTracks(info);
	const track = [...tracks].sort((a, b) => {
		const rank = (ext) =>
			({ json3: 0, srv3: 1, vtt: 2 }[String(ext || "").toLowerCase()] ?? 9);
		return rank(a.ext || a.format) - rank(b.ext || b.format);
	}).find((t) => t.url);
	if (!track?.url) throw new Error("yt-dlp found no captions for this video");
	const res = await fetch(track.url, {
		signal: AbortSignal.timeout(60_000),
		headers: { "User-Agent": "Mozilla/5.0" },
	});
	if (!res.ok) throw new Error(`Caption download HTTP ${res.status}`);
	const ext = String(track.ext || "").toLowerCase();
	let text = "";
	if (ext === "json3" || ext === "srv3") text = json3ToText(await res.json());
	else text = vttToText(await res.text());
	text = text.replace(/\s+/g, " ").trim();
	if (!text) throw new Error("yt-dlp captions were empty");
	return {
		title: info.title || `YouTube: ${info.id || ""}`,
		channel: info.channel || info.uploader || "",
		text,
		kind: "youtube",
		endpoint: "yt-dlp",
		meta: {
			videoId: info.id || parseYoutubeId(youtubeUrl),
			duration: info.duration || null,
			thumbnail: info.thumbnail || null,
		},
	};
}

async function scrapeRedditEndpoint(url, baseUrl) {
	const res = await fetch(`${baseUrl}/scrape-reddit`, {
		method: "POST",
		signal: AbortSignal.timeout(45_000),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ url }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.success === false) {
		throw new Error(data.details || data.error || `Reddit scrape HTTP ${res.status}`);
	}
	const text = String(data.markdown || "").trim();
	if (!text) throw new Error("Reddit scraper returned empty markdown");
	return {
		title: data.data?.title || data.data?.metadata?.title || `Reddit: ${url}`,
		text,
		kind: "reddit",
		endpoint: "/scrape-reddit",
	};
}

async function scrapeGithubEndpoint(url, baseUrl) {
	const res = await fetch(`${baseUrl}/scrape-git`, {
		method: "POST",
		signal: AbortSignal.timeout(60_000),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ url }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.success === false) {
		throw new Error(data.error || `GitHub scrape HTTP ${res.status}`);
	}
	const stars = data.stars
		? `Stars: ${data.stars.count} · Forks: ${data.stars.forks}`
		: "";
	const text = [data.markdown, stars, data.data?.metadata?.description]
		.filter(Boolean)
		.join("\n\n")
		.trim();
	if (!text) throw new Error("GitHub scraper returned empty content");
	return {
		title: data.data?.title || data.data?.metadata?.title || `GitHub: ${url}`,
		text,
		kind: "github",
		endpoint: "/scrape-git",
	};
}

async function scrapeWebEndpoint(url, baseUrl) {
	const res = await fetch(`${baseUrl}/scrape`, {
		method: "POST",
		signal: AbortSignal.timeout(90_000),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			url,
			timeout: 45_000,
			includeSemanticContent: true,
			includeImages: false,
			includeLinks: true,
			extractMetadata: true,
			takeScreenshot: false,
		}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.success === false) {
		throw new Error(
			data.error || data.details || `Scrape HTTP ${res.status}`,
		);
	}
	const text = String(data.markdown || data.summary || "").trim();
	if (!text) throw new Error("Scrape returned empty markdown");
	return {
		title: data.data?.metadata?.title || data.data?.title || url,
		text,
		kind: "web",
		endpoint: "/scrape",
	};
}

export async function scrapeUrlForCarousel(url, opts = {}) {
	const baseUrl = (opts.baseUrl || scrapeBase(opts)).replace(/\/$/, "");
	const kind = classifySourceUrl(url);
	if (kind === "youtube") {
		try {
			return await scrapeYoutubeEndpoint(url, baseUrl);
		} catch (err) {
			console.warn(
				"[ig-carousel] /scrape-youtube failed, falling back to yt-dlp:",
				err?.message || err,
			);
			return await scrapeYoutubeYtDlp(url);
		}
	}
	if (kind === "reddit") return scrapeRedditEndpoint(url, baseUrl);
	if (kind === "github") return scrapeGithubEndpoint(url, baseUrl);
	return scrapeWebEndpoint(url, baseUrl);
}

async function planCarouselSlides({ title, sourceKind, text, slides, style }) {
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		signal: AbortSignal.timeout(90_000),
		headers: openRouterHeaders(),
		body: JSON.stringify({
			model: IG_CAROUSEL_LLM_MODEL,
			temperature: 0.4,
			max_tokens: 6000,
			response_format: { type: "json_object" },
			messages: [
				{
					role: "system",
					content: `You turn scraped web content into an Instagram carousel (max ${MAX_SLIDES} slides).
Source type: ${sourceKind}.
Return ONLY JSON:
{
  "caption": "single IG caption under the carousel, 2-4 short sentences, no hashtags",
  "hashtags": ["tag", "..."],
  "slides": [
    {
      "headline": "3-8 words, punchy",
      "body": "1-2 short lines of supporting copy",
      "imagePrompt": "detailed visual prompt for a ${IG_ASPECT} Instagram slide at ${IG_SIZE}. Bold graphic, high contrast, one huge headline matching the slide, no watermark, no logos, no tiny paragraphs"
    }
  ]
}
Slide 1 is a cover. Last slide is a CTA. Keep headlines readable on mobile.`,
				},
				{
					role: "user",
					content: JSON.stringify({
						title,
						sourceKind,
						slideCount: slides,
						style: style || "bold educational founder carousel",
						content: String(text || "").slice(0, SOURCE_MAX_CHARS),
					}),
				},
			],
		}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.error) {
		throw new Error(
			data.error?.message || data.error || `OpenRouter LLM HTTP ${res.status}`,
		);
	}
	const content = data.choices?.[0]?.message?.content;
	if (!content) throw new Error("OpenRouter returned empty carousel plan");
	const parsed = parseJsonFromLLM(content);
	const list = Array.isArray(parsed.slides) ? parsed.slides : [];
	if (!list.length) throw new Error("LLM returned no slides");
	return {
		caption: String(parsed.caption || "").trim(),
		hashtags: Array.isArray(parsed.hashtags)
			? parsed.hashtags.map((h) => String(h).replace(/^#/, "")).slice(0, 12)
			: [],
		slides: list.slice(0, slides).map((s, i) => ({
			index: i + 1,
			headline: String(s.headline || `Slide ${i + 1}`).trim(),
			body: String(s.body || "").trim(),
			imagePrompt: String(s.imagePrompt || "").trim(),
		})),
	};
}

function dataUrlToBuffer(dataUrl) {
	const s = String(dataUrl || "");
	const m = s.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
	if (m) return { buffer: Buffer.from(m[2], "base64"), mime: m[1] };
	if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 200) {
		return {
			buffer: Buffer.from(s.replace(/\s/g, ""), "base64"),
			mime: "image/png",
		};
	}
	throw new Error("Image response was not a data URL or base64");
}

async function generateCarouselImage(prompt) {
	const fullPrompt = `${prompt}

Instagram carousel slide, ${IG_ASPECT} portrait ${IG_SIZE}, bold modern graphic, high contrast, large readable headline, no watermark, no platform UI, no extra captions.`;

	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		signal: AbortSignal.timeout(120_000),
		headers: openRouterHeaders(),
		body: JSON.stringify({
			model: IG_CAROUSEL_IMAGE_MODEL,
			messages: [{ role: "user", content: fullPrompt }],
			modalities: ["image", "text"],
		}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.error) {
		throw new Error(
			data.error?.message || data.error || `OpenRouter image HTTP ${res.status}`,
		);
	}
	const message = data.choices?.[0]?.message || {};
	const fromImages = message.images?.[0]?.image_url?.url;
	if (fromImages) return dataUrlToBuffer(fromImages);
	const parts = Array.isArray(message.content) ? message.content : [];
	for (const part of parts) {
		const url = part?.image_url?.url || part?.inline_data?.data;
		if (!url) continue;
		if (String(url).startsWith("data:")) return dataUrlToBuffer(url);
		if (part?.inline_data?.mime_type) {
			return {
				buffer: Buffer.from(part.inline_data.data, "base64"),
				mime: part.inline_data.mime_type,
			};
		}
	}
	throw new Error("Image model returned no image bytes");
}

async function uploadPngToUploadThing(buffer, mime, index) {
	if (!process.env.UPLOADTHING_TOKEN?.trim()) {
		throw new Error("UPLOADTHING_TOKEN is required");
	}
	const ext = mime?.includes("jpeg") || mime?.includes("jpg") ? "jpg" : "png";
	const type = ext === "jpg" ? "image/jpeg" : "image/png";
	const fileName = `ig-carousel-${Date.now()}-${index}.${ext}`;
	const utFile = new UTFile([buffer], fileName, { type });
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(`UploadThing upload failed: ${response.error.message}`);
	}
	return response.data.ufsUrl || response.data.url;
}

async function mapPool(items, limit, fn) {
	const out = new Array(items.length);
	let i = 0;
	async function worker() {
		while (i < items.length) {
			const idx = i++;
			out[idx] = await fn(items[idx], idx);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return out;
}

/**
 * @param {{ url: string, slides?: number, style?: string, baseUrl?: string, c?: object }} opts
 */
export async function generateUrlIgCarousel(opts = {}) {
	const url = normalizeInputUrl(opts.url);
	const sourceKind = classifySourceUrl(url);
	const slideCount = Math.min(
		MAX_SLIDES,
		Math.max(1, Number(opts.slides) || DEFAULT_SLIDES),
	);

	const scraped = await scrapeUrlForCarousel(url, opts);
	const plan = await planCarouselSlides({
		title: scraped.title,
		sourceKind,
		text: scraped.text,
		slides: slideCount,
		style: opts.style,
	});

	const rendered = await mapPool(plan.slides, IMAGE_CONCURRENCY, async (slide) => {
		try {
			const { buffer, mime } = await generateCarouselImage(
				slide.imagePrompt ||
					`Instagram cover slide, bold headline: ${slide.headline}`,
			);
			const imageUrl = await uploadPngToUploadThing(buffer, mime, slide.index);
			return { ...slide, imageUrl, imageError: null };
		} catch (err) {
			return {
				...slide,
				imageUrl: null,
				imageError: err?.message || String(err),
			};
		}
	});

	return {
		source: {
			url,
			kind: sourceKind,
			endpoint: scraped.endpoint,
			title: scraped.title,
			...(scraped.meta || {}),
		},
		models: {
			llm: IG_CAROUSEL_LLM_MODEL,
			image: IG_CAROUSEL_IMAGE_MODEL,
		},
		dimensions: { aspect: IG_ASPECT, size: IG_SIZE },
		contentChars: scraped.text.length,
		caption: plan.caption,
		hashtags: plan.hashtags,
		slides: rendered,
	};
}

/** @deprecated use generateUrlIgCarousel */
export async function generateYoutubeIgCarousel(opts = {}) {
	return generateUrlIgCarousel(opts);
}

export async function fetchYoutubeTranscriptWithYtDlp(youtubeUrl) {
	const row = await scrapeYoutubeYtDlp(youtubeUrl);
	return {
		transcript: row.text,
		title: row.title,
		channel: row.channel || "",
		duration: row.meta?.duration || null,
		videoId: row.meta?.videoId || parseYoutubeId(youtubeUrl),
		thumbnail: row.meta?.thumbnail || null,
	};
}
