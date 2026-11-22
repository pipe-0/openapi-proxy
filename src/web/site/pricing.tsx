import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GUARDS, PLAN_LIMITS, PLAN_NAMES, PLAN_PRICES } from "../../shared/plans";
import { GITHUB_URL } from "./site";

const link = "underline decoration-border underline-offset-4 hover:decoration-foreground";

/**
 * The three ways to use it. Free and Pro are the hosted service; self-hosted
 * is the same code on the reader's own Cloudflare account, where the plans do
 * not exist and only the guards apply.
 */
type Column = "free" | "pro" | "self";

const MB = `${GUARDS.projectBytes / 1_000_000} MB`;
const same = (value: string): Record<Column, string> => ({ free: value, pro: value, self: value });

/** One row of the comparison. Every number comes from the code that enforces it. */
const ROWS: Array<{ label: string; hint?: string; values: Record<Column, string> }> = [
  {
    label: "Projects",
    hint: "One API each, from one OpenAPI document or several merged into one.",
    values: {
      free: String(PLAN_LIMITS.free.projects),
      pro: String(PLAN_LIMITS.pro.projects),
      self: String(PLAN_LIMITS.pro.projects),
    },
  },
  {
    label: "Variants",
    hint: "A selection of operations, served at a URL of its own.",
    values: {
      free: `${PLAN_LIMITS.free.variants} in total`,
      pro: `${GUARDS.variantsPerProject} per project`,
      self: `${GUARDS.variantsPerProject} per project`,
    },
  },
  {
    label: "Size of a project",
    hint: "All of its OpenAPI documents together, before compression.",
    values: same(MB),
  },
  {
    label: "Documents merged into one project",
    values: same(String(GUARDS.sourcesPerProject)),
  },
  {
    label: "People in the workspace",
    values: same(String(GUARDS.people)),
  },
  {
    label: "OpenAPI 3.0 and 3.1 output, change emails, API and MCP",
    values: same("Included"),
  },
  {
    label: "Who runs it",
    values: { free: "We do", pro: "We do", self: "You do" },
  },
];

const COLUMN_NAMES: Record<Column, string> = {
  free: PLAN_NAMES.free,
  pro: PLAN_NAMES.pro,
  self: "Self-hosted",
};

function Plan({
  name,
  amount,
  per,
  children,
  action,
}: {
  name: string;
  amount: string;
  per: string;
  children: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <h3 className="font-display text-[19px] font-semibold tracking-[-0.015em]">{name}</h3>
      <p className="mt-3 flex items-baseline gap-1.5">
        <span className="font-display text-[34px] leading-none font-semibold tracking-[-0.03em]">
          {amount}
        </span>
        <span className="text-[14px] text-muted-foreground">{per}</span>
      </p>
      <p className="mt-3 text-[15px] leading-[1.65] text-pretty text-muted-foreground">
        {children}
      </p>
      <div className="mt-5">{action}</div>
    </div>
  );
}

export function Pricing() {
  return (
    <div className="mx-auto max-w-5xl px-6 pt-14 sm:pt-20">
      <h1 className="font-display text-[38px] leading-[1.1] font-semibold tracking-[-0.03em]">
        Pricing
      </h1>
      <p className="mt-3 max-w-xl text-[16px] leading-7 text-pretty text-muted-foreground">
        Use it hosted at openapi-proxy.app, free or on Pro, or run the same open source code on your
        own Cloudflare account for free. Every feature is in all three.
      </p>

      <div className="mt-14 grid gap-12 md:grid-cols-3 md:gap-0">
        <section aria-labelledby="hosted" className="md:col-span-2 md:pr-10">
          <h2 id="hosted" className="text-[14px] text-muted-foreground">
            Hosted at openapi-proxy.app
          </h2>
          <div className="mt-5 grid gap-10 border-t pt-6 sm:grid-cols-2">
            <Plan
              name={PLAN_NAMES.free}
              amount={PLAN_PRICES.free.amount}
              per={PLAN_PRICES.free.per}
              action={
                // Links that look like buttons: they go somewhere, so they stay links.
                <a href="/login" className={buttonVariants({ variant: "outline" })}>
                  Start for free
                </a>
              }
            >
              Enough for most teams: a few APIs, each with its audiences.
            </Plan>
            <Plan
              name={PLAN_NAMES.pro}
              amount={PLAN_PRICES.pro.amount}
              per={PLAN_PRICES.pro.per}
              action={
                // Signing in leads to the workspace, where upgrading is explained.
                <a href="/workspace" className={buttonVariants()}>
                  Get Pro
                </a>
              }
            >
              For companies with many APIs: {PLAN_LIMITS.pro.projects} projects, each with up to{" "}
              {GUARDS.variantsPerProject} variants.
            </Plan>
          </div>
        </section>
        <section aria-labelledby="self-hosted" className="md:border-l md:pl-10">
          <h2 id="self-hosted" className="text-[14px] text-muted-foreground">
            On your own Cloudflare account
          </h2>
          <div className="mt-5 border-t pt-6">
            <Plan
              name="Self-hosted"
              amount="$0"
              per="always"
              action={
                <a href={GITHUB_URL} className={buttonVariants({ variant: "outline" })}>
                  Deploy from GitHub
                </a>
              }
            >
              The same code on Cloudflare Workers and D1, under your control. No plan to buy, and
              you pay Cloudflare for what it uses, if anything.
            </Plan>
          </div>
        </section>
      </div>

      <div className="scroll-quiet mt-16 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-[15px]">
          <caption className="sr-only">What each way of using openapi-proxy includes</caption>
          <thead>
            <tr className="border-b">
              <th scope="col" className="py-3 pr-4 font-medium">
                <span className="sr-only">Feature</span>
              </th>
              {(Object.keys(COLUMN_NAMES) as Column[]).map((column) => (
                <th key={column} scope="col" className="w-[18%] py-3 pr-4 font-medium">
                  {COLUMN_NAMES[column]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label} className="border-b align-top">
                <th scope="row" className="py-3.5 pr-4 font-normal">
                  {row.label}
                  {row.hint && (
                    <span className="mt-0.5 block text-[13.5px] leading-5 text-muted-foreground">
                      {row.hint}
                    </span>
                  )}
                </th>
                <td className="py-3.5 pr-4">{row.values.free}</td>
                <td className="py-3.5 pr-4">{row.values.pro}</td>
                <td className="py-3.5 pr-4">{row.values.self}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-20 grid gap-x-12 gap-y-10 sm:grid-cols-2">
        <section>
          <h2 className="font-display text-[17px] font-semibold tracking-[-0.015em]">
            Reaching a limit
          </h2>
          <p className="mt-2 text-[15px] leading-[1.65] text-pretty text-muted-foreground">
            Limits apply to creating projects and variants, never to serving them. Everything you
            have keeps working, and every URL keeps answering.
          </p>
        </section>
        <section>
          <h2 className="font-display text-[17px] font-semibold tracking-[-0.015em]">
            Why self-hosted has limits too
          </h2>
          <p className="mt-2 text-[15px] leading-[1.65] text-pretty text-muted-foreground">
            They are guards, not a plan: what one Worker handles well in memory and time. They are
            constants in the{" "}
            <a href={GITHUB_URL} className={cn("text-foreground", link)}>
              source
            </a>
            , so you can change them on your own account.
          </p>
        </section>
      </div>
    </div>
  );
}
