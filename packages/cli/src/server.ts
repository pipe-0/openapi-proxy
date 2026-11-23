import { createHash } from "node:crypto";
import {
  CONTENT_TYPES,
  describeProblem,
  etagMatches,
  isLoopback,
  noSuchVersion,
  readRepresentation,
  versionFor,
} from "@openapi-proxy/core";
import { type Context, Hono } from "hono";
import { ConfigError, NoConfigError } from "./config.js";
import { describe, loadProject, render } from "./project.js";
import { SourceError } from "./sources.js";

export interface ServerOptions {
  /** The definition file to serve. */
  config: string;
  /** What `--source` said. */
  sources: string[];
  /** Hosts, besides this machine's own names, that requests may be addressed to. */
  allowedHosts: string[];
}

/** The host a request is addressed to, without its port. */
function hostOf(header: string | undefined): string {
  if (!header) return "";
  try {
    return new URL(`http://${header}`).hostname;
  } catch {
    return "";
  }
}

/**
 * The local server, as one function from a request to a response: the
 * variants of one definition file at the paths the service has.
 *
 *   GET /v/<project>/<variant>[.json|.yaml]
 *   GET /v/<project>/<variant>/<3.0|3.1>[.json|.yaml]
 *
 * Nothing is kept between requests. The file and the sources are read each
 * time, so what is served is what is on disk and running right now, and a
 * source that cannot be read is an error, never an older copy.
 */
export function createServer(options: ServerOptions): Hono {
  const app = new Hono();
  const allowed = (host: string) =>
    isLoopback(host) ||
    options.allowedHosts.some(
      (entry) => host === entry || (entry.startsWith(".") && host.endsWith(entry)),
    );

  // Only requests addressed to this machine, or to a host that was named. A
  // page on another site can make the browser send a request here, and with a
  // domain of its own that points at 127.0.0.1 it could read the answer; the
  // name it would have to use is not one of these.
  app.use("*", async (c, next) => {
    // A request that came over the network says in its Host header whom it is for.
    const host = hostOf(c.req.header("host")) || new URL(c.req.url).hostname;
    if (!allowed(host)) {
      return c.json(
        {
          code: "host-not-allowed",
          error: `This server does not answer to "${host}". Start it with --allowed-host ${host} if it should.`,
        },
        403,
      );
    }
    await next();
    c.header("x-content-type-options", "nosniff");
    // Documents may be read by a page on this machine or on a host that was named, and by no other site.
    const origin = c.req.header("origin");
    if (
      origin &&
      c.req.path.startsWith("/v/") &&
      allowed(hostOf(origin.replace(/^https?:\/\//, "")))
    ) {
      c.header("access-control-allow-origin", origin);
      c.header("vary", "Origin");
    }
  });

  const serve = async (c: Context, project: string, variant: string, version?: string) => {
    const asked = readRepresentation(variant, version, c.req.header("accept") ?? "");
    const loaded = await loadProject(options.config, options.sources);
    const { definition } = loaded.config;
    const path = `/v/${project}/${asked.slug}`;
    if (definition.project !== project || !Object.hasOwn(definition.variants, asked.slug)) {
      const known = Object.keys(definition.variants).map(
        (slug) => `/v/${definition.project}/${slug}`,
      );
      return c.json(
        {
          code: "not-found",
          error: `No variant is published at ${path}. ${known.length > 0 ? `This file has ${known.join(", ")}.` : "This file has no variants yet."}`,
        },
        404,
      );
    }

    const { specVersion } = describe(loaded);
    const target = versionFor(asked.askedVersion, specVersion);
    if (target === undefined) {
      return c.json(
        { code: "not-found", error: noSuchVersion(path, asked.askedVersion ?? "", specVersion) },
        404,
      );
    }

    const body = render(loaded, asked.slug, asked.format, target);
    const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
    const headers: Record<string, string> = { etag, "cache-control": "no-store" };
    if (asked.negotiated) headers.vary = "Accept";
    if (etagMatches(c.req.header("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    headers["content-type"] = CONTENT_TYPES[asked.format];
    return new Response(c.req.method === "HEAD" ? null : body, { headers });
  };

  app.on(["GET", "HEAD"], "/v/:project/:variant", (c) =>
    serve(c, c.req.param("project"), c.req.param("variant")),
  );
  app.on(["GET", "HEAD"], "/v/:project/:variant/:version", (c) =>
    serve(c, c.req.param("project"), c.req.param("variant"), c.req.param("version")),
  );

  app.notFound((c) => c.json({ code: "not-found", error: "Not found." }, 404));
  app.onError((error, c) => {
    c.header("cache-control", "no-store");
    if (error instanceof SourceError) {
      return c.json(
        { code: "source-unavailable", error: error.message, source: error.source },
        502,
      );
    }
    if (error instanceof ConfigError) {
      return c.json(
        {
          code: "invalid-definition",
          error: `${error.path} is not a valid definition: ${error.problems.map(describeProblem).join(" ")}`,
          problems: error.problems,
        },
        500,
      );
    }
    if (error instanceof NoConfigError) {
      return c.json({ code: "invalid-definition", error: error.message }, 500);
    }
    console.error(error);
    return c.json({ code: "internal", error: "Something went wrong." }, 500);
  });

  return app;
}
