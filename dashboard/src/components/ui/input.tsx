import { type InputHTMLAttributes, type Ref } from "react";
import { cn } from "@/lib/utils";

export function Input({
	className,
	ref,
	...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
	return (
		<input
			ref={ref}
			className={cn(
				"flex h-9 w-full rounded-md border border-border bg-white px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-foreground",
				className,
			)}
			{...props}
		/>
	);
}
