import {
  BookOpenIcon,
  BotIcon,
  CheckIcon,
  CreditCardIcon,
  FlaskConicalIcon,
  HandshakeIcon,
  type LucideIcon,
  PackageIcon,
  SearchIcon,
  ServerIcon,
  ShieldIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Mark } from "@/components/brand";
import { MethodChip } from "@/components/method-chip";
import { OperationPath } from "@/components/operation-path";
import { cn } from "@/lib/utils";

/**
 * The two problems openapi-proxy was made for, as pictures rather than prose:
 * one generated document that many consumers each need a different subset
 * of, and an endpoint that is deployed before it is announced. Built from
 * page elements so it is sharp in both color schemes; the motion lives in
 * styles.css and stops for people who ask for reduced motion.
 */

const TOTAL = 175;

const SERVICES: Array<{ id: string; name: string; icon: LucideIcon }> = [
  { id: "core", name: "Core API", icon: ServerIcon },
  { id: "billing", name: "Billing", icon: CreditCardIcon },
  { id: "search", name: "Search", icon: SearchIcon },
];

/** Who reads a variant, and how many of the document's operations it serves. */
const CONSUMERS: Array<{ id: string; name: string; icon: LucideIcon; operations: number }> = [
  { id: "docs", name: "Public docs", icon: BookOpenIcon, operations: 33 },
  { id: "sdk", name: "Public SDK", icon: PackageIcon, operations: 31 },
  { id: "partner", name: "Partner API", icon: HandshakeIcon, operations: 12 },
  { id: "tests", name: "Contract tests", icon: FlaskConicalIcon, operations: 58 },
  { id: "agent", name: "Agent tools", icon: BotIcon, operations: 18 },
  { id: "internal", name: "Internal docs", icon: ShieldIcon, operations: TOTAL },
];

const tile = "material-raised grid shrink-0 place-items-center rounded-xl text-muted-foreground";

/**
 * Curves from each node to the next, measured from the page, so they follow
 * the layout at every width. Side by side above the md breakpoint, stacked
 * below it.
 */
function useBeams(
  container: React.RefObject<HTMLDivElement | null>,
  pairs: Array<[string, string]>,
) {
  const [beams, setBeams] = useState<Array<{ id: string; d: string }>>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairs are a constant
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const wide = window.matchMedia("(min-width: 768px)");
    const measure = () => {
      const origin = root.getBoundingClientRect();
      // Stacked, a node's label sits under it, so a beam leaves from below the label.
      const box = (id: string) => {
        const node =
          (!wide.matches && root.querySelector(`[data-stack="${id}"]`)) ||
          root.querySelector(`[data-node="${id}"]`);
        const rect = node?.getBoundingClientRect();
        return (
          rect && {
            x: rect.left - origin.left,
            y: rect.top - origin.top,
            w: rect.width,
            h: rect.height,
          }
        );
      };
      setBeams(
        pairs.flatMap(([from, to]) => {
          const a = box(from);
          const b = box(to);
          if (!a || !b) return [];
          if (wide.matches) {
            const [sx, sy, ex, ey] = [a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2];
            const mid = (sx + ex) / 2;
            return [
              { id: `${from}-${to}`, d: `M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ey}, ${ex} ${ey}` },
            ];
          }
          const [sx, sy, ex, ey] = [a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y];
          const mid = (sy + ey) / 2;
          return [
            { id: `${from}-${to}`, d: `M ${sx} ${sy} C ${sx} ${mid}, ${ex} ${mid}, ${ex} ${ey}` },
          ];
        }),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    wide.addEventListener("change", measure);
    return () => {
      observer.disconnect();
      wide.removeEventListener("change", measure);
    };
  }, []);
  return beams;
}

const PAIRS: Array<[string, string]> = [
  ...SERVICES.map((service): [string, string] => [service.id, "hub"]),
  ...CONSUMERS.map((consumer): [string, string] => ["hub", consumer.id]),
];

function Flow() {
  const root = useRef<HTMLDivElement>(null);
  const beams = useBeams(root, PAIRS);
  return (
    <figure className="mt-14">
      <div
        ref={root}
        className="relative flex flex-col items-center gap-14 md:grid md:grid-cols-[auto_minmax(56px,1fr)_auto_minmax(56px,1fr)_auto] md:items-center md:gap-0"
      >
        <svg
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
          aria-hidden
        >
          {beams.map((beam, index) => (
            <g key={beam.id}>
              <path d={beam.d} className="fill-none stroke-border" strokeWidth={1} />
              <path
                d={beam.d}
                pathLength={1}
                className="beam-pulse fill-none stroke-primary"
                strokeWidth={1.5}
                strokeLinecap="round"
                style={{
                  animationDelay:
                    index < SERVICES.length
                      ? `${index * 0.15}s`
                      : `${1.1 + (index - SERVICES.length) * 0.12}s`,
                }}
              />
            </g>
          ))}
        </svg>

        <ul className="relative flex gap-6 md:col-start-1 md:flex-col md:gap-7">
          {SERVICES.map((service) => (
            <li
              key={service.id}
              data-stack={service.id}
              className="flex flex-col items-center gap-2 md:flex-row-reverse md:gap-3"
            >
              <span data-node={service.id} className={cn(tile, "size-11")}>
                <service.icon className="size-[18px]" strokeWidth={1.75} />
              </span>
              <span className="text-[12px] text-muted-foreground md:text-[13.5px]">
                {service.name}
              </span>
            </li>
          ))}
        </ul>

        <div data-stack="hub" className="relative flex flex-col items-center gap-3 md:col-start-3">
          <span
            data-node="hub"
            className="hub-ring material-raised grid size-20 place-items-center rounded-[22px]"
          >
            <Mark className="size-10" />
          </span>
          <span className="text-center text-[12px] leading-4 text-muted-foreground">
            One document
            <br />
            {TOTAL} operations
          </span>
        </div>

        <ul className="relative grid w-full grid-cols-6 gap-1 md:col-start-5 md:flex md:w-auto md:flex-col md:gap-3.5">
          {CONSUMERS.map((consumer) => (
            <li
              key={consumer.id}
              className="flex flex-col items-center gap-2 text-center md:flex-row md:gap-3 md:text-left"
            >
              <span data-node={consumer.id} className={cn(tile, "size-10")}>
                <consumer.icon className="size-[17px]" strokeWidth={1.75} />
              </span>
              <span className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[11px] leading-tight md:text-[14px] md:leading-5">
                  {consumer.name}
                </span>
                <span className="hidden items-center gap-2 md:flex">
                  <span className="h-1 w-24 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-primary/70"
                      style={{ width: `${(consumer.operations / TOTAL) * 100}%` }}
                    />
                  </span>
                  <span className="text-[12px] text-faint tabular-nums">{consumer.operations}</span>
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <figcaption className="sr-only">
        Three services make up one OpenAPI document of {TOTAL} operations. openapi-proxy serves six
        variants of it:{" "}
        {CONSUMERS.map((consumer) => `${consumer.name} with ${consumer.operations}`).join(", ")}.
      </figcaption>
    </figure>
  );
}

/** A checkbox as the editor draws it. `animated` ticks it during the loop. */
function Tick({ checked = false, animated = false }: { checked?: boolean; animated?: boolean }) {
  return (
    <span className="relative grid size-4 shrink-0 place-items-center rounded-[4px] ring-1 ring-border ring-inset">
      {(checked || animated) && (
        <span
          className={cn(
            "absolute inset-0 grid place-items-center rounded-[4px] bg-primary text-primary-foreground",
            animated && "demo-check",
          )}
        >
          <CheckIcon className="size-3" strokeWidth={3} />
        </span>
      )}
    </span>
  );
}

function Row({
  method,
  path,
  children,
  className,
}: {
  method: string;
  path: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <li className={cn("overflow-hidden", className)}>
      <div className="flex h-9 items-center gap-3 rounded-md px-3 text-[13.5px]">
        {children}
        <MethodChip method={method} />
        <OperationPath path={path} />
      </div>
    </li>
  );
}

const SERVED = [
  { method: "GET", path: "/v1/charges" },
  { method: "POST", path: "/v1/charges" },
  { method: "GET", path: "/v1/customers/{customer_id}" },
];

/** The cursor of the loop: an arrow, drawn so its tip is its top left corner. */
function Cursor() {
  return (
    <svg
      viewBox="0 0 16 20"
      className="demo-cursor pointer-events-none absolute size-[18px] drop-shadow-sm"
      aria-hidden
    >
      <path
        d="M1 1v15.5l4.2-4.1 2.9 6.6 2.6-1.1-2.9-6.5H14L1 1z"
        className="fill-foreground stroke-background"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PublishDemo() {
  return (
    <figure className="mt-14">
      <div className="grid gap-4 md:grid-cols-2 md:gap-6">
        {/* The variant in the editor: the new endpoint arrives unchecked, is checked, published. */}
        <div className="relative min-h-[244px] rounded-2xl bg-card shadow-float">
          <div className="flex h-12 items-center gap-3 border-b px-4">
            <span className="font-display text-[14.5px] font-semibold">Public docs</span>
            <span className="flex-1" />
            <span className="demo-press material-solid rounded-md px-3 py-1 text-[12.5px] font-medium text-primary-foreground">
              Publish
            </span>
          </div>
          <ul className="p-2">
            {SERVED.map((row) => (
              <Row key={`${row.method} ${row.path}`} {...row}>
                <Tick checked />
              </Row>
            ))}
            <Row method="POST" path="/v1/refunds" className="demo-arrive">
              <Tick animated />
            </Row>
          </ul>
          <Cursor />
        </div>

        {/* What its readers get: the endpoint appears once it is published. */}
        <div className="rounded-2xl bg-subtle ring-1 ring-border ring-inset">
          <div className="flex h-12 items-center gap-2 border-b px-4 text-[13px] text-muted-foreground">
            <span className="truncate">
              <span className="text-faint">openapi-proxy.app/v/acme/</span>
              <span className="text-foreground">public-docs.json</span>
            </span>
          </div>
          <ul className="p-2">
            {SERVED.map((row) => (
              <Row key={`${row.method} ${row.path}`} {...row} />
            ))}
            <Row method="POST" path="/v1/refunds" className="demo-served" />
          </ul>
        </div>
      </div>
      <figcaption className="sr-only">
        A new endpoint, POST /v1/refunds, appears in the editor unchecked. It is checked and
        published, and appears in the document the variant serves.
      </figcaption>
    </figure>
  );
}

const h2 =
  "max-w-2xl font-display text-[30px] leading-[1.15] font-semibold tracking-[-0.03em] text-balance sm:text-[36px]";
const lead = "mt-4 max-w-xl text-[16px] leading-7 text-pretty text-muted-foreground";

export function Problem() {
  return (
    <>
      <section className="mx-auto mt-28 max-w-5xl px-6 sm:mt-40">
        <h2 className={h2}>One OpenAPI document. Many consumers.</h2>
        <p className={lead}>
          Docs, SDKs, partners, tests and agents each need a different subset of your operations.
          Each subset becomes a variant, served at its own URL and current with the source.
        </p>
        <Flow />
      </section>

      <section className="mx-auto mt-28 max-w-5xl px-6 sm:mt-40">
        <h2 className={h2}>Ship the endpoint now. Publish it when it is ready.</h2>
        <p className={lead}>
          A new operation stays out of a variant until you include it. Publishing it is a click, not
          a pull request and a deploy.
        </p>
        <PublishDemo />
      </section>
    </>
  );
}
