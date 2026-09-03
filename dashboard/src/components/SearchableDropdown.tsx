import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type DropdownItem = {
	value: string;
	label: string;
	hint?: string;
};

export function SearchableDropdown({
	items,
	value,
	onChange,
	placeholder = "Select…",
	searchPlaceholder = "Search…",
	className,
}: {
	items: DropdownItem[];
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	searchPlaceholder?: string;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const [q, setQ] = useState("");
	const root = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const selected = items.find((i) => i.value === value);

	const filtered = useMemo(() => {
		const needle = q.trim().toLowerCase();
		if (!needle) return items;
		return items.filter((i) =>
			`${i.label} ${i.value} ${i.hint || ""}`.toLowerCase().includes(needle),
		);
	}, [items, q]);

	useEffect(() => {
		function onDoc(e: MouseEvent) {
			if (!root.current?.contains(e.target as Node)) setOpen(false);
		}
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, []);

	useEffect(() => {
		if (open) {
			setQ("");
			setTimeout(() => input.current?.focus(), 0);
		}
	}, [open]);

	return (
		<div ref={root} className={cn("relative", className)}>
			<Button
				type="button"
				variant="outline"
				className="w-full justify-between font-normal"
				onClick={() => setOpen((v) => !v)}
			>
				<span className="truncate">{selected?.label || placeholder}</span>
				<ChevronsUpDown className="size-4 shrink-0 opacity-50" />
			</Button>
			{open ? (
				<div className="absolute z-50 mt-1 w-[min(100%,20rem)] min-w-full overflow-hidden rounded-xl border border-border bg-white shadow-lg">
					<div className="relative border-b border-border p-2">
						<Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							ref={input}
							value={q}
							onChange={(e) => setQ(e.target.value)}
							placeholder={searchPlaceholder}
							className="h-8 pl-8"
						/>
					</div>
					<div className="max-h-64 overflow-y-auto p-1">
						{filtered.length === 0 ? (
							<p className="px-2 py-6 text-center text-sm text-muted-foreground">No matches</p>
						) : (
							filtered.map((item) => {
								const active = item.value === value;
								return (
									<button
										key={item.value}
										type="button"
										onClick={() => {
											onChange(item.value);
											setOpen(false);
										}}
										className={cn(
											"flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted",
											active && "bg-muted font-medium",
										)}
									>
										<span className="min-w-0">
											<span className="block truncate">{item.label}</span>
											{item.hint ? (
												<span className="block truncate text-[11px] text-muted-foreground">
													{item.hint}
												</span>
											) : null}
										</span>
										{active ? <Check className="size-3.5 shrink-0" /> : null}
									</button>
								);
							})
						)}
					</div>
				</div>
			) : null}
		</div>
	);
}
