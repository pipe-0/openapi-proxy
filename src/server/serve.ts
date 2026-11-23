import {
  CONTENT_TYPES,
  etagMatches,
  noSuchVersion,
  readRepresentation,
  type SpecFormat,
  versionFor,
} from "@openapi-proxy/core";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { keyPrincipal } from "./auth";
import { createDb, type Db } from "./db/client";
import { projects, variants } from "./db/schema";
import type { AppContext } from "./env";
import { bearerCredential, reads } from "./keys";
import { type RenderTarget, renderVariant, variantEtag } from "./render";

/**
 * For caches in between. A minute of reuse, since nothing here changes by
 * the second, and a strong ETag to revalidate with after that.
 */
const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
/** A private variant is for its reader alone, and is asked for again each time: a 304 is cheap. */
const PRIVATE_CACHE_CONTROL = "private, no-cache";
type SourceStatus = "fresh" | "stale-error";

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
 * A request reads what is stored and nothing else. It never makes the
 * service contact a source: keeping the copy current is the timer's work
 * (scheduled.ts), and a deploy's.
 *
 * So delivery does not fail. Once a project has its documents, its variants
 * are answered from the last good copy whatever a source does afterwards; a
 * failing source only shows in the X-Proxy-Source-Status header.
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

/** Key of a rendered document in the per-location edge cache. */
export function edgeCacheKey(variantId: string, format: SpecFormat, etag: string): Request {
  return new Request(
    `https://openapi-proxy.internal/${variantId}.${format}?etag=${encodeURIComponent(etag)}`,
  );
}

serveRoutes.on(["GET", "HEAD"], "/:project/:variant", (c) =>
  serveVariant(c, c.req.param("project"), c.req.param("variant")),
);
serveRoutes.on(["GET", "HEAD"], "/:project/:variant/:version", (c) =>
  serveVariant(c, c.req.param("project"), c.req.param("variant"), c.req.param("version")),
);

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
  const { slug, format, negotiated, askedVersion } = readRepresentation(
    variantParam,
    versionParam,
    c.req.header("accept") ?? "",
  );
  const db = createDb(c.env.DB);

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
        error: noSuchVersion(`/v/${projectSlug}/${slug}`, askedVersion ?? "", row.specVersion),
      },
      404,
    );
  }

  const status: SourceStatus = row.lastStatus === "error" ? "stale-error" : "fresh";

  const target: RenderTarget = {
    projectId: row.projectId,
    bodyHash: row.bodyHash,
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
    rendered = await renderVariant(db, target, format, etag, Date.now());
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
    // The documents changed between reading the project and reading them.
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
