import { GUARDS, PLAN_LIMITS, PLAN_NAMES, PLAN_PRICES, type PlanLimits } from "../../shared/plans";
import { Problem } from "./problem";
import { GITHUB_URL } from "./site";
import { UrlForm } from "./url-form";

function planLines(limits: PlanLimits): string[] {
  return [
    `${limits.projects} projects`,
    // Without a workspace limit, the guard every workspace has is what counts.
    Number.isFinite(limits.variants)
      ? `${limits.variants} variants`
      : `${GUARDS.variantsPerProject} variants per project`,
    `${GUARDS.projectBytes / 1_000_000} MB per project`,
  ];
}

/**
 * What people use it for, each pointing to the post that explains the problem
 * at length. The first six are the use cases, the last three how it fits in.
 */
const POINTS: Array<{ title: string; body: string; href?: string }> = [
  {
    title: "Public docs without internal endpoints",
    body: "Check the tags and operations that are public. The variant serves those and exactly the schemas they reference, so no internal model is left behind in components.",
    href: "/blog/public-openapi-document-without-internal-endpoints",
  },
  {
    title: "A document for each SDK and partner",
    body: "Every selection gets its own URL, as JSON and YAML. Your docs read one, your SDK generator another, a partner a third. Changing who sees what takes a click, not a deploy.",
    href: "/blog/one-openapi-document-per-audience",
  },
  {
    title: "Several services, one document",
    body: "Merge the documents of up to ten services into one. Two schemas that share a name but not a meaning are told apart, and you are shown what the merge did.",
    href: "/blog/merge-multiple-openapi-documents",
  },
  {
    title: "OpenAPI 3.0 for the tools that need it",
    body: "Serve a variant as 3.0 or 3.1, whatever your framework generates. Where 3.0 cannot say something, you are told exactly what was left out.",
    href: "/blog/convert-openapi-3-1-to-3-0",
  },
  {
    title: "Hear when your API changes",
    body: "Each check compares operations, not text. You get an email that says what was added, changed or removed, and which variants it touches.",
    href: "/blog/know-when-your-openapi-document-changes",
  },
  {
    title: "Current when it is read",
    body: "A copy older than the check interval is never handed out on trust, and a failing API never turns into an error for your readers. No pipeline step, nothing to regenerate.",
    href: "/docs/keeping-in-sync",
  },
  {
    title: "For scripts and agents too",
    body: "Everything the app does is an HTTP API, and an MCP endpoint offers the same as tools. Ask an agent for a variant with only the billing endpoints and get the URL back.",
    href: "/docs/api-and-mcp",
  },
  {
    title: "Private sources stay private",
    body: "A document behind authentication is fetched with headers you provide, stored encrypted and only ever sent to that document's own origin.",
  },
  {
    title: "A workspace for the team",
    body: "Invite your colleagues. Everyone works on the same projects and variants, so the public docs do not depend on one person being around.",
  },
];

const readLabel = (href: string) => (href.startsWith("/blog/") ? "Read the post" : "Read the docs");

/** A small OpenAPI document, drawn as code: which schemas come along with one kept path. */
function Exhibit({
  caption,
  schemas,
  note,
}: {
  caption: string;
  schemas: Array<{ name: string; internal?: boolean }>;
  note: string;
}) {
  return (
    <figure className="min-w-0">
      <figcaption className="text-[14px] font-medium">{caption}</figcaption>
      <pre className="scroll-quiet mt-3 overflow-x-auto rounded-xl bg-subtle p-5 font-mono text-[12.5px] leading-6 text-muted-foreground ring-1 ring-border ring-inset">
        <code>
          {'{\n  "paths": {\n    '}
          <span className="text-foreground">"/v1/books"</span>
          {': { … }\n  },\n  "components": {\n    "schemas": {\n'}
          {schemas.map((schema, index) => (
            <span key={schema.name}>
              {"      "}
              <span className={schema.internal ? "text-bad-foreground" : "text-foreground"}>
                "{schema.name}"
              </span>
              {": { … }"}
              {index < schemas.length - 1 ? "," : ""}
              {"\n"}
            </span>
          ))}
          {"    }\n  }\n}"}
        </code>
      </pre>
      <p className="mt-3 text-[14px] leading-6 text-muted-foreground">{note}</p>
    </figure>
  );
}

export function Landing() {
  return (
    <>
      <section className="mx-auto max-w-5xl px-6 pt-16 pb-14 text-center sm:pt-24 sm:pb-16">
        <h1 className="font-display text-[38px] leading-[1.06] font-semibold tracking-[-0.035em] text-balance sm:text-[46px] lg:text-[54px]">
          The OpenAPI toolchain <br className="hidden sm:block" />
          that lives on the edge.
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-[17px] leading-7 text-pretty text-muted-foreground">
          Filter, merge and convert the OpenAPI documents your backends generate, and serve each
          result at a URL that stays current with your APIs. Your docs, your SDKs and your partners
          each get the part they need, without a line of code in your backends.
        </p>
        <UrlForm id="hero-url" className="mx-auto mt-9 max-w-xl" />
        <p className="mt-4 text-[13.5px] text-muted-foreground">
          Open source. Free to start here, or deploy it to your own Cloudflare account.{" "}
          <a
            href={GITHUB_URL}
            className="text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            View on GitHub
          </a>
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6" aria-label="The variant editor">
        <div className="overflow-hidden rounded-xl bg-card shadow-float ring-1 ring-border">
          <img
            src="/site/editor-light.png"
            alt="The variant editor. Every operation of the document on the left with a checkbox, the document being served on the right, the variant's URL above both."
            width={1440}
            height={900}
            loading="lazy"
            decoding="async"
            className="block h-auto w-full dark:hidden"
          />
          <img
            src="/site/editor-dark.png"
            alt=""
            width={1440}
            height={900}
            loading="lazy"
            decoding="async"
            className="hidden h-auto w-full dark:block"
          />
        </div>
      </section>

      <Problem />

      <section className="mx-auto mt-28 max-w-5xl px-6 sm:mt-36">
        <h2 className="sr-only">What people use it for</h2>
        <div className="grid gap-x-12 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {POINTS.map((point) => (
            <div key={point.title}>
              <h3 className="font-display text-[19px] leading-7 font-semibold tracking-[-0.015em]">
                {point.title}
              </h3>
              <p className="mt-2 text-[15px] leading-[1.65] text-pretty text-muted-foreground">
                {point.body}
              </p>
              {point.href && (
                <a
                  href={point.href}
                  aria-label={`${readLabel(point.href)}: ${point.title}`}
                  className="mt-2 inline-block text-[14px] underline decoration-border underline-offset-4 hover:decoration-foreground"
                >
                  {readLabel(point.href)}
                </a>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto mt-28 max-w-5xl px-6 sm:mt-36">
        <h2 className="max-w-2xl font-display text-[30px] leading-[1.15] font-semibold tracking-[-0.03em] text-balance sm:text-[36px]">
          A filter written by hand keeps more than it shows.
        </h2>
        <p className="mt-4 max-w-2xl text-[16px] leading-7 text-pretty text-muted-foreground">
          The usual shortcut is a loop in the backend that drops paths by tag. It rarely touches the
          schemas, so the public document still describes every internal request and response, for
          anyone who scrolls down.
        </p>
        <div className="mt-10 grid gap-8 md:grid-cols-2">
          <Exhibit
            caption="Paths trimmed by hand"
            schemas={[
              { name: "Book" },
              { name: "AdminAuditEntry", internal: true },
              { name: "InternalBillingRun", internal: true },
              { name: "StaffImpersonation", internal: true },
            ]}
            note="One public path is left. The schemas of the internal ones are all still there."
          />
          <Exhibit
            caption="The same selection as a variant"
            schemas={[{ name: "Book" }]}
            note="What the kept operations reference comes along. Everything else is gone, including tags and security schemes nobody uses anymore."
          />
        </div>
      </section>

      <section className="mx-auto mt-28 max-w-5xl px-6 sm:mt-36">
        <h2 className="font-display text-[30px] leading-[1.15] font-semibold tracking-[-0.03em] sm:text-[36px]">
          Free to start.
        </h2>
        <p className="mt-3 text-[15px] text-muted-foreground">
          Every feature is in both plans.{" "}
          <a
            href="/pricing"
            className="text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            Compare plans
          </a>
        </p>
        <div className="mt-10 grid gap-x-16 gap-y-10 md:grid-cols-3">
          <div>
            <h3 className="font-display text-[19px] leading-7 font-semibold tracking-[-0.015em]">
              {PLAN_NAMES.free}
              <span className="ml-2 font-normal text-muted-foreground">
                {PLAN_PRICES.free.amount}
              </span>
            </h3>
            <p className="mt-2 text-[15px] leading-[1.65] text-muted-foreground">
              Enough for most teams: a few APIs, each with its audiences.
            </p>
            <ul className="mt-4 flex flex-col gap-1.5 text-[15px] leading-6">
              {planLines(PLAN_LIMITS.free).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-display text-[19px] leading-7 font-semibold tracking-[-0.015em]">
              {PLAN_NAMES.pro}
              <span className="ml-2 font-normal text-muted-foreground">
                {PLAN_PRICES.pro.amount} {PLAN_PRICES.pro.per}
              </span>
            </h3>
            <p className="mt-2 text-[15px] leading-[1.65] text-muted-foreground">
              For companies with many APIs, or many audiences for them.
            </p>
            <ul className="mt-4 flex flex-col gap-1.5 text-[15px] leading-6">
              {planLines(PLAN_LIMITS.pro).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-display text-[19px] leading-7 font-semibold tracking-[-0.015em]">
              On your own account
            </h3>
            <p className="mt-2 text-[15px] leading-[1.65] text-muted-foreground">
              openapi-proxy is open source and runs on Cloudflare Workers. Deploy it to your own
              account and there is no plan to buy.
            </p>
            <p className="mt-4 text-[15px] leading-6">
              <a
                href={GITHUB_URL}
                className="underline decoration-border underline-offset-4 hover:decoration-foreground"
              >
                Read the source
              </a>
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto mt-28 max-w-3xl px-6 text-center sm:mt-36">
        <h2 className="font-display text-[30px] leading-[1.15] font-semibold tracking-[-0.03em] sm:text-[36px]">
          Start with the document you already have.
        </h2>
        <UrlForm id="closing-url" className="mx-auto mt-8 max-w-xl" />
      </section>
    </>
  );
}
