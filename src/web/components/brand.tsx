import { cn } from "@/lib/utils";

/**
 * The mark: a pair of JSON braces with a face between them, `{•‿•}`. An
 * OpenAPI document, pleased to be served the right way.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-6 shrink-0", className)} aria-hidden="true">
      <defs>
        <linearGradient id="mark-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5a66ee" />
          <stop offset="1" stopColor="#2f3bd8" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#mark-face)" />
      <g fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round">
        <path
          d="M11.2 8.5c-1.9 0-2.7 1-2.7 2.7v2.3c0 1.2-.7 2-1.9 2.5 1.2.5 1.9 1.3 1.9 2.5v2.3c0 1.7.8 2.7 2.7 2.7M20.8 8.5c1.9 0 2.7 1 2.7 2.7v2.3c0 1.2.7 2 1.9 2.5-1.2.5-1.9 1.3-1.9 2.5v2.3c0 1.7-.8 2.7-2.7 2.7"
          strokeWidth="2.1"
        />
        <path d="M13.4 18.2c1.5 1.7 3.7 1.7 5.2 0" strokeWidth="1.9" />
      </g>
      <circle cx="13.7" cy="14.2" r="1.45" fill="#fff" />
      <circle cx="18.3" cy="14.2" r="1.45" fill="#fff" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-display text-[15px] font-semibold tracking-[-0.015em] whitespace-nowrap",
        className,
      )}
    >
      openapi-proxy
    </span>
  );
}
