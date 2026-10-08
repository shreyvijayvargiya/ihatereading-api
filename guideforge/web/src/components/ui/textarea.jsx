import { forwardRef } from "react";
import { cn } from "../../lib/utils.js";

export const Textarea = forwardRef(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-[120px] w-full rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--card))] px-3 py-2 text-sm shadow-sm placeholder:text-[hsl(var(--muted-foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
