import { cn } from "../../lib/utils.js";

export function Switch({ checked, onCheckedChange, id, className, disabled }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-[hsl(var(--primary))]" : "bg-[hsl(var(--input))]",
        className,
      )}
    >
      <span
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-lg ring-0 transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}
