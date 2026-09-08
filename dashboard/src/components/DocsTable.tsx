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

function str(doc: Record<string, unknown>, ...keys: string[]) {
	for (const k of keys) {
		const v = doc[k];
		if (v == null || v === "") continue;
		if (typeof v === "object" && v !== null && "website" in (v as object)) {
			const nested = String((v as { website?: string }).website || "");
			if (nested) return nested;
			continue;
		}
		const s = String(v).trim();
		if (s) return s;
	}
	return "";
}

function nestedStr(doc: Record<string, unknown>, path: string[]) {
	let cur: unknown = doc;
	for (const p of path) {
		if (!cur || typeof cur !== "object") return "";
		cur = (cur as Record<string, unknown>)[p];
	}
	return cur == null ? "" : String(cur).trim();
}

function clubPhone(doc: Record<string, unknown>) {
	return (
		str(doc, "phone") ||
		nestedStr(doc, ["contact", "phone"]) ||
		nestedStr(doc, ["maps", "phone"])
	);
}

function clubEmail(doc: Record<string, unknown>) {
	const emails = Array.isArray(doc.emails) ? String(doc.emails[0] || "") : "";
	return (
		str(doc, "outreachEmail") ||
		str(doc, "email") ||
		str(doc, "contactEmail") ||
		emails ||
		nestedStr(doc, ["contact", "email"])
	);
}

function clubWebsite(doc: Record<string, unknown>) {
	return (
		str(doc, "website") ||
		nestedStr(doc, ["contact", "website"]) ||
		nestedStr(doc, ["maps", "website"])
	);
}

function clubMapsUrl(doc: Record<string, unknown>) {
	return str(doc, "mapsUrl") || nestedStr(doc, ["maps", "url"]);
}

function clubCoords(doc: Record<string, unknown>) {
	const nested = doc.coordinates as { lat?: number; lng?: number } | undefined;
	const maps = doc.maps as { coordinates?: { lat?: number; lng?: number } } | undefined;
	const lat = Number(doc.latitude ?? nested?.lat ?? maps?.coordinates?.lat);
	const lng = Number(doc.longitude ?? nested?.lng ?? maps?.coordinates?.lng);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
	return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function clubContactPerson(doc: Record<string, unknown>) {
	return [str(doc, "contactName") || nestedStr(doc, ["contact", "name"]), str(doc, "contactRole") || nestedStr(doc, ["contact", "role"])]
		.filter(Boolean)
		.join(" · ");
}

function hrefButton(href: string, label: string) {
	if (!href) return <span className="text-xs text-muted-foreground">—</span>;
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="inline-flex items-center gap-1 text-xs hover:underline"
		>
			<ExternalLink className="size-3.5 shrink-0" />
			{label}
		</a>
	);
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
						{str(row.original, "location")}
						{row.original.founded ? ` · ${row.original.founded}` : ""}
					</p>
				</div>
			),
		},
		{
			id: "league",
			accessorFn: (row) => str(row, "league"),
			header: "League",
			cell: ({ row }) => <Badge>{str(row.original, "league") || "—"}</Badge>,
		},
		{
			id: "manager",
			accessorFn: (row) => str(row, "manager"),
			header: "Manager",
			cell: ({ row }) => <span className="text-sm">{str(row.original, "manager") || "—"}</span>,
		},
		{
			id: "stadium",
			accessorFn: (row) => str(row, "stadium", "stadiumAddress", "address"),
			header: "Stadium",
			cell: ({ row }) => (
				<div className="min-w-[10rem] max-w-[14rem]">
					<p className="text-sm">{str(row.original, "stadium") || "—"}</p>
					<p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
						{str(row.original, "stadiumAddress", "address") || ""}
					</p>
				</div>
			),
		},
		{
			id: "coords",
			accessorFn: (row) => clubCoords(row),
			header: "Lat / Lng",
			cell: ({ row }) => (
				<span className="whitespace-nowrap font-mono text-xs">
					{clubCoords(row.original) || "—"}
				</span>
			),
		},
		{
			id: "phone",
			accessorFn: (row) => clubPhone(row),
			header: "Phone",
			cell: ({ row }) => (
				<span className="whitespace-nowrap font-mono text-xs">
					{clubPhone(row.original) || "—"}
				</span>
			),
		},
		{
			id: "email",
			accessorFn: (row) => clubEmail(row),
			header: "Email",
			cell: ({ row }) => (
				<div className="min-w-[11rem] max-w-[16rem]">
					<p className="text-xs">{clubEmail(row.original) || "—"}</p>
					<p className="mt-0.5 text-[11px] text-muted-foreground">
						{clubContactPerson(row.original)}
					</p>
					{Array.isArray(row.original.staff) && row.original.staff.length ? (
						<p className="mt-0.5 text-[11px] text-muted-foreground">
							{row.original.staff.filter((s) => s && typeof s === "object" && "email" in s && s.email).length}{" "}
							staff emails
						</p>
					) : null}
				</div>
			),
		},
		{
			id: "website",
			accessorFn: (row) => clubWebsite(row),
			header: "Website",
			cell: ({ row }) => hrefButton(clubWebsite(row.original), "Site"),
		},
		{
			id: "maps",
			accessorFn: (row) => clubMapsUrl(row),
			header: "Maps",
			cell: ({ row }) => hrefButton(clubMapsUrl(row.original), "Maps"),
		},
		{
			id: "enrich",
			accessorFn: (row) => str(row, "enrichStatus"),
			header: "Enrich",
			cell: ({ row }) => {
				const status = str(row.original, "enrichStatus") || "pending";
				return <Badge>{status}</Badge>;
			},
		},
		{
			id: "link",
			accessorFn: (row) => rowHref(row),
			header: "Wiki",
			cell: ({ row }) => linkCell(row.original),
		},
	];
}

function ycLogoUrl(doc: Record<string, unknown>) {
	const brand = doc.brand as { logoUrl?: string; faviconUrl?: string; ogImage?: string } | undefined;
	return str(doc, "logoUrl") || String(brand?.logoUrl || brand?.faviconUrl || brand?.ogImage || "");
}

function ycThemeColor(doc: Record<string, unknown>) {
	const brand = doc.brand as { themeColor?: string } | undefined;
	return String(brand?.themeColor || "").trim();
}

function ycCoords(doc: Record<string, unknown>) {
	const nested = doc.coordinates as { lat?: number; lng?: number } | undefined;
	const maps = doc.maps as { coordinates?: { lat?: number; lng?: number } } | undefined;
	const lat = Number(doc.latitude ?? nested?.lat ?? maps?.coordinates?.lat);
	const lng = Number(doc.longitude ?? nested?.lng ?? maps?.coordinates?.lng);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
	return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function ycSocialLinks(doc: Record<string, unknown>) {
	const socials = doc.socials as
		| { linkedin?: string; twitter?: string; github?: string }
		| undefined;
	return [
		{ href: str(doc, "linkedinUrl") || String(socials?.linkedin || ""), label: "LinkedIn" },
		{ href: str(doc, "twitterUrl") || String(socials?.twitter || ""), label: "X" },
		{ href: str(doc, "githubUrl") || String(socials?.github || ""), label: "GitHub" },
	].filter((x) => x.href);
}

function ycPageLinks(doc: Record<string, unknown>) {
	const llm = doc.llmTxt as { found?: boolean; url?: string } | undefined;
	return [
		{ href: str(doc, "landingUrl", "website"), label: "Home" },
		{ href: str(doc, "blogUrl"), label: "Blog" },
		{ href: str(doc, "pricingUrl"), label: "Pricing" },
		{ href: str(doc, "docsUrl"), label: "Docs" },
		{ href: str(doc, "aboutUrl"), label: "About" },
		{ href: str(doc, "contactUrl"), label: "Contact" },
		{ href: str(doc, "sitemapUrl"), label: "Sitemap" },
		{ href: str(doc, "rssUrl"), label: "RSS" },
		{ href: llm?.found ? String(llm.url || "") : "", label: "llm.txt" },
	].filter((x) => x.href);
}

function ycColumns(): ColumnDef<Record<string, unknown>>[] {
	return [
		{
			id: "logo",
			accessorFn: (row) => ycLogoUrl(row),
			header: "Logo",
			enableSorting: false,
			cell: ({ row }) => {
				const src = ycLogoUrl(row.original);
				const color = ycThemeColor(row.original);
				if (!src) {
					return color ? (
						<span
							className="inline-block size-8 rounded border border-border"
							style={{ background: color }}
							title={color}
						/>
					) : (
						<span className="text-xs text-muted-foreground">—</span>
					);
				}
				return (
					<img
						src={src}
						alt=""
						className="size-8 rounded border border-border bg-white object-contain"
					/>
				);
			},
		},
		{
			id: "company",
			accessorFn: (row) => str(row, "name"),
			header: "Company",
			cell: ({ row }) => (
				<div className="min-w-[12rem] max-w-[16rem]">
					<p className="font-medium">{str(row.original, "name") || "—"}</p>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{[str(row.original, "batch"), str(row.original, "status"), str(row.original, "industry")]
							.filter(Boolean)
							.join(" · ")}
					</p>
					<p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
						{str(row.original, "oneLiner", "summary")}
					</p>
					{ycSocialLinks(row.original).length ? (
						<div className="mt-0.5 flex flex-wrap gap-x-2">
							{ycSocialLinks(row.original).map((l) => (
								<a
									key={l.label}
									href={l.href}
									target="_blank"
									rel="noreferrer"
									className="text-[11px] hover:underline"
								>
									{l.label}
								</a>
							))}
						</div>
					) : null}
				</div>
			),
		},
		{
			id: "website",
			accessorFn: (row) => str(row, "website"),
			header: "Website",
			cell: ({ row }) => hrefButton(str(row.original, "website"), "Site"),
		},
		{
			id: "pages",
			accessorFn: (row) => Number(row.sitePageCount) || 0,
			header: "Site pages",
			cell: ({ row }) => {
				const n = Number(row.original.sitePageCount) || 0;
				const links = ycPageLinks(row.original);
				return (
					<div className="min-w-[12rem] max-w-[18rem]">
						<p className="font-mono text-xs tabular-nums">{n} urls</p>
						<div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
							{links.map((l) => (
								<a
									key={l.label}
									href={l.href}
									target="_blank"
									rel="noreferrer"
									className="text-[11px] hover:underline"
								>
									{l.label}
								</a>
							))}
						</div>
					</div>
				);
			},
		},
		{
			id: "brand",
			accessorFn: (row) => ycThemeColor(row),
			header: "Brand",
			cell: ({ row }) => {
				const color = ycThemeColor(row.original);
				const brand = row.original.brand as { name?: string; title?: string } | undefined;
				return (
					<div className="flex min-w-[7rem] items-center gap-2">
						{color ? (
							<span
								className="size-4 shrink-0 rounded border border-border"
								style={{ background: color }}
							/>
						) : null}
						<span className="line-clamp-2 text-[11px] text-muted-foreground">
							{color || brand?.name || brand?.title || "—"}
						</span>
					</div>
				);
			},
		},
		{
			id: "address",
			accessorFn: (row) => str(row, "address", "location"),
			header: "Address",
			cell: ({ row }) => (
				<div className="min-w-[11rem] max-w-[16rem]">
					<p className="line-clamp-2 text-xs">
						{str(row.original, "address") || str(row.original, "location") || "—"}
					</p>
					<p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
						{ycCoords(row.original)}
					</p>
				</div>
			),
		},
		{
			id: "maps",
			accessorFn: (row) => str(row, "mapsUrl"),
			header: "Maps",
			cell: ({ row }) => hrefButton(str(row.original, "mapsUrl"), "Maps"),
		},
		{
			id: "locationStatus",
			accessorFn: (row) => str(row, "locationStatus"),
			header: "Geo",
			cell: ({ row }) => (
				<Badge>
					{str(row.original, "locationStatus") || str(row.original, "locationSource") || "—"}
				</Badge>
			),
		},
		{
			id: "siteEnrich",
			accessorFn: (row) => str(row, "siteEnrichStatus"),
			header: "Enrich",
			cell: ({ row }) => <Badge>{str(row.original, "siteEnrichStatus") || "pending"}</Badge>,
		},
		{
			id: "directory",
			accessorFn: (row) => str(row, "a16zUrl", "ycUrl"),
			header: "Page",
			cell: ({ row }) => {
				const label = row.original.sourceType === "a16z" ? "a16z" : "YC";
				return hrefButton(str(row.original, "a16zUrl", "ycUrl"), label);
			},
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

function crmColumns(): ColumnDef<Record<string, unknown>>[] {
	return [
		{
			id: "name",
			accessorFn: (row) => str(row, "name"),
			header: "CRM",
			cell: ({ row }) => (
				<div className="min-w-[12rem] max-w-[18rem]">
					<p className="font-medium">{str(row.original, "name") || "—"}</p>
					<p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
						{str(row.original, "description", "snippet")}
					</p>
				</div>
			),
		},
		{
			id: "website",
			accessorFn: (row) => str(row, "website"),
			header: "Website",
			cell: ({ row }) => hrefButton(str(row.original, "website"), "Site"),
		},
		{
			id: "domain",
			accessorFn: (row) => str(row, "domain"),
			header: "Domain",
			cell: ({ row }) => (
				<span className="font-mono text-xs">{str(row.original, "domain") || "—"}</span>
			),
		},
		{
			id: "query",
			accessorFn: (row) => str(row, "sourceQuery", "source"),
			header: "Keyword",
			cell: ({ row }) => (
				<span className="max-w-[14rem] text-xs text-muted-foreground">
					{str(row.original, "sourceQuery", "source") || "—"}
				</span>
			),
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
			id: "source",
			accessorFn: (row) => str(row, "sourceUrl"),
			header: "Found on",
			cell: ({ row }) => hrefButton(str(row.original, "sourceUrl"), "List"),
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
	const isYc =
		tableId === "yc" ||
		docs.some((d) => Boolean(d.ycUrl || d.a16zUrl) && Boolean(d.slug || d.batch || d.a16zId));
	const isFounders = tableId === "founders";
	const isCrm =
		tableId === "crm" ||
		docs.some((d) => Boolean(d.website && d.domain && d.sourceType === "google-scrape"));
	const columns = useMemo<ColumnDef<Record<string, unknown>>[]>(() => {
		if (isClubs) return clubColumns();
		if (isYc) return ycColumns();
		if (isFounders) return founderColumns(freshIds);
		if (isCrm) return crmColumns();
		return defaultColumns(freshIds);
	}, [freshIds, isClubs, isYc, isFounders, isCrm]);

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
