import { describe, expect, it } from "vitest";
import { edgeCacheKey } from "../src/server/serve";
import {
  call,
  createProject,
  createVariant,
  json,
  login,
  publish,
  SPEC,
  serveSpec,
  sql,
  textOf,
} from "./harness";

describe("serving a variant", () => {
  it("serves the filtered document with caching headers", async () => {
    const { variant } = await publish();
    const response = await call(variant.path);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(response.headers.get("cache-control")).toContain("stale-while-revalidate");
    expect(response.headers.get("x-proxy-source-status")).toBe("fresh");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("vary")).toBe("Accept");

    const doc = (await response.json()) as {
      paths: Record<string, object>;
      components: { schemas: Record<string, object> };
    };
    expect(Object.keys(doc.paths)).toEqual(["/pets"]);
    expect(Object.keys(doc.components.schemas)).toEqual(["Pet"]);
  });

  it("mirrors the source's JSON formatting", async () => {
    const cookie = await login();

    serveSpec(JSON.stringify(SPEC));
    const minified = await createProject(cookie);
    const a = await createVariant(cookie, minified.id);
    expect(await (await call(`${a.path}.json`)).text()).not.toContain("\n");

    serveSpec(JSON.stringify(SPEC, null, 2), {}, "https://pretty.example.com/openapi.json");
    const pretty = await createProject(cookie, { url: "https://pretty.example.com/openapi.json" });
    const b = await createVariant(cookie, pretty.id);
    expect(await (await call(`${b.path}.json`)).text()).toContain('\n  "openapi": "3.1.0"');
  });

  it("serves YAML by extension or Accept header, with its own ETag", async () => {
    const { variant } = await publish();
    const asJson = await call(`${variant.path}.json`);
    const asYaml = await call(`${variant.path}.yaml`);

    expect(asYaml.headers.get("content-type")).toBe("application/yaml; charset=utf-8");
    expect((await textOf(asYaml)).startsWith("openapi: 3.1.0")).toBe(true);
    expect(asYaml.headers.get("etag")).not.toBe(asJson.headers.get("etag"));
    // A URL that pins the format does not vary.
    expect(asYaml.headers.get("vary")).toBeNull();
    expect((await call(`${variant.path}.yml`)).status).toBe(200);

    const negotiated = await call(variant.path, { headers: { accept: "application/yaml" } });
    expect(negotiated.headers.get("content-type")).toContain("application/yaml");
    expect(negotiated.headers.get("etag")).toBe(asYaml.headers.get("etag"));
  });

  it("answers conditional requests, strong or weak", async () => {
    const { variant } = await publish();
    const etag = (await call(variant.path)).headers.get("etag") as string;

    for (const header of [etag, `W/${etag}`, `"something-else", W/${etag}`, "*"]) {
      const response = await call(variant.path, { headers: { "if-none-match": header } });
      expect(response.status, header).toBe(304);
      expect(response.headers.get("etag")).toBe(etag);
    }
    const miss = await call(variant.path, { headers: { "if-none-match": '"other"' } });
    expect(miss.status).toBe(200);
  });

  it("answers HEAD without a body", async () => {
    const { variant } = await publish();
    const head = await call(`${variant.path}.json`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBeTruthy();
    expect(await head.text()).toBe("");
  });

  it("404s for unknown projects and variants", async () => {
    const { variant } = await publish();
    expect((await call("/v/test/nope")).status).toBe(404);
    expect((await call("/v/nope/public")).status).toBe(404);
    expect((await call("/v/public")).status).toBe(404);
    expect((await call(`${variant.path}.txt`)).status).toBe(404);
  });

  it("changes the ETag and the document when the selection changes", async () => {
    const { cookie, variant } = await publish();
    const before = await call(variant.path);

    const patch = await call(
      `/api/variants/${variant.id}`,
      json(
        "PATCH",
        { selection: { mode: "include", operations: ["GET /pets"], tags: [] } },
        cookie,
      ),
    );
    expect(patch.status).toBe(200);

    const after = await call(variant.path);
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
    const doc = (await after.json()) as { paths: Record<string, Record<string, object>> };
    expect(Object.keys(doc.paths["/pets"] ?? {})).toEqual(["get"]);
  });

  it("renders once and then serves the stored output", async () => {
    const { variant } = await publish();
    const first = await call(`${variant.path}.yaml`);
    const etag = first.headers.get("etag") as string;
    const body = await textOf(first);

    const stored = await sql(
      "SELECT format, etag FROM variant_outputs WHERE variant_id = ?",
      variant.id,
    );
    expect(stored.results).toEqual([{ format: "yaml", etag }]);

    // With the source document gone and the edge cache empty, only the stored
    // output can answer.
    await sql("DELETE FROM sources");
    await caches.default.delete(edgeCacheKey(variant.id, "yaml", etag));
    const second = await call(`${variant.path}.yaml`);
    expect(second.status).toBe(200);
    expect(await textOf(second)).toBe(body);

    // Nothing stored for JSON, and no source to render from: a clean error, not a crash.
    const missing = await call(`${variant.path}.json`);
    expect(missing.status).toBe(502);
  });
});

describe("webhooks", () => {
  it("are only served when selected", async () => {
    const cookie = await login();
    serveSpec({
      ...SPEC,
      webhooks: {
        petAdopted: {
          post: {
            tags: ["internal"],
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Secret" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const project = await createProject(cookie);
    expect(project.opIndex.map((op) => op.key)).toContain("POST webhook:petAdopted");

    const publicDocs = await createVariant(cookie, project.id);
    const doc = (await (await call(publicDocs.path)).json()) as {
      webhooks: object;
      components: { schemas: object };
    };
    expect(doc.webhooks).toEqual({});
    expect(Object.keys(doc.components.schemas)).toEqual(["Pet"]);
  });
});
