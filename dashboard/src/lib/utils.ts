import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function formatWhen(v?: string | null) {
	if (!v) return "—";
	const d = new Date(v);
	if (Number.isNaN(d.getTime())) return String(v).slice(0, 16);
	return d.toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function redditUrl(doc: Record<string, unknown>) {
	const permalink = String(doc.permalink || doc.threadUrl || "");
	if (!permalink) return "";
	if (permalink.startsWith("http")) return permalink;
	return `https://www.reddit.com${permalink}`;
}

export function rowHref(doc: Record<string, unknown>) {
	return (
		String(doc.wikiUrl || "") ||
		String(doc.threadUrl || "") ||
		redditUrl(doc) ||
		String(doc.url || doc.mapsUrl || doc.linkedinUrl || doc.ycUrl || doc.website || doc.profileUrl || doc.sourceUrl || "")
	);
}

export function rowTitle(doc: Record<string, unknown>) {
	return String(
		doc.title || doc.name || doc.handle || doc.prompt || doc.id || "Untitled",
	);
}

export function rowBody(doc: Record<string, unknown>) {
	const raw = String(
		doc.body ||
			doc.snippet ||
			doc.oneLiner ||
			doc.bio ||
			doc.relevanceReason ||
			doc.summary ||
			doc.address ||
			[doc.league, doc.manager, doc.stadium, doc.location].filter(Boolean).join(" · ") ||
			"",
	);
	return raw.slice(0, 180);
}

export function scoreOf(doc: Record<string, unknown>) {
	const n = Number(doc.relevanceScore ?? doc.score ?? doc.confidence ?? 0);
	return Number.isFinite(n) ? n : 0;
}

export function rowMeta(doc: Record<string, unknown>) {
	return String(
		doc.league ||
			(doc.subreddit
				? `r/${String(doc.subreddit).replace(/^r\//i, "")}`
				: doc.intent ||
					doc.city ||
					doc.platform ||
					doc.batch ||
					doc.category ||
					doc.source ||
					"—"),
	);
}

export function rowAuthor(doc: Record<string, unknown>) {
	return String(
		doc.manager ||
			doc.author ||
			doc.handle ||
			doc.developer ||
			doc.founderEmail ||
			doc.email ||
			"—",
	);
}

export function founderEmailOf(doc: Record<string, unknown>) {
	return String(
		doc.founderEmail ||
			doc.email ||
			doc.ctoEmail ||
			doc.salesEmail ||
			doc.genericEmail ||
			doc.hrEmail ||
			(Array.isArray(doc.emails) ? doc.emails[0] : "") ||
			"",
	);
}

export function rowWhen(doc: Record<string, unknown>) {
	return String(doc.fetchedAt || doc.publishedAt || doc.updatedAt || "");
}
