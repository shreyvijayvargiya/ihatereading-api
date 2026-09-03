import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Mail } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { sendFounderEmail } from "@/lib/api";
import {
	formatWhen,
	founderEmailOf,
	rowAuthor,
	rowBody,
	rowHref,
	rowMeta,
	rowTitle,
	rowWhen,
	scoreOf,
} from "@/lib/utils";

function linkCell(doc: Record<string, unknown>) {
	const href = rowHref(doc);
	if (!href) return null;
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="inline-flex rounded-md border border-border p-1.5 hover:bg-muted"
		>
			<ExternalLink className="size-3.5" />
		</a>
	);
}

function defaultColumns(freshIds?: Set<string>): ColumnDef<Record<string, unknown>>[] {
	return [
		{
			id: "score",
			accessorFn: (row) => scoreOf(row),
			header: "Score",
			cell: ({ row }) => {
				const n = scoreOf(row.original);
				const id = String(row.original.id);
				const fresh = freshIds?.has(id);
				return (
					<span className="font-medium tabular-nums">
						{n ? `${n}/5` : "—"}
						{fresh ? (
							<span className="ml-1 text-[10px] uppercase text-muted-foreground">new</span>
						) : null}
					</span>
				);
			},
		},
		{
			id: "meta",
			accessorFn: (row) => rowMeta(row),
			header: "Meta",
			cell: ({ row }) => <Badge>{rowMeta(row.original)}</Badge>,
		},
		{
			id: "item",
			accessorFn: (row) => rowTitle(row),
			header: "Item",
			cell: ({ row }) => (
				<div className="min-w-[16rem] max-w-md">
					<p className="font-medium">{rowTitle(row.original)}</p>
					<p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{rowBody(row.original)}</p>
				</div>
			),
		},
		{
			id: "author",
			accessorFn: (row) => rowAuthor(row),
			header: "Author",
			cell: ({ row }) => <span className="font-mono text-xs">{rowAuthor(row.original)}</span>,
		},
		{
			id: "when",
			accessorFn: (row) => rowWhen(row),
			header: "When",
			cell: ({ row }) => (
				<span className="whitespace-nowrap text-xs text-muted-foreground">
					{formatWhen(rowWhen(row.original))}
				</span>
			),
		},
		{
			id: "link",
			accessorFn: (row) => rowHref(row),
			header: "Link",
			cell: ({ row }) => linkCell(row.original),
		},
	];
}

function clubColumns(): ColumnDef<Record<string, unknown>>[] {
	return [
		{
			id: "club",
			accessorFn: (row) => rowTitle(row),
			header: "Club",
			cell: ({ row }) => (
				<div className="min-w-[10rem]">
					<p className="font-medium">{rowTitle(row.original)}</p>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{String(row.original.location || "")}
						{row.original.founded ? ` · ${row.original.founded}` : ""}
					</p>
				</div>
			),
		},
		{
			id: "league",
			accessorFn: (row) => String(row.league || ""),
			header: "League",
			cell: ({ row }) => <Badge>{String(row.original.league || "—")}</Badge>,
		},
		{
			id: "manager",
			accessorFn: (row) => String(row.manager || ""),
			header: "Manager",
			cell: ({ row }) => <span className="text-sm">{String(row.original.manager || "—")}</span>,
		},
		{
			id: "stadium",
			accessorFn: (row) => String(row.stadium || ""),
			header: "Stadium",
			cell: ({ row }) => <span className="text-sm">{String(row.original.stadium || "—")}</span>,
		},
		{
			id: "website",
			accessorFn: (row) => String(row.website || row.email || ""),
			header: "Contact",
			cell: ({ row }) => (
				<span className="text-xs text-muted-foreground">
					{String(row.original.email || row.original.website || "—")}
				</span>
			),
		},
		{
			id: "link",
			accessorFn: (row) => rowHref(row),
			header: "Wiki",
			cell: ({ row }) => linkCell(row.original),
		},
	];
}

function FounderSendButton({ doc }: { doc: Record<string, unknown> }) {
	const qc = useQueryClient();
	const [err, setErr] = useState("");
	const email = founderEmailOf(doc);
	const sent = String(doc.outreachStatus || "") === "sent";
	const mut = useMutation({
		mutationFn: () =>
			sendFounderEmail(String(doc.id), {
				force: sent,
				subject: doc.draftSubject,
				text: doc.draftMessage,
			}),
		onSuccess: () => {
			setErr("");
			qc.invalidateQueries({ queryKey: ["dashboard-table"] });
			qc.invalidateQueries({ queryKey: ["dashboard-latest"] });
		},
		onError: (e: Error) => setErr(e.message),
	});
	if (!email) {
		return <span className="text-xs text-muted-foreground">no email</span>;
	}
	return (
		<div className="flex flex-col items-end gap-1">
			<Button
				type="button"
				size="sm"
				variant={sent ? "outline" : "default"}
				disabled={mut.isPending}
				onClick={() => {
					const ok = window.confirm(
						sent
							? `Resend to ${email}?`
							: `Send karyam.xyz outreach to ${email} via AutoSend?`,
					);
					if (ok) mut.mutate();
				}}
			>
				<Mail className="size-3.5" />
				{mut.isPending ? "Sending" : sent ? "Resend" : "Send"}
			</Button>
			{err ? <span className="max-w-[10rem] text-[10px] text-muted-foreground">{err}</span> : null}
		</div>
	);
}

function founderColumns(freshIds?: Set<string>): ColumnDef<Record<string, unknown>>[] {
	return [
		{
			id: "score",
			accessorFn: (row) => scoreOf(row),
			header: "Score",
			cell: ({ row }) => {
				const n = scoreOf(row.original);
				const fresh = freshIds?.has(String(row.original.id));
				return (
					<span className="font-medium tabular-nums">
						{n ? `${n}/5` : "—"}
						{fresh ? (
							<span className="ml-1 text-[10px] uppercase text-muted-foreground">new</span>
						) : null}
					</span>
				);
			},
		},
		{
			id: "company",
			accessorFn: (row) => String(row.company || row.name || ""),
			header: "Company",
			cell: ({ row }) => (
				<div className="min-w-[12rem] max-w-xs">
					<p className="font-medium">{String(row.original.company || rowTitle(row.original))}</p>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{String(row.original.name || row.original.role || "")}
						{row.original.intent ? ` · ${row.original.intent}` : ""}
					</p>
				</div>
			),
		},
		{
			id: "email",
			accessorFn: (row) => founderEmailOf(row),
			header: "Email",
			cell: ({ row }) => (
				<div className="min-w-[11rem] font-mono text-xs">
					<p>{founderEmailOf(row.original) || "—"}</p>
					<p className="mt-0.5 text-muted-foreground">
						{String(row.original.phone || row.original.linkedinUrl || "")}
					</p>
				</div>
			),
		},
		{
			id: "status",
			accessorFn: (row) => String(row.outreachStatus || "new"),
			header: "Outreach",
			cell: ({ row }) => <Badge>{String(row.original.outreachStatus || "new")}</Badge>,
		},
		{
			id: "link",
			accessorFn: (row) => rowHref(row),
			header: "Site",
			cell: ({ row }) => linkCell(row.original),
		},
		{
			id: "send",
			header: "AutoSend",
			cell: ({ row }) => <FounderSendButton doc={row.original} />,
		},
	];
}

export function DocsTable({
	docs,
	loading,
	empty,
	freshIds,
	tableId,
}: {
	docs: Record<string, unknown>[];
	loading?: boolean;
	empty?: string;
	freshIds?: Set<string>;
	tableId?: string;
}) {
	const isClubs =
		tableId === "clubs" ||
		docs.some((d) => Boolean(d.clubId || d.wikiUrl) && Boolean(d.league));
	const isFounders = tableId === "founders";
	const columns = useMemo<ColumnDef<Record<string, unknown>>[]>(() => {
		if (isClubs) return clubColumns();
		if (isFounders) return founderColumns(freshIds);
		return defaultColumns(freshIds);
	}, [freshIds, isClubs, isFounders]);

	return (
		<DataTable
			data={docs}
			columns={columns}
			getRowId={(row) => String(row.id)}
			loading={loading}
			empty={empty}
			rowClassName={(row) => (freshIds?.has(String(row.id)) ? "bg-muted" : "")}
		/>
	);
}
