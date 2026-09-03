/**
 * Shared parsers for public social profile HTML / JSON (no login).
 */

export const IG_RESERVED = new Set([
	"p",
	"reel",
	"reels",
	"stories",
	"explore",
	"accounts",
	"about",
	"legal",
	"developer",
	"directory",
	"lite",
	"tv",
	"direct",
	"privacy",
	"terms",
	"emailsignup",
	"nametag",
]);

export const X_RESERVED = new Set([
	"home",
	"search",
	"explore",
	"i",
	"intent",
	"share",
	"settings",
	"compose",
	"notifications",
	"messages",
	"hashtag",
	"tos",
	"privacy",
	"login",
	"signup",
	"jobs",
	"about",
]);

export const YT_RESERVED = new Set([
	"watch",
	"shorts",
	"results",
	"feed",
	"playlist",
	"channel",
	"c",
	"user",
	"account",
	"premium",
	"upload",
	"live",
]);

export function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

export function parseCount(raw) {
	if (raw == null || raw === "") return null;
	if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
	const s = String(raw)
		.replace(/,/g, "")
		.replace(/\u00a0/g, " ")
		.trim();
	const m = s.match(/([\d.]+)\s*([KMB])?/i);
	if (!m) return null;
	const n = Number(m[1]);
	if (!Number.isFinite(n)) return null;
	const mul =
		String(m[2] || "").toUpperCase() === "B"
			? 1e9
			: String(m[2] || "").toUpperCase() === "M"
				? 1e6
				: String(m[2] || "").toUpperCase() === "K"
					? 1e3
					: 1;
	return Math.round(n * mul);
}

/** "1.2M Followers, 323 Following, 1,204 Posts" */
export function parseIgOgDescription(desc) {
	const s = String(desc || "");
	const followers = s.match(/([\d.,]+\s*[KMB]?)\s*Followers/i);
	const following = s.match(/([\d.,]+\s*[KMB]?)\s*Following/i);
	const posts = s.match(/([\d.,]+\s*[KMB]?)\s*Posts/i);
	return {
		followersCount: followers ? parseCount(followers[1]) : null,
		followingCount: following ? parseCount(following[1]) : null,
		postsCount: posts ? parseCount(posts[1]) : null,
	};
}

export function parseFollowerPhrase(text) {
	const s = String(text || "");
	const m =
		s.match(
			/([\d.,]+\s*[KMB]?)\s*(?:followers|subscriber[s]?)/i,
		) || s.match(/(?:followers|subscriber[s]?)\s*[:\-]?\s*([\d.,]+\s*[KMB]?)/i);
	return m ? parseCount(m[1]) : null;
}

export function extractMeta(html) {
	const out = { title: "", description: "", image: "", ogTitle: "", ogDescription: "" };
	const pick = (re) => {
		const m = String(html || "").match(re);
		return m ? decodeHtml(m[1]).trim() : "";
	};
	out.title = pick(/<title[^>]*>([^<]+)<\/title>/i);
	out.ogTitle = pick(
		/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i,
	) || pick(
		/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:title["']/i,
	);
	out.ogDescription = pick(
		/<meta[^>]+(?:property|name)=["']og:description["'][^>]+content=["']([^"']+)["']/i,
	) || pick(
		/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:description["']/i,
	);
	out.description =
		out.ogDescription ||
		pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
	out.image =
		pick(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
		pick(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i);
	return out;
}

function decodeHtml(s) {
	return String(s || "")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

export function extractJsonScripts(html) {
	const blobs = [];
	const re =
		/<script[^>]*>([\s\S]*?)<\/script>/gi;
	let m;
	const src = String(html || "");
	while ((m = re.exec(src))) {
		const body = m[1].trim();
		if (!body) continue;
		const assign = body.match(
			/(?:window\._sharedData|window\.__additionalDataLoaded|ytInitialData|ytInitialPlayerResponse)\s*=\s*(\{[\s\S]*?\});?\s*$/,
		);
		const jsonLd = body.match(/^\s*(\{[\s\S]*\})\s*$/);
		const candidate = assign?.[1] || (body.startsWith("{") ? jsonLd?.[1] : null);
		if (!candidate) continue;
		try {
			blobs.push(JSON.parse(candidate));
		} catch {
			/* ignore */
		}
	}
	return blobs;
}

export function walkFind(obj, pred, acc = [], depth = 0) {
	if (!obj || depth > 12 || acc.length > 8) return acc;
	if (pred(obj)) acc.push(obj);
	if (Array.isArray(obj)) {
		for (const v of obj) walkFind(v, pred, acc, depth + 1);
	} else if (typeof obj === "object") {
		for (const v of Object.values(obj)) walkFind(v, pred, acc, depth + 1);
	}
	return acc;
}

export function instagramUsernameFrom(raw) {
	const s = String(raw || "").trim();
	if (!s) return "";
	try {
		if (/^https?:\/\//i.test(s) || s.includes("instagram.com")) {
			const u = new URL(s.startsWith("http") ? s : `https://${s}`);
			const parts = u.pathname.split("/").filter(Boolean);
			const handle = (parts[0] || "").replace(/^@/, "");
			if (!handle || IG_RESERVED.has(handle.toLowerCase())) return "";
			return handle.replace(/[^A-Za-z0-9._]/g, "");
		}
	} catch {
		/* fall through */
	}
	const h = s.replace(/^@/, "").split("/")[0].replace(/[^A-Za-z0-9._]/g, "");
	if (!h || IG_RESERVED.has(h.toLowerCase())) return "";
	return h;
}

export function xHandleFrom(raw) {
	const s = String(raw || "").trim();
	if (!s) return "";
	try {
		if (/^https?:\/\//i.test(s) || /(?:x|twitter)\.com/i.test(s)) {
			const u = new URL(s.startsWith("http") ? s : `https://${s}`);
			const parts = u.pathname.split("/").filter(Boolean);
			const handle = (parts[0] || "").replace(/^@/, "");
			if (!handle || X_RESERVED.has(handle.toLowerCase())) return "";
			if (["status", "with_replies", "highlights", "media", "likes"].includes(
				(parts[1] || "").toLowerCase(),
			) && parts[0]) {
				return parts[0].replace(/[^A-Za-z0-9_]/g, "");
			}
			return handle.replace(/[^A-Za-z0-9_]/g, "");
		}
	} catch {
		/* fall through */
	}
	const h = s.replace(/^@/, "").split("/")[0].replace(/[^A-Za-z0-9_]/g, "");
	if (!h || X_RESERVED.has(h.toLowerCase())) return "";
	return h;
}

export function youtubeFrom(raw) {
	const s = String(raw || "").trim();
	if (!s) return { handle: "", channelId: "", url: "" };
	try {
		const u = new URL(s.startsWith("http") ? s : `https://${s}`);
		const parts = u.pathname.split("/").filter(Boolean);
		if (u.hostname.includes("youtu.be")) return { handle: "", channelId: "", url: "" };
		if (parts[0] === "channel" && parts[1]?.startsWith("UC")) {
			return {
				handle: "",
				channelId: parts[1],
				url: `https://www.youtube.com/channel/${parts[1]}`,
			};
		}
		if (parts[0]?.startsWith("@")) {
			const handle = parts[0].replace(/^@/, "");
			if (YT_RESERVED.has(handle.toLowerCase())) return { handle: "", channelId: "", url: "" };
			return {
				handle,
				channelId: "",
				url: `https://www.youtube.com/@${handle}`,
			};
		}
		if (parts[0] === "c" && parts[1]) {
			return {
				handle: parts[1],
				channelId: "",
				url: `https://www.youtube.com/@${parts[1]}`,
			};
		}
		if (YT_RESERVED.has(String(parts[0] || "").toLowerCase())) {
			return { handle: "", channelId: "", url: "" };
		}
	} catch {
		/* fall through */
	}
	if (/^https?:\/\//i.test(s)) return { handle: "", channelId: "", url: "" };
	const h = s.replace(/^@/, "").split("/")[0];
	if (!h || YT_RESERVED.has(h.toLowerCase())) return { handle: "", channelId: "", url: "" };
	return { handle: h, channelId: "", url: `https://www.youtube.com/@${h}` };
}

/** Pull `varName = {...}` JSON from HTML with brace matching. */
export function extractAssignedJson(html, varName) {
	const src = String(html || "");
	const re = new RegExp(`${varName}\\s*=\\s*\\{`);
	const m = src.match(re);
	if (!m) return null;
	const start = src.indexOf(m[0]) + m[0].length - 1;
	let depth = 0;
	for (let i = start; i < src.length && i < start + 2_000_000; i++) {
		const ch = src[i];
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				try {
					return JSON.parse(src.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

export function looksLikeLoginWall(html, title) {
	const blob = `${title || ""}\n${String(html || "").slice(0, 4000)}`.toLowerCase();
	return (
		blob.includes("log into instagram") ||
		blob.includes("log in to instagram") ||
		blob.includes("sign up to see") ||
		/\blog in to x\b/.test(blob) ||
		blob.includes("sign in to x")
	);
}
