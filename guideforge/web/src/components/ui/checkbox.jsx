import { Check } from "lucide-react";
import { cn } from "../../lib/utils.js";

export function Checkbox({ checked, onCheckedChange, id, className, disabled }) {
  return (
    <button
      type="button"
      id={id}
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "peer h-4 w-4 shrink-0 rounded border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] disabled:cursor-not-allowed disabled:opacity-50",
        checked && "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-[hsl(var(--primary))]",
        className,
      )}
    >
      {checked ? <Check className="h-3 w-3 mx-auto" strokeWidth={3} /> : null}
    </button>
  );
}
