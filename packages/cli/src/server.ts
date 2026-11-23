import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import {
  CONTENT_TYPES,
  describeProblem,
  documentText,
  etagMatches,
  isLoopback,
  noSuchVersion,
  readDefinition,
  readRepresentation,
  versionFor,
  warningsOf,
} from "@openapi-proxy/core";
import { type Context, Hono } from "hono";
import { ConfigError, loadConfig, NoConfigError, parseConfig } from "./config.js";
import { describe, loadProject, render } from "./project.js";
import { patchDefinition } from "./save.js";
import { SourceError } from "./sources.js";
import { resultOf, revisionOf, viewOf } from "./view.js";

export interface ServerOptions {
  /** The definition file to serve. */
  config: string;
  /** What `--source` said. */
  sources: string[];
  /** Hosts, besides this machine's own names, that requests may be addressed to. */
  allowedHosts: string[];
  /**
   * The folder the editor's page was built into. Given, the server also
   * answers what the page asks (the project, its document, a save into the
   * file). Left out, it serves variants and nothing else.
   */
  editor?: string | undefined;
}

/** The types of the files the editor's page is made of. */
const PAGE_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

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
 * and, with the editor, the page at `/` and the three calls it makes, which
 * are the ones the service answers for a project of its own
 * (packages/core/src/definition/api.ts):
 *
 *   GET /api/projects/<slug>             the file as a project
 *   GET /api/projects/<slug>/document    its documents assembled into one
 *   PUT /api/projects/<slug>             write a changed definition into the file
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
    // A save comes from the page this server served, and from nowhere else.
    // A browser says where a request that changes something comes from, so a
    // page on another site cannot write the file even where it can reach it.
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      const here = c.req.header("host") ?? new URL(c.req.url).host;
      const sameSite = origin !== undefined && origin.replace(/^https?:\/\//, "") === here;
      const json = (c.req.header("content-type") ?? "").startsWith("application/json");
      if (!sameSite || !json) {
        return c.json(
          {
            code: "forbidden",
            error: "Only the page this server serves changes the file.",
          },
          403,
        );
      }
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

  if (options.editor !== undefined) editorRoutes(app, options, options.editor);

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

/** The address the server is reached at, as the request says it. */
const originOf = (c: Context): string => {
  const url = new URL(c.req.url);
  return `${url.protocol}//${c.req.header("host") ?? url.host}`;
};

/** What the editor's page asks of the server, and the page itself. */
function editorRoutes(app: Hono, options: ServerOptions, pageDir: string): void {
  const noProject = (c: Context, slug: string, actual: string) =>
    c.json(
      {
        code: "not-found",
        error: `This server serves the project "${actual}", not "${slug}".`,
      },
      404,
    );

  app.get("/api/projects", async (c) => {
    c.header("cache-control", "no-store");
    return c.json([viewOf(await loadProject(options.config, options.sources), originOf(c))]);
  });

  app.get("/api/projects/:slug", async (c) => {
    c.header("cache-control", "no-store");
    const project = await loadProject(options.config, options.sources);
    const { project: slug } = project.config.definition;
    if (slug !== c.req.param("slug")) return noProject(c, c.req.param("slug"), slug);
    return c.json(viewOf(project, originOf(c)));
  });

  app.get("/api/projects/:slug/document", async (c) => {
    const project = await loadProject(options.config, options.sources);
    const { project: slug } = project.config.definition;
    if (slug !== c.req.param("slug")) return noProject(c, c.req.param("slug"), slug);
    const body = documentText(project.sources);
    return new Response(body, {
      headers: {
        "content-type": body.trimStart().startsWith("{") ? CONTENT_TYPES.json : CONTENT_TYPES.yaml,
        "cache-control": "no-store",
      },
    });
  });

  // A save. The file is changed where the definition changed and nowhere
  // else: its comments and its layout are its author's (save.ts).
  app.put("/api/projects/:slug", async (c) => {
    c.header("cache-control", "no-store");
    const payload = (await c.req.json().catch(() => ({}))) as {
      definition?: unknown;
      ifRevision?: unknown;
    };
    const config = loadConfig(options.config);
    const slug = c.req.param("slug");
    if (config.definition.project !== slug) return noProject(c, slug, config.definition.project);

    const read = readDefinition(payload.definition);
    if ("problems" in read) {
      return c.json(
        {
          code: "invalid-definition",
          error: read.problems.map(describeProblem).join(" "),
          problems: read.problems,
        },
        400,
      );
    }
    if (read.definition.project !== slug) {
      return c.json(
        {
          code: "bad-request",
          error:
            "The project slug is what the file is deployed as. It is changed in the file itself.",
        },
        400,
      );
    }
    // The file is someone's to edit while this page is open. A save that started from an older one is not made.
    const changedMeanwhile = () =>
      c.json(
        {
          code: "conflict",
          error: `${options.config} was changed in the meantime, so this was not saved.`,
        },
        409,
      );
    if (payload.ifRevision !== undefined && payload.ifRevision !== revisionOf(config.text)) {
      return changedMeanwhile();
    }

    const text = patchDefinition(config.text, config.definition, read.definition);
    // What is written has to read back as what was asked for. Anything else is a fault here, and the file is left alone.
    const written = parseConfig(text);
    const readBack = "problems" in written ? undefined : readDefinition(written.doc.toJS());
    if (
      !readBack ||
      "problems" in readBack ||
      JSON.stringify(readBack.definition) !== JSON.stringify(read.definition)
    ) {
      console.error("The save would not have written what was asked for.");
      return c.json({ code: "internal", error: "The file could not be written as asked." }, 500);
    }
    // The documents are read before anything is written: a source that is
    // down is said now, and not as the failure of a save that went through.
    const loaded = await loadProject(options.config, options.sources);
    const dryRun = c.req.query("dryRun") === "true";
    if (!dryRun && text !== config.text) {
      // Reading the documents took a moment. The file is looked at once more
      // right before it is replaced, with nothing to wait for in between.
      if (readFileSync(config.path, "utf8") !== config.text) return changedMeanwhile();
      // Whole or not at all: a file that is half written is worse than one
      // that is not. A file that is a link stays one, with the rights it had.
      const target = realpathSync(config.path);
      const draft = `${target}.${process.pid}.tmp`;
      writeFileSync(draft, text, { mode: statSync(target).mode });
      renameSync(draft, target);
    }
    // What it came to. Sources are read again only if the save changed which they are.
    const saved = { ...config, text, definition: read.definition };
    const project =
      dryRun ||
      JSON.stringify(config.definition.sources) === JSON.stringify(read.definition.sources)
        ? { ...loaded, config: saved }
        : await loadProject(options.config, options.sources);
    const result = resultOf(config.definition, viewOf(project, originOf(c)), dryRun);
    return c.json({ ...result, warnings: warningsOf(read.definition) });
  });

  // The page: one document and the files it loads, as they were built.
  const root = normalize(pageDir);
  const file = (c: Context, name: string) => {
    const path = normalize(join(root, name));
    if (!path.startsWith(root + sep) || !existsSync(path)) {
      return c.json({ code: "not-found", error: "Not found." }, 404);
    }
    return new Response(c.req.method === "HEAD" ? null : readFileSync(path), {
      headers: {
        "content-type": PAGE_TYPES[extname(path)] ?? "application/octet-stream",
        // The page is small and changes with the tool: asked for again each time.
        "cache-control": name === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
        // It talks to this server and to nothing else.
        ...(name === "index.html"
          ? {
              "content-security-policy":
                "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
            }
          : {}),
      },
    });
  };
  app.on(["GET", "HEAD"], "/", (c) => file(c, "index.html"));
  app.on(["GET", "HEAD"], "/assets/:name", (c) => file(c, join("assets", c.req.param("name"))));
}
