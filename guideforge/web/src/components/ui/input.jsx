import { forwardRef } from "react";
import { cn } from "../../lib/utils.js";

export const Input = forwardRef(function Input({ className, type = "text", ...props }, ref) {
  return (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--card))] px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-[hsl(var(--muted-foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
