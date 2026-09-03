/**
 * Latest YouTube videos for a channel — Data API when keyed, else /videos HTML.
 */

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function ytKey() {
	return process.env.YOUTUBE_API_KEY?.trim() || "";
}

async function resolveChannelId(handle, channelId) {
	if (channelId && String(channelId).startsWith("UC")) return channelId;
	const key = ytKey();
	if (!key || !handle) return channelId || "";
	const params = new URLSearchParams({
		part: "id,contentDetails",
		forHandle: String(handle).replace(/^@/, ""),
		key,
	});
	try {
		const res = await fetch(
			`https://www.googleapis.com/youtube/v3/channels?${params}`,
			{ signal: AbortSignal.timeout(15_000) },
		);
		const data = await res.json().catch(() => ({}));
		return data.items?.[0]?.id || "";
	} catch {
		return "";
	}
}

async function uploadsPlaylistId(channelId) {
	const key = ytKey();
	if (!key || !channelId) return "";
	const params = new URLSearchParams({
		part: "contentDetails",
		id: channelId,
		key,
	});
	try {
		const res = await fetch(
			`https://www.googleapis.com/youtube/v3/channels?${params}`,
			{ signal: AbortSignal.timeout(15_000) },
		);
		const data = await res.json().catch(() => ({}));
		return data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || "";
	} catch {
		return "";
	}
}

async function playlistVideos(playlistId, max = 10) {
	const key = ytKey();
	if (!key || !playlistId) return [];
	const params = new URLSearchParams({
		part: "snippet,contentDetails",
		playlistId,
		maxResults: String(Math.min(50, Math.max(1, max))),
		key,
	});
	try {
		const res = await fetch(
			`https://www.googleapis.com/youtube/v3/playlistItems?${params}`,
			{ signal: AbortSignal.timeout(20_000) },
		);
		const data = await res.json().catch(() => ({}));
		return (data.items || [])
			.map((item) => {
				const sn = item.snippet || {};
				const videoId = item.contentDetails?.videoId || sn.resourceId?.videoId;
				if (!videoId) return null;
				return {
					videoId,
					title: sn.title || null,
					description: String(sn.description || "").slice(0, 2000),
					publishedAt: sn.publishedAt || item.contentDetails?.videoPublishedAt || null,
					thumbnail:
						sn.thumbnails?.high?.url ||
						sn.thumbnails?.medium?.url ||
						sn.thumbnails?.default?.url ||
						null,
					url: `https://www.youtube.com/watch?v=${videoId}`,
					source: "youtube_data_api",
				};
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

function videosFromHtml(html) {
	const ids = [];
	const seen = new Set();
	const re = /"videoId":"([A-Za-z0-9_-]{11})"/g;
	let m;
	while ((m = re.exec(html))) {
		if (seen.has(m[1])) continue;
		seen.add(m[1]);
		ids.push(m[1]);
		if (ids.length >= 20) break;
	}
	const titles = {};
	const titleRe =
		/"videoId":"([A-Za-z0-9_-]{11})"[^]{0,400}?"text":"([^"\\]{3,120})"/g;
	let t;
	while ((t = titleRe.exec(html))) {
		if (!titles[t[1]]) titles[t[1]] = t[2];
	}
	return ids.map((videoId) => ({
		videoId,
		title: titles[videoId] || null,
		description: "",
		publishedAt: null,
		thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
		url: `https://www.youtube.com/watch?v=${videoId}`,
		source: "html_videos",
	}));
}

async function fetchVideosHtml(handle, channelId) {
	const url = handle
		? `https://www.youtube.com/@${encodeURIComponent(String(handle).replace(/^@/, ""))}/videos`
		: channelId
			? `https://www.youtube.com/channel/${channelId}/videos`
			: "";
	if (!url) return [];
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(20_000),
			headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
		});
		const html = await res.text();
		return videosFromHtml(html);
	} catch {
		return [];
	}
}

/**
 * @param {{ handle?: string, channelId?: string, max?: number }} input
 */
export async function fetchLatestYoutubeVideos(input = {}) {
	const handle = String(input.handle || "").replace(/^@/, "");
	let channelId = input.channelId || "";
	const max = input.max || 10;

	if (ytKey()) {
		channelId = (await resolveChannelId(handle, channelId)) || channelId;
		const playlist = await uploadsPlaylistId(channelId);
		const api = await playlistVideos(playlist, max);
		if (api.length) {
			return { channelId, videos: api.slice(0, max), source: "youtube_data_api" };
		}
	}

	const html = await fetchVideosHtml(handle, channelId);
	return {
		channelId: channelId || null,
		videos: html.slice(0, max),
		source: html.length ? "html_videos" : "empty",
	};
}
