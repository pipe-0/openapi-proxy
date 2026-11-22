import { cn } from "@/lib/utils";

/**
 * An HTTP method: a colored word at a fixed width, so the paths after it line
 * up. No box around it; in a list of thirty that is thirty boxes less.
 */
export function MethodChip({ method, className }: { method: string; className?: string }) {
  return (
    <span
      data-method={method}
      className={cn(
        "method inline-block w-11 shrink-0 text-[11px] leading-none font-semibold",
        className,
      )}
    >
      {method}
    </span>
  );
}
