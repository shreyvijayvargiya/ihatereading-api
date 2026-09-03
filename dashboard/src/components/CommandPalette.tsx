import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Activity, BookOpen, Database, Power, Search, ToggleLeft } from "lucide-react";
import { fetchStatus, startAgent, stopAgent } from "@/lib/api";
import { withPinnedTables } from "@/lib/catalog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Item = {
	id: string;
	group: string;
	label: string;
	hint?: string;
	icon: typeof Search;
	onSelect: () => void | Promise<void>;
};

function tokensMatch(haystack: string, needle: string) {
	const tokens = needle.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const h = haystack.toLowerCase();
	return tokens.every((t) => h.includes(t));
}

export function CommandPalette({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const input = useRef<HTMLInputElement>(null);
	const [q, setQ] = useState("");
	const [active, setActive] = useState(0);
	const status = useQuery({
		queryKey: ["dashboard-status"],
		queryFn: fetchStatus,
		enabled: open,
		refetchInterval: open ? 4000 : false,
	});
	const tables = withPinnedTables(status.data?.tables || []);

	const startMut = useMutation({
		mutationFn: ({ id }: { id: string }) => startAgent(id, { loop: true, intervalMs: 30_000 }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["dashboard-status"] });
			qc.invalidateQueries({ queryKey: ["dashboard-agent"] });
		},
	});
	const stopMut = useMutation({
		mutationFn: ({ id }: { id: string }) => stopAgent(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["dashboard-status"] });
			qc.invalidateQueries({ queryKey: ["dashboard-agent"] });
		},
	});

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				onOpenChange(!open);
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onOpenChange]);

	useEffect(() => {
		if (open) {
			setQ("");
			setActive(0);
			setTimeout(() => input.current?.focus(), 0);
		}
	}, [open]);

	const toggleMode = /^\s*toggle\b/i.test(q);
	const needle = toggleMode ? q.replace(/^\s*toggle\b/i, "").trim() : q.trim();

	const items = useMemo(() => {
		const close = () => onOpenChange(false);
		const go = (to: string, params?: Record<string, string>) => {
			close();
			if (params) navigate({ to: to as never, params: params as never });
			else navigate({ to: to as never });
		};

		const nav: Item[] = [
			{ id: "nav-scrapers", group: "Navigate", label: "Scrapers", icon: Activity, onSelect: () => go("/") },
			{
				id: "nav-tables",
				group: "Navigate",
				label: "Collections",
				icon: Database,
				onSelect: () => go("/tables"),
			},
			{ id: "nav-docs", group: "Navigate", label: "Docs", icon: BookOpen, onSelect: () => go("/docs") },
		];

		for (const t of tables) {
			nav.push({
				id: `scraper-${t.id}`,
				group: "Agents",
				label: t.label,
				hint: t.collection,
				icon: Activity,
				onSelect: () => go("/scrapers/$tableId", { tableId: t.id }),
			});
			nav.push({
				id: `table-${t.id}`,
				group: "Collections",
				label: `${t.label} table`,
				hint: t.collection,
				icon: Database,
				onSelect: () => go("/tables/$tableId", { tableId: t.id }),
			});
		}

		const toggles: Item[] = tables.map((t) => {
			const on = Boolean(t.run?.running);
			return {
				id: `toggle-${t.id}`,
				group: "Toggle agents",
				label: `TOGGLE ${t.label}`,
				hint: `${t.group} · currently ${on ? "ON" : "OFF"}`,
				icon: on ? Power : ToggleLeft,
				onSelect: async () => {
					try {
						if (on) await stopMut.mutateAsync({ id: t.id });
						else await startMut.mutateAsync({ id: t.id });
						close();
					} catch {
						close();
						navigate({ to: "/scrapers/$tableId", params: { tableId: t.id } });
					}
				},
			};
		});

		const matchItem = (item: Item) => {
			if (!needle) return true;
			return tokensMatch(`${item.label} ${item.hint || ""} ${item.id}`, needle);
		};

		if (toggleMode) return toggles.filter(matchItem);
		const filteredNav = needle ? nav.filter(matchItem) : nav.slice(0, 6);
		const filteredToggles = toggles.filter((item) => (needle ? matchItem(item) : true));
		return [...filteredNav, ...filteredToggles];
	}, [needle, toggleMode, tables, navigate, onOpenChange, startMut, stopMut]);

	useEffect(() => {
		setActive(0);
	}, [q, items.length]);

	useEffect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				onOpenChange(false);
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActive((i) => Math.min(items.length - 1, i + 1));
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setActive((i) => Math.max(0, i - 1));
			}
			if (e.key === "Enter") {
				e.preventDefault();
				items[active]?.onSelect();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, items, active, onOpenChange]);

	if (!open) return null;

	const groups = items.reduce<Record<string, Item[]>>((acc, item) => {
		(acc[item.group] ||= []).push(item);
		return acc;
	}, {});

	let index = -1;

	return (
		<div className="fixed inset-0 z-[80] flex items-start justify-center p-4 pt-[12vh]">
			<button
				type="button"
				aria-label="Close search"
				className="absolute inset-0 bg-black/40"
				onClick={() => onOpenChange(false)}
			/>
			<div className="relative z-10 w-full max-w-xl overflow-hidden rounded-xl border border-border bg-white shadow-2xl">
				<div className="relative border-b border-border">
					<Search className="pointer-events-none absolute left-4 top-3.5 size-4 text-muted-foreground" />
					<Input
						ref={input}
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="Search pages, tables… or TOGGLE saas"
						className="h-11 border-0 pl-10 shadow-none focus:ring-0"
					/>
				</div>
				<div className="max-h-[min(28rem,60vh)] overflow-y-auto p-2">
					{items.length === 0 ? (
						<p className="px-2 py-8 text-center text-sm text-muted-foreground">No matches</p>
					) : (
						Object.entries(groups).map(([group, groupItems]) => (
							<div key={group} className="mb-2">
								<p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
									{group}
								</p>
								{groupItems.map((item) => {
									index += 1;
									const i = index;
									const Icon = item.icon;
									return (
										<button
											key={item.id}
											type="button"
											onMouseEnter={() => setActive(i)}
											onClick={() => item.onSelect()}
											className={cn(
												"flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm",
												i === active ? "bg-muted" : "hover:bg-muted/60",
											)}
										>
											<Icon className="size-4 shrink-0 text-muted-foreground" />
											<span className="min-w-0 flex-1">
												<span className="block truncate font-medium">{item.label}</span>
												{item.hint ? (
													<span className="block truncate text-xs text-muted-foreground">
														{item.hint}
													</span>
												) : null}
											</span>
										</button>
									);
								})}
							</div>
						))
					)}
				</div>
				<div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
					Type <span className="font-mono">TOGGLE</span> then an agent name to switch it on or off.
				</div>
			</div>
		</div>
	);
}
