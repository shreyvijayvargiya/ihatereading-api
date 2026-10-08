import { cn } from "../../lib/utils.js";

export function Separator({ className, orientation = "horizontal", ...props }) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        "shrink-0 bg-[hsl(var(--border))]",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
}
