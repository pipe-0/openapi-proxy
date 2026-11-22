import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A status as a quiet chip: a soft tint and a hairline in the status color.
 * The label carries the meaning; nothing is put in front of it. Color is
 * reserved for judgment (`ok`, `warn`, `bad`). Plain facts are `neutral`, and
 * `accent` marks something new that wants a look.
 */
const statusChip = cva(
  "inline-flex h-[18px] shrink-0 items-center rounded-[5px] px-1.5 text-[11.5px] leading-none font-medium whitespace-nowrap ring-1 ring-inset",
  {
    variants: {
      tone: {
        neutral: "bg-muted/70 text-foreground/70 ring-border",
        ok: "bg-ok text-ok-foreground ring-ok-edge/20",
        warn: "bg-warn text-warn-foreground ring-warn-edge/25",
        bad: "bg-bad text-bad-foreground ring-bad-edge/20",
        accent: "bg-primary/8 text-primary ring-primary/20 dark:bg-primary/15",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function StatusChip({
  tone,
  className,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof statusChip>) {
  return (
    <span data-slot="status-chip" className={cn(statusChip({ tone }), className)} {...props} />
  );
}
