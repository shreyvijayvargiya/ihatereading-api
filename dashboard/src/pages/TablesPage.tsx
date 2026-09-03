import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Download, Mail, RefreshCw, Search } from "lucide-react";
import {
	fetchAutosendStatus,
	fetchStatus,
	fetchTable,
	sendFounderEmails,
} from "@/lib/api";
import { withPinnedTables } from "@/lib/catalog";
import { DocsTable } from "@/components/DocsTable";
import { SearchableDropdown } from "@/components/SearchableDropdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { founderEmailOf, scoreOf, rowAuthor, rowHref, rowTitle } from "@/lib/utils";

export function TablesPage() {
	const navigate = useNavigate();
	const { tableId } = useParams({ strict: false }) as { tableId?: string };
	const [q, setQ] = useState("");
	const [minScore, setMinScore] = useState("0");
	const [cursorStack, setCursorStack] = useState<string[]>([""]);
	const cursor = cursorStack[cursorStack.length - 1] || "";

	const status = useQuery({ queryKey: ["dashboard-status"], queryFn: fetchStatus });
	const tables = withPinnedTables(status.data?.tables || []);
	const activeId = tableId || tables[0]?.id || "clubs";
	const active = tables.find((t) => t.id === activeId) || tables[0];

	const page = useQuery({
		queryKey: ["dashboard-table", activeId, cursor],
		queryFn: () => fetchTable(activeId, cursor || undefined, 25),
		enabled: Boolean(activeId),
	});
	const autosend = useQuery({
		queryKey: ["autosend-status"],
		queryFn: fetchAutosendStatus,
		enabled: activeId === "founders",
	});

	const docs = page.data?.docs || [];
	const filtered = useMemo(() => {
		const needle = q.trim().toLowerCase();
		const min = Number(minScore) || 0;
		return docs.filter((doc) => {
			if (min && scoreOf(doc) < min) return false;
			if (!needle) return true;
			const blob = JSON.stringify(doc).toLowerCase();
			return blob.includes(needle);
		});
	}, [docs, q, minScore]);

	const subs = useMemo(() => {
		const set = new Set<string>();
		for (const d of docs) {
			const s = String(d.subreddit || "").trim();
			if (s) set.add(s.replace(/^r\//i, "").toLowerCase());
		}
		return [...set].sort();
	}, [docs]);
	const [sub, setSub] = useState("all");
	const shown = filtered.filter((d) => {
		if (sub === "all") return true;
		return String(d.subreddit || "").toLowerCase().replace(/^r\//i, "") === sub;
	});

	const sendPage = useMutation({
		mutationFn: () => {
			const ids = shown
				.filter((d) => founderEmailOf(d) && d.outreachStatus !== "sent")
				.map((d) => String(d.id));
			if (!ids.length) throw new Error("No unsent emails on this page");
			return sendFounderEmails({ ids });
		},
		onSuccess: () => page.refetch(),
	});

	function downloadCsv() {
		const rows = shown.map((d) =>
			activeId === "founders"
				? {
						id: d.id,
						score: scoreOf(d),
						company: d.company || "",
						name: d.name || "",
						email: founderEmailOf(d),
						founderEmail: d.founderEmail || "",
						ctoEmail: d.ctoEmail || "",
						hrEmail: d.hrEmail || "",
						phone: d.phone || "",
						linkedin: d.linkedinUrl || "",
						website: d.website || "",
						intent: d.intent || "",
						outreach: d.outreachStatus || "",
						url: rowHref(d),
					}
				: {
						id: d.id,
						score: scoreOf(d),
						title: rowTitle(d),
						subreddit: d.subreddit || "",
						author: rowAuthor(d),
						when: d.publishedAt || d.fetchedAt || "",
						url: rowHref(d),
					},
		);
		const header = Object.keys(rows[0] || { id: "" });
		const csv = [
			header.join(","),
			...rows.map((r) => header.map((k) => JSON.stringify(r[k] ?? "")).join(",")),
		].join("\n");
		const blob = new Blob([csv], { type: "text/csv" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${activeId}.csv`;
		a.click();
	}

	return (
		<div className="flex h-full min-h-0 flex-col gap-3">
			<div className="flex shrink-0 flex-wrap items-center gap-2">
				<SearchableDropdown
					className="w-56"
					placeholder="Collection"
					searchPlaceholder="Search tables…"
					value={activeId}
					items={tables.map((t) => ({
						value: t.id,
						label: t.label,
						hint: t.collection,
					}))}
					onChange={(id) => {
						setCursorStack([""]);
						setQ("");
						setSub("all");
						navigate({ to: "/tables/$tableId", params: { tableId: id } });
					}}
				/>
				<div className="relative min-w-[12rem] flex-1">
					<Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
					<Input
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="Filter this page…"
						className="pl-9"
					/>
				</div>
				<SearchableDropdown
					className="w-36"
					value={minScore}
					items={[
						{ value: "0", label: "All scores" },
						{ value: "3", label: "3+" },
						{ value: "4", label: "4+ relevant" },
						{ value: "5", label: "5 only" },
					]}
					onChange={setMinScore}
				/>
				{subs.length > 0 ? (
					<SearchableDropdown
						className="w-40"
						value={sub}
						searchPlaceholder="Search subs…"
						items={[
							{ value: "all", label: "All subs" },
							...subs.map((s) => ({ value: s, label: `r/${s}` })),
						]}
						onChange={setSub}
					/>
				) : null}
				<Button type="button" variant="outline" size="sm" onClick={downloadCsv}>
					<Download className="size-4" />
					CSV
				</Button>
				{activeId === "founders" ? (
					<Button
						type="button"
						size="sm"
						disabled={sendPage.isPending}
						onClick={() => {
							const n = shown.filter((d) => founderEmailOf(d) && d.outreachStatus !== "sent").length;
							if (!n) return;
							const ok = window.confirm(
								`Send ${n} karyam.xyz emails via AutoSend from ${autosend.data?.fromEmail || "configured domain"}?`,
							);
							if (ok) sendPage.mutate();
						}}
					>
						<Mail className="size-4" />
						{sendPage.isPending ? "Sending…" : "Email page"}
					</Button>
				) : null}
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => {
						status.refetch();
						page.refetch();
					}}
				>
					<RefreshCw className="size-4" />
				</Button>
				{active ? (
					<Badge>
						{active.collection} · {(page.data?.count ?? active.count ?? 0).toLocaleString()}
					</Badge>
				) : null}
				{activeId === "founders" ? (
					<Badge>
						{autosend.data?.configured
							? `AutoSend ${autosend.data.fromEmail}`
							: "AutoSend not configured"}
					</Badge>
				) : null}
			</div>

			<Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
				<div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
					<p className="text-sm text-muted-foreground">
						{shown.length} of {filtered.length} on this page
						{page.data?.count != null ? ` · ${page.data.count.toLocaleString()} stored` : ""}
					</p>
					<div className="flex gap-2">
						{cursorStack.length > 1 ? (
							<Button size="sm" variant="outline" onClick={() => setCursorStack((s) => s.slice(0, -1))}>
								Previous
							</Button>
						) : null}
						{page.data?.nextCursor ? (
							<Button
								size="sm"
								onClick={() => setCursorStack((s) => [...s, page.data.nextCursor as string])}
							>
								Load more
							</Button>
						) : null}
					</div>
				</div>
				<CardContent className="min-h-0 flex-1 overflow-hidden p-3">
					<DocsTable
						tableId={activeId}
						docs={shown}
						loading={page.isLoading}
						empty="No rows on this page."
					/>
				</CardContent>
			</Card>
		</div>
	);
}
