import { useEffect } from "react";
import { cn } from "@/lib/utils";

/** Set the browser tab title while a page is mounted. */
export function useTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · openapi-proxy` : "openapi-proxy";
    return () => {
      document.title = "openapi-proxy";
    };
  }, [title]);
}

/** A scrolling page inside the app shell: one centered column. */
export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="scroll-quiet h-full overflow-y-auto">
      <div className={cn("mx-auto w-full max-w-4xl px-6 pt-8 pb-24 sm:px-8", className)}>
        {children}
      </div>
    </div>
  );
}

/**
 * Top of a page: the title with its description directly beneath (one unit),
 * and the page's own actions aligned to the title on the right.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex items-start justify-between gap-6 pb-8", className)}>
      <div className="min-w-0">
        <h1 className="type-title truncate">{title}</h1>
        {description && (
          <div className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</div>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 pt-0.5">{actions}</div>}
    </header>
  );
}

/**
 * A titled group. Hierarchy comes from type and space: no card, no rule. The
 * description sits right under the title, then the content.
 */
export function Section({
  title,
  description,
  action,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("w-full", className)}>
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="type-heading">{title}</h2>
          {description && (
            <p className="max-w-prose text-[13px] leading-5 text-muted-foreground">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      {children && <div className="mt-4 flex flex-col gap-6">{children}</div>}
    </section>
  );
}

/** One field: label, then the control, then a hint that explains it. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-[13px] leading-5 font-medium">
          {label}
        </label>
      )}
      <div>{children}</div>
      {error ? (
        <p role="alert" className="text-[12.5px] leading-[18px] text-bad-foreground">
          {error}
        </p>
      ) : (
        hint && (
          <p className="max-w-prose text-[12.5px] leading-[18px] text-muted-foreground">{hint}</p>
        )
      )}
    </div>
  );
}

/** A notice inside the flow of a page. Tinted, edged, no icon in front. */
export function Notice({
  tone = "bad",
  children,
  action,
  className,
}: {
  tone?: "bad" | "warn" | "accent" | "neutral";
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const tones = {
    bad: "bg-bad text-bad-foreground ring-bad-edge/20",
    warn: "bg-warn text-warn-foreground ring-warn-edge/25",
    accent: "bg-primary/6 text-foreground ring-primary/20 dark:bg-primary/12",
    neutral: "bg-muted/60 text-foreground ring-border",
  };
  return (
    <div
      role={tone === "bad" ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg px-3.5 py-2.5 text-[13px] leading-5 ring-1 ring-inset",
        tones[tone],
        className,
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
    </div>
  );
}

export function Missing({ what }: { what: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <p className="type-heading">{what} not found</p>
      <p className="mt-1 text-[13px] text-muted-foreground">
        It may have been deleted, or the link is wrong.
      </p>
    </div>
  );
}
