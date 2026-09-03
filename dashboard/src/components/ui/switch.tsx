import { cn } from "@/lib/utils";

export function Switch({
	checked,
	onCheckedChange,
	disabled,
	id,
}: {
	checked: boolean;
	onCheckedChange: (next: boolean) => void;
	disabled?: boolean;
	id?: string;
}) {
	return (
		<button
			id={id}
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onCheckedChange(!checked)}
			className={cn(
				"relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border transition-colors disabled:opacity-50",
				checked ? "bg-primary" : "bg-muted",
			)}
		>
			<span
				className={cn(
					"pointer-events-none block size-4 rounded-full bg-white shadow transition-transform",
					checked ? "translate-x-[18px]" : "translate-x-0.5",
				)}
			/>
		</button>
	);
}
