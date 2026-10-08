/**
 * YouTube channel → longer videos → full transcript script in Firestore.
 *
 * Collection: sir-deepanshu-giri-videos-scripts
 * One batch fetches 4–10 videos and pulls transcripts in parallel.
 * Caption chunks are joined into a single `script` string per video.
 */

import { FieldValue } from "firebase-admin/firestore";
import {
	fetchTranscript,
	YoutubeTranscriptNotAvailableLanguageError,
} from "youtube-transcript-plus";
import { firestore } from "../../config/firebase.js";
import { extractAssignedJson, youtubeFrom } from "../socialScrapers/parse.js";

export const YT_SCRIPTS_COLLECTION = "sir-deepanshu-giri-videos-scripts";
export const DEFAULT_CHANNEL_URL = "https://www.youtube.com/channel/UCZDXGoo2MxjJRAKusbbDzvA";
export const GREG_ISENBERG_COLLECTION = "GregIsenberg";
export const GREG_ISENBERG_CHANNEL = "https://www.youtube.com/@GregIsenberg";

export const YT_CHANNELS = [
	{
		id: "deepanshu-giri",
		label: "Deepanshu Giri",
		collection: YT_SCRIPTS_COLLECTION,
		channelUrl: DEFAULT_CHANNEL_URL,
	},
	{
		id: "greg-isenberg",
		label: "Greg Isenberg",
		collection: GREG_ISENBERG_COLLECTION,
		channelUrl: GREG_ISENBERG_CHANNEL,
	},
];

export function resolveYoutubeChannel({ collection, channelUrl } = {}) {
	const wantedCollection = String(collection || "").trim();
	const wantedUrl = String(channelUrl || "").trim();
	const match = YT_CHANNELS.find((row) => {
		if (wantedCollection && (row.collection === wantedCollection || row.id === wantedCollection)) {
			return true;
		}
		return false;
	});
	const name = wantedCollection || match?.collection || YT_SCRIPTS_COLLECTION;
	if (!/^[\w-]+$/.test(name)) throw new Error("Invalid collection name");
	return {
		collection: name,
		channelUrl: wantedUrl || match?.channelUrl || DEFAULT_CHANNEL_URL,
		label: match?.label || name,
	};
}
const CURSOR_ID = "_cursor";
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const DEFAULT_BATCH = 8;
const DEFAULT_MIN_SECONDS = 180;
const DEFAULT_INTERVAL_MS = 8_000;
const MAX_SCRIPT_CHARS = 900_000;

export function clampBatch(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return DEFAULT_BATCH;
	return Math.min(10, Math.max(4, Math.round(n)));
}

export function minDurationSeconds(value) {
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0) return DEFAULT_MIN_SECONDS;
	return Math.round(n);
}

export function intervalMs(value) {
	const n = Number(value);
	if (!Number.isFinite(n) || n < 1000) return DEFAULT_INTERVAL_MS;
	return Math.round(n);
}

function textOf(node) {
	if (!node) return "";
	if (typeof node === "string") return node;
	if (typeof node.simpleText === "string") return node.simpleText;
	if (typeof node.content === "string") return node.content;
	if (Array.isArray(node.runs)) return node.runs.map((row) => row?.text || "").join("");
	return "";
}

export function parseDuration(text) {
	const raw = String(text || "").trim();
	const match = raw.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
	if (!match) return null;
	if (match[3] != null) {
		return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
	}
	return Number(match[1]) * 60 + Number(match[2]);
}

export function videosPageUrl(channelUrl) {
	const parsed = youtubeFrom(channelUrl);
	let base = (parsed.url || String(channelUrl || "").trim()).replace(/\/+$/, "");
	if (!base) throw new Error("YouTube channel URL is required");
	base = base.replace(/\/(videos|shorts|streams|playlists|about|featured|community)$/i, "");
	return `${base}/videos`;
}

function thumbnailFor(videoId, thumbs) {
	const list = thumbs?.thumbnails || thumbs || [];
	if (Array.isArray(list) && list.length) {
		const last = list[list.length - 1];
		if (last?.url) return last.url;
	}
	return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function lengthFromOverlays(overlays) {
	if (!Array.isArray(overlays)) return "";
	for (const overlay of overlays) {
		const badge = overlay?.thumbnailOverlayTimeStatusRenderer;
		if (badge) return textOf(badge.text);
	}
	return "";
}

function isShort(renderer) {
	const blob = JSON.stringify(renderer?.navigationEndpoint || renderer?.navigationEndpoint || "");
	return blob.includes("/shorts/");
}

function videoFromNode(node) {
	const renderer = node?.videoRenderer || node?.gridVideoRenderer || node?.playlistVideoRenderer;
	if (renderer?.videoId && !isShort(renderer)) {
		const lengthText = textOf(renderer.lengthText) || lengthFromOverlays(renderer.thumbnailOverlays);
		return {
			videoId: renderer.videoId,
			title: textOf(renderer.title) || `YouTube ${renderer.videoId}`,
			lengthText,
			durationSec: parseDuration(lengthText),
			publishedText: textOf(renderer.publishedTimeText),
			viewCountText: textOf(renderer.viewCountText) || textOf(renderer.shortViewCountText),
			thumbnail: thumbnailFor(renderer.videoId, renderer.thumbnail),
			url: `https://www.youtube.com/watch?v=${renderer.videoId}`,
		};
	}

	const lock = node?.lockupViewModel;
	const videoId = lock?.contentId;
	if (!lock || !/^[A-Za-z0-9_-]{11}$/.test(videoId || "")) return null;
	const blob = JSON.stringify(lock);
	if (blob.includes("/shorts/")) return null;
	const title =
		lock.metadata?.lockupMetadataViewModel?.title?.content ||
		textOf(lock.metadata?.lockupMetadataViewModel?.title) ||
		`YouTube ${videoId}`;
	const lengthMatch = blob.match(/"text":"(\d{1,2}:\d{2}(?::\d{2})?)"/);
	const lengthText = lengthMatch?.[1] || "";
	return {
		videoId,
		title: typeof title === "string" ? title : `YouTube ${videoId}`,
		lengthText,
		durationSec: parseDuration(lengthText),
		publishedText: "",
		viewCountText: "",
		thumbnail: thumbnailFor(videoId),
		url: `https://www.youtube.com/watch?v=${videoId}`,
	};
}

function continuationToken(node) {
	return node?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || "";
}

function walkGrid(nodes, acc, depth = 0) {
	if (!nodes || depth > 12) return;
	const list = Array.isArray(nodes) ? nodes : [nodes];
	for (const node of list) {
		if (!node || typeof node !== "object") continue;
		const video = videoFromNode(node);
		if (video) acc.videos.push(video);
		const token = continuationToken(node);
		if (token) acc.continuation = token;
		if (node.richItemRenderer?.content) walkGrid(node.richItemRenderer.content, acc, depth + 1);
		if (node.gridVideoRenderer) walkGrid({ videoRenderer: node.gridVideoRenderer }, acc, depth + 1);
		if (Array.isArray(node.contents)) walkGrid(node.contents, acc, depth + 1);
		if (Array.isArray(node.items)) walkGrid(node.items, acc, depth + 1);
	}
}

function gridContents(data) {
	const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
	for (const tab of tabs) {
		const rich = tab?.tabRenderer?.content?.richGridRenderer?.contents;
		if (Array.isArray(rich) && rich.length) return rich;
		const section = tab?.tabRenderer?.content?.sectionListRenderer?.contents;
		if (Array.isArray(section) && section.length) return section;
	}
	const actions = data?.onResponseReceivedActions || [];
	for (const action of actions) {
		const items =
			action?.appendContinuationItemsAction?.continuationItems ||
			action?.reloadContinuationItemsCommand?.continuationItems;
		if (Array.isArray(items) && items.length) return items;
	}
	return [];
}

export function parseChannelVideosPayload(data) {
	const acc = { videos: [], continuation: "" };
	walkGrid(gridContents(data), acc);
	const seen = new Set();
	const videos = [];
	for (const video of acc.videos) {
		if (!video?.videoId || seen.has(video.videoId)) continue;
		seen.add(video.videoId);
		videos.push(video);
	}
	return { videos, continuation: acc.continuation || "" };
}

function channelMeta(data, html) {
	const meta = data?.metadata?.channelMetadataRenderer || {};
	const channelId =
		meta.externalId ||
		data?.header?.c4TabbedHeaderRenderer?.channelId ||
		String(html || "").match(/"externalId":"(UC[\w-]{20,})"/)?.[1] ||
		"";
	return {
		channelId,
		channelTitle: meta.title || data?.header?.c4TabbedHeaderRenderer?.title || "",
		apiKey: String(html || "").match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] || "",
		clientVersion:
			String(html || "").match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] ||
			"2.20250901.01.00",
	};
}

async function fetchChannelPage(channelUrl) {
	const url = videosPageUrl(channelUrl);
	const res = await fetch(url, {
		redirect: "follow",
		signal: AbortSignal.timeout(25_000),
		headers: {
			"User-Agent": UA,
			"Accept-Language": "en-US,en;q=0.9",
			Accept: "text/html",
		},
	});
	if (!res.ok) throw new Error(`YouTube channel page HTTP ${res.status}`);
	const html = await res.text();
	const data = extractAssignedJson(html, "ytInitialData");
	if (!data) throw new Error("YouTube channel page had no video data");
	const parsed = parseChannelVideosPayload(data);
	return { url, ...parsed, ...channelMeta(data, html) };
}

async function fetchContinuationPage({ continuation, apiKey, clientVersion }) {
	const endpoint = new URL("https://www.youtube.com/youtubei/v1/browse");
	endpoint.searchParams.set("prettyPrint", "false");
	if (apiKey) endpoint.searchParams.set("key", apiKey);
	const res = await fetch(endpoint, {
		method: "POST",
		signal: AbortSignal.timeout(25_000),
		headers: {
			"Content-Type": "application/json",
			"User-Agent": UA,
			"Accept-Language": "en-US,en;q=0.9",
		},
		body: JSON.stringify({
			context: {
				client: {
					clientName: "WEB",
					clientVersion: clientVersion || "2.20250901.01.00",
					hl: "en",
					gl: "US",
				},
			},
			continuation,
		}),
	});
	if (!res.ok) throw new Error(`YouTube continuation HTTP ${res.status}`);
	const data = await res.json();
	return parseChannelVideosPayload(data);
}

function isLongEnough(video, minSeconds) {
	if (video.durationSec == null) return true;
	return video.durationSec >= minSeconds;
}

export function joinTranscript(rows) {
	return (Array.isArray(rows) ? rows : [])
		.map((row) => String(row?.text || "").replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_SCRIPT_CHARS);
}

const ANDROID_UA =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

export function isTranscriptBlockError(message) {
	const text = String(message || "").toLowerCase();
	return (
		text.includes("no longer available") ||
		text.includes("too many requests") ||
		text.includes("recaptcha") ||
		text.includes("429") ||
		text.includes("/sorry/")
	);
}

function decodeXml(text) {
	return String(text || "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function rowsFromCaptionXml(xml, lang) {
	const rows = [];
	const re = /<text[^>]*>([^<]*)<\/text>/g;
	let match;
	while ((match = re.exec(xml))) {
		const text = decodeXml(match[1]).replace(/\s+/g, " ").trim();
		if (text) rows.push({ text, lang });
	}
	return rows;
}

function pickCaptionTrack(tracks) {
	const usable = (Array.isArray(tracks) ? tracks : []).filter((track) => track?.baseUrl);
	const rank = (track) => {
		const code = String(track.languageCode || "");
		const asr = track.kind === "asr" ? 1 : 0;
		if (code === "en" || code.startsWith("en-")) return asr;
		if (code === "hi" || code.startsWith("hi-")) return 10 + asr;
		return 30 + asr;
	};
	usable.sort((a, b) => rank(a) - rank(b));
	return usable[0] || null;
}

/** Watch-page transcript fetches get HTTP 429 and the library calls that "removed". Android player still has the captions. */
async function fetchTranscriptViaAndroid(videoId, apiKey) {
	if (!apiKey) throw new Error("Missing Innertube key for caption fallback");
	const res = await fetch(
		`https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=${encodeURIComponent(apiKey)}`,
		{
			method: "POST",
			signal: AbortSignal.timeout(20_000),
			headers: {
				"Content-Type": "application/json",
				"User-Agent": ANDROID_UA,
			},
			body: JSON.stringify({
				context: {
					client: {
						clientName: "ANDROID",
						clientVersion: "20.10.38",
						hl: "en",
						gl: "US",
					},
				},
				videoId,
			}),
		},
	);
	if (!res.ok) throw new Error(`YouTube player HTTP ${res.status}`);
	const data = await res.json();
	const playable = data?.playabilityStatus?.status;
	if (playable && playable !== "OK") {
		throw new Error(data?.playabilityStatus?.reason || `Player status ${playable}`);
	}
	const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
	const track = pickCaptionTrack(tracks);
	if (!track) throw new Error("No caption tracks");
	const captionUrl = String(track.baseUrl).replace(/&fmt=[^&]+/, "");
	const captionRes = await fetch(captionUrl, {
		signal: AbortSignal.timeout(20_000),
		headers: { "User-Agent": ANDROID_UA },
	});
	if (!captionRes.ok) throw new Error(`Caption download HTTP ${captionRes.status}`);
	const rows = rowsFromCaptionXml(await captionRes.text(), track.languageCode || "");
	if (!rows.length) throw new Error("Caption track was empty");
	return rows;
}

async function fetchTranscriptRows(videoId, apiKey) {
	try {
		return await fetchTranscriptViaAndroid(videoId, apiKey);
	} catch (androidError) {
		try {
			return await fetchTranscript(videoId);
		} catch (err) {
			if (err instanceof YoutubeTranscriptNotAvailableLanguageError) {
				try {
					return await fetchTranscript(videoId, { lang: "en" });
				} catch {
					/* use the android error below */
				}
			}
			if (isTranscriptBlockError(err?.message) || isTranscriptBlockError(androidError?.message)) {
				throw new Error(err?.message || androidError?.message || "YouTube blocked the transcript request");
			}
			throw androidError;
		}
	}
}

async function transcriptForVideo(video, apiKey) {
	try {
		const rows = await fetchTranscriptRows(video.videoId, apiKey);
		const script = joinTranscript(rows);
		if (!script) {
			return { ...video, script: "", segmentCount: 0, status: "no_transcript", error: "Empty transcript" };
		}
		return {
			...video,
			script,
			segmentCount: rows.length,
			status: "ok",
			error: "",
		};
	} catch (err) {
		return {
			...video,
			script: "",
			segmentCount: 0,
			status: "no_transcript",
			error: err?.message || String(err),
		};
	}
}

function cursorRef(collection) {
	return firestore.collection(collection).doc(CURSOR_ID);
}

async function loadCursor(collection) {
	const snap = await cursorRef(collection).get();
	return snap.exists ? snap.data() || {} : {};
}

async function saveCursor(collection, patch) {
	await cursorRef(collection).set(
		{
			kind: "cursor",
			...patch,
			updatedAt: FieldValue.serverTimestamp(),
		},
		{ merge: true },
	);
}

function isBlockedMiss(data) {
	if (!data || data.kind === "cursor") return false;
	if (data.status === "ok" && Number(data.scriptChars || 0) > 0) return false;
	return isTranscriptBlockError(data.error);
}

async function storedIds(collection) {
	const snap = await firestore.collection(collection).select("status", "kind", "error", "scriptChars").get();
	const ids = new Set();
	for (const doc of snap.docs) {
		if (doc.id === CURSOR_ID || doc.get("kind") === "cursor") continue;
		if (isBlockedMiss(doc.data())) continue;
		ids.add(doc.id);
	}
	return ids;
}

async function blockedVideoStubs(collection) {
	const snap = await firestore
		.collection(collection)
		.select("status", "kind", "error", "scriptChars", "title", "url", "thumbnail", "lengthText", "durationSec")
		.get();
	const rows = [];
	for (const doc of snap.docs) {
		if (!isBlockedMiss(doc.data())) continue;
		rows.push({
			videoId: doc.id,
			title: doc.get("title") || "",
			url: doc.get("url") || `https://www.youtube.com/watch?v=${doc.id}`,
			thumbnail: doc.get("thumbnail") || "",
			lengthText: doc.get("lengthText") || "",
			durationSec: doc.get("durationSec") ?? null,
		});
	}
	return rows;
}

async function saveVideo(video, channel, collection) {
	const ref = firestore.collection(collection).doc(video.videoId);
	const existing = await ref.get();
	const blockedMiss = existing.exists && isBlockedMiss(existing.data());
	if (existing.exists && existing.get("kind") !== "cursor" && !blockedMiss) return false;
	if (!video.script && isTranscriptBlockError(video.error)) return false;
	await ref.set({
		kind: "video",
		videoId: video.videoId,
		title: video.title,
		url: video.url,
		thumbnail: video.thumbnail,
		lengthText: video.lengthText || "",
		durationSec: video.durationSec,
		publishedText: video.publishedText || "",
		viewCountText: video.viewCountText || "",
		script: video.script || "",
		segmentCount: video.segmentCount || 0,
		scriptChars: String(video.script || "").length,
		status: video.status,
		error: video.error || "",
		channelUrl: channel.channelUrl,
		channelId: channel.channelId || "",
		channelTitle: channel.channelTitle || "",
		createdAt: blockedMiss
			? existing.get("createdAt") || FieldValue.serverTimestamp()
			: FieldValue.serverTimestamp(),
		updatedAt: FieldValue.serverTimestamp(),
	});
	return true;
}

function publicVideo(id, data, { includeScript = false } = {}) {
	const script = String(data?.script || "");
	return {
		videoId: id,
		title: data?.title || "",
		url: data?.url || `https://www.youtube.com/watch?v=${id}`,
		thumbnail: data?.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
		lengthText: data?.lengthText || "",
		durationSec: data?.durationSec ?? null,
		publishedText: data?.publishedText || "",
		channelTitle: data?.channelTitle || "",
		channelUrl: data?.channelUrl || "",
		status: data?.status || "",
		scriptChars: data?.scriptChars ?? script.length,
		segmentCount: data?.segmentCount || 0,
		scriptPreview: script.slice(0, 220),
		updatedAt: data?.updatedAt?.toDate?.()?.toISOString?.() || null,
		...(includeScript ? { script, error: data?.error || "" } : {}),
	};
}

function savedMillis(data) {
	const stamp = data?.updatedAt || data?.createdAt;
	const millis = stamp?.toMillis?.();
	return Number.isFinite(millis) ? millis : 0;
}

export async function listYoutubeScripts({ limit = 80, collection } = {}) {
	const resolved = resolveYoutubeChannel({ collection });
	const cap = Math.min(200, Math.max(1, Number(limit) || 80));
	let snap;
	try {
		snap = await firestore
			.collection(resolved.collection)
			.orderBy("updatedAt", "desc")
			.limit(cap + 5)
			.get();
	} catch {
		snap = await firestore.collection(resolved.collection).get();
	}
	const videos = snap.docs
		.filter((doc) => doc.id !== CURSOR_ID && doc.get("kind") !== "cursor")
		.sort((a, b) => savedMillis(b.data()) - savedMillis(a.data()))
		.slice(0, cap)
		.map((doc) => publicVideo(doc.id, doc.data()));
	return {
		collection: resolved.collection,
		label: resolved.label,
		count: videos.length,
		videos,
	};
}

export async function getYoutubeScript(videoId, collection) {
	const resolved = resolveYoutubeChannel({ collection });
	const id = String(videoId || "").trim();
	if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
	const snap = await firestore.collection(resolved.collection).doc(id).get();
	if (!snap.exists || snap.get("kind") === "cursor") return null;
	return publicVideo(snap.id, snap.data(), { includeScript: true });
}

/**
 * One tick: discover the next longer videos, fetch transcripts in parallel, store scripts.
 */
export async function runYoutubeChannelScriptsBatch({
	channelUrl,
	collection,
	batchSize,
	minSeconds,
} = {}) {
	const resolved = resolveYoutubeChannel({
		collection: collection || process.env.YT_SCRIPTS_COLLECTION,
		channelUrl: channelUrl || process.env.YT_CHANNEL_URL,
	});
	const channel = resolved.channelUrl;
	if (!channel) throw new Error("channelUrl is required");
	const size = clampBatch(batchSize ?? process.env.YT_SCRIPTS_BATCH);
	const min = minDurationSeconds(minSeconds ?? process.env.YT_SCRIPTS_MIN_SECONDS);
	const pageUrl = videosPageUrl(channel);

	let cursor = await loadCursor(resolved.collection);
	if (cursor.channelUrl && cursor.channelUrl !== pageUrl) {
		cursor = {};
	}

	const done = await storedIds(resolved.collection);
	const retries = await blockedVideoStubs(resolved.collection);
	let pending = [
		...retries,
		...(Array.isArray(cursor.pending) ? cursor.pending : []),
	].filter((row) => row?.videoId && !done.has(row.videoId));
	const seenPending = new Set();
	pending = pending.filter((row) => {
		if (seenPending.has(row.videoId)) return false;
		seenPending.add(row.videoId);
		return true;
	});
	let continuation = cursor.exhausted ? "" : cursor.continuation || "";
	let apiKey = cursor.apiKey || "";
	let clientVersion = cursor.clientVersion || "";
	let channelId = cursor.channelId || "";
	let channelTitle = cursor.channelTitle || "";
	let pagesFetched = 0;
	let exhausted = false;

	while (pending.length < size && pagesFetched < 4 && !exhausted) {
		const page = continuation
			? await fetchContinuationPage({ continuation, apiKey, clientVersion })
			: await fetchChannelPage(channel);
		pagesFetched += 1;
		if (!continuation) {
			channelId = page.channelId || channelId;
			channelTitle = page.channelTitle || channelTitle;
			apiKey = page.apiKey || apiKey;
			clientVersion = page.clientVersion || clientVersion;
		}
		const fresh = page.videos.filter(
			(video) => isLongEnough(video, min) && !done.has(video.videoId) && !pending.some((row) => row.videoId === video.videoId),
		);
		pending.push(...fresh);
		continuation = page.continuation || "";
		if (!continuation) {
			exhausted = true;
			break;
		}
		if (!page.videos.length) break;
	}

	const unique = [];
	const seenBatch = new Set();
	for (const video of pending) {
		if (!video?.videoId || done.has(video.videoId) || seenBatch.has(video.videoId)) continue;
		seenBatch.add(video.videoId);
		unique.push(video);
		if (unique.length >= size) break;
	}
	const rest = pending.filter((video) => !seenBatch.has(video.videoId));
	const settled = await Promise.all(unique.map((video) => transcriptForVideo(video, apiKey)));
	const writes = await Promise.all(
		settled.map((video) =>
			saveVideo(video, { channelUrl: pageUrl, channelId, channelTitle }, resolved.collection),
		),
	);
	const retryLater = settled
		.filter((video) => !video.script && isTranscriptBlockError(video.error))
		.map(({ script, segmentCount, status, error, ...video }) => video);
	const pendingNext = [...retryLater, ...rest];

	const saved = writes.filter(Boolean).length;
	const skipped = writes.length - saved;
	const missing = settled.filter((video) => video.status !== "ok").length;
	const nextExhausted = exhausted && pendingNext.length === 0;

	await saveCursor(resolved.collection, {
		channelUrl: pageUrl,
		channelId,
		channelTitle,
		apiKey,
		clientVersion,
		continuation: nextExhausted ? "" : continuation,
		pending: pendingNext,
		exhausted: nextExhausted,
		lastBatch: settled.length,
		lastSaved: saved,
	});

	return {
		collection: resolved.collection,
		channelUrl: pageUrl,
		channelId,
		channelTitle,
		batch: settled.length,
		saved,
		skipped,
		missing,
		pending: pendingNext.length,
		exhausted: nextExhausted,
		videos: settled.map((video) => ({
			videoId: video.videoId,
			title: video.title,
			status: video.status,
			scriptChars: String(video.script || "").length,
			error: video.error || "",
		})),
	};
}
