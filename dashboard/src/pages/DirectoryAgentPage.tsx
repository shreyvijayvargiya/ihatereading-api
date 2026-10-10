import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	createTask,
	eventsUrl,
	fetchAuthedBlob,
	fetchTask,
	fetchTasks,
	readAgentToken,
	taskAction,
	writeAgentToken,
	type DirectoryTask,
	type TaskCard,
	type TaskSummary,
} from "@/lib/directoryAgent";
import { cn } from "@/lib/utils";

function stateClass(state: string) {
	if (state === "COMPLETED") return "text-foreground";
	if (state === "FAILED" || state === "CANCELLED") return "text-muted-foreground line-through";
	if (state.startsWith("WAITING")) return "border-foreground";
	return "";
}

function field(name: string, label: string, props: Record<string, string | boolean | number> = {}) {
	const tag = props.tag === "textarea" ? "textarea" : "input";
	return (
		<label className={props.full ? "sm:col-span-2" : ""}>
			<Label>{label}</Label>
			{tag === "textarea" ? (
				<textarea
					name={name}
					required={Boolean(props.required)}
					rows={Number(props.rows || 3)}
					placeholder={String(props.placeholder || "")}
					className="mt-1 flex w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-foreground"
				/>
			) : (
				<Input
					className="mt-1"
					name={name}
					type={String(props.type || "text")}
					required={Boolean(props.required)}
					placeholder={String(props.placeholder || "")}
				/>
			)}
		</label>
	);
}

function NewTaskForm({
	onCreated,
	onCancel,
}: {
	onCreated: (id: string) => void;
	onCancel: () => void;
}) {
	const [error, setError] = useState("");
	const mutation = useMutation({
		mutationFn: createTask,
		onSuccess: (data) => onCreated(data.task.id),
		onError: (e: Error) => setError(e.message),
	});

	return (
		<Card>
			<CardContent className="p-4">
				<p className="mb-3 text-sm font-medium">New submission</p>
				<form
					className="grid gap-3 sm:grid-cols-2"
					onSubmit={(e) => {
						e.preventDefault();
						const v = Object.fromEntries(new FormData(e.currentTarget));
						const text = (k: string) => String(v[k] || "").trim();
						const tags = text("tags")
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						mutation.mutate({
							directoryUrl: text("directoryUrl"),
							...(text("submissionUrl") ? { submissionUrl: text("submissionUrl") } : {}),
							...(text("githubRepo") ? { githubRepo: text("githubRepo") } : {}),
							product: {
								name: text("name"),
								website: text("website"),
								description: text("description"),
								...(text("tagline") ? { tagline: text("tagline") } : {}),
								...(text("category") ? { category: text("category") } : {}),
								...(text("email") ? { email: text("email") } : {}),
								...(text("logoUrl") ? { logoUrl: text("logoUrl") } : {}),
								...(tags.length ? { tags } : {}),
							},
						});
					}}
				>
					{field("directoryUrl", "Directory URL", { required: true, type: "url", full: true })}
					{field("name", "Product name", { required: true })}
					{field("website", "Website", { required: true, type: "url" })}
					{field("tagline", "Tagline")}
					{field("category", "Category")}
					{field("tags", "Tags, comma separated")}
					{field("email", "Email", { type: "email" })}
					{field("logoUrl", "Logo URL", { type: "url" })}
					{field("githubRepo", "GitHub repo (owner/repo)")}
					{field("description", "Description", { required: true, tag: "textarea", full: true })}
					{field("submissionUrl", "Direct submission URL", { type: "url", full: true })}
					{error ? <p className="text-sm text-muted-foreground sm:col-span-2">{error}</p> : null}
					<div className="flex gap-2 sm:col-span-2">
						<Button type="submit" disabled={mutation.isPending}>
							{mutation.isPending ? "Starting…" : "Start agent"}
						</Button>
						<Button type="button" variant="outline" onClick={onCancel}>
							Cancel
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	);
}

function Shot({ shot }: { shot: DirectoryTask["screenshots"][number] }) {
	const [src, setSrc] = useState("");
	useEffect(() => {
		let url = "";
		let gone = false;
		fetchAuthedBlob(shot.url)
			.then((r) => r.blob())
			.then((b) => {
				if (gone) return;
				url = URL.createObjectURL(b);
				setSrc(url);
			})
			.catch(() => {});
		return () => {
			gone = true;
			if (url) URL.revokeObjectURL(url);
		};
	}, [shot.url]);
	if (!src) return null;
	return (
		<figure className="m-0">
			<a href={src} target="_blank" rel="noreferrer">
				<img src={src} alt={shot.label} className="w-full rounded-md border border-border" />
			</a>
			<figcaption className="mt-1 text-[11px] text-muted-foreground">
				{shot.label} · {shot.step}
			</figcaption>
		</figure>
	);
}

function ActionCard({
	card,
	onAct,
	busy,
}: {
	card: TaskCard;
	onAct: (action: string, body?: Record<string, unknown>) => void;
	busy: boolean;
}) {
	const data = card.data || {};
	const summary = data.summary && typeof data.summary === "object" ? (data.summary as Record<string, string>) : null;
	const badgeCode = typeof data.badgeCode === "string" ? data.badgeCode : "";
	return (
		<Card className="border-foreground">
			<CardContent className="space-y-3 p-4">
				<p className="text-sm font-medium">{card.title}</p>
				<p className="whitespace-pre-wrap text-sm text-muted-foreground">{card.message}</p>
				{badgeCode ? (
					<pre className="overflow-auto rounded-md border border-border bg-muted p-2 text-xs">{badgeCode}</pre>
				) : null}
				{summary ? (
					<dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
						{Object.entries(summary).map(([k, v]) => (
							<div key={k} className="contents">
								<dt className="text-muted-foreground">{k}</dt>
								<dd>{v || "—"}</dd>
							</div>
						))}
					</dl>
				) : null}
				<div className="flex flex-wrap gap-2">
					{card.actions.map((a) => (
						<Button
							key={a.id}
							disabled={busy}
							variant={a.style === "danger" ? "outline" : "default"}
							onClick={() => onAct(a.id)}
						>
							{a.label}
						</Button>
					))}
					{data.allowForce ? (
						<Button variant="outline" disabled={busy} onClick={() => onAct("approve", { force: true })}>
							Badge is there — continue
						</Button>
					) : null}
				</div>
			</CardContent>
		</Card>
	);
}

function LiveBrowser({ taskId }: { taskId: string }) {
	const [src, setSrc] = useState("");
	const [pageUrl, setPageUrl] = useState("");
	const [goto, setGoto] = useState("");
	const [text, setText] = useState("");

	useEffect(() => {
		let gone = false;
		let current = "";
		const tick = async () => {
			try {
				const res = await fetchAuthedBlob(`/api/tasks/${taskId}/live/frame`);
				const blob = await res.blob();
				if (gone) return;
				const next = URL.createObjectURL(blob);
				setSrc(next);
				if (current) URL.revokeObjectURL(current);
				current = next;
				const pu = res.headers.get("X-Page-Url");
				if (pu) setPageUrl(decodeURIComponent(pu));
			} catch {
				/* session may be closed */
			}
		};
		tick();
		const id = setInterval(tick, 900);
		return () => {
			gone = true;
			clearInterval(id);
			if (current) URL.revokeObjectURL(current);
		};
	}, [taskId]);

	async function send(body: Record<string, unknown>) {
		await taskAction(taskId, "live/input", body).catch(() => {});
	}

	return (
		<Card>
			<CardContent className="space-y-2 p-4">
				<p className="text-sm font-medium">Live browser</p>
				<p className="truncate text-xs text-muted-foreground">{pageUrl || "Waiting for a frame…"}</p>
				<div className="flex gap-2">
					<Input value={goto} onChange={(e) => setGoto(e.target.value)} placeholder="Go to URL" />
					<Button variant="outline" onClick={() => goto && send({ type: "goto", url: goto })}>
						Go
					</Button>
				</div>
				{src ? (
					<img
						src={src}
						alt="Live browser"
						className="w-full cursor-crosshair rounded-md border border-border"
						onClick={(e) => {
							const r = e.currentTarget.getBoundingClientRect();
							const x = Math.round((e.clientX - r.left) * (e.currentTarget.naturalWidth / r.width));
							const y = Math.round((e.clientY - r.top) * (e.currentTarget.naturalHeight / r.height));
							send({ type: "click", x, y });
						}}
					/>
				) : (
					<p className="text-sm text-muted-foreground">No frame yet. Approve the card to open the browser.</p>
				)}
				<div className="flex gap-2">
					<Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type into the page" />
					<Button
						variant="outline"
						onClick={() => {
							if (!text) return;
							send({ type: "type", text });
							setText("");
						}}
					>
						Type
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

function TaskDetail({
	task,
	onAct,
	busy,
}: {
	task: DirectoryTask;
	onAct: (action: string, body?: Record<string, unknown>) => void;
	busy: boolean;
}) {
	const ended = ["COMPLETED", "FAILED", "CANCELLED"].includes(task.state);
	const showLive =
		Boolean(task.session) &&
		(task.liveSessionOpen || task.state === "WAITING_FOR_BADGE" || task.state === "WAITING_FOR_APPROVAL");
	return (
		<div className="space-y-3">
			<Card>
				<CardContent className="space-y-2 p-4">
					<div className="flex flex-wrap items-center gap-2">
						<p className="font-medium">{task.input.product.name}</p>
						<Badge className={stateClass(task.state)}>{task.state.replaceAll("_", " ")}</Badge>
						<span className="text-xs text-muted-foreground">{task.currentStep}</span>
						<span className="flex-1" />
						{ended ? null : (
							<Button variant="outline" disabled={busy} onClick={() => onAct("cancel")}>
								Cancel
							</Button>
						)}
					</div>
					<p className="truncate text-xs text-muted-foreground">{task.input.directoryUrl}</p>
					{task.humanMessage ? <p className="text-sm">{task.humanMessage}</p> : null}
					{task.error ? <p className="text-sm text-muted-foreground">{task.error}</p> : null}
				</CardContent>
			</Card>
			{task.card ? <ActionCard card={task.card} onAct={onAct} busy={busy} /> : null}
			{showLive ? <LiveBrowser taskId={task.id} /> : null}
			<Card>
				<CardContent className="p-4">
					<p className="mb-2 text-sm font-medium">Logs</p>
					<div className="max-h-56 space-y-1 overflow-auto font-mono text-xs">
						{task.logs.map((l, i) => (
							<p key={`${l.ts}-${i}`} className={cn(l.level === "error" && "text-foreground")}>
								{l.ts.slice(11, 19)} [{l.step}] {l.message}
							</p>
						))}
					</div>
				</CardContent>
			</Card>
			{task.screenshots.length ? (
				<Card>
					<CardContent className="p-4">
						<p className="mb-2 text-sm font-medium">Screenshots</p>
						<div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
							{task.screenshots
								.slice()
								.reverse()
								.map((s) => (
									<Shot key={s.file} shot={s} />
								))}
						</div>
					</CardContent>
				</Card>
			) : null}
		</div>
	);
}

export function DirectoryAgentPage() {
	const qc = useQueryClient();
	const [token, setToken] = useState(readAgentToken);
	const [selected, setSelected] = useState("");
	const [creating, setCreating] = useState(false);
	const [actionError, setActionError] = useState("");

	const list = useQuery({
		queryKey: ["da-tasks", token],
		queryFn: fetchTasks,
		refetchInterval: 8000,
	});

	const detail = useQuery({
		queryKey: ["da-task", selected, token],
		queryFn: () => fetchTask(selected),
		enabled: Boolean(selected),
		refetchInterval: 4000,
	});

	useEffect(() => {
		const es = new EventSource(eventsUrl());
		const onTask = (ev: MessageEvent) => {
			const summary = JSON.parse(ev.data) as TaskSummary;
			qc.setQueryData<{ tasks: TaskSummary[] }>(["da-tasks", token], (prev) => {
				if (!prev) return prev;
				const tasks = prev.tasks.some((t) => t.id === summary.id)
					? prev.tasks.map((t) => (t.id === summary.id ? { ...t, ...summary } : t))
					: [summary, ...prev.tasks];
				return { tasks };
			});
			if (summary.id === selected) qc.invalidateQueries({ queryKey: ["da-task", selected, token] });
		};
		es.addEventListener("task", onTask);
		return () => es.close();
	}, [qc, selected, token]);

	const action = useMutation({
		mutationFn: ({ id, name, body }: { id: string; name: string; body?: Record<string, unknown> }) =>
			taskAction(id, name, body),
		onSuccess: (data) => {
			setActionError("");
			qc.setQueryData(["da-task", data.task.id, token], data);
			qc.invalidateQueries({ queryKey: ["da-tasks", token] });
		},
		onError: (e: Error) => setActionError(e.message),
	});

	const rows = [...(list.data?.tasks || [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

	return (
		<div className="flex h-full min-h-0 flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2">
				<p className="text-sm text-muted-foreground">Tasks from the directory agent on port 3002.</p>
				<div className="ml-auto flex items-center gap-2">
					<Input
						className="w-44"
						type="password"
						placeholder="API token"
						value={token}
						onChange={(e) => setToken(e.target.value)}
						onBlur={() => writeAgentToken(token.trim())}
					/>
					<Button
						onClick={() => {
							setCreating(true);
							setSelected("");
						}}
					>
						New task
					</Button>
				</div>
			</div>
			{list.error ? <p className="text-sm text-muted-foreground">{String(list.error)}</p> : null}
			{actionError ? <p className="text-sm text-muted-foreground">{actionError}</p> : null}
			<div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[260px_1fr]">
				<div className="overflow-auto rounded-xl border border-border">
					{list.isLoading ? <p className="p-4 text-sm text-muted-foreground">Loading tasks…</p> : null}
					{!list.isLoading && !rows.length ? (
						<p className="p-4 text-sm text-muted-foreground">No tasks yet.</p>
					) : null}
					{rows.map((t) => (
						<button
							key={t.id}
							type="button"
							onClick={() => {
								setCreating(false);
								setSelected(t.id);
							}}
							className={cn(
								"block w-full border-b border-border px-3 py-2 text-left hover:bg-muted",
								selected === t.id && "bg-muted",
							)}
						>
							<p className="truncate text-sm font-medium">{t.productName || t.id}</p>
							<p className="truncate text-xs text-muted-foreground">{t.directoryUrl}</p>
							<Badge className={cn("mt-1", stateClass(t.state))}>{t.state.replaceAll("_", " ")}</Badge>
						</button>
					))}
				</div>
				<div className="min-h-0 overflow-auto">
					{creating ? (
						<NewTaskForm
							onCancel={() => setCreating(false)}
							onCreated={(id) => {
								setCreating(false);
								setSelected(id);
								qc.invalidateQueries({ queryKey: ["da-tasks", token] });
							}}
						/>
					) : detail.data?.task ? (
						<TaskDetail
							task={detail.data.task}
							busy={action.isPending}
							onAct={(name, body) => action.mutate({ id: detail.data.task.id, name, body })}
						/>
					) : (
						<p className="p-6 text-sm text-muted-foreground">Select a task or create one.</p>
					)}
					{detail.error ? <p className="mt-2 text-sm text-muted-foreground">{String(detail.error)}</p> : null}
				</div>
			</div>
		</div>
	);
}
