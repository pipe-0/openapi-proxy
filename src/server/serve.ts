import type { SpecFormat } from "@openapi-proxy/core";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { claimRefresh, REFRESH_CLAIM_MS } from "./assemble";
import { checkProject } from "./check";
import { createDb, type Db } from "./db/client";
import { projects, variants } from "./db/schema";
import type { AppContext } from "./env";
import { type RenderTarget, renderVariant, variantEtag } from "./render";

/**
 * Timing of the freshness contract. An object, so tests can shorten the waits.
 */
export const timing = {
  /** How long a request waits for a check of the source before answering from the copy it has. */
  checkWaitMs: 5_000,
  /**
   * A requester may ask for less staleness than the project's interval
   * (`Cache-Control: no-cache` or `max-age`), but nobody can make the proxy
   * ask the source more often than this.
   */
  requestFloorMs: 10_000,
};
const CONTENT_TYPES: Record<SpecFormat, string> = {
  json: "application/json; charset=utf-8",
  yaml: "application/yaml; charset=utf-8",
};

type SourceStatus = "fresh" | "stale" | "stale-error";

/**
 * Public variant serving: GET /v/:project/:variant[.json|.yaml]
 *
 * Two promises, in this order.
 *
 * Delivery does not fail. Once a project has been fetched, its variants are
 * answered from the last good copy whatever the source does afterwards; a
 * failing or slow source only shows in the X-Proxy-Source-Status header.
 *
 * What is delivered is current. A copy older than the project's interval is
 * not handed out on trust: the request that notices checks the source first
 * and answers with the result. That matters because the typical reader of an
 * OpenAPI document is a build that runs a few times a day, and "serve the old
 * copy, refresh afterwards" would give every one of those the document as of
 * the previous build. Exactly one request does the checking; the others wait
 * for it, unless the copy only just crossed its interval, in which case it is
 * still as good as it was a moment ago and they get it at once.
 */
export const serveRoutes = new Hono<AppContext>();

serveRoutes.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "OPTIONS"],
    exposeHeaders: ["ETag", "X-Proxy-Source-Status"],
    maxAge: 86_400,
  }),
);

function parseVariantParam(
  raw: string,
  accept: string,
): { slug: string; format: SpecFormat; negotiated: boolean } {
  if (raw.endsWith(".json")) return { slug: raw.slice(0, -5), format: "json", negotiated: false };
  if (raw.endsWith(".yaml")) return { slug: raw.slice(0, -5), format: "yaml", negotiated: false };
  if (raw.endsWith(".yml")) return { slug: raw.slice(0, -4), format: "yaml", negotiated: false };
  const wantsYaml = /application\/(x-)?yaml|text\/(x-)?yaml/i.test(accept);
  return { slug: raw, format: wantsYaml ? "yaml" : "json", negotiated: true };
}

/** Key of a rendered document in the per-location edge cache. */
export function edgeCacheKey(variantId: string, format: SpecFormat, etag: string): Request {
  return new Request(
    `https://openapi-proxy.internal/${variantId}.${format}?etag=${encodeURIComponent(etag)}`,
  );
}

/** If-None-Match uses weak comparison: `W/"x"` and `"x"` match. CDNs weaken ETags when they compress. */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === "*" || candidate === etag);
}

interface SourceState {
  bodyHash: string;
  lastStatus: "ok" | "error";
}

async function refreshById(
  c: Context<AppContext>,
  db: Db,
  id: string,
  now: number,
): Promise<SourceState | undefined> {
  try {
    const project = await db.select().from(projects).where(eq(projects.id, id)).get();
    if (!project) return undefined;
    const result = await checkProject(db, c.env, project, now, {
      origin: new URL(c.req.url).origin,
      defer: (work) => c.executionCtx.waitUntil(work),
    });
    return result.project;
  } catch (error) {
    console.error("refresh failed", error);
    return undefined;
  }
}

/** The promise's value, or undefined if it takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/**
 * Wait for the check another request is running, by watching the project row
 * until it settles. Polling is what works here: the other request usually
 * runs in a different isolate, so there is no promise to share.
 */
async function otherCheck(
  db: Db,
  projectId: string,
  seenFetchedAt: number,
  deadline: number,
): Promise<SourceState | undefined> {
  for (let delay = 50; Date.now() + delay < deadline; delay = Math.min(delay * 2, 400)) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const current = await db
      .select({
        bodyHash: projects.bodyHash,
        lastStatus: projects.lastStatus,
        fetchedAt: projects.fetchedAt,
        refreshClaimedAt: projects.refreshClaimedAt,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!current) return undefined;
    const settled =
      current.fetchedAt !== seenFetchedAt ||
      current.lastStatus === "error" ||
      current.refreshClaimedAt === null;
    if (settled) return current;
  }
  return undefined;
}

/** The oldest copy the requester accepts, from its own Cache-Control, in seconds. */
function requestedMaxAge(
  header: string | undefined,
  pragma: string | undefined,
): number | undefined {
  if (/(^|,)\s*no-cache\s*(,|$)/i.test(header ?? "") || /no-cache/i.test(pragma ?? "")) return 0;
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(header ?? "");
  return match ? Number(match[1]) : undefined;
}

function cacheControl(ttlSeconds: number): string {
  // An interval of 0 means "always ask": caches may keep the document, but
  // have to revalidate it (cheaply, with the ETag) before every use.
  if (ttlSeconds <= 0) return "public, no-cache";
  return `public, max-age=${Math.min(60, ttlSeconds)}, stale-while-revalidate=${Math.min(300, ttlSeconds)}`;
}

serveRoutes.on(["GET", "HEAD"], "/:project/:variant", (c) =>
  serveVariant(c, c.req.param("project"), c.req.param("variant")),
);

/**
 * Answer a request for one variant. Separate from the route so that another
 * address can lead here too: a project on a domain of its own resolves the
 * hostname to a project and calls this (see "Custom domains" in ARCHITECTURE.md).
 */
export async function serveVariant(
  c: Context<AppContext>,
  projectSlug: string,
  variantParam: string,
): Promise<Response> {
  const { slug, format, negotiated } = parseVariantParam(
    variantParam,
    c.req.header("accept") ?? "",
  );
  const db = createDb(c.env.DB);
  const now = Date.now();

  // Only the columns this path needs: the operation index can be large and is
  // irrelevant here.
  const row = await db
    .select({
      variantId: variants.id,
      selection: variants.selection,
      outputVersion: variants.outputVersion,
      selectionVersion: variants.selectionVersion,
      projectId: projects.id,
      bodyHash: projects.bodyHash,
      fetchedAt: projects.fetchedAt,
      ttlSeconds: projects.ttlSeconds,
      lastStatus: projects.lastStatus,
    })
    .from(variants)
    .innerJoin(projects, eq(variants.projectId, projects.id))
    .where(and(eq(projects.slug, projectSlug), eq(variants.slug, slug)))
    .get();

  if (!row) {
    return c.json(
      { code: "not-found", error: `No variant is published at /v/${projectSlug}/${slug}.` },
      404,
    );
  }

  let { bodyHash } = row;
  let status: SourceStatus = row.lastStatus === "error" ? "stale-error" : "fresh";

  const interval = row.ttlSeconds * 1000;
  const asked = requestedMaxAge(c.req.header("cache-control"), c.req.header("pragma"));
  const limit =
    asked === undefined
      ? interval
      : Math.min(interval, Math.max(asked * 1000, timing.requestFloorMs));
  const age = now - row.fetchedAt;

  if (age >= limit) {
    const adopt = (state: SourceState | undefined) => {
      if (!state) {
        status = "stale";
        return;
      }
      bodyHash = state.bodyHash;
      status = state.lastStatus === "error" ? "stale-error" : "fresh";
    };

    if (row.lastStatus === "error") {
      // The source is failing. Nobody waits on it again; one request per
      // backoff period retries in the background until it is back.
      if (await claimRefresh(db, row.projectId, now)) {
        c.executionCtx.waitUntil(refreshById(c, db, row.projectId, now));
      }
    } else if (await claimRefresh(db, row.projectId, now)) {
      // This request checks. If the source is slow, the check carries on in
      // the background and the answer comes from the copy.
      const check = refreshById(c, db, row.projectId, now);
      c.executionCtx.waitUntil(check);
      adopt(await within(check, timing.checkWaitMs));
    } else if (asked === undefined && interval > 0 && age < interval + REFRESH_CLAIM_MS) {
      // Someone else is checking, and the copy only just crossed its interval.
      status = "stale";
    } else {
      adopt(await otherCheck(db, row.projectId, row.fetchedAt, now + timing.checkWaitMs));
    }
  }

  const target: RenderTarget = {
    projectId: row.projectId,
    bodyHash,
    variantId: row.variantId,
    selection: row.selection,
    outputVersion: row.outputVersion,
    selectionVersion: row.selectionVersion,
  };
  let etag = await variantEtag(target, format);
  const headers: Record<string, string> = {
    etag,
    "cache-control": cacheControl(row.ttlSeconds),
    "x-proxy-source-status": status,
    "x-content-type-options": "nosniff",
    ...(negotiated ? { vary: "Accept" } : {}),
  };

  if (etagMatches(c.req.header("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers["content-type"] = CONTENT_TYPES[format];
  if (c.req.method === "HEAD") return new Response(null, { headers });

  // First the per-location edge cache (Cloudflare only guarantees it on custom
  // domains, so nothing depends on it), then the stored output in D1, then an
  // actual render.
  const cache = caches.default;
  let cacheKey = edgeCacheKey(row.variantId, format, etag);
  const cached = await cache.match(cacheKey);
  if (cached) return new Response(cached.body, { headers });

  let rendered: Awaited<ReturnType<typeof renderVariant>>;
  try {
    rendered = await renderVariant(db, target, format, etag, now);
  } catch (error) {
    // Unreachable in practice (documents are validated when fetched), but a
    // consumer must never be handed a raw exception.
    console.error("render failed", error);
    return c.json(
      { code: "transform-failed", error: "The source document could not be transformed." },
      500,
    );
  }
  if (!rendered) {
    return c.json({ code: "source-unavailable", error: "The stored source is missing." }, 502);
  }

  const { body, store } = rendered;
  if (rendered.etag !== etag) {
    // The source changed between reading the project and reading its document.
    // The validator has to describe the bytes that are actually sent.
    etag = rendered.etag;
    headers.etag = etag;
    cacheKey = edgeCacheKey(row.variantId, format, etag);
  }
  c.executionCtx.waitUntil(
    Promise.all([
      store?.(),
      cache.put(
        cacheKey,
        new Response(body, {
          headers: {
            "content-type": CONTENT_TYPES[format],
            "cache-control": "public, max-age=3600",
          },
        }),
      ),
    ]).catch((error) => console.error("caching rendered output failed", error)),
  );

  return new Response(body, { headers });
}
