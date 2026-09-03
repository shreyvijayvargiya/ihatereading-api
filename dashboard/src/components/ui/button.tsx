import type { ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-zinc-800",
				outline: "border border-border bg-white hover:bg-muted",
				ghost: "hover:bg-muted",
				danger: "border border-border bg-white text-foreground hover:bg-zinc-100",
			},
			size: {
				default: "h-9 px-3",
				sm: "h-8 px-2.5 text-xs",
				lg: "h-10 px-4",
				icon: "size-8 p-0",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
);

type Props = ButtonHTMLAttributes<HTMLButtonElement> &
	VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: Props) {
	return (
		<button className={cn(buttonVariants({ variant, size }), className)} {...props} />
	);
}
