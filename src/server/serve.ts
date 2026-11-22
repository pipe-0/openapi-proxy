import { type SpecFormat, TARGET_VERSIONS, type TargetVersion } from "@openapi-proxy/core";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { CHECK_CLAIM_MS, claimCheck } from "./assemble";
import { keyPrincipal } from "./auth";
import { checkProject } from "./check";
import { createDb, type Db } from "./db/client";
import { projects, variants } from "./db/schema";
import type { AppContext } from "./env";
import { bearerCredential, reads } from "./keys";
import { type RenderTarget, renderVariant, variantEtag } from "./render";
import { checkEveryMs, RETRY_AFTER_MS } from "./schedule";

/**
 * Timing of the freshness contract. An object, so tests can shorten the waits.
 */
export const timing = {
  /** How long a request waits for a check of the source before answering from the copy it has. */
  checkWaitMs: 5_000,
};
/**
 * For caches in between. A minute of reuse, since nothing here changes by
 * the second, and a strong ETag to revalidate with after that.
 */
const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
/** A private variant is for its reader alone, and is asked for again each time: a 304 is cheap. */
const PRIVATE_CACHE_CONTROL = "private, no-cache";
const CONTENT_TYPES: Record<SpecFormat, string> = {
  json: "application/json; charset=utf-8",
  yaml: "application/yaml; charset=utf-8",
};

type SourceStatus = "fresh" | "stale" | "stale-error";

/**
 * Variant serving:
 *
 *   GET /v/:project/:variant[.json|.yaml]             in the OpenAPI version its document has
 *   GET /v/:project/:variant/:version[.json|.yaml]    in 3.0 or 3.1, converted
 *
 * A variant has one selection and several representations, and the URL says
 * which one: the format by its extension (or the Accept header), the OpenAPI
 * version by a path segment. Each is rendered when it is first asked for and
 * stored. A private variant is all of this behind an API key.
 *
 * Two promises, in this order.
 *
 * Delivery does not fail. Once a project has been fetched, its variants are
 * answered from the last good copy whatever the source does afterwards; a
 * failing or slow source only shows in the X-Proxy-Source-Status header.
 *
 * What is delivered is current. A copy older than the project's check
 * interval (which the service decides, see schedule.ts) is not handed out on
 * trust: the request that notices checks the source first and answers with
 * the result. That matters because the typical reader of an
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
        checkClaimedAt: projects.checkClaimedAt,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!current) return undefined;
    const settled =
      current.fetchedAt !== seenFetchedAt ||
      current.lastStatus === "error" ||
      current.checkClaimedAt === null;
    if (settled) return current;
  }
  return undefined;
}

serveRoutes.on(["GET", "HEAD"], "/:project/:variant", (c) =>
  serveVariant(c, c.req.param("project"), c.req.param("variant")),
);
serveRoutes.on(["GET", "HEAD"], "/:project/:variant/:version", (c) =>
  serveVariant(c, c.req.param("project"), c.req.param("variant"), c.req.param("version")),
);

/**
 * The OpenAPI version a request gets, or undefined when the URL names one
 * there is none of. Null is the document's own, unconverted, which is what a
 * URL without a version in it serves. Conversion exists between 3.0 and 3.1.
 */
function versionFor(
  asked: string | undefined,
  specVersion: string,
): TargetVersion | null | undefined {
  if (asked === undefined || asked === specVersion) return null;
  const version = TARGET_VERSIONS.find((candidate) => candidate === asked);
  return version && TARGET_VERSIONS.some((candidate) => candidate === specVersion)
    ? version
    : undefined;
}

/**
 * A private variant is read with an API key of its workspace: one with full
 * access, or one that only reads (this variant, or all of them). The answer
 * to anyone else, or nothing when the reader may read.
 */
async function refused(
  c: Context<AppContext>,
  db: Db,
  variant: { id: string; organizationId: string },
): Promise<Response | undefined> {
  c.header("cache-control", "no-store");
  const credential = bearerCredential(c.req.header("authorization"));
  const principal = credential === undefined ? undefined : await keyPrincipal(c, db, credential);
  if (!principal) {
    c.header("www-authenticate", "Bearer");
    return c.json(
      {
        code: "unauthorized",
        error:
          credential === undefined
            ? "This variant is private. Send an API key of its workspace: Authorization: Bearer <key>."
            : "This API key is not valid.",
      },
      401,
    );
  }
  if (!reads(principal, variant)) {
    return c.json({ code: "forbidden", error: "This API key does not read this variant." }, 403);
  }
  return undefined;
}

/**
 * Answer a request for one variant. Separate from the route so that another
 * address can lead here too: a project on a domain of its own resolves the
 * hostname to a project and calls this (see "Custom domains" in ARCHITECTURE.md).
 */
export async function serveVariant(
  c: Context<AppContext>,
  projectSlug: string,
  variantParam: string,
  versionParam?: string,
): Promise<Response> {
  // The extension is on the last segment, whichever that is.
  const last = parseVariantParam(versionParam ?? variantParam, c.req.header("accept") ?? "");
  const { format, negotiated } = last;
  const slug = versionParam === undefined ? last.slug : variantParam;
  const askedVersion = versionParam === undefined ? undefined : last.slug;
  const db = createDb(c.env.DB);
  const now = Date.now();

  // Only the columns this path needs: the operation index can be large and is
  // irrelevant here.
  const row = await db
    .select({
      variantId: variants.id,
      selection: variants.selection,
      overrides: variants.overrides,
      revision: variants.revision,
      visibility: variants.visibility,
      projectId: projects.id,
      organizationId: projects.organizationId,
      specVersion: projects.specVersion,
      bodyHash: projects.bodyHash,
      fetchedAt: projects.fetchedAt,
      checkEveryMs,
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

  // Before anything else is said or done about it: who is asking.
  const isPrivate = row.visibility === "private";
  if (isPrivate) {
    const refusal = await refused(c, db, {
      id: row.variantId,
      organizationId: row.organizationId,
    });
    if (refusal) return refusal;
    c.header("cache-control", PRIVATE_CACHE_CONTROL);
  }

  const version = versionFor(askedVersion, row.specVersion);
  if (version === undefined) {
    return c.json(
      {
        code: "not-found",
        error: `/v/${projectSlug}/${slug} is not served as "${askedVersion}". Its document is OpenAPI ${row.specVersion}; a 3.0 or 3.1 document is also served as the other, at /3.0 and /3.1.`,
      },
      404,
    );
  }

  let { bodyHash } = row;
  let status: SourceStatus = row.lastStatus === "error" ? "stale-error" : "fresh";

  const age = now - row.fetchedAt;

  if (age >= row.checkEveryMs) {
    const adopt = (state: SourceState | undefined) => {
      if (!state) {
        status = "stale";
        return;
      }
      bodyHash = state.bodyHash;
      status = state.lastStatus === "error" ? "stale-error" : "fresh";
    };

    if (row.lastStatus === "error") {
      // The source is failing. Nobody waits on it again; every few minutes
      // one request retries in the background until it is back.
      if (await claimCheck(db, row.projectId, now, RETRY_AFTER_MS)) {
        c.executionCtx.waitUntil(refreshById(c, db, row.projectId, now));
      }
    } else if (await claimCheck(db, row.projectId, now)) {
      // This request checks. If the source is slow, the check carries on in
      // the background and the answer comes from the copy.
      const check = refreshById(c, db, row.projectId, now);
      c.executionCtx.waitUntil(check);
      adopt(await within(check, timing.checkWaitMs));
    } else if (age < row.checkEveryMs + CHECK_CLAIM_MS) {
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
    version,
    overrides: row.overrides,
    revision: row.revision,
  };
  let etag = await variantEtag(target, format);
  const headers: Record<string, string> = {
    etag,
    "cache-control": isPrivate ? PRIVATE_CACHE_CONTROL : CACHE_CONTROL,
    "x-proxy-source-status": status,
    "x-content-type-options": "nosniff",
  };
  const varies = [...(isPrivate ? ["Authorization"] : []), ...(negotiated ? ["Accept"] : [])];
  if (varies.length > 0) headers.vary = varies.join(", ");

  if (etagMatches(c.req.header("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers["content-type"] = CONTENT_TYPES[format];
  // HEAD is GET without the body, all the way: it says 200 only for a
  // document that can be had.
  const answer = (body: BodyInit | null) =>
    new Response(c.req.method === "HEAD" ? null : body, { headers });

  // First the per-location edge cache (Cloudflare only guarantees it on custom
  // domains, so nothing depends on it), then the stored output in D1, then an
  // actual render.
  const cache = caches.default;
  let cacheKey = edgeCacheKey(row.variantId, format, etag);
  const cached = await cache.match(cacheKey);
  if (cached) return answer(cached.body);

  let rendered: Awaited<ReturnType<typeof renderVariant>>;
  try {
    rendered = await renderVariant(db, target, format, etag, now);
  } catch (error) {
    // The database, not the document: a document that cannot be rendered is
    // answered for below. A consumer is never handed a raw exception.
    console.error("render failed", error);
    return c.json(
      { code: "transform-failed", error: "The source document could not be transformed." },
      500,
    );
  }
  if (!rendered) {
    return c.json({ code: "source-unavailable", error: "The stored source is missing." }, 502);
  }
  if ("failure" in rendered) {
    c.executionCtx.waitUntil(
      (rendered.store?.() ?? Promise.resolve()).catch((error) =>
        console.error("remembering a failed render failed", error),
      ),
    );
    return c.json({ code: "transform-failed", error: rendered.failure }, 500);
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

  return answer(body);
}
