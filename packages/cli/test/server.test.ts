import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  effectiveVariant,
  indexOperations,
  parseSpec,
  renderVariantText,
} from "@openapi-proxy/core";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { copyOf, example } from "./helpers.js";

const ORIGIN = "http://localhost:7745";
function serverFor(dir: string, sources: string[] = [], allowedHosts: string[] = []) {
  const app = createServer({ config: join(dir, "openapi-proxy.yaml"), sources, allowedHosts });
  return (path: string, init?: RequestInit) => app.fetch(new Request(`${ORIGIN}${path}`, init));
}
const keysOf = async (response: Response) =>
  indexOperations(parseSpec(await response.text()).doc)
    .entries.map((entry) => entry.key)
    .sort();

describe("the local server", () => {
  const get = serverFor(example("several-audiences"));

  it("serves each variant at the path the service has", async () => {
    const response = await get("/v/bookshop/docs.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await keysOf(response)).toEqual([
      "GET /billing/invoices",
      "GET /books",
      "GET /books/{id}",
      "POST /orders",
    ]);
    expect(await keysOf(await get("/v/bookshop/partner"))).toEqual([
      "GET /books",
      "GET /books/{id}",
    ]);
  });

  it("serves exactly what the engine renders from the same files", async () => {
    const dir = example("several-audiences");
    const parts = [
      { name: "core", text: readFileSync(join(dir, "core.yaml"), "utf8") },
      {
        name: "billing",
        pathPrefix: "/billing",
        text: readFileSync(join(dir, "billing.yaml"), "utf8"),
      },
    ];
    const { definition } = (await import("../src/config.js")).loadConfig(
      join(dir, "openapi-proxy.yaml"),
    );
    for (const [path, format, version] of [
      ["/v/bookshop/docs.json", "json", null],
      ["/v/bookshop/docs.yaml", "yaml", null],
      ["/v/bookshop/sdk/3.0.json", "json", "3.0"],
      ["/v/bookshop/internal/3.1.yaml", "yaml", null],
    ] as const) {
      const slug = path.split("/")[3]?.replace(/\..*$/, "") as string;
      const expected = renderVariantText(parts, {
        ...effectiveVariant(definition, slug),
        version,
        format,
      });
      expect(await (await get(path)).text(), path).toBe(expected);
    }
  });

  it("fills in what a variant leaves to the project", async () => {
    const docs = (await (await get("/v/bookshop/docs.json")).json()) as {
      info: { title: string };
      servers: Array<{ url: string }>;
      components: { schemas: Record<string, unknown> };
    };
    // The project's servers, the main document's title, and the renamed clash from the merge.
    expect(docs.servers).toEqual([
      { url: "https://api.bookshop.example", description: "Production" },
    ]);
    expect(docs.info.title).toBe("Bookshop API");
    expect(Object.keys(docs.components.schemas)).toContain("BillingError");
    const sdk = (await (await get("/v/bookshop/sdk.json")).json()) as typeof docs;
    expect(sdk.info.title).toBe("Bookshop SDK");
    const internal = (await (await get("/v/bookshop/internal.json")).json()) as typeof docs;
    expect(internal.servers[0]?.url).toBe("https://core.bookshop.internal");
  });

  it("answers the format and the version the URL asks for", async () => {
    const yaml = await get("/v/bookshop/docs.yaml");
    expect(yaml.headers.get("content-type")).toBe("application/yaml; charset=utf-8");
    expect(await yaml.text()).toMatch(/^openapi: 3\.1\.0/);
    const negotiated = await get("/v/bookshop/docs", { headers: { accept: "application/yaml" } });
    expect(negotiated.headers.get("content-type")).toContain("yaml");
    expect(negotiated.headers.get("vary")).toBe("Accept");
    const older = (await (await get("/v/bookshop/sdk/3.0.json")).json()) as { openapi: string };
    expect(older.openapi).toMatch(/^3\.0\./);
    const none = await get("/v/bookshop/sdk/2.0.json");
    expect(none.status).toBe(404);
    expect(((await none.json()) as { error: string }).error).toContain('not served as "2.0"');
  });

  it("has validators, and HEAD without a body", async () => {
    const first = await get("/v/bookshop/docs.json");
    const etag = first.headers.get("etag") as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await get("/v/bookshop/docs.json", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    const head = await get("/v/bookshop/docs.json", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("says what there is when asked for what there is not", async () => {
    const missing = await get("/v/bookshop/nope.json");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not-found" });
    expect(((await (await get("/v/other/docs.json")).json()) as { error: string }).error).toContain(
      "/v/bookshop/docs",
    );
    expect((await get("/anything")).status).toBe(404);
  });
});

describe("the local server and what is on disk", () => {
  it("reads the file and the sources on every request", async () => {
    const dir = copyOf("in-your-repository");
    const get = serverFor(dir);
    expect(await keysOf(await get("/v/bookshop/public.json"))).not.toContain("GET /admin/staff");

    const file = join(dir, "openapi-proxy.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("tags: [Books, Orders]", "tags: [Books, Orders, Admin]"),
    );
    expect(await keysOf(await get("/v/bookshop/public.json"))).toContain("GET /admin/staff");

    // And the document: an operation the API gains shows up without a restart.
    const document = JSON.parse(readFileSync(join(dir, "openapi.json"), "utf8"));
    document.paths["/books/search"] = {
      get: { tags: ["Books"], responses: { "200": { description: "ok" } } },
    };
    writeFileSync(join(dir, "openapi.json"), JSON.stringify(document));
    expect(await keysOf(await get("/v/bookshop/public.json"))).toContain("GET /books/search");
  });

  it("answers 502 and names the source when a document cannot be read, never an older copy", async () => {
    const dir = copyOf("in-your-repository");
    const get = serverFor(dir);
    expect((await get("/v/bookshop/public.json")).status).toBe(200);
    rmSync(join(dir, "openapi.json"));
    const gone = await get("/v/bookshop/public.json");
    expect(gone.status).toBe(502);
    expect(await gone.json()).toMatchObject({ code: "source-unavailable", source: "main" });

    writeFileSync(join(dir, "openapi.json"), "{ not an openapi document");
    const broken = await get("/v/bookshop/public.json");
    expect(broken.status).toBe(502);
    expect(((await broken.json()) as { error: string }).error).toContain("not an OpenAPI document");
  });

  it("answers 500 with the problems when the file stops being a definition", async () => {
    const dir = copyOf("in-your-repository");
    const get = serverFor(dir);
    const file = join(dir, "openapi-proxy.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("visibility: public", "visibility: open"),
    );
    const response = await get("/v/bookshop/public.json");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "invalid-definition",
      problems: [{ path: "variants.public.visibility", line: 15 }],
    });
  });

  it("reads a source from where --source says", async () => {
    // The example names an address nothing answers at; the flag points at the file beside it.
    const dir = example("from-a-url");
    const get = serverFor(dir, [join(dir, "openapi.json")]);
    expect(await keysOf(await get("/v/bookshop/partner.json"))).toEqual([
      "GET /books",
      "GET /books/{id}",
    ]);
  });
});

describe("who the local server answers", () => {
  const dir = example("in-your-repository");
  const ask = (host: string, init: RequestInit = {}, allowedHosts: string[] = []) =>
    createServer({ config: join(dir, "openapi-proxy.yaml"), sources: [], allowedHosts }).fetch(
      new Request("http://localhost:7745/v/bookshop/public.json", {
        ...init,
        headers: { ...init.headers, host },
      }),
    );

  it("only requests addressed to this machine", async () => {
    for (const host of ["localhost:7745", "127.0.0.1:7745", "[::1]:7745", "app.localhost:7745"]) {
      expect((await ask(host)).status, host).toBe(200);
    }
    // A site that points a name of its own at this machine uses that name.
    const refused = await ask("attacker.example:7745");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "host-not-allowed" });
  });

  it("and to the hosts it was told to answer", async () => {
    expect((await ask("docs.acme.dev", {}, ["docs.acme.dev"])).status).toBe(200);
    expect((await ask("x.tunnel.example", {}, [".tunnel.example"])).status).toBe(200);
    expect((await ask("tunnel.example.evil.test", {}, [".tunnel.example"])).status).toBe(403);
  });

  it("lets a page on this machine read a document, and no other site", async () => {
    const local = await ask("localhost:7745", { headers: { origin: "http://localhost:3000" } });
    expect(local.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const foreign = await ask("localhost:7745", { headers: { origin: "https://evil.example" } });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });
});
