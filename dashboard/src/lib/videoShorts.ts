export type ShortsAudio = {
	narration: boolean;
	music: string;
	sfx: boolean;
	voice: string;
};

export type ShortsRequest = {
	url: string;
	github_url?: string;
	blog_url?: string;
	extra_urls?: string[];
	variations: number;
	duration_sec: number;
	aspect: "9:16" | "1:1" | "16:9";
	formats?: string[];
	tone?: string;
	audience?: string;
	audio: ShortsAudio | false;
	captions: boolean;
	upload: boolean;
};

export type ShortsEstimate = {
	currency: string;
	breakdown: Record<string, number>;
	total_usd: number;
	per_video_usd: number;
};

export type ShortsScene = {
	id: string;
	purpose: string;
	duration: number;
	start: number;
	narration: string;
	on_screen_text: string;
	visual: { type: string; [k: string]: unknown };
	frame_path?: string | null;
};

export type ShortsVariant = {
	id: string;
	status: "pending" | "scripting" | "queued" | "rendering" | "success" | "failed";
	step: string;
	progress: number;
	error: string | null;
	concept: {
		id: string;
		format: string;
		title: string;
		angle: string;
		hook: string;
		audience: string;
		pace: string;
		music_mood: string;
		theme?: { background?: string; accent?: string } | null;
	};
	caption?: string;
	result: null | {
		video_url: string | null;
		video_path: string | null;
		duration_sec: number;
		resolution: string;
		has_audio: boolean;
		title: string;
		logline: string;
		caption: string;
		music: { source: string; title: string | null; attribution: string | null } | null;
		thumbnail_path: string | null;
		thumbnail_url: string | null;
		scenes: ShortsScene[];
	};
};

export type ShortsJob = {
	id: string;
	status: "pending" | "running" | "success" | "partial" | "failed";
	step: string;
	progress: number;
	input: ShortsRequest & { narration: boolean; music: string; sfx: boolean; target_duration_sec: number };
	estimate: ShortsEstimate;
	sources: { type: string; url: string; ok: boolean; detail: string | null }[];
	frames: { id: string; kind: "screenshot" | "image"; source: string; preview_path: string | null; summary?: string; quality?: number; use_for?: string }[];
	brief: null | {
		product_name: string;
		one_liner: string;
		audience?: string[];
		pains?: string[];
		features?: { name: string; benefit: string; source: string }[];
		proof?: { label: string; value: string; source: string }[];
		hooks?: string[];
	};
	variants: ShortsVariant[];
	cost: null | { total_usd: number; by_stage: Record<string, number>; by_variant: Record<string, number> };
	error: string | null;
	logs: string[];
	created_at: string;
};

export type ShortsJobSummary = {
	id: string;
	url: string;
	status: ShortsJob["status"];
	step: string;
	progress: number;
	product: string | null;
	variants: { id: string; status: string; title: string; format: string; video_url: string | null; video_path: string | null }[];
	total_usd: number | null;
	created_at: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`/api${path}`, {
		...init,
		headers: init?.body ? { "Content-Type": "application/json" } : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok && res.status !== 202) {
		const err = new Error(data?.error || `HTTP ${res.status}`) as Error & { code?: string };
		err.code = data?.code;
		throw err;
	}
	return data as T;
}

export const shortsApi = {
	formats: () => request<{ formats: Record<string, string> }>("/video-shorts/formats"),
	estimate: (body: ShortsRequest) =>
		request<{ estimate: ShortsEstimate }>("/video-shorts/estimate", { method: "POST", body: JSON.stringify(body) }),
	create: (body: ShortsRequest) =>
		request<ShortsJob & { job_id: string }>("/video-shorts", { method: "POST", body: JSON.stringify(body) }),
	get: (id: string) => request<ShortsJob>(`/video-shorts/${id}`),
	list: () => request<{ jobs: ShortsJobSummary[] }>("/video-shorts?limit=15"),
};

/** UploadThing URL when uploaded, otherwise the API's local file route. */
export function mediaUrl(jobId: string, remote: string | null | undefined, local: string | null | undefined) {
	if (remote) return remote;
	if (!local) return null;
	return `/api/video-shorts/${jobId}/file?p=${encodeURIComponent(local)}`;
}

export const isActive = (s?: string) => s === "pending" || s === "running";
