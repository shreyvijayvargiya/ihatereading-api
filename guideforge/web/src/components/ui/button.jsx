import { forwardRef } from "react";
import { cn } from "../../lib/utils.js";

const variants = {
  default:
    "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90",
  secondary:
    "bg-[hsl(var(--muted))] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]",
  outline:
    "border border-[hsl(var(--border))] bg-[hsl(var(--card))] hover:bg-[hsl(var(--accent))]",
  ghost: "hover:bg-[hsl(var(--accent))]",
  destructive: "bg-[hsl(var(--destructive))] text-white hover:opacity-90",
  link: "text-[hsl(var(--foreground))] underline-offset-4 hover:underline",
};

const sizes = {
  default: "h-9 px-4 py-2",
  sm: "h-8 rounded-md px-3 text-xs",
  lg: "h-10 rounded-md px-6",
  icon: "h-9 w-9",
};

export const Button = forwardRef(function Button(
  { className, variant = "default", size = "default", type = "button", ...props },
  ref,
) {
  return (
    <button
      type={type}
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] disabled:pointer-events-none disabled:opacity-50",
        variants[variant] || variants.default,
        sizes[size] || sizes.default,
        className,
      )}
      {...props}
    />
  );
});
