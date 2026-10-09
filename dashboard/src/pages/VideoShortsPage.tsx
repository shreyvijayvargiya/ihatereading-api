import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertTriangle,
	Check,
	ChevronDown,
	Clapperboard,
	Copy,
	Download,
	FileText,
	Github,
	Globe,
	Image as ImageIcon,
	Loader2,
	Newspaper,
	Sparkles,
	Volume2,
	VolumeX,
	X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
	isActive,
	mediaUrl,
	shortsApi,
	type ShortsJob,
	type ShortsRequest,
	type ShortsVariant,
} from "@/lib/videoShorts";

const STEPS = [
	{ key: "gather_context", label: "Context" },
	{ key: "analyze_frames", label: "Frames" },
	{ key: "product_brief", label: "Brief" },
	{ key: "plan_concepts", label: "Concepts" },
	{ key: "storyboards", label: "Scripts" },
	{ key: "render", label: "Render" },
	{ key: "done", label: "Done" },
];

const ASPECT_CLASS: Record<string, string> = { "9:16": "aspect-[9/16]", "1:1": "aspect-square", "16:9": "aspect-video" };
const SOURCE_ICON: Record<string, typeof Globe> = { website: Globe, github: Github, blog: Newspaper, llms_txt: FileText, page: Globe };
const LAST_JOB_KEY = "video-shorts-last-job";

type FormState = {
	url: string;
	github_url: string;
	blog_url: string;
	extra_urls: string;
	variations: number;
	duration_sec: number;
	aspect: ShortsRequest["aspect"];
	formats: string[];
	tone: string;
	audio: boolean;
	narration: boolean;
	music: string;
	sfx: boolean;
	voice: string;
	captions: boolean;
	upload: boolean;
};

const DEFAULT_FORM: FormState = {
	url: "",
	github_url: "",
	blog_url: "",
	extra_urls: "",
	variations: 3,
	duration_sec: 30,
	aspect: "9:16",
	formats: [],
	tone: "punchy, confident, modern",
	audio: true,
	narration: true,
	music: "auto",
	sfx: true,
	voice: "nova",
	captions: true,
	upload: true,
};

function toRequest(f: FormState): ShortsRequest {
	return {
		url: f.url.trim(),
		github_url: f.github_url.trim() || undefined,
		blog_url: f.blog_url.trim() || undefined,
		extra_urls: f.extra_urls
			.split(/[\s,]+/)
			.map((s) => s.trim())
			.filter(Boolean),
		variations: f.variations,
		duration_sec: f.duration_sec,
		aspect: f.aspect,
		formats: f.formats,
		tone: f.tone,
		audio: f.audio ? { narration: f.narration, music: f.music, sfx: f.sfx, voice: f.voice } : false,
		captions: f.audio && f.narration && f.captions,
		upload: f.upload,
	};
}

function useDebounced<T>(value: T, ms: number) {
	const [v, setV] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setV(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return v;
}

export function VideoShortsPage() {
	const qc = useQueryClient();
	const [form, setForm] = useState<FormState>(DEFAULT_FORM);
	const [jobId, setJobId] = useState<string | null>(() => {
		try {
			return localStorage.getItem(LAST_JOB_KEY);
		} catch {
			return null;
		}
	});

	useEffect(() => {
		try {
			if (jobId) localStorage.setItem(LAST_JOB_KEY, jobId);
		} catch {
			/* storage unavailable */
		}
	}, [jobId]);

	const job = useQuery({
		queryKey: ["video-shorts", jobId],
		queryFn: () => shortsApi.get(jobId!),
		enabled: Boolean(jobId),
		refetchInterval: (q) => (isActive(q.state.data?.status) ? 1500 : false),
	});
	const history = useQuery({
		queryKey: ["video-shorts-list"],
		queryFn: shortsApi.list,
		refetchInterval: isActive(job.data?.status) ? 4000 : 15000,
	});
	const create = useMutation({
		mutationFn: shortsApi.create,
		onSuccess: (data) => {
			setJobId(data.id);
			qc.invalidateQueries({ queryKey: ["video-shorts-list"] });
		},
	});

	return (
		<div className="h-full overflow-y-auto overflow-x-hidden lg:overflow-hidden">
			<div className="grid gap-4 lg:h-full lg:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
			<div className="flex min-w-0 flex-col gap-4 lg:min-h-0 lg:overflow-auto lg:pr-1">
				<CreateForm form={form} setForm={setForm} submitting={create.isPending} error={create.error as (Error & { code?: string }) | null} onSubmit={() => create.mutate(toRequest(form))} />
				<HistoryCard jobs={history.data?.jobs || []} activeId={jobId} onPick={setJobId} />
			</div>
			<div className="min-w-0 lg:min-h-0 lg:overflow-auto">
				{jobId && job.data ? (
					<JobView job={job.data} />
				) : jobId && job.isLoading ? (
					<p className="p-6 text-sm text-muted-foreground">Loading job…</p>
				) : (
					<EmptyState />
				)}
			</div>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ form */

function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
	return (
		<div className="flex rounded-md border border-border bg-muted p-0.5">
			{options.map((o) => (
				<button
					key={String(o.value)}
					type="button"
					onClick={() => onChange(o.value)}
					className={cn("flex-1 rounded px-2 py-1 text-xs font-medium transition-colors", value === o.value ? "bg-white shadow-sm" : "text-muted-foreground hover:text-foreground")}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-baseline justify-between gap-2">
				<Label className="text-xs">{label}</Label>
				{hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
			</div>
			{children}
		</div>
	);
}

function ToggleRow({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
	return (
		<div className={cn("flex items-center justify-between gap-2", disabled && "opacity-50")}>
			<span className="text-sm">{label}</span>
			<Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
		</div>
	);
}

function CreateForm({
	form,
	setForm,
	submitting,
	error,
	onSubmit,
}: {
	form: FormState;
	setForm: React.Dispatch<React.SetStateAction<FormState>>;
	submitting: boolean;
	error: (Error & { code?: string }) | null;
	onSubmit: () => void;
}) {
	const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
	const [advanced, setAdvanced] = useState(false);
	const formats = useQuery({ queryKey: ["video-shorts-formats"], queryFn: shortsApi.formats, staleTime: Infinity });
	const req = useDebounced(toRequest(form), 400);
	const validUrl = /^(https?:\/\/)?[^\s/]+\.[^\s]+/.test(req.url);
	const estimate = useQuery({
		queryKey: ["video-shorts-estimate", JSON.stringify(req)],
		queryFn: () => shortsApi.estimate(req),
		enabled: validUrl,
		staleTime: 60_000,
	});

	return (
		<Card>
			<CardHeader className="pb-4">
				<CardTitle className="flex items-center gap-2">
					<Clapperboard className="size-4" /> Video shorts agent
				</CardTitle>
				<CardDescription>
					Reads the site, llms.txt, blog and GitHub repo, then writes and renders several distinct shorts under 60 s.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<form
					className="flex flex-col gap-4"
					onSubmit={(e) => {
						e.preventDefault();
						if (validUrl) onSubmit();
					}}
				>
					<Field label="Product URL" hint="SaaS site, blog or GitHub repo">
						<Input value={form.url} onChange={(e) => set("url", e.target.value)} placeholder="https://yoursaas.com" autoFocus />
					</Field>

					<div className="grid grid-cols-2 gap-3">
						<Field label="Variations">
							<Segmented value={form.variations} onChange={(v) => set("variations", v)} options={[1, 2, 3, 4, 6].map((n) => ({ value: n, label: String(n) }))} />
						</Field>
						<Field label="Aspect">
							<Segmented value={form.aspect} onChange={(v) => set("aspect", v)} options={[{ value: "9:16", label: "9:16" }, { value: "1:1", label: "1:1" }, { value: "16:9", label: "16:9" }]} />
						</Field>
					</div>

					<Field label="Length" hint={`${form.duration_sec}s`}>
						<input type="range" min={10} max={59} step={1} value={form.duration_sec} onChange={(e) => set("duration_sec", Number(e.target.value))} className="w-full accent-black" />
					</Field>

					<div className="flex flex-col gap-2.5 rounded-lg border border-border p-3">
						<ToggleRow label="Audio" checked={form.audio} onChange={(v) => set("audio", v)} />
						<ToggleRow label="AI voice-over" checked={form.narration} onChange={(v) => set("narration", v)} disabled={!form.audio} />
						<ToggleRow label="Sound effects" checked={form.sfx} onChange={(v) => set("sfx", v)} disabled={!form.audio} />
						<ToggleRow label="Burned-in captions" checked={form.captions} onChange={(v) => set("captions", v)} disabled={!form.audio || !form.narration} />
						<div className={cn("grid grid-cols-2 gap-2", !form.audio && "pointer-events-none opacity-50")}>
							<select className="h-8 rounded-md border border-border bg-white px-2 text-xs" value={form.music} onChange={(e) => set("music", e.target.value)} aria-label="Music">
								<option value="auto">Music: CC library</option>
								<option value="generate">Music: generated</option>
								<option value="none">No music</option>
							</select>
							<select className="h-8 rounded-md border border-border bg-white px-2 text-xs" value={form.voice} onChange={(e) => set("voice", e.target.value)} disabled={!form.narration} aria-label="Voice">
								{["nova", "alloy", "echo", "fable", "onyx", "shimmer"].map((v) => (
									<option key={v} value={v}>
										Voice: {v}
									</option>
								))}
							</select>
						</div>
					</div>

					<button type="button" onClick={() => setAdvanced((v) => !v)} className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
						<ChevronDown className={cn("size-3.5 transition-transform", advanced && "rotate-180")} /> More context &amp; formats
					</button>
					{advanced ? (
						<div className="flex flex-col gap-3">
							<Field label="GitHub repo" hint="auto-detected from the site">
								<Input value={form.github_url} onChange={(e) => set("github_url", e.target.value)} placeholder="https://github.com/owner/repo" />
							</Field>
							<Field label="Blog index" hint="auto-detected">
								<Input value={form.blog_url} onChange={(e) => set("blog_url", e.target.value)} placeholder="https://yoursaas.com/blog" />
							</Field>
							<Field label="Extra pages" hint="pricing, docs…">
								<Input value={form.extra_urls} onChange={(e) => set("extra_urls", e.target.value)} placeholder="comma separated URLs" />
							</Field>
							<Field label="Tone">
								<Input value={form.tone} onChange={(e) => set("tone", e.target.value)} />
							</Field>
							<Field label="Preferred formats" hint={form.formats.length ? `${form.formats.length} picked` : "AI picks"}>
								<div className="flex flex-wrap gap-1.5">
									{Object.entries(formats.data?.formats || {}).map(([key, desc]) => {
										const on = form.formats.includes(key);
										return (
											<button
												key={key}
												type="button"
												title={desc}
												onClick={() => set("formats", on ? form.formats.filter((f) => f !== key) : [...form.formats, key])}
												className={cn("rounded-full border px-2.5 py-1 text-[11px]", on ? "border-foreground bg-foreground text-white" : "border-border hover:bg-muted")}
											>
												{key.replace(/_/g, " ")}
											</button>
										);
									})}
								</div>
							</Field>
							<ToggleRow label="Upload to UploadThing" checked={form.upload} onChange={(v) => set("upload", v)} />
						</div>
					) : null}

					{error ? <ErrorBox message={error.message} code={error.code} /> : null}

					<div className="flex items-center justify-between gap-3">
						<p className="text-xs text-muted-foreground">
							{estimate.data ? (
								<>
									≈ <span className="font-medium text-foreground">${estimate.data.estimate.total_usd.toFixed(3)}</span> total · ${estimate.data.estimate.per_video_usd.toFixed(3)}/video
								</>
							) : (
								"Cost estimate appears here"
							)}
						</p>
						<Button type="submit" disabled={!validUrl || submitting}>
							{submitting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
							Generate
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	);
}

function ErrorBox({ message, code }: { message: string; code?: string }) {
	const hint =
		code === "OPENROUTER_AUTH"
			? "Your OpenRouter key was rejected. Create a new one at openrouter.ai/settings/keys, update OPENROUTER_API_KEY in .env and restart the API."
			: code === "FFMPEG_UNAVAILABLE"
				? "Run npm install in the API folder (bundles ffmpeg-static) or reinstall ffmpeg."
				: null;
	return (
		<div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
			<AlertTriangle className="mt-0.5 size-4 shrink-0" />
			<div className="min-w-0">
				<p className="break-words font-medium">{message}</p>
				{hint ? <p className="mt-1">{hint}</p> : null}
			</div>
		</div>
	);
}

/* --------------------------------------------------------------- history */

function HistoryCard({ jobs, activeId, onPick }: { jobs: { id: string; url: string; product: string | null; status: string; variants: unknown[]; total_usd: number | null; created_at: string }[]; activeId: string | null; onPick: (id: string) => void }) {
	if (!jobs.length) return null;
	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="text-sm">Recent runs</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-1 p-2 pt-0">
				{jobs.map((j) => (
					<button
						key={j.id}
						type="button"
						onClick={() => onPick(j.id)}
						className={cn("flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm", j.id === activeId ? "bg-muted font-medium" : "hover:bg-muted")}
					>
						<span className="min-w-0 truncate">{j.product || j.url.replace(/^https?:\/\//, "")}</span>
						<span className="flex shrink-0 items-center gap-1.5">
							<span className="text-[11px] text-muted-foreground">{j.variants.length}×</span>
							<StatusDot status={j.status} />
						</span>
					</button>
				))}
			</CardContent>
		</Card>
	);
}

function StatusDot({ status }: { status: string }) {
	return (
		<span
			className={cn(
				"size-2 rounded-full",
				status === "success" ? "bg-emerald-500" : status === "failed" ? "bg-red-500" : status === "partial" ? "bg-amber-500" : "animate-pulse bg-sky-500",
			)}
		/>
	);
}

function EmptyState() {
	return (
		<div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-8 text-center">
			<Clapperboard className="size-8 text-muted-foreground" />
			<p className="text-sm font-medium">Paste a product URL to start</p>
			<p className="max-w-md text-sm text-muted-foreground">
				The agent gathers context in parallel (homepage, llms.txt, latest blog posts, GitHub repo, product images and screenshots), writes a product
				brief, plans different concepts and renders each one as a short.
			</p>
		</div>
	);
}

/* ------------------------------------------------------------------ job */

function JobView({ job }: { job: ShortsJob }) {
	const stepIdx = Math.max(0, STEPS.findIndex((s) => s.key === job.step));
	const active = isActive(job.status);
	return (
		<div className="flex flex-col gap-4">
			<Card>
				<CardContent className="flex flex-col gap-3 p-4">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div className="min-w-0">
							<p className="truncate text-base font-semibold">{job.brief?.product_name || job.input.url}</p>
							<p className="truncate text-xs text-muted-foreground">
								{job.brief?.one_liner || job.input.url} · {job.input.variations} variations · {job.input.target_duration_sec}s{" "}
								{job.input.aspect} · {job.input.narration ? "voice-over" : job.input.music === "none" && !job.input.sfx ? "silent" : "music only"}
							</p>
						</div>
						<div className="flex items-center gap-2">
							{job.cost ? <Badge>${job.cost.total_usd.toFixed(3)}</Badge> : <Badge className="text-muted-foreground">est. ${job.estimate.total_usd.toFixed(3)}</Badge>}
							<Badge className={cn(job.status === "success" && "border-emerald-200 bg-emerald-50 text-emerald-700", job.status === "failed" && "border-red-200 bg-red-50 text-red-700", job.status === "partial" && "border-amber-200 bg-amber-50 text-amber-700")}>
								{active ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
								{job.status}
							</Badge>
						</div>
					</div>
					<div className="flex items-center gap-1">
						{STEPS.map((s, i) => (
							<div key={s.key} className="flex flex-1 flex-col gap-1">
								<div className={cn("h-1 rounded-full", i < stepIdx || job.step === "done" ? "bg-foreground" : i === stepIdx && active ? "animate-pulse bg-foreground/60" : "bg-muted")} />
								<span className={cn("hidden text-[10px] sm:block", i <= stepIdx ? "text-foreground" : "text-muted-foreground")}>{s.label}</span>
							</div>
						))}
					</div>
					{job.error ? <ErrorBox message={job.error} code={job.error.includes("OPENROUTER_API_KEY") ? "OPENROUTER_AUTH" : undefined} /> : null}
				</CardContent>
			</Card>

			{job.variants.length ? (
				<div className={cn("grid gap-4", job.input.aspect === "16:9" ? "sm:grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-3")}>
					{job.variants.map((v) => (
						<VariantCard key={v.id} job={job} v={v} />
					))}
				</div>
			) : null}

			<ContextPanel job={job} />

			<details className="rounded-xl border border-border bg-white">
				<summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">Agent log</summary>
				<pre className="max-h-72 overflow-auto border-t border-border bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-200">{job.logs.join("\n")}</pre>
			</details>
		</div>
	);
}

function ContextPanel({ job }: { job: ShortsJob }) {
	if (!job.sources.length && !job.frames.length) return null;
	const b = job.brief;
	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="text-sm">What the agent read</CardTitle>
				<CardDescription>Sources gathered in parallel, frames it can show, and the brief every script is grounded in.</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-wrap gap-2">
					{job.sources.map((s, i) => {
						const Icon = SOURCE_ICON[s.type] || Globe;
						return (
							<a
								key={i}
								href={s.url}
								target="_blank"
								rel="noreferrer"
								title={s.detail || s.url}
								className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs", s.ok ? "border-border" : "border-dashed border-border text-muted-foreground line-through")}
							>
								<Icon className="size-3.5" />
								{s.type.replace("_", ".")}
								{s.detail ? <span className="text-muted-foreground no-underline">· {s.detail}</span> : null}
							</a>
						);
					})}
				</div>

				{job.frames.length ? (
					<div className="flex gap-2 overflow-x-auto pb-1">
						{job.frames.map((f) => {
							const src = mediaUrl(job.id, null, f.preview_path);
							return (
								<figure key={f.id} className={cn("relative w-28 shrink-0 overflow-hidden rounded-md border border-border", f.use_for === "skip" && "opacity-40")} title={f.summary || f.source}>
									{src ? <img src={src} alt={f.summary || f.source} className="h-20 w-full object-cover object-top" loading="lazy" /> : <div className="h-20 bg-muted" />}
									<figcaption className="flex items-center gap-1 truncate px-1.5 py-1 text-[10px]">
										{f.kind === "image" ? <ImageIcon className="size-3" /> : <Globe className="size-3" />}
										{f.id}
										{f.quality ? <span className="ml-auto text-muted-foreground">{f.quality}/10</span> : null}
									</figcaption>
								</figure>
							);
						})}
					</div>
				) : null}

				{b ? (
					<div className="grid gap-3 text-sm sm:grid-cols-3">
						<BriefList title="Features" items={(b.features || []).map((f) => `${f.name} — ${f.benefit}`)} />
						<BriefList title="Proof" items={(b.proof || []).map((p) => `${p.value} ${p.label}`)} />
						<BriefList title="Hooks" items={b.hooks || []} />
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}

function BriefList({ title, items }: { title: string; items: string[] }) {
	return (
		<div>
			<p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
			{items.length ? (
				<ul className="flex flex-col gap-1">
					{items.slice(0, 5).map((t, i) => (
						<li key={i} className="text-xs leading-snug">
							{t}
						</li>
					))}
				</ul>
			) : (
				<p className="text-xs text-muted-foreground">None found</p>
			)}
		</div>
	);
}

function VariantCard({ job, v }: { job: ShortsJob; v: ShortsVariant }) {
	const [copied, setCopied] = useState(false);
	const [showScript, setShowScript] = useState(false);
	const video = mediaUrl(job.id, v.result?.video_url, v.result?.video_path);
	const poster = mediaUrl(job.id, v.result?.thumbnail_url, v.result?.thumbnail_path);
	const caption = v.result?.caption || v.caption || "";
	const cost = job.cost?.by_variant?.[v.id];
	const accent = v.concept.theme?.accent;
	const working = !["success", "failed"].includes(v.status);

	const scenes = useMemo(() => v.result?.scenes || [], [v.result]);

	return (
		<Card className="flex flex-col overflow-hidden">
			<div className={cn("relative w-full bg-zinc-950", ASPECT_CLASS[job.input.aspect] || "aspect-[9/16]")}>
				{video ? (
					<video src={video} poster={poster || undefined} controls playsInline preload="metadata" className="absolute inset-0 size-full object-contain" />
				) : (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-zinc-300">
						{v.status === "failed" ? <X className="size-6 text-red-400" /> : <Loader2 className="size-6 animate-spin" />}
						<p className="text-sm font-medium text-white">{v.concept.hook || v.concept.title}</p>
						<p className="text-xs">{v.status === "failed" ? v.error : `${v.status}${v.step && v.step !== "queued" ? ` · ${v.step.replace(/_/g, " ")}` : ""}`}</p>
						{working ? (
							<div className="h-1 w-32 overflow-hidden rounded-full bg-white/10">
								<div className="h-full bg-white transition-all" style={{ width: `${Math.max(5, v.progress)}%` }} />
							</div>
						) : null}
					</div>
				)}
			</div>
			<CardContent className="flex flex-1 flex-col gap-2 p-3">
				<div className="flex items-center gap-2">
					<span className="size-2.5 shrink-0 rounded-full" style={{ background: accent || "#0a0a0a" }} />
					<p className="min-w-0 flex-1 truncate text-sm font-semibold">{v.result?.title || v.concept.title}</p>
					{v.result ? (
						<span className="flex items-center gap-1 text-[11px] text-muted-foreground">
							{v.result.has_audio ? <Volume2 className="size-3" /> : <VolumeX className="size-3" />}
							{v.result.duration_sec.toFixed(0)}s
						</span>
					) : null}
				</div>
				<div className="flex flex-wrap gap-1">
					<Badge className="text-[10px]">{v.concept.format.replace(/_/g, " ")}</Badge>
					<Badge className="text-[10px]">{v.concept.pace}</Badge>
					{cost != null ? <Badge className="text-[10px]">${cost.toFixed(3)}</Badge> : null}
				</div>
				{v.concept.angle ? <p className="text-xs text-muted-foreground">{v.concept.angle}</p> : null}
				{caption ? (
					<div className="rounded-md bg-muted p-2 text-xs">
						<p className="whitespace-pre-wrap">{caption}</p>
					</div>
				) : null}
				{v.result?.music?.attribution ? <p className="text-[10px] text-muted-foreground">♪ {v.result.music.attribution}</p> : null}
				<div className="mt-auto flex flex-wrap gap-1.5 pt-1">
					{video ? (
						<a href={video} download={`${v.id}.mp4`} target="_blank" rel="noreferrer">
							<Button size="sm" variant="outline">
								<Download className="size-3.5" /> MP4
							</Button>
						</a>
					) : null}
					{caption ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								navigator.clipboard?.writeText(caption).then(() => {
									setCopied(true);
									setTimeout(() => setCopied(false), 1500);
								});
							}}
						>
							{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} Caption
						</Button>
					) : null}
					{scenes.length ? (
						<Button size="sm" variant="ghost" onClick={() => setShowScript((s) => !s)}>
							<FileText className="size-3.5" /> Script
						</Button>
					) : null}
				</div>
				{showScript ? (
					<ol className="flex flex-col gap-1.5 border-t border-border pt-2">
						{scenes.map((s) => (
							<li key={s.id} className="text-xs">
								<span className="font-mono text-[10px] text-muted-foreground">
									{s.start.toFixed(1)}s · {s.visual.type}
								</span>
								<p className="leading-snug">{s.narration || s.on_screen_text || String(s.visual.title || s.visual.text || "")}</p>
							</li>
						))}
					</ol>
				) : null}
			</CardContent>
		</Card>
	);
}
