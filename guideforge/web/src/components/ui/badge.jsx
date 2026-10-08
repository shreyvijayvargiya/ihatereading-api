import { cn } from "../../lib/utils.js";

const variants = {
  default: "border-transparent bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]",
  secondary: "border-transparent bg-[hsl(var(--muted))] text-[hsl(var(--foreground))]",
  outline: "text-[hsl(var(--foreground))] border-[hsl(var(--border))]",
  success: "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  warning: "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  muted: "border-transparent bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]",
};

export function Badge({ className, variant = "default", ...props }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
        variants[variant] || variants.default,
        className,
      )}
      {...props}
    />
  );
}
