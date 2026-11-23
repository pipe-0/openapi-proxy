import { cn } from "../lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Shown after the label as a small numeral. */
  count?: number;
}

/**
 * One choice among a few, visible all at once. Every tab-like control in the
 * app is this one: a quiet track, with the selected option lifted off it in
 * the raised material. Indigo stays reserved for the main action and for what
 * is served.
 */
export function Segmented<T extends string>({
  value,
  options,
  onValueChange,
  "aria-label": label,
  className,
}: {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onValueChange: (value: T) => void;
  "aria-label": string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex h-8 items-center gap-0.5 rounded-lg bg-muted p-0.5", className)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const index = options.findIndex((option) => option.value === value);
        const step = event.key === "ArrowRight" ? 1 : -1;
        const next = options[(index + step + options.length) % options.length];
        if (!next) return;
        onValueChange(next.value);
        event.currentTarget
          .querySelectorAll<HTMLButtonElement>("button")
          [options.indexOf(next)]?.focus();
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a segmented control; native radios cannot carry this layout
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange(option.value)}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] leading-none font-medium whitespace-nowrap outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50",
              selected
                ? "material-raised text-foreground"
                : "border border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span
                className={cn(
                  "text-[11.5px] font-medium tabular-nums",
                  selected ? "text-muted-foreground" : "text-faint",
                )}
              >
                {option.count.toLocaleString("en-US")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
