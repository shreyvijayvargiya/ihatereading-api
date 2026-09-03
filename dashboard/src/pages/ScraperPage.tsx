import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
	fetchAgent,
	fetchTable,
	startAgent,
	stopAgent,
	type DashboardField,
} from "@/lib/api";
import { DocsTable } from "@/components/DocsTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export function ScraperPage() {
	const { tableId } = useParams({ strict: false }) as { tableId: string };
	const qc = useQueryClient();
	const [tab, setTab] = useState<"live" | "cli">("live");
	const q = useQuery({
		queryKey: ["dashboard-agent", tableId],
		queryFn: () => fetchAgent(tableId),
		refetchInterval: 1000,
		enabled: Boolean(tableId),
	});
	const live = useQuery({
		queryKey: ["dashboard-latest", tableId],
		queryFn: () => fetchTable(tableId, undefined, 40, true),
		refetchInterval: q.data?.run?.running ? 1500 : 4000,
		enabled: Boolean(tableId),
	});
	const fields = q.data?.fields || q.data?.run?.fields || [];
	const run = q.data?.run;
	const table = q.data?.table;
	const [form, setForm] = useState<Record<string, string | boolean>>({});
	const [loop, setLoop] = useState(true);
	const [intervalMs, setIntervalMs] = useState(tableId === "clubs" ? "8000" : "30000");
	const knownIds = useRef<Set<string>>(new Set());
	const primed = useRef(false);
	const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
	const logRef = useRef<HTMLPreElement>(null);

	useEffect(() => {
		primed.current = false;
		knownIds.current = new Set();
		setFreshIds(new Set());
		if (tableId === "clubs") setIntervalMs("8000");
	}, [tableId]);

	useEffect(() => {
		const docs = live.data?.docs || [];
		if (!docs.length) return;
		const incoming = docs.map((d) => String(d.id));
		if (!primed.current) {
			knownIds.current = new Set(incoming);
			primed.current = true;
			return;
		}
		const added = incoming.filter((id) => !knownIds.current.has(id));
		if (!added.length) return;
		for (const id of incoming) knownIds.current.add(id);
		setFreshIds(new Set(added));
		const t = setTimeout(() => setFreshIds(new Set()), 4000);
		return () => clearTimeout(t);
	}, [live.data?.docs]);

	useEffect(() => {
		if (!fields.length) return;
		setForm((prev) => {
			const next = { ...prev };
			for (const f of fields) {
				if (next[f.key] === undefined) next[f.key] = f.type === "checkbox" ? false : "";
			}
			return next;
		});
	}, [fields]);

	useEffect(() => {
		if (tab !== "cli") return;
		const el = logRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [run?.logs, tab]);

	const payload = useMemo(() => {
		const params: Record<string, unknown> = {};
		for (const f of fields) {
			const v = form[f.key];
			if (f.type === "checkbox") params[f.key] = Boolean(v);
			else if (v !== "" && v != null) params[f.key] = f.type === "number" ? Number(v) : v;
		}
		return {
			loop,
			intervalMs: Number(intervalMs) || 30_000,
			...params,
		};
	}, [fields, form, loop, intervalMs]);

	const startMut = useMutation({
		mutationFn: () => startAgent(tableId, payload),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["dashboard-agent", tableId] });
			qc.invalidateQueries({ queryKey: ["dashboard-latest", tableId] });
			qc.invalidateQueries({ queryKey: ["dashboard-status"] });
		},
	});
	const stopMut = useMutation({
		mutationFn: () => stopAgent(tableId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["dashboard-agent", tableId] });
			qc.invalidateQueries({ queryKey: ["dashboard-status"] });
		},
	});

	if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading scraper…</p>;
	if (q.error) return <p className="text-sm">{String(q.error)}</p>;

	const on = Boolean(run?.running);
	const stats = run?.stats;
	const docs = live.data?.docs || [];
	const checkboxes = fields.filter((f) => f.type === "checkbox");
	const inputs = fields.filter((f) => f.type !== "checkbox");

	return (
		<div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
			<div className="min-h-0 space-y-4 overflow-y-auto pr-1">
				<Card>
					<CardHeader className="p-4">
						<CardTitle>{table?.label}</CardTitle>
						<CardDescription>{table?.description}</CardDescription>
					</CardHeader>
					<CardContent className="p-4 pt-0">
						<div className="flex flex-wrap gap-1.5">
							<Badge>{table?.collection}</Badge>
							<Badge>{on ? (run?.loop ? "loop on" : "running once") : "off"}</Badge>
							{run?.pid ? <Badge>pid {run.pid}</Badge> : null}
						</div>
						<div className="mt-4 grid grid-cols-4 gap-2 rounded-lg border border-border p-3 text-center">
							<Stat n={live.data?.count || stats?.stored || table?.count || 0} label="stored" />
							<Stat n={stats?.fetched || 0} label="fetched" />
							<Stat n={stats?.scraped || 0} label="scraped" />
							<Stat n={stats?.failed || 0} label="failed" />
						</div>
					</CardContent>
				</Card>

				<Card>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							startMut.mutate();
						}}
					>
						<CardHeader className="p-4">
							<CardTitle>Run</CardTitle>
							<CardDescription>
								{run?.help || "Set interval and agent options, then start a tick or loop."}
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4 p-4 pt-0">
							<div className="flex items-center justify-between gap-3">
								<div>
									<Label htmlFor="loop">Keep looping</Label>
									<p className="mt-0.5 text-xs text-muted-foreground">
										Dashboard re-runs the CLI after each tick
									</p>
								</div>
								<Switch id="loop" checked={loop} onCheckedChange={setLoop} />
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="intervalMs">Interval (ms)</Label>
								<Input
									id="intervalMs"
									type="number"
									min={1000}
									value={intervalMs}
									onChange={(e) => setIntervalMs(e.target.value)}
								/>
							</div>
							{inputs.length ? (
								<div className="space-y-3 border-t border-border pt-4">
									<p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
										Parameters
									</p>
									{inputs.map((f) => (
										<FieldInput
											key={f.key}
											field={f}
											value={form[f.key]}
											onChange={(v) => setForm((p) => ({ ...p, [f.key]: v }))}
										/>
									))}
								</div>
							) : null}
							{checkboxes.length ? (
								<div className="space-y-3 border-t border-border pt-4">
									<p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
										Options
									</p>
									{checkboxes.map((f) => (
										<FieldInput
											key={f.key}
											field={f}
											value={form[f.key]}
											onChange={(v) => setForm((p) => ({ ...p, [f.key]: v }))}
										/>
									))}
								</div>
							) : null}
							{startMut.error ? (
								<p className="text-sm text-muted-foreground">{String(startMut.error)}</p>
							) : null}
						</CardContent>
						<CardFooter className="flex-col items-stretch gap-2 p-4 pt-0">
							<div className="flex flex-wrap gap-2">
								<Button type="submit" disabled={on || startMut.isPending}>
									{loop ? "Turn on" : "Run once"}
								</Button>
								<Button
									type="button"
									variant="outline"
									disabled={!on || stopMut.isPending}
									onClick={() => stopMut.mutate()}
								>
									Stop
								</Button>
							</div>
							<p className="font-mono text-[11px] text-muted-foreground">{table?.cli}</p>
							{run?.argv?.length ? (
								<p className="font-mono text-[11px] text-muted-foreground">{run.argv.join(" ")}</p>
							) : null}
						</CardFooter>
					</form>
				</Card>
			</div>

			<Card className="flex min-h-0 min-w-0 flex-col overflow-hidden">
				<CardHeader className="flex shrink-0 flex-row flex-wrap items-center justify-between gap-2 space-y-0 p-4">
					<div className="flex gap-1 rounded-md border border-border p-0.5">
						<button
							type="button"
							onClick={() => setTab("live")}
							className={cn(
								"rounded px-3 py-1.5 text-sm",
								tab === "live" ? "bg-primary text-primary-foreground" : "hover:bg-muted",
							)}
						>
							Live table
						</button>
						<button
							type="button"
							onClick={() => setTab("cli")}
							className={cn(
								"rounded px-3 py-1.5 text-sm",
								tab === "cli" ? "bg-primary text-primary-foreground" : "hover:bg-muted",
							)}
						>
							CLI output
						</button>
					</div>
					<p className="text-xs text-muted-foreground">
						{tab === "live"
							? `${docs.length} latest · ${live.data?.count ?? 0} stored${on ? " · polling" : ""}`
							: `${run?.logs?.length || 0} lines · ticks ${stats?.ticks || 0}`}
					</p>
				</CardHeader>
				<CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4 pt-0">
					<div className="min-h-0 flex-1">
						{tab === "cli" ? (
							<pre
								ref={logRef}
								className="h-full overflow-auto rounded-lg border border-border bg-zinc-950 p-3 font-mono text-[11px] leading-5 text-zinc-100"
							>
								{(run?.logs || [])
									.map((l) => `${l.t.slice(11, 19)} ${l.stream.padEnd(3)} ${l.line}`)
									.join("\n") || "No output yet. Turn the scraper on."}
							</pre>
						) : (
							<DocsTable
								tableId={tableId}
								docs={docs}
								loading={live.isLoading}
								empty="Nothing stored yet. Turn the scraper on."
								freshIds={freshIds}
							/>
						)}
					</div>
					<p className="shrink-0 text-xs text-muted-foreground">
						<Link to="/tables/$tableId" params={{ tableId }} className="underline">
							Open full collection
						</Link>
					</p>
				</CardContent>
			</Card>
		</div>
	);
}

function FieldInput({
	field,
	value,
	onChange,
}: {
	field: DashboardField;
	value: string | boolean | undefined;
	onChange: (v: string | boolean) => void;
}) {
	const id = `field-${field.key}`;
	if (field.type === "checkbox") {
		return (
			<div className="flex items-center justify-between gap-3">
				<div>
					<Label htmlFor={id}>{field.label}</Label>
					{field.help ? <p className="mt-0.5 text-xs text-muted-foreground">{field.help}</p> : null}
				</div>
				<Switch id={id} checked={Boolean(value)} onCheckedChange={onChange} />
			</div>
		);
	}
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>
				{field.label}
				{field.required ? " *" : ""}
			</Label>
			<Input
				id={id}
				type={field.type === "number" ? "number" : "text"}
				placeholder={field.placeholder}
				value={typeof value === "string" ? value : ""}
				onChange={(e) => onChange(e.target.value)}
			/>
			{field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
		</div>
	);
}

function Stat({ n, label }: { n: number; label: string }) {
	return (
		<div>
			<p className="text-base font-semibold tabular-nums">{n.toLocaleString()}</p>
			<p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
		</div>
	);
}
