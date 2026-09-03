import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, BookOpen, Database, PanelLeft, Search, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { fetchStatus } from "@/lib/api";
import { withPinnedTables } from "@/lib/catalog";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";

const NAV = [
	{ to: "/", label: "Scrapers", icon: Activity, match: (p: string) => p === "/" || p.startsWith("/scrapers") },
	{ to: "/tables", label: "Collections", icon: Database, match: (p: string) => p.startsWith("/tables") },
	{ to: "/docs", label: "Docs", icon: BookOpen, match: (p: string) => p.startsWith("/docs") },
];

export function AppSidebar({
	open,
	collapsed,
	onClose,
	onToggle,
}: {
	open: boolean;
	collapsed: boolean;
	onClose: () => void;
	onToggle: () => void;
}) {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const status = useQuery({
		queryKey: ["dashboard-status"],
		queryFn: fetchStatus,
		refetchInterval: 8000,
	});
	const tables = withPinnedTables(status.data?.tables || []);
	const slim = collapsed && !open;

	return (
		<>
			{open ? (
				<button
					type="button"
					aria-label="Close menu"
					className="fixed inset-0 z-40 bg-black/30 md:hidden"
					onClick={onClose}
				/>
			) : null}
			<div
				aria-hidden
				className={cn("hidden shrink-0 md:block", slim ? "w-14" : "w-60")}
			/>
			<aside
				className={cn(
					"fixed inset-y-3 left-3 z-50 flex flex-col rounded-xl border border-border bg-white shadow-lg shadow-zinc-300/50 transition-[width,transform] duration-200",
					slim ? "w-14" : "w-60",
					open ? "translate-x-0" : "-translate-x-[120%] md:translate-x-0",
				)}
			>
				<div className={cn("flex h-14 items-center px-2", slim ? "justify-center" : "justify-between px-3")}>
					<Link to="/" className="flex min-w-0 items-center gap-2" onClick={onClose}>
						<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground shadow-sm">
							M
						</span>
						{slim ? null : (
							<div className="leading-tight">
								<p className="text-sm font-semibold">Monitor</p>
								<p className="text-[10px] text-muted-foreground">iHateReading</p>
							</div>
						)}
					</Link>
					{slim ? null : (
						<Button variant="ghost" size="icon" className="md:hidden" onClick={onClose}>
							<X className="size-4" />
						</Button>
					)}
				</div>
				<Separator />
				<nav className="flex flex-col gap-1 p-2">
					{slim ? null : (
						<p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
							Workspace
						</p>
					)}
					{NAV.map((item) => {
						const Icon = item.icon;
						const active = item.match(pathname);
						return (
							<Link
								key={item.to}
								to={item.to}
								onClick={onClose}
								title={item.label}
								className={cn(
									"flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm",
									slim && "justify-center px-0",
									active ? "bg-sidebar-accent font-medium" : "hover:bg-muted",
								)}
							>
								<Icon className="size-4 shrink-0" />
								{slim ? null : item.label}
							</Link>
						);
					})}
				</nav>
				<Separator />
				<div className="min-h-0 flex-1 overflow-y-auto p-2">
					{slim ? null : (
						<p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
							Agents
						</p>
					)}
					<div className="flex flex-col gap-0.5">
						{tables.map((t) => {
							const href = `/scrapers/${t.id}`;
							const active = pathname === href;
							const on = Boolean(t.run?.running);
							return (
								<Link
									key={t.id}
									to="/scrapers/$tableId"
									params={{ tableId: t.id }}
									onClick={onClose}
									title={t.label}
									className={cn(
										"flex items-center justify-between rounded-lg px-2 py-1.5 text-sm",
										slim && "justify-center px-0",
										active ? "bg-sidebar-accent font-medium" : "hover:bg-muted",
									)}
								>
									{slim ? (
										<span className={cn("size-2 rounded-full", on ? "bg-foreground" : "bg-border")} />
									) : (
										<>
											<span className="truncate">{t.label}</span>
											<div className="flex shrink-0 items-center gap-1">
												{t.id === "clubs" ? (
													<span className="rounded bg-muted px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
														new
													</span>
												) : null}
												<span
													className={cn(
														"size-1.5 rounded-full",
														on ? "bg-foreground" : "bg-border",
													)}
												/>
											</div>
										</>
									)}
								</Link>
							);
						})}
					</div>
				</div>
				<div className="p-2">
					<Button
						variant="ghost"
						size={slim ? "icon" : "sm"}
						className={cn("w-full", !slim && "justify-start")}
						onClick={onToggle}
						title={slim ? "Expand sidebar" : "Collapse sidebar"}
					>
						<PanelLeft className="size-4" />
						{slim ? null : <span>Collapse</span>}
					</Button>
				</div>
			</aside>
		</>
	);
}

export function AppNavbar({
	onMenu,
	onSearch,
}: {
	onMenu: () => void;
	onSearch: () => void;
}) {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const status = useQuery({
		queryKey: ["dashboard-status"],
		queryFn: fetchStatus,
		refetchInterval: 8000,
	});
	const tables = withPinnedTables(status.data?.tables || []);
	const running = tables.filter((t) => t.run?.running).length;
	const matched = tables.find(
		(t) => pathname === `/scrapers/${t.id}` || pathname === `/tables/${t.id}`,
	);
	const title =
		pathname === "/"
			? "Scrapers"
			: pathname.startsWith("/docs")
				? "Documentation"
				: pathname.startsWith("/tables")
					? matched?.label || "Collections"
					: matched?.label || "Agent";

	return (
		<header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3">
			<Button variant="ghost" size="icon" onClick={onMenu} title="Toggle sidebar">
				<PanelLeft className="size-4" />
			</Button>
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-semibold">{title}</p>
				<p className="hidden text-xs text-muted-foreground sm:block">
					{status.data?.project} · {status.data?.database}
				</p>
			</div>
			<button
				type="button"
				onClick={onSearch}
				className="flex h-9 max-w-xs flex-1 items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 text-sm text-muted-foreground hover:bg-muted"
			>
				<Search className="size-4" />
				<span className="hidden sm:inline">Search…</span>
				<kbd className="ml-auto hidden rounded border border-border bg-white px-1.5 py-0.5 font-mono text-[10px] sm:inline">
					⌘K
				</kbd>
			</button>
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<span className="rounded-md border border-border px-2 py-1">{running} running</span>
				<span className="hidden rounded-md border border-border px-2 py-1 sm:inline">
					{(tables.reduce((n, t) => n + (t.count || 0), 0) || 0).toLocaleString()} docs
				</span>
			</div>
		</header>
	);
}
