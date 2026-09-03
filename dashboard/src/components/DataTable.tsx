import { useState } from "react";
import {
	flexRender,
	getCoreRowModel,
	getSortedRowModel,
	useReactTable,
	type ColumnDef,
	type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export function DataTable<T>({
	data,
	columns,
	getRowId,
	rowClassName,
	loading,
	empty = "No rows.",
	className,
}: {
	data: T[];
	columns: ColumnDef<T, unknown>[];
	getRowId: (row: T) => string;
	rowClassName?: (row: T) => string;
	loading?: boolean;
	empty?: string;
	className?: string;
}) {
	const [sorting, setSorting] = useState<SortingState>([]);
	const table = useReactTable({
		data,
		columns,
		state: { sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getRowId: (row) => getRowId(row),
	});

	return (
		<div className={cn("h-full min-h-0 overflow-auto rounded-lg border border-border bg-card", className)}>
			<Table className="min-w-[800px]">
				<TableHeader>
					{table.getHeaderGroups().map((group) => (
						<TableRow key={group.id} className="hover:bg-transparent">
							{group.headers.map((header) => {
								const sorted = header.column.getIsSorted();
								const canSort = header.column.getCanSort();
								return (
									<TableHead key={header.id} className="whitespace-nowrap">
										{header.isPlaceholder ? null : canSort ? (
											<button
												type="button"
												className="inline-flex items-center gap-1 hover:text-foreground"
												onClick={header.column.getToggleSortingHandler()}
											>
												{flexRender(header.column.columnDef.header, header.getContext())}
												{sorted === "asc" ? (
													<ArrowUp className="size-3.5" />
												) : sorted === "desc" ? (
													<ArrowDown className="size-3.5" />
												) : (
													<ArrowUpDown className="size-3.5 opacity-50" />
												)}
											</button>
										) : (
											flexRender(header.column.columnDef.header, header.getContext())
										)}
									</TableHead>
								);
							})}
						</TableRow>
					))}
				</TableHeader>
				<TableBody>
					{loading ? (
						<TableRow>
							<TableCell colSpan={columns.length} className="h-32 text-center text-muted-foreground">
								Loading…
							</TableCell>
						</TableRow>
					) : table.getRowModel().rows.length === 0 ? (
						<TableRow>
							<TableCell colSpan={columns.length} className="h-32 text-center text-muted-foreground">
								{empty}
							</TableCell>
						</TableRow>
					) : (
						table.getRowModel().rows.map((row) => (
							<TableRow key={row.id} className={rowClassName?.(row.original)}>
								{row.getVisibleCells().map((cell) => (
									<TableCell key={cell.id}>
										{flexRender(cell.column.columnDef.cell, cell.getContext())}
									</TableCell>
								))}
							</TableRow>
						))
					)}
				</TableBody>
			</Table>
		</div>
	);
}
